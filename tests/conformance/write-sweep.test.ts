import { afterAll, beforeAll, describe, test } from "bun:test";
import type { WriteAuthorizationModelRequest } from "@openfga/sdk";
import { TypeName } from "@openfga/sdk";
import {
  type AddTupleRequest,
  type ConditionDefinition,
  createTsfga,
  type RelationConfig,
  type TsfgaClient,
  type WriteRuleId,
} from "@tsfga/core";
import type { DB } from "@tsfga/kysely";
import { KyselyTupleStore } from "@tsfga/kysely";
import type { Kysely } from "kysely";
import {
  expectDeleteConformance,
  expectPinnedDeleteDivergence,
  expectWriteConformance,
  expectWriteConformanceWithCause,
} from "./helpers/conformance.ts";
import {
  beginTransaction,
  destroyDb,
  getDb,
  rollbackTransaction,
} from "./helpers/db.ts";
import { fgaCreateStore, fgaWriteModelJson } from "./helpers/openfga.ts";

/**
 * One dimension at a time, over one fixed base tuple and one
 * fixed base config.
 *
 * The rest of this suite exercises the write gate through models
 * that mean something. This one exercises it as a matrix: vary
 * the subject, then only the object, then only the relation, then
 * only the condition, then the sequence of writes, then replay
 * the lot through `removeTuple`. It samples the rule *bodies*
 * along dimensions no realistic fixture covers, which is the
 * largest residual risk in a write gate — a rule can carry the
 * right name, biject to the right upstream cause, and check the
 * wrong thing.
 *
 * Deterministic and fully enumerated: no seed, no shrinker, no
 * nightly tier. A property test that runs different cases on
 * different days is a test whose failures cannot be reproduced by
 * the person who reads them.
 *
 * **Where a `ruleId` is pinned and where it is not.** Every case
 * asserts parity. A case whose defect lives *outside* the
 * identifier additionally pins which tsfga rule fired, which is
 * the only way rule precedence is observable. A case whose defect
 * **is** the identifier does not: a rule gating the id domain
 * would run ahead of all of them, and pinning there would pin a
 * decision about where such a rule belongs rather than upstream's
 * order.
 *
 * **No condition here uses a regular expression.** `matches()` is
 * not supported, and a fixture reaching for it would be refused
 * at the model write for a reason that is not the reason under
 * test.
 */

const USER = "user_e1s";
const TEAM = "team_e1s";
const DOC = "doc_e1s";
const CONDITION = "in_window_e1s";
const BELL = "";

/**
 * The fixture's well-formed ids, now that `@tsfga/kysely` holds
 * canonical UUIDs and nothing else.
 *
 * Substitution is safe here and only here: every one of these
 * appears in a case whose defect lives *outside* the identifier,
 * so nothing about the case changes. The cases whose defect **is**
 * the identifier keep their malformed literals -- a `:` or a `#`
 * or an empty string cannot be written as a UUID at all, and
 * rewriting them would leave the assertion vacuously true.
 */
const ALICE = "00000000-0000-4000-e120-000000000001";
const TEAM1 = "00000000-0000-4000-e120-000000000002";
const DOC0 = "00000000-0000-4000-e120-000000000003";

const MODEL: WriteAuthorizationModelRequest = {
  schema_version: "1.1",
  type_definitions: [
    { type: USER, relations: {}, metadata: { relations: {} } },
    {
      type: TEAM,
      relations: { member: { this: {} } },
      metadata: {
        relations: {
          member: { directly_related_user_types: [{ type: USER }] },
        },
      },
    },
    {
      type: DOC,
      relations: {
        bare: { this: {} },
        wild: { this: {} },
        userset: { this: {} },
        cond: { this: {} },
        computed: { computedUserset: { relation: "bare" } },
      },
      metadata: {
        relations: {
          bare: { directly_related_user_types: [{ type: USER }] },
          wild: {
            directly_related_user_types: [{ type: USER, wildcard: {} }],
          },
          userset: {
            directly_related_user_types: [{ type: TEAM, relation: "member" }],
          },
          cond: {
            directly_related_user_types: [{ type: USER, condition: CONDITION }],
          },
          computed: { directly_related_user_types: [] },
        },
      },
    },
  ],
  conditions: {
    [CONDITION]: {
      name: CONDITION,
      expression: "n > 0",
      // `s` is declared and unused: the byte-limit case needs a
      // *declared* key big enough to cross 32 KiB, and an
      // undeclared one is refused by an earlier rule.
      parameters: {
        n: { type_name: TypeName.Int },
        s: { type_name: TypeName.String },
      },
    },
  },
};

const CONDITIONS: ConditionDefinition[] = [
  {
    name: CONDITION,
    expression: "n > 0",
    parameters: { n: "int", s: "string" },
  },
];

