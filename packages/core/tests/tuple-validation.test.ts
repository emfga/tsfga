import { beforeEach, describe, expect, test } from "bun:test";
import { check } from "../src/check.ts";
import {
  DuplicateTupleError,
  IdDomainError,
  InvalidConditionalTupleError,
  InvalidObjectError,
  InvalidSubjectTypeError,
  TsfgaError,
} from "../src/errors.ts";
import { createTsfga, type TsfgaClient } from "../src/index.ts";
import { CANONICAL_UUID_IDS } from "../src/store-interface.ts";
import { DEFAULT_WRITE_CONTEXT_BYTE_LIMIT } from "../src/tuple-validation.ts";
import type { AddTupleRequest, CheckRequest } from "../src/types.ts";
import { MockTupleStore } from "./helpers/mock-store.ts";

/**
 * The write-path gates OpenFGA applies and tsfga did not.
 *
 * Pinned two-sided in `tests/conformance/write-gate.test.ts`.
 * Here the same rules are exercised against the mock, plus the
 * three things the conformance suite cannot say: which error class
 * and cause each refusal carries, that a duplicate leaves the
 * stored row *untouched* rather than merely unreported, and that
 * the context byte limit is a write-path rule the contextual-tuple
 * path does not inherit.
 */

const BACKSPACE = "\u0008";
const DELETE = "\u007f";

function seed(store: MockTupleStore): void {
  store.relationConfigs.push(
    {
      objectType: "doc",
      relation: "userset_only",
      directlyAssignable: [{ type: "team", relation: "member" }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    },
    {
      objectType: "doc",
      relation: "both",
      directlyAssignable: [
        { type: "user" },
        { type: "user", condition: "big" },
      ],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    },
    {
      objectType: "doc",
      relation: "wildcard_only",
      directlyAssignable: [{ type: "user", wildcard: true }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    },
  );
  store.conditionDefinitions.push({
    name: "big",
    expression: "s != ''",
    parameters: { s: "string" },
  });
}

const conditioned = (context: Record<string, unknown>): AddTupleRequest => ({
  objectType: "doc",
  objectId: "1",
  relation: "both",
  subjectType: "user",
  subjectId: "alice",
  conditionName: "big",
  conditionContext: context,
});

describe("addTuple refuses a malformed subject", () => {
  let store: MockTupleStore;
  let fga: TsfgaClient;

  beforeEach(() => {
    store = new MockTupleStore();
    seed(store);
    fga = createTsfga(store);
  });

  const malformed: AddTupleRequest = {
    objectType: "doc",
    objectId: "1",
    relation: "userset_only",
    subjectType: "team",
    subjectId: "*",
    subjectRelation: "member",
  };

  test("a wildcard id carrying a subject relation", async () => {
    await expect(fga.addTuple(malformed)).rejects.toBeInstanceOf(
      InvalidSubjectTypeError,
    );
  });

  test("the refusal is discriminated as a malformed subject", async () => {
    // Not "the relation does not admit this shape": the relation
    // admits `team#member`, and `team:*#member` reads as one. The
    // defect is the ref, not the model.
    const error = await fga.addTuple(malformed).catch((e) => e);
    expect(error).toBeInstanceOf(InvalidSubjectTypeError);
    expect(error.cause).toBe("malformed subject");
  });

  test("nothing is stored", async () => {
    await fga.addTuple(malformed).catch(() => {});
    expect(store.tuples).toHaveLength(0);
  });

  test("the same shape is refused as a contextual tuple", async () => {
    // Upstream validates a contextual tuple exactly as a write, so
    // the shape gate has to fire on both paths.
    await expect(
      check(store, {
        objectType: "doc",
        objectId: "1",
        relation: "userset_only",
        subjectType: "user",
        subjectId: "alice",
        contextualTuples: [malformed],
      }),
    ).rejects.toBeInstanceOf(InvalidSubjectTypeError);
  });

  test("the control: a concrete userset is written", async () => {
    await expect(
      fga.addTuple({ ...malformed, subjectId: "engineering" }),
    ).resolves.toBeUndefined();
  });
});

describe("addTuple refuses forbidden characters", () => {
  let store: MockTupleStore;
  let fga: TsfgaClient;

  beforeEach(() => {
    store = new MockTupleStore();
    seed(store);
    fga = createTsfga(store);
  });

  const cause = async (request: AddTupleRequest): Promise<unknown> => {
    const error = await fga.addTuple(request).catch((e) => e);
    expect(error).toBeInstanceOf(InvalidConditionalTupleError);
    return error.cause;
  };

  test("a control character in a context value", async () => {
    expect(await cause(conditioned({ s: `a${BACKSPACE}b` }))).toBe(
      "context contains forbidden characters",
    );
  });

  test("a control character in a context key", async () => {
    expect(await cause(conditioned({ [`s${BACKSPACE}`]: "x" }))).toBe(
      "context contains forbidden characters",
    );
  });

  test("a control character nested in a list", async () => {
    expect(await cause(conditioned({ s: ["ok", `a${BACKSPACE}b`] }))).toBe(
      "context contains forbidden characters",
    );
  });

  test("a control character nested in a struct", async () => {
    expect(await cause(conditioned({ s: { inner: `a${BACKSPACE}b` } }))).toBe(
      "context contains forbidden characters",
    );
  });

  test("a control character in the condition name", async () => {
    // Scanned before the definition lookup, which is upstream's
    // order: this reports the characters, not "undefined
    // condition", even though no such condition can be defined.
    expect(
      await cause({
        ...conditioned({ s: "ok" }),
        conditionName: `big${BACKSPACE}`,
      }),
    ).toBe("context contains forbidden characters");
  });

  test("a delete character is forbidden too", async () => {
    // U+007F is `Cc` and so is `unicode.IsControl`, though it sits
    // above the printable range rather than below it.
    expect(await cause(conditioned({ s: `a${DELETE}b` }))).toBe(
      "context contains forbidden characters",
    );
  });

  test("a tab is forbidden too", async () => {
    // A tab is `Cc` in Unicode and so `unicode.IsControl` in Go.
    // Asserted so the boundary is stated rather than assumed: this
    // is the one forbidden character an ordinary caller might send
    // without meaning anything by it.
    expect(await cause(conditioned({ s: "a\tb" }))).toBe(
      "context contains forbidden characters",
    );
  });

  test("the control: an ordinary string is written", async () => {
    await expect(
      fga.addTuple(conditioned({ s: "ok" })),
    ).resolves.toBeUndefined();
  });
});

describe("addTuple refuses an oversized condition context", () => {
  let store: MockTupleStore;
  let fga: TsfgaClient;

  beforeEach(() => {
    store = new MockTupleStore();
    seed(store);
    fga = createTsfga(store);
  });

  test("a context over the default limit", async () => {
    const error = await fga
      .addTuple(conditioned({ s: "x".repeat(40_000) }))
      .catch((e) => e);
    expect(error).toBeInstanceOf(InvalidConditionalTupleError);
    expect(error.cause).toBe("context size limit exceeded");
  });

  test("the default is OpenFGA's 32 KiB", async () => {
    expect(DEFAULT_WRITE_CONTEXT_BYTE_LIMIT).toBe(32 * 1024);
  });

  test("a context just under the limit is written", async () => {
    await expect(
      fga.addTuple(conditioned({ s: "x".repeat(1_000) })),
    ).resolves.toBeUndefined();
  });

  test("the limit is configurable", async () => {
    const tight = createTsfga(store, { writeContextByteLimit: 16 });
    await expect(
      tight.addTuple(conditioned({ s: "x".repeat(100) })),
    ).rejects.toBeInstanceOf(InvalidConditionalTupleError);
  });

  test("a contextual tuple is not measured", async () => {
    // The limit lives in upstream's Write command and nowhere
    // else, so a check request carrying a large contextual context
    // is answered rather than refused. Measuring it here would
    // refuse a request upstream accepts.
    await expect(
      check(store, {
        objectType: "doc",
        objectId: "1",
        relation: "both",
        subjectType: "user",
        subjectId: "alice",
        contextualTuples: [conditioned({ s: "x".repeat(40_000) })],
      }),
    ).resolves.toBe(true);
  });
});

/**
 * The measure itself, calibrated against v1.18.2.
 *
 * The limit is enforced on the serialised size of the
 * `google.protobuf.Struct` the context becomes on the wire, not on
 * the UTF-8 length of its JSON. The two differ in both directions —
 * JSON frames a single entry in 8 bytes where protobuf takes 15,
 * and `JSON.stringify` escapes where protobuf carries raw UTF-8 —
 * so the boundary is asserted exactly rather than approximately.
 *
 * `"x".repeat(32_753)` is the largest single-string context
 * upstream accepts: the container takes it and refuses
 * `32_756`. One entry keyed `s` costs `len(s) + 15`.
 */
describe("the condition context is measured as protobuf does", () => {
  let store: MockTupleStore;
  let fga: TsfgaClient;

  /**
   * A second condition, because the recursive arms need values the
   * `big` fixture's `s: string` cannot carry. `any` is what lets a
   * list, a map and a number reach the size check at all: the
   * parameter pass runs first and would otherwise refuse them
   * before anything was measured.
   */
  const nested = (context: Record<string, unknown>): AddTupleRequest => ({
    objectType: "doc",
    objectId: "1",
    relation: "anything",
    subjectType: "user",
    subjectId: "alice",
    conditionName: "anything",
    conditionContext: context,
  });

  beforeEach(() => {
    store = new MockTupleStore();
    seed(store);
    store.relationConfigs.push({
      objectType: "doc",
      relation: "anything",
      directlyAssignable: [{ type: "user", condition: "anything" }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    store.conditionDefinitions.push({
      name: "anything",
      expression: "true",
      parameters: { s: "any", n: "any" },
    });
    fga = createTsfga(store);
  });

  test("the largest context upstream accepts is written", async () => {
    // 32_753 + 15 = 32_768, and the check is `>` the limit.
    await expect(
      fga.addTuple(conditioned({ s: "x".repeat(32_753) })),
    ).resolves.toBeUndefined();
  });

  test("one byte past it is refused", async () => {
    const error = await fga
      .addTuple(conditioned({ s: "x".repeat(32_754) }))
      .catch((e) => e);
    expect(error).toBeInstanceOf(InvalidConditionalTupleError);
    expect(error.cause).toBe("context size limit exceeded");
  });

  test("the refusal names the protobuf size, not the JSON one", async () => {
    // JSON would say 32_769 bytes for this context; protobuf says
    // 32_771. Asserting the number pins which measure ran.
    const error = await fga
      .addTuple(conditioned({ s: "x".repeat(32_756) }))
      .catch((e) => e);
    expect(error.message).toContain("32771 bytes");
  });

  test("escaping does not inflate a quote-heavy context", async () => {
    // 20_000 quote characters are 40_008 bytes of JSON and 20_015
    // of protobuf. Upstream accepts the write, so refusing it made
    // a grant the model permits impossible to create.
    await expect(
      fga.addTuple(conditioned({ s: '"'.repeat(20_000) })),
    ).resolves.toBeUndefined();
  });

  test("a backslash-heavy context is not inflated either", async () => {
    await expect(
      fga.addTuple(conditioned({ s: "\\".repeat(20_000) })),
    ).resolves.toBeUndefined();
  });

  test("a nested list is measured through its items", async () => {
    // Each item costs `1 + varint(m) + m` inside the `ListValue`
    // and the list costs the same again as a `Value`, so the pair
    // is 40_031 bytes where one alone is 20_023.
    await expect(
      fga.addTuple(nested({ s: ["x".repeat(20_000), "y".repeat(20_000)] })),
    ).rejects.toBeInstanceOf(InvalidConditionalTupleError);
    await expect(
      fga.addTuple(nested({ s: ["x".repeat(20_000)] })),
    ).resolves.toBeUndefined();
  });

  test("a nested map is measured through its entries", async () => {
    // 40_045 and 20_030 — a nested entry pays the map-entry framing
    // a second time, which is what makes the recursion worth
    // asserting separately from the list.
    await expect(
      fga.addTuple(
        nested({ s: { a: "x".repeat(20_000), b: "y".repeat(20_000) } }),
      ),
    ).rejects.toBeInstanceOf(InvalidConditionalTupleError);
    await expect(
      fga.addTuple(nested({ s: { a: "x".repeat(20_000) } })),
    ).resolves.toBeUndefined();
  });

  test("a number entry costs its fixed64", async () => {
    // A `number_value` is a tag plus eight bytes whatever it holds,
    // so the `n` entry costs 16 bytes all in. 32_737 + 16 lands on
    // 32_768 exactly and 32_738 goes over — a boundary JSON's
    // measure could not reproduce, since `1` is one byte there.
    await expect(
      fga.addTuple(nested({ s: "x".repeat(32_737), n: 1 })),
    ).resolves.toBeUndefined();
    await expect(
      fga.addTuple(nested({ s: "x".repeat(32_738), n: 1 })),
    ).rejects.toBeInstanceOf(InvalidConditionalTupleError);
  });

  test("a null entry costs two bytes, not none", async () => {
    // `null_value` is a oneof member, and a oneof member is written
    // even holding its zero value. JSON spells it in four bytes; if
    // the measure were still JSON's, the boundary would move.
    await expect(
      fga.addTuple(nested({ s: "x".repeat(32_744), n: null })),
    ).resolves.toBeUndefined();
    await expect(
      fga.addTuple(nested({ s: "x".repeat(32_745), n: null })),
    ).rejects.toBeInstanceOf(InvalidConditionalTupleError);
  });
});

/**
 * `IsValidUserID` and `IsValidObject`, on the write path.
 *
 * The check path applied the subject half first, so for a while a
 * subject id holding `:` or `#` was writable and uncheckable. Both halves report as `TsfgaError`s, so a caller
 * catching the base class sees every malformed identifier.
 */
describe("addTuple refuses a malformed identifier", () => {
  let store: MockTupleStore;
  let fga: TsfgaClient;

  beforeEach(() => {
    store = new MockTupleStore();
    seed(store);
    fga = createTsfga(store);
  });

  const bare = (subjectId: string): AddTupleRequest => ({
    objectType: "doc",
    objectId: "1",
    relation: "both",
    subjectType: "user",
    subjectId,
  });

  test("the object half still reports as a TsfgaError", async () => {
    // `InvalidObjectError` replaced the bare `TsfgaError` this was
    // raised as, and a caller catching the base class must still
    // see it — `identifiers.test.ts` asserts exactly that, from
    // the other side.
    await expect(
      fga.addTuple({ ...bare("alice"), objectId: "a b" }),
    ).rejects.toBeInstanceOf(TsfgaError);
  });

  for (const [label, id] of [
    ["empty", ""],
    ["a colon", "a:b"],
    ["a hash", "a#b"],
    ["a space", "a b"],
    ["a backspace", `a${BACKSPACE}b`],
    ["a delete", `a${DELETE}b`],
  ] as const) {
    test(`a subject id holding ${label}`, async () => {
      const error = await fga.addTuple(bare(id)).catch((e) => e);
      expect(error).toBeInstanceOf(InvalidSubjectTypeError);
      expect(error.cause).toBe("malformed subject");
      expect(store.tuples).toHaveLength(0);
    });
  }

  test("the wildcard id is still legal", async () => {
    store.relationConfigs.push({
      objectType: "doc",
      relation: "public",
      directlyAssignable: [{ type: "user", wildcard: true }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await expect(
      fga.addTuple({ ...bare("*"), relation: "public" }),
    ).resolves.toBeUndefined();
  });

  test("a unicode subject id is written", async () => {
    await expect(fga.addTuple(bare("café"))).resolves.toBeUndefined();
  });

  test("the `user` field is bounded at 512 bytes", async () => {
    // `user:` is 5 bytes, so 507 fits and 508 does not. Bisected
    // against the container, which counts bytes rather than runes.
    await expect(fga.addTuple(bare("a".repeat(507)))).resolves.toBeUndefined();
    const error = await fga.addTuple(bare("a".repeat(508))).catch((e) => e);
    expect(error).toBeInstanceOf(InvalidSubjectTypeError);
    expect(error.cause).toBe("malformed subject");
  });

  test("the bound counts the subject relation too", async () => {
    const long = {
      objectType: "doc",
      objectId: "1",
      relation: "userset_only",
      subjectType: "team",
      subjectId: "a".repeat(500),
      subjectRelation: "member",
    };
    // `team:` + 500 + `#member` is 512 exactly.
    await expect(fga.addTuple(long)).resolves.toBeUndefined();
    await expect(
      fga.addTuple({ ...long, subjectId: "a".repeat(501) }),
    ).rejects.toBeInstanceOf(InvalidSubjectTypeError);
  });

  test("a contextual tuple is gated identically", async () => {
    await expect(
      check(store, {
        objectType: "doc",
        objectId: "1",
        relation: "both",
        subjectType: "user",
        subjectId: "alice",
        contextualTuples: [bare("a:b")],
      }),
    ).rejects.toBeInstanceOf(InvalidSubjectTypeError);
  });

  for (const [label, id] of [
    ["empty", ""],
    ["a colon", "a:b"],
    ["a hash", "a#b"],
    ["a space", "a b"],
    ["a backspace", `a${BACKSPACE}b`],
  ] as const) {
    test(`an object id holding ${label}`, async () => {
      const error = await fga
        .addTuple({ ...bare("alice"), objectId: id })
        .catch((e) => e);
      expect(error).toBeInstanceOf(InvalidObjectError);
      expect(error.cause).toBe("malformed object id");
      expect(store.tuples).toHaveLength(0);
    });
  }

  test("an object id of '*' is refused", async () => {
    // A typed wildcard is a *subject*. `doc:*` is a row nothing may
    // ever read back, because no check may name it as its object —
    // upstream refuses it in `ValidateObject`, before the type is
    // looked up.
    const error = await fga
      .addTuple({ ...bare("alice"), objectId: "*" })
      .catch((e) => e);
    expect(error).toBeInstanceOf(InvalidObjectError);
    expect(error.cause).toBe("object id is a typed wildcard");
    expect(store.tuples).toHaveLength(0);
  });

  test("a check whose object id is '*' is refused too", async () => {
    // The same gate, on the read path: one predicate, as upstream's
    // `ValidateUserObjectRelation` is one.
    const error = await check(store, {
      objectType: "doc",
      objectId: "*",
      relation: "both",
      subjectType: "user",
      subjectId: "alice",
    }).catch((e) => e);
    expect(error).toBeInstanceOf(InvalidObjectError);
    expect(error.cause).toBe("object id is a typed wildcard");
  });

  test("a contextual tuple's object id is gated identically", async () => {
    await expect(
      check(store, {
        objectType: "doc",
        objectId: "1",
        relation: "both",
        subjectType: "user",
        subjectId: "alice",
        contextualTuples: [{ ...bare("alice"), objectId: "*" }],
      }),
    ).rejects.toBeInstanceOf(InvalidObjectError);
  });

  test("a wildcard *subject* stays legal on both paths", async () => {
    store.relationConfigs.push({
      objectType: "doc",
      relation: "public",
      directlyAssignable: [{ type: "user", wildcard: true }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await expect(
      fga.addTuple({ ...bare("*"), relation: "public" }),
    ).resolves.toBeUndefined();
    await expect(
      check(store, {
        objectType: "doc",
        objectId: "1",
        relation: "public",
        subjectType: "user",
        subjectId: "alice",
      }),
    ).resolves.toBe(true);
  });

  test("the `object` field is bounded at 256 code points", async () => {
    // `doc:` is 4 runes, so 252 fits and 253 does not. The bound
    // counts runes, not bytes: the container accepts 200 two-byte
    // runes.
    await expect(
      fga.addTuple({ ...bare("alice"), objectId: "a".repeat(252) }),
    ).resolves.toBeUndefined();
    const error = await fga
      .addTuple({ ...bare("alice"), objectId: "a".repeat(253) })
      .catch((e) => e);
    expect(error).toBeInstanceOf(InvalidObjectError);
    expect(error.cause).toBe("object too long");
    await expect(
      fga.addTuple({ ...bare("alice"), objectId: "é".repeat(200) }),
    ).resolves.toBeUndefined();
  });
});

/**
 * The same two rules on the **check** path, which is where issue
 * 422 was measured: a malformed id is a perfectly good text column
 * value, so tsfga read no row and answered `false` where upstream
 * answers 400. The predicate is shared with the write path above
 * rather than re-spelled, and these pin the two halves that differ
 * — the class each side raises, and the bounds.
 *
 * Two-sided in `tests/conformance/request-idents.test.ts`.
 */
describe("check refuses a malformed identifier", () => {
  let store: MockTupleStore;

  beforeEach(() => {
    store = new MockTupleStore();
    seed(store);
  });

  const request = (overrides: {
    objectId?: string;
    subjectId?: string;
  }): CheckRequest => ({
    objectType: "doc",
    objectId: "1",
    relation: "both",
    subjectType: "user",
    subjectId: "alice",
    ...overrides,
  });

  for (const [label, id] of [
    ["empty", ""],
    ["a colon", "a:b"],
    ["a hash", "a#b"],
    ["a space", "a b"],
    ["a backspace", `a${BACKSPACE}b`],
    ["a delete", `a${DELETE}b`],
  ] as const) {
    test(`an object id holding ${label}`, async () => {
      const error = await check(store, request({ objectId: id })).catch(
        (e) => e,
      );
      expect(error).toBeInstanceOf(InvalidObjectError);
      expect(error.cause).toBe("malformed object id");
    });

    test(`a subject id holding ${label}`, async () => {
      // The subject's refusal stays an `InvalidSubjectTypeError`
      // with cause `malformed subject`: it is the same defect the
      // write path reports, and only the allow-list differs —
      // empty here, since nothing has read a relation config.
      const error = await check(store, request({ subjectId: id })).catch(
        (e) => e,
      );
      expect(error).toBeInstanceOf(InvalidSubjectTypeError);
      expect(error.cause).toBe("malformed subject");
    });
  }

  test("the bounds are the wire string's, not the id's", async () => {
    // `doc:` is 4 runes and `user:` is 5 bytes, exactly as the
    // write path measures them.
    await expect(
      check(store, request({ objectId: "a".repeat(252) })),
    ).resolves.toBe(false);
    const object = await check(
      store,
      request({ objectId: "a".repeat(253) }),
    ).catch((e) => e);
    expect(object).toBeInstanceOf(InvalidObjectError);
    expect(object.cause).toBe("object too long");

    await expect(
      check(store, request({ subjectId: "a".repeat(507) })),
    ).resolves.toBe(false);
    const subject = await check(
      store,
      request({ subjectId: "a".repeat(508) }),
    ).catch((e) => e);
    expect(subject).toBeInstanceOf(InvalidSubjectTypeError);
    expect(subject.cause).toBe("malformed subject");
  });

  test("a non-breaking space is an ordinary character", async () => {
    // `unicode.IsControl` plus U+0020 and nothing wider. A rule
    // spelled with JavaScript's `\s`, or with `\p{Zs}`, would
    // refuse a request both engines answer — and would take every
    // non-ASCII id in the corpus with it.
    const nbsp = "\u00a0";
    await expect(check(store, request({ objectId: `1${nbsp}` }))).resolves.toBe(
      false,
    );
    await expect(
      check(store, request({ subjectId: `alice${nbsp}` })),
    ).resolves.toBe(false);
    await expect(
      check(store, request({ objectId: "dökümän-1" })),
    ).resolves.toBe(false);
  });
});

describe("addTuple refuses a duplicate", () => {
  let store: MockTupleStore;
  let fga: TsfgaClient;

  const bare: AddTupleRequest = {
    objectType: "doc",
    objectId: "1",
    relation: "both",
    subjectType: "user",
    subjectId: "alice",
  };

  beforeEach(() => {
    store = new MockTupleStore();
    seed(store);
    fga = createTsfga(store);
  });

  test("the second write of the same edge", async () => {
    await fga.addTuple(bare);
    await expect(fga.addTuple(bare)).rejects.toBeInstanceOf(
      DuplicateTupleError,
    );
  });

  test("the condition is not part of the key", async () => {
    // Upstream keys on `TupleKeyWithoutCondition`, so re-granting
    // the same edge under a condition is a duplicate rather than
    // an edit.
    await fga.addTuple(bare);
    await expect(
      fga.addTuple({ ...bare, conditionName: "big", conditionContext: {} }),
    ).rejects.toBeInstanceOf(DuplicateTupleError);
  });

  test("the stored row is left exactly as it was", async () => {
    // The failure this replaces was silent, and it ran in the
    // widening direction as readily as the narrowing one: an
    // upsert would have dropped the condition here.
    await fga.addTuple({
      ...bare,
      conditionName: "big",
      conditionContext: { s: "ok" },
    });
    await fga.addTuple(bare).catch(() => {});
    expect(store.tuples).toHaveLength(1);
    expect(store.tuples[0]?.conditionName).toBe("big");
    expect(store.tuples[0]?.conditionContext).toEqual({ s: "ok" });
  });

  test("the error names the edge", async () => {
    await fga.addTuple(bare);
    const error = await fga.addTuple(bare).catch((e) => e);
    expect(error.objectType).toBe("doc");
    expect(error.objectId).toBe("1");
    expect(error.relation).toBe("both");
    expect(error.subjectType).toBe("user");
    expect(error.subjectId).toBe("alice");
    expect(error.subjectRelation).toBeNull();
  });

  test("removing then writing is how a condition changes", async () => {
    await fga.addTuple(bare);
    await fga.removeTuple(bare);
    await expect(
      fga.addTuple({
        ...bare,
        conditionName: "big",
        conditionContext: { s: "ok" },
      }),
    ).resolves.toBeUndefined();
    expect(store.tuples[0]?.conditionName).toBe("big");
  });

  test("a different subject relation is a different edge", async () => {
    await fga.addTuple({
      objectType: "doc",
      objectId: "1",
      relation: "userset_only",
      subjectType: "team",
      subjectId: "engineering",
      subjectRelation: "member",
    });
    await expect(
      fga.addTuple({
        objectType: "doc",
        objectId: "1",
        relation: "userset_only",
        subjectType: "team",
        subjectId: "engineering",
        subjectRelation: "member",
      }),
    ).rejects.toBeInstanceOf(DuplicateTupleError);
  });
});

/**
 * Which rule wins when a write carries two defects at once.
 *
 * The order of the rules in `validateTupleWrite` is upstream's,
 * and it is observable: a caller sees one refusal, and which one
 * it is says which rule ran first. Until `ruleId` existed there
 * was nothing to assert it with — every refusal reduced to the
 * same word, so a reordering passed. Measured before these
 * landed: of seventeen adjacent rule-block swaps, three failed
 * anything anywhere in the repository.
 *
 * Five of the twenty silent sites, one line each. The rest are
 * listed in the commit that added these.
 *
 * **Three of these are about a malformed id**, and the id-domain
 * rule takes precedence over none of them. It runs after every
 * upstream rule about the request's strings and before the first
 * rule about the model, so a malformed id keeps reporting the
 * upstream rule that refuses it. The block below asserts that
 * position from both sides.
 */
describe("two defects at once report the earlier rule", () => {
  let store: MockTupleStore;
  let fga: TsfgaClient;

  beforeEach(() => {
    store = new MockTupleStore();
    seed(store);
    fga = createTsfga(store);
  });

  /** The rule that refused, or `"accepted"`. */
  async function ruleFor(request: AddTupleRequest): Promise<string> {
    try {
      await fga.addTuple(request);
      return "accepted";
    } catch (error) {
      if (!(error instanceof TsfgaError)) throw error;
      return error.ruleId ?? "unnamed";
    }
  }

  test("implicit beats every gate below it", async () => {
    // `doc:1#both@doc:1#both` is implicit *and* names a subject
    // type the relation does not admit.
    expect(
      await ruleFor({
        objectType: "doc",
        objectId: "1",
        relation: "both",
        subjectType: "doc",
        subjectId: "1",
        subjectRelation: "both",
      }),
    ).toBe("TUPLE-IMPLICIT");
  });

  test("the wildcard shape beats the rest of IsValidUser", async () => {
    expect(
      await ruleFor({
        objectType: "doc",
        objectId: "1",
        relation: "both",
        subjectType: "user",
        subjectId: "*",
        subjectRelation: "x".repeat(600),
      }),
    ).toBe("TUPLE-SUBJECT-WILDCARD-SHAPE");
  });

  test("a malformed subject beats a malformed object", async () => {
    expect(
      await ruleFor({
        objectType: "doc",
        objectId: "a:b",
        relation: "both",
        subjectType: "user",
        subjectId: "a b",
      }),
    ).toBe("TUPLE-SUBJECT-MALFORMED");
  });

  test("a malformed object beats an unadmitted subject type", async () => {
    expect(
      await ruleFor({
        objectType: "doc",
        objectId: "a:b",
        relation: "both",
        subjectType: "team",
        subjectId: "t1",
      }),
    ).toBe("TUPLE-OBJECT-MALFORMED");
  });

  test("a parameter type error beats an undeclared key", async () => {
    expect(await ruleFor(conditioned({ s: 5, stray: "x" }))).toBe(
      "TUPLE-CONTEXT-PARAMETER-TYPE",
    );
  });
});

/**
 * Where the store's own id rule sits, asserted from both sides.
 *
 * `ID-DOMAIN-OUT-OF-DOMAIN` refuses an id OpenFGA accepts, so its
 * position in the order is observable on nearly every refusing
 * input: no malformed id is a canonical UUID, so a store with a
 * narrow domain has two rules that both apply to almost every bad
 * request. The decision is that upstream's rule wins — a caller
 * hears the refusal that is portable rather than the one that is
 * local to this deployment — and that the domain rule still runs
 * ahead of every question about the model, because it is a rule
 * about a string and upstream settles all of those first.
 *
 * The mock's domain is opaque by default, which is why none of the
 * assertions above moved when this landed.
 */
describe("the id domain runs behind the request rules and ahead of the model", () => {
  let store: MockTupleStore;
  let fga: TsfgaClient;

  beforeEach(() => {
    store = new MockTupleStore();
    seed(store);
    store.idDomain = CANONICAL_UUID_IDS;
    fga = createTsfga(store);
  });

  const UUID = "00000000-0000-4000-a000-000000000001";

  async function ruleFor(request: AddTupleRequest): Promise<string> {
    try {
      await fga.addTuple(request);
      return "accepted";
    } catch (error) {
      if (!(error instanceof TsfgaError)) throw error;
      return error.ruleId ?? "unnamed";
    }
  }

  test("a malformed subject beats the domain rule", async () => {
    expect(
      await ruleFor({
        objectType: "doc",
        objectId: UUID,
        relation: "both",
        subjectType: "user",
        subjectId: "a b",
      }),
    ).toBe("TUPLE-SUBJECT-MALFORMED");
  });

  test("a malformed object beats the domain rule", async () => {
    expect(
      await ruleFor({
        objectType: "doc",
        objectId: "a:b",
        relation: "both",
        subjectType: "user",
        subjectId: UUID,
      }),
    ).toBe("TUPLE-OBJECT-MALFORMED");
  });

  test("the typed wildcard object beats the domain rule", async () => {
    expect(
      await ruleFor({
        objectType: "doc",
        objectId: "*",
        relation: "both",
        subjectType: "user",
        subjectId: UUID,
      }),
    ).toBe("TUPLE-OBJECT-WILDCARD");
  });

  test("the domain rule beats an unadmitted subject type", async () => {
    // The model half. `team` is not admitted by `both`, and the
    // subject id is a slug -- upstream would report the type, and
    // this store cannot get that far.
    expect(
      await ruleFor({
        objectType: "doc",
        objectId: UUID,
        relation: "both",
        subjectType: "team",
        subjectId: "t1",
      }),
    ).toBe("ID-DOMAIN-OUT-OF-DOMAIN");
  });

  test("the subject half runs before the object half", async () => {
    const error = await fga
      .addTuple({
        objectType: "doc",
        objectId: "readme.md",
        relation: "both",
        subjectType: "user",
        subjectId: "alice",
      })
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(IdDomainError);
    if (error instanceof IdDomainError) {
      expect(error.position).toBe("subject");
      expect(error.id).toBe("alice");
      expect(error.domain).toBe("canonical UUID");
    }
  });

  test("the typed wildcard subject is exempt", async () => {
    // `user:*` is a subject shape, not an id. Refusing it would
    // refuse every wildcard grant there is.
    expect(
      await ruleFor({
        objectType: "doc",
        objectId: UUID,
        relation: "wildcard_only",
        subjectType: "user",
        subjectId: "*",
      }),
    ).toBe("accepted");
  });

  test("a store declaring no domain fails closed and named", async () => {
    // Not reachable from TypeScript -- the property is required --
    // but a JavaScript consumer, a spread clone or a `Proxy` can
    // produce it. Reading `.defect` off `undefined` would throw a
    // bare `TypeError` from inside the gate, which is the unnamed
    // crash this whole design was bought to fix.
    const undeclared = new MockTupleStore();
    seed(undeclared);
    Reflect.deleteProperty(undeclared, "idDomain");
    const error = await createTsfga(undeclared)
      .addTuple({
        objectType: "doc",
        objectId: UUID,
        relation: "both",
        subjectType: "user",
        subjectId: UUID,
      })
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(IdDomainError);
    if (error instanceof IdDomainError) {
      expect(error.detail).toBe("store declares no id domain");
    }
  });

  test("the check path refuses rather than answering false", async () => {
    // Upstream returns HTTP 400 for every id it cannot represent
    // and never answers `false`. A silent deny is
    // indistinguishable from a real one.
    const error = await check(store, {
      objectType: "doc",
      objectId: UUID,
      relation: "both",
      subjectType: "user",
      subjectId: "alice",
    }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(IdDomainError);
  });

  test("removeTuple refuses too", async () => {
    const error = await fga
      .removeTuple({
        objectType: "doc",
        objectId: UUID,
        relation: "both",
        subjectType: "user",
        subjectId: "alice",
      })
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(IdDomainError);
  });

  test("listSubjects refuses on the object id", async () => {
    const error = await fga
      .listSubjects("doc", "readme.md", "both")
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(IdDomainError);
  });
});

/**
 * The delete gate, which is not the write gate narrowed.
 *
 * Upstream validates a delete with one `IsValidUser` call over
 * the rendered subject plus the protobuf field bounds, and runs
 * **no** model validation: it reads no config, so an undefined
 * relation, an undefined type and an unadmitted subject type all
 * fall through to "the tuple does not exist".
 *
 * Pinned two-sided in `tests/conformance/delete-gate.test.ts`,
 * where the fall-through half is asserted against the container.
 * Here: which rule fires, and that the gate reads nothing.
 */
describe("removeTuple validates as upstream validates a delete", () => {
  let store: MockTupleStore;
  let fga: TsfgaClient;

  beforeEach(() => {
    store = new MockTupleStore();
    seed(store);
    fga = createTsfga(store);
  });

  const target = (overrides: Record<string, unknown>) => ({
    objectType: "doc",
    objectId: "1",
    relation: "both",
    subjectType: "user",
    subjectId: "alice",
    ...overrides,
  });

  /** The rule that refused, or the store's answer. */
  async function ruleFor(request: Parameters<typeof fga.removeTuple>[0]) {
    try {
      await fga.removeTuple(request);
      return "accepted";
    } catch (error) {
      if (!(error instanceof TsfgaError)) throw error;
      return error.ruleId ?? "unnamed";
    }
  }

  test("a malformed subject is refused", async () => {
    expect(await ruleFor(target({ subjectId: "al ice" }))).toBe(
      "DELETE-SUBJECT-MALFORMED",
    );
  });

  test("a wildcard carrying a subject relation is refused", async () => {
    expect(
      await ruleFor(target({ subjectId: "*", subjectRelation: "member" })),
    ).toBe("DELETE-SUBJECT-MALFORMED");
  });

  test("the rendered subject is bounded at 512 bytes", async () => {
    expect(await ruleFor(target({ subjectId: "a".repeat(507) }))).toBe(
      "DELETE-TUPLE-MISSING",
    );
    expect(await ruleFor(target({ subjectId: "a".repeat(508) }))).toBe(
      "DELETE-SUBJECT-TOO-LONG",
    );
  });

  test("the rendered object is bounded at 256 code points", async () => {
    expect(
      await ruleFor(
        target({ objectType: "t".repeat(219), objectId: "o".repeat(36) }),
      ),
    ).toBe("DELETE-TUPLE-MISSING");
    expect(
      await ruleFor(
        target({ objectType: "t".repeat(220), objectId: "o".repeat(36) }),
      ),
    ).toBe("DELETE-OBJECT-MALFORMED");
  });

  test("a relation past the pattern is refused", async () => {
    expect(await ruleFor(target({ relation: "v".repeat(51) }))).toBe(
      "DELETE-RELATION-MALFORMED",
    );
    expect(await ruleFor(target({ relation: "vie wer" }))).toBe(
      "DELETE-RELATION-MALFORMED",
    );
  });

  test("an empty relation is not matched against the pattern", async () => {
    expect(await ruleFor(target({ relation: "" }))).toBe(
      "DELETE-TUPLE-MISSING",
    );
  });

  test("a userset subject id is legal here and not on a write", async () => {
    // `IsValidUser` is a union, and `user:a#b` satisfies its
    // userset arm. The write path runs `IsValidUserID` on the id
    // alone and refuses the `#`.
    expect(await ruleFor(target({ subjectId: "a#b" }))).toBe(
      "DELETE-TUPLE-MISSING",
    );
  });

  test("a malformed subject beats a missing row", async () => {
    expect(
      await ruleFor(
        target({
          objectType: "nosuchtype",
          relation: "nosuchrel",
          subjectId: "al ice",
        }),
      ),
    ).toBe("DELETE-SUBJECT-MALFORMED");
  });

  test("the gate reads nothing at all", async () => {
    // No relation config, no condition definition. Upstream's
    // delete validation is `IsValidUser` and a `TODO`; a gate that
    // read the model would refuse deletes upstream performs and
    // would make a dropped relation unrecoverable.
    const before = store.calls.length;
    await ruleFor(target({ relation: "nosuchrel" }));
    const methods = store.calls.slice(before).map((each) => each.method);
    expect(methods.join(",")).toBe("deleteTuple");
  });
});

/**
 * `TupleKey.object`'s protovalidate pattern is `^[^\s]{2,256}$`,
 * and the `\s` in it is Go's RE2 class — `[\t\n\f\r ]`, five
 * characters. JavaScript's `\s` is the Unicode space property,
 * which is wider, and borrowing it here refused a delete for an
 * object id the write and check paths both accept: the row was
 * writable, resolved `true`, and had no library path that removed
 * it.
 */
describe("a delete borrows Go's whitespace class, not JavaScript's", () => {
  function client(): TsfgaClient {
    const store = new MockTupleStore();
    store.relationConfigs.push({
      objectType: "doc",
      relation: "viewer",
      directlyAssignable: [{ type: "user" }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    return createTsfga(store);
  }

  // A no-break space, a line separator and an ideographic space:
  // Unicode space characters, and ordinary id characters to RE2.
  for (const [name, char] of [
    ["U+00A0", " "],
    ["U+2028", " "],
    ["U+3000", "　"],
  ] as const) {
    test(`${name} in an object id survives the round trip`, async () => {
      const c = client();
      const key = {
        objectType: "doc",
        objectId: `d${char}1`,
        relation: "viewer",
        subjectType: "user",
        subjectId: "alice",
      };
      await c.addTuple(key);
      expect(await c.check(key)).toBe(true);
      await c.removeTuple(key);
      expect(await c.check(key)).toBe(false);
    });
  }

  // And the five characters that *are* in the class must still
  // refuse, so the fix cannot be read as dropping the rule.
  for (const [name, char] of [
    ["tab", "\t"],
    ["newline", "\n"],
    ["form feed", "\f"],
    ["carriage return", "\r"],
    ["space", " "],
  ] as const) {
    test(`${name} in an object id still refuses a delete`, async () => {
      await expect(
        client().removeTuple({
          objectType: "doc",
          objectId: `d${char}1`,
          relation: "viewer",
          subjectType: "user",
          subjectId: "alice",
        }),
      ).rejects.toBeInstanceOf(InvalidObjectError);
    });
  }
});