const plain = {
  impliedBy: null,
  computedUserset: null,
  tupleToUserset: null,
  excludedBy: null,
  intersection: null,
} as const;

const CONFIGS: RelationConfig[] = [
  {
    objectType: TEAM,
    relation: "member",
    directlyAssignable: [{ type: USER }],
    ...plain,
  },
  {
    objectType: DOC,
    relation: "bare",
    directlyAssignable: [{ type: USER }],
    ...plain,
  },
  {
    objectType: DOC,
    relation: "wild",
    directlyAssignable: [{ type: USER, wildcard: true }],
    ...plain,
  },
  {
    objectType: DOC,
    relation: "userset",
    directlyAssignable: [{ type: TEAM, relation: "member" }],
    ...plain,
  },
  {
    objectType: DOC,
    relation: "cond",
    directlyAssignable: [{ type: USER, condition: CONDITION }],
    ...plain,
  },
  {
    objectType: DOC,
    relation: "computed",
    directlyAssignable: [],
    ...plain,
    computedUserset: "bare",
  },
];

describe("Write sweep conformance", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let modelId: string;
  let tsfga: TsfgaClient;
  let counter = 0;

  beforeAll(async () => {
    db = getDb();
    await beginTransaction(db);
    tsfga = createTsfga(new KyselyTupleStore(db));
    storeId = await fgaCreateStore("write-sweep");
    modelId = await fgaWriteModelJson(storeId, MODEL);
    for (const condition of CONDITIONS) {
      await tsfga.writeConditionDefinition(condition);
    }
    for (const config of CONFIGS) {
      await tsfga.writeRelationConfig(config);
    }
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  /**
   * A fresh object id per case.
   *
   * Every case writes to its own object, so no case can be
   * decided by a row another case left behind -- and the
   * duplicate dimension, which is the one case that *depends* on
   * a row being there, writes both of them itself.
   */
  function base(overrides: Partial<AddTupleRequest> = {}): AddTupleRequest {
    counter += 1;
    return {
      objectType: DOC,
      objectId: `00000000-0000-4000-e120-1${String(counter).padStart(11, "0")}`,
      relation: "bare",
      subjectType: USER,
      subjectId: ALICE,
      ...overrides,
    };
  }

  /** Parity only -- for a case whose defect is the identifier. */
  async function parity(
    tuple: AddTupleRequest,
    expected: "accepted" | "refused",
  ): Promise<void> {
    await expectWriteConformance(storeId, modelId, tsfga, tuple, expected);
  }

  /** Parity, plus which rule fired. */
  async function ruled(
    tuple: AddTupleRequest,
    expected: "accepted" | "refused",
    rule: WriteRuleId,
  ): Promise<void> {
    await expectWriteConformanceWithCause(
      storeId,
      modelId,
      tsfga,
      tuple,
      expected,
      { tsfga: rule },
    );
  }

  describe("1: the subject", () => {
    test("a concrete subject the relation admits", async () => {
      await parity(base(), "accepted");
    });

    test("the wildcard where it is admitted", async () => {
      await parity(base({ relation: "wild", subjectId: "*" }), "accepted");
    });

    test("a userset where it is admitted", async () => {
      await parity(
        base({
          relation: "userset",
          subjectType: TEAM,
          subjectId: TEAM1,
          subjectRelation: "member",
        }),
        "accepted",
      );
    });

    test("a concrete subject where only the wildcard is admitted", async () => {
      await ruled(
        base({ relation: "wild" }),
        "refused",
        "TUPLE-SUBJECT-NOT-ADMITTED",
      );
    });

    test("the wildcard where only the bare type is admitted", async () => {
      await ruled(
        base({ subjectId: "*" }),
        "refused",
        "TUPLE-SUBJECT-NOT-ADMITTED",
      );
    });

    test("a userset where only a concrete subject is admitted", async () => {
      await ruled(
        base({
          subjectType: TEAM,
          subjectId: TEAM1,
          subjectRelation: "member",
        }),
        "refused",
        "TUPLE-SUBJECT-NOT-ADMITTED",
      );
    });

    test("a subject type the model does not define", async () => {
      await ruled(
        base({ subjectType: "ghost_e1s" }),
        "refused",
        "TUPLE-SUBJECT-NOT-ADMITTED",
      );
    });

    test("a userset naming a relation the subject type lacks", async () => {
      await ruled(
        base({
          relation: "userset",
          subjectType: TEAM,
          subjectId: TEAM1,
          subjectRelation: "ghost",
        }),
        "refused",
        "TUPLE-SUBJECT-NOT-ADMITTED",
      );
    });

    test("a wildcard carrying a subject relation", async () => {
      await parity(
        base({ relation: "wild", subjectId: "*", subjectRelation: "member" }),
        "refused",
      );
    });

    test("a subject id holding a colon", async () => {
      await parity(base({ subjectId: "a:b" }), "refused");
    });

    test("a subject id holding a hash", async () => {
      await parity(base({ subjectId: "a#b" }), "refused");
    });

    test("a subject id holding a space", async () => {
      await parity(base({ subjectId: "a b" }), "refused");
    });

    test("a subject id holding a control character", async () => {
      await parity(base({ subjectId: `a${BELL}b` }), "refused");
    });

    test("an empty subject id", async () => {
      await parity(base({ subjectId: "" }), "refused");
    });

    test("a rendered subject of 513 bytes", async () => {
      await parity(
        base({ subjectId: "a".repeat(513 - USER.length - 1) }),
        "refused",
      );
    });

    // The 512-byte subject that upstream *accepts* is gone, and it
    // does not become a pin. It cannot be expressed at all under
    // this store's id domain -- the longest subject a canonical
    // UUID can render is `user_e1s:` plus 36 characters, 45 bytes
    // -- so a pin would record tsfga refusing a non-UUID id for a
    // reason that has nothing to do with the bound, which is a
    // claim about the wrong rule. The bound is asserted at the
    // core level, against the mock store, in
    // `packages/core/tests/tuple-validation.test.ts`. The 513-byte
    // row above survives: upstream's own length rule runs ahead of
    // the domain gate, so it still refuses for the reason named.
  });

  describe("2: the object", () => {
    test("an object id that is a typed wildcard", async () => {
      await parity(base({ objectId: "*" }), "refused");
    });

    test("an object id holding a colon", async () => {
      await parity(base({ objectId: "a:b" }), "refused");
    });

    test("an object id holding a hash", async () => {
      await parity(base({ objectId: "a#b" }), "refused");
    });

    test("an object id holding a space", async () => {
      await parity(base({ objectId: "a b" }), "refused");
    });

    test("an object id holding a control character", async () => {
      await parity(base({ objectId: `a${BELL}b` }), "refused");
    });

    test("an empty object id", async () => {
      await parity(base({ objectId: "" }), "refused");
    });

    test("a rendered object of 257 runes", async () => {
      await parity(
        base({ objectId: "o".repeat(257 - DOC.length - 1) }),
        "refused",
      );
    });

    // Retired for the same reason as the 512-byte subject, with
    // one extra: the delete fixture keeps its 256-rune row by
    // moving the length into the *type* name, and a write cannot
    // do that -- upstream validates the model on a write, so a
    // 219-character type is refused for being undefined. Asserted
    // at the core level instead.

    test("an object type the model does not define", async () => {
      await ruled(
        base({ objectType: "ghost_e1s" }),
        "refused",
        "TUPLE-RELATION-UNDEFINED",
      );
    });
  });

  describe("3: the relation", () => {
    test("a relation the model does not define", async () => {
      await ruled(
        base({ relation: "ghost" }),
        "refused",
        "TUPLE-RELATION-UNDEFINED",
      );
    });

    test("the reserved name 'self'", async () => {
      await ruled(
        base({ relation: "self" }),
        "refused",
        "TUPLE-RELATION-UNDEFINED",
      );
    });

    test("the reserved name 'this'", async () => {
      await ruled(
        base({ relation: "this" }),
        "refused",
        "TUPLE-RELATION-UNDEFINED",
      );
    });

    test("a relation holding an at sign", async () => {
      await ruled(
        base({ relation: "a@b" }),
        "refused",
        "TUPLE-RELATION-UNDEFINED",
      );
    });

    test("a relation of 51 characters", async () => {
      await ruled(
        base({ relation: "v".repeat(51) }),
        "refused",
        "TUPLE-RELATION-UNDEFINED",
      );
    });

    test("a relation that rewrites admits no direct write", async () => {
      await ruled(
        base({ relation: "computed" }),
        "refused",
        "TUPLE-SUBJECT-NOT-ADMITTED",
      );
    });
  });

  describe("4: the condition", () => {
    test("the condition the restriction names", async () => {
      await parity(
        base({
          relation: "cond",
          conditionName: CONDITION,
          conditionContext: { n: 1 },
        }),
        "accepted",
      );
    });

    test("no condition where the restriction requires one", async () => {
      await ruled(
        base({ relation: "cond" }),
        "refused",
        "TUPLE-CONDITION-MISSING",
      );
    });

    test("a condition where the restriction names none", async () => {
      await ruled(
        base({ conditionName: CONDITION, conditionContext: { n: 1 } }),
        "refused",
        "TUPLE-CONDITION-NOT-ADMITTED",
      );
    });

    test("a condition the store does not define", async () => {
      await ruled(
        base({ relation: "cond", conditionName: "ghost_e1s" }),
        "refused",
        "TUPLE-CONDITION-UNDEFINED",
      );
    });

    test("a control character in the condition name", async () => {
      await ruled(
        base({ relation: "cond", conditionName: `a${BELL}b` }),
        "refused",
        "TUPLE-CONDITION-NAME-FORBIDDEN-CHARS",
      );
    });

    test("a control character in a context key", async () => {
      await ruled(
        base({
          relation: "cond",
          conditionName: CONDITION,
          conditionContext: { [`n${BELL}`]: 1 },
        }),
        "refused",
        "TUPLE-CONTEXT-FORBIDDEN-CHARS",
      );
    });

    test("a control character in a context value", async () => {
      await ruled(
        base({
          relation: "cond",
          conditionName: CONDITION,
          conditionContext: { n: `1${BELL}` },
        }),
        "refused",
        "TUPLE-CONTEXT-FORBIDDEN-CHARS",
      );
    });

    test("a context key the condition does not declare", async () => {
      await ruled(
        base({
          relation: "cond",
          conditionName: CONDITION,
          conditionContext: { n: 1, stray: 2 },
        }),
        "refused",
        "TUPLE-CONTEXT-PARAMETER-UNDECLARED",
      );
    });

    test("a context value of the wrong type", async () => {
      await ruled(
        base({
          relation: "cond",
          conditionName: CONDITION,
          conditionContext: { n: true },
        }),
        "refused",
        "TUPLE-CONTEXT-PARAMETER-TYPE",
      );
    });

    test("a partial context is accepted", async () => {
      // The rest can still arrive with the check request, which is
      // upstream's rule and the one a stricter gate would break.
      await parity(
        base({ relation: "cond", conditionName: CONDITION }),
        "accepted",
      );
    });

    test("a context over the byte limit", async () => {
      await ruled(
        base({
          relation: "cond",
          conditionName: CONDITION,
          conditionContext: { n: 1, s: "x".repeat(33 * 1024) },
        }),
        "refused",
        "TUPLE-CONTEXT-TOO-LARGE",
      );
    });
  });

  describe("5: the sequence", () => {
    test("the same edge twice", async () => {
      const tuple = base();
      await parity(tuple, "accepted");
      await ruled(tuple, "refused", "TUPLE-DUPLICATE");
    });

    test("the same edge differing only in its condition", async () => {
      // The natural key is `TupleKeyWithoutCondition`, so this is
      // a duplicate rather than an edit -- the one shape that
      // silently widened a live grant when the write was an
      // upsert.
      const tuple = base({
        relation: "cond",
        conditionName: CONDITION,
        conditionContext: { n: 1 },
      });
      await parity(tuple, "accepted");
      await ruled(
        { ...tuple, conditionContext: { n: 2 } },
        "refused",
        "TUPLE-DUPLICATE",
      );
    });

    test("a tuple that says only what the model says", async () => {
      await ruled(
        base({
          relation: "bare",
          subjectType: DOC,
          subjectId: DOC0,
          subjectRelation: "bare",
        }),
        "refused",
        "TUPLE-SUBJECT-NOT-ADMITTED",
      );
    });
  });

  describe("6: the same shapes replayed through removeTuple", () => {
    test("a malformed subject", async () => {
      await expectDeleteConformance(
        storeId,
        modelId,
        tsfga,
        base({ subjectId: "a b" }),
        "refused",
      );
    });

    test("a wildcard carrying a subject relation", async () => {
      await expectDeleteConformance(
        storeId,
        modelId,
        tsfga,
        base({ subjectId: "*", subjectRelation: "member" }),
        "refused",
      );
    });

    test("an object id holding a colon is refused by the id domain", async () => {
      // The guard this row carries is that the delete gate is not
      // the write gate: upstream reaches the row for an object id
      // a write refuses. tsfga still does not reuse the write
      // validators here -- it refuses one rule later, on the id
      // domain, because `a:b` is not a UUID and this store holds
      // nothing else. Pinned rather than deleted so the guard
      // survives as a two-sided assertion, and so the day either
      // engine moves, a test says so.
      await expectPinnedDeleteDivergence(
        storeId,
        modelId,
        tsfga,
        base({ objectId: "a:b" }),
        { openfga: "missing", tsfga: "refused" },
      );
    });

    test("a relation the model does not define falls through", async () => {
      await expectDeleteConformance(
        storeId,
        modelId,
        tsfga,
        base({ relation: "ghost" }),
        "missing",
      );
    });

    test("a row that is there is deleted", async () => {
      const tuple = base();
      await parity(tuple, "accepted");
      await expectDeleteConformance(storeId, modelId, tsfga, tuple, "accepted");
    });
  });
});
