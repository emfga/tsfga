import { beforeEach, describe, expect, test } from "bun:test";
import {
  ImplicitTupleError,
  InvalidRelationConfigError,
} from "../src/errors.ts";
import { createTsfga, type TsfgaClient } from "../src/index.ts";
import type { ConditionDefinition, RelationConfig } from "../src/types.ts";
import { MockTupleStore } from "./helpers/mock-store.ts";

/**
 * The write gates for shapes OpenFGA's typesystem refuses.
 *
 * Pinned two-sided in
 * `tests/conformance/config-validation.test.ts`. Here the same
 * rules are exercised against the mock, plus the two things the
 * conformance suite cannot say: the error class each refusal
 * raises, and that the self-reference gate is on `addTuple` and
 * **not** on the shared validation contextual tuples run.
 */

function config(overrides: Partial<RelationConfig>): RelationConfig {
  return {
    objectType: "doc",
    relation: "viewer",
    directlyAssignable: [],
    impliedBy: null,
    computedUserset: null,
    tupleToUserset: null,
    excludedBy: null,
    intersection: null,
    ...overrides,
  };
}

describe("writeRelationConfig refuses what the model would", () => {
  let store: MockTupleStore;
  let fga: TsfgaClient;

  beforeEach(() => {
    store = new MockTupleStore();
    fga = createTsfga(store);
  });

  test("an intersection with one operand", async () => {
    await expect(
      fga.writeRelationConfig(
        config({ intersection: [{ type: "computedUserset", relation: "a" }] }),
      ),
    ).rejects.toBeInstanceOf(InvalidRelationConfigError);
  });

  test("an intersection with no operands", async () => {
    await expect(
      fga.writeRelationConfig(config({ intersection: [] })),
    ).rejects.toBeInstanceOf(InvalidRelationConfigError);
  });

  test("the control: two operands are accepted", async () => {
    await expect(
      fga.writeRelationConfig(
        config({
          intersection: [
            { type: "computedUserset", relation: "a" },
            { type: "computedUserset", relation: "b" },
          ],
        }),
      ),
    ).resolves.toBeUndefined();
  });

  test("a restriction naming an undefined condition", async () => {
    await expect(
      fga.writeRelationConfig(
        config({ directlyAssignable: [{ type: "user", condition: "nope" }] }),
      ),
    ).rejects.toBeInstanceOf(InvalidRelationConfigError);
  });

  test("the control: a defined condition is accepted", async () => {
    await fga.writeConditionDefinition({
      name: "yep",
      expression: "true",
      parameters: {},
    });
    await expect(
      fga.writeRelationConfig(
        config({ directlyAssignable: [{ type: "user", condition: "yep" }] }),
      ),
    ).resolves.toBeUndefined();
  });

  describe("a tupleset relation that admits too much", () => {
    /** The tupleset relation is written first, or there is nothing
     * to read — see the stated gap below. */
    async function writeParent(
      directlyAssignable: RelationConfig["directlyAssignable"],
    ): Promise<void> {
      await fga.writeRelationConfig(
        config({ relation: "parent", directlyAssignable }),
      );
    }

    const ttu = config({
      tupleToUserset: [{ tupleset: "parent", computedUserset: "viewer" }],
    });

    test("a userset ref", async () => {
      await writeParent([{ type: "folder", relation: "owner" }]);
      await expect(fga.writeRelationConfig(ttu)).rejects.toBeInstanceOf(
        InvalidRelationConfigError,
      );
    });

    test("a wildcard ref", async () => {
      await writeParent([{ type: "folder", wildcard: true }]);
      await expect(fga.writeRelationConfig(ttu)).rejects.toBeInstanceOf(
        InvalidRelationConfigError,
      );
    });

    test("the control: a bare type is accepted", async () => {
      await writeParent([{ type: "folder" }]);
      await expect(fga.writeRelationConfig(ttu)).resolves.toBeUndefined();
    });

    test("an intersection operand's tupleset is checked too", async () => {
      // The operand form is the one a fix applied to step 5 alone
      // would leave open, and it is the worse of the two: inside
      // the subtrahend of an exclusion it grants rather than denies.
      await writeParent([{ type: "folder", relation: "owner" }]);
      await expect(
        fga.writeRelationConfig(
          config({
            intersection: [
              { type: "computedUserset", relation: "a" },
              {
                type: "tupleToUserset",
                tupleset: "parent",
                computedUserset: "viewer",
              },
            ],
          }),
        ),
      ).rejects.toBeInstanceOf(InvalidRelationConfigError);
    });

    test("the stated gap: no config to read, no check", async () => {
      // Declared before its tupleset relation exists. Accepted,
      // deliberately: closing this needs a reverse lookup TupleStore
      // has not got, and a validator that fired on write order would
      // refuse correct models for arriving in an undocumented order.
      await expect(fga.writeRelationConfig(ttu)).resolves.toBeUndefined();
      await expect(
        writeParent([{ type: "folder", relation: "owner" }]),
      ).resolves.toBeUndefined();
    });
  });
});

/**
 * The two rules that finish the single-config gate.
 *
 * `self` and `this` are reserved as a type name and as a relation
 * name, and a rewrite on the same object may not name the relation
 * it defines. Both are pinned two-sided against the container in
 * `tests/conformance/model-gate-rules.test.ts`; here are the cause
 * each raises and — the part no conformance cell can state,
 * because it asserts an *absence* — the shapes each rule must go
 * on accepting.
 */
describe("the model's own names are reserved", () => {
  let fga: TsfgaClient;

  beforeEach(() => {
    fga = createTsfga(new MockTupleStore());
  });

  async function refusal(
    relationConfig: RelationConfig,
  ): Promise<InvalidRelationConfigError> {
    try {
      await fga.writeRelationConfig(relationConfig);
    } catch (error) {
      if (error instanceof InvalidRelationConfigError) return error;
      throw error;
    }
    throw new Error("expected a refusal");
  }

  test("as an object type name", async () => {
    for (const reserved of ["self", "this"]) {
      const error = await refusal(
        config({
          objectType: reserved,
          directlyAssignable: [{ type: "user" }],
        }),
      );
      expect(error.cause).toBe("reserved keyword");
      expect(error.objectType).toBe(reserved);
    }
  });

  test("as a relation name", async () => {
    for (const reserved of ["self", "this"]) {
      const error = await refusal(
        config({ relation: reserved, directlyAssignable: [{ type: "user" }] }),
      );
      expect(error.cause).toBe("reserved keyword");
      expect(error.relation).toBe(reserved);
    }
  });

  test("the rule is on the whole name, not a prefix", async () => {
    // `write-gate` defines `self_a`, and `myself` / `thistle`
    // are ordinary names upstream stores.
    for (const ordinary of ["self_a", "myself", "this_1", "thistle"]) {
      await fga.writeRelationConfig(
        config({ relation: ordinary, directlyAssignable: [{ type: "user" }] }),
      );
    }
  });

  test("a condition named 'self' is still stored", async () => {
    // `validateNames` walks type definitions and relation keys and
    // looks at nothing else. v1.18.2 stores this, measured — so a
    // pass that "unifies" the two name gates is a regression.
    for (const name of ["self", "this"]) {
      await fga.writeConditionDefinition({
        name,
        expression: "true",
        parameters: {},
      });
    }
  });
});

describe("a rewrite may not name its own relation", () => {
  let fga: TsfgaClient;

  beforeEach(() => {
    fga = createTsfga(new MockTupleStore());
  });

  async function refusal(
    relationConfig: RelationConfig,
  ): Promise<InvalidRelationConfigError> {
    try {
      await fga.writeRelationConfig(relationConfig);
    } catch (error) {
      if (error instanceof InvalidRelationConfigError) return error;
      throw error;
    }
    throw new Error("expected a refusal");
  }

  test("all four positions a computed userset can sit in", async () => {
    const positions: Array<Partial<RelationConfig>> = [
      // `viewer: viewer`
      { computedUserset: "viewer" },
      // `viewer: [user] or viewer`
      { directlyAssignable: [{ type: "user" }], impliedBy: ["viewer"] },
      // `viewer: [user] and viewer`
      {
        directlyAssignable: [{ type: "user" }],
        intersection: [
          { type: "direct" },
          { type: "computedUserset", relation: "viewer" },
        ],
      },
      // `viewer: [user] but not viewer`
      { directlyAssignable: [{ type: "user" }], excludedBy: "viewer" },
    ];
    for (const position of positions) {
      const error = await refusal(config(position));
      expect(error.cause).toBe("rewrite names its own relation");
    }
  });

  /**
   * The guard the rule exists around.
   *
   * `viewer: [user] or viewer from parent` names this relation on
   * **another** object and is upstream's single most common model
   * shape — `gcloud`, `oncall`, `market`,
   * `nested-folders`, `recursive-relations`, `recursion-depth-boundary` and
   * `snowflake` all lean on it. A predicate that reached
   * `tupleToUserset` would take out roughly 150 assertions and
   * refuse models the container stores.
   */
  test("a self-recursive tuple-to-userset is accepted", async () => {
    await fga.writeRelationConfig(
      config({ relation: "parent", directlyAssignable: [{ type: "doc" }] }),
    );
    await fga.writeRelationConfig(
      config({
        directlyAssignable: [{ type: "user" }],
        tupleToUserset: [{ tupleset: "parent", computedUserset: "viewer" }],
      }),
    );
  });

  test("so is one reached through an intersection operand", async () => {
    await fga.writeRelationConfig(
      config({ relation: "parent", directlyAssignable: [{ type: "doc" }] }),
    );
    await fga.writeRelationConfig(
      config({
        directlyAssignable: [{ type: "user" }],
        intersection: [
          { type: "direct" },
          {
            type: "tupleToUserset",
            tupleset: "parent",
            computedUserset: "viewer",
          },
        ],
      }),
    );
  });

  test("naming a different relation is what these arms are for", async () => {
    await fga.writeRelationConfig(
      config({
        directlyAssignable: [{ type: "user" }],
        impliedBy: ["editor"],
        excludedBy: "banned",
      }),
    );
    await fga.writeRelationConfig(
      config({ relation: "editor", computedUserset: "owner" }),
    );
  });
});

describe("addTuple refuses a tuple that is implicit", () => {
  let store: MockTupleStore;
  let fga: TsfgaClient;

  beforeEach(async () => {
    store = new MockTupleStore();
    fga = createTsfga(store);
    await fga.writeRelationConfig(
      config({
        relation: "blocked",
        directlyAssignable: [
          { type: "user" },
          { type: "doc", relation: "blocked" },
        ],
      }),
    );
  });

  const selfTuple = {
    objectType: "doc",
    objectId: "1",
    relation: "blocked",
    subjectType: "doc",
    subjectId: "1",
    subjectRelation: "blocked",
  };

  test("the write is refused", async () => {
    await expect(fga.addTuple(selfTuple)).rejects.toBeInstanceOf(
      ImplicitTupleError,
    );
  });

  test("a different object of the same relation is accepted", async () => {
    await expect(
      fga.addTuple({ ...selfTuple, subjectId: "2" }),
    ).resolves.toBeUndefined();
  });

  test("a different relation on the same object is accepted", async () => {
    await fga.writeRelationConfig(
      config({
        relation: "member",
        directlyAssignable: [{ type: "doc", relation: "blocked" }],
      }),
    );
    await expect(
      fga.addTuple({ ...selfTuple, relation: "member" }),
    ).resolves.toBeUndefined();
  });

  /**
   * The asymmetry, and the reason the gate is not in
   * `validateTupleWrite`. Upstream refuses the write and accepts
   * the same tuple contextually — measured on v1.18.2 with a
   * control proving the contextual field was honoured — so sharing
   * the gate would refuse a tuple OpenFGA takes.
   */
  test("the same tuple is accepted contextually", async () => {
    store.tuples.push({
      objectType: "doc",
      objectId: "1",
      relation: "blocked",
      subjectType: "user",
      subjectId: "alice",
      subjectRelation: null,
      conditionName: null,
      conditionContext: null,
    });
    expect(
      await fga.check({
        objectType: "doc",
        objectId: "1",
        relation: "blocked",
        subjectType: "user",
        subjectId: "alice",
        contextualTuples: [selfTuple],
      }),
    ).toBe(true);
  });
});

/**
 * The name gate on the *other* write path.
 *
 * A relation config's own names were gated first; a condition
 * definition carries two more name fields under the same proto
 * pattern, `^[^:#@\s]{1,50}$` — its own name and every key of its
 * parameters. Both bounds are pinned two-sided against the
 * container in `tests/conformance/model-name-fields.test.ts`. Here: the
 * error class and its cause, which the conformance suite cannot
 * see, and the acceptances a rule one character too wide loses.
 */
describe("writeConditionDefinition gates both name fields", () => {
  let fga: TsfgaClient;

  beforeEach(() => {
    fga = createTsfga(new MockTupleStore());
  });

  function definition(name: string, parameter = "p"): ConditionDefinition {
    return { name, expression: "true", parameters: { [parameter]: "string" } };
  }

  async function refusal(
    condition: ConditionDefinition,
  ): Promise<InvalidRelationConfigError> {
    try {
      await fga.writeConditionDefinition(condition);
    } catch (error) {
      if (error instanceof InvalidRelationConfigError) return error;
      throw error;
    }
    throw new Error("expected a refusal");
  }

  test("a condition name holding a reserved character", async () => {
    for (const bad of ["bad:name", "bad#name", "bad@name", "bad name"]) {
      const error = await refusal(definition(bad));
      expect(error.cause).toBe("malformed condition name");
      // No object type and no relation to blame, so the message
      // names the condition instead.
      expect(error.objectType).toBeNull();
      expect(error.conditionName).toBe(bad);
    }
  });

  test("an empty condition name", async () => {
    const error = await refusal(definition(""));
    expect(error.cause).toBe("malformed condition name");
  });

  test("the bound is 50, and it counts code points", async () => {
    await fga.writeConditionDefinition(definition("c".repeat(50)));
    expect((await refusal(definition("c".repeat(51)))).cause).toBe(
      "malformed condition name",
    );
    // 50 astral code points are 100 UTF-16 units and 200 bytes.
    // Neither is the measure: a Go quantifier counts runes.
    await fga.writeConditionDefinition(definition("\u{1F600}".repeat(50)));
    expect((await refusal(definition("\u{1F600}".repeat(51)))).cause).toBe(
      "malformed condition name",
    );
  });

  test("a control character outside Go's five is accepted", async () => {
    // `\s` is `[\t\n\f\r ]` and nothing wider. Reusing the tuple
    // path's control-character rule here would refuse names
    // upstream stores.
    const accepted = ["\u000B", "\u0001", "\u007F", "\u0085", "\u00A0"];
    for (const ok of accepted) {
      await fga.writeConditionDefinition(definition(`c${ok}n`));
    }
  });

  test("every parameter key runs the same rule", async () => {
    const error = await refusal(definition("ok", "bad:p"));
    expect(error.cause).toBe("malformed condition parameter name");
    // The offending key, as upstream's `Condition.Parameters[…]`
    // names it.
    expect(error.message).toContain("bad:p");
    expect((await refusal(definition("ok", "p".repeat(51)))).cause).toBe(
      "malformed condition parameter name",
    );
    await fga.writeConditionDefinition(definition("ok", "p".repeat(50)));
  });

  test("the names are checked before the expression", async () => {
    // Both are defects, and upstream refuses on the name whatever
    // the expression says, so an uncompilable expression must not
    // decide which error the caller sees.
    const error = await refusal({
      name: "bad:name",
      expression: "((",
      parameters: {},
    });
    expect(error.cause).toBe("malformed condition name");
  });

  test("the control: an ordinary definition is stored", async () => {
    await fga.writeConditionDefinition(definition("weekday_only", "grantee"));
  });
});

describe("createTsfga validates writeContextByteLimit", () => {
  test("a nonsense limit is refused at construction", () => {
    // The fourth option, held to the rule the other three are.
    // `NaN` is the one that matters: it compares false against
    // every context size, so a caller who was setting a bound
    // silently removed it.
    for (const writeContextByteLimit of [Number.NaN, -1, 2.5]) {
      expect(() =>
        createTsfga(new MockTupleStore(), { writeContextByteLimit }),
      ).toThrow();
    }
  });

  test("zero and Infinity are limits, and both are taken", () => {
    // Non-negative, not positive: `0` refuses every conditioned
    // write, which is coherent where a `maxDepth` of `0` is not.
    for (const writeContextByteLimit of [0, Number.POSITIVE_INFINITY]) {
      createTsfga(new MockTupleStore(), { writeContextByteLimit });
    }
  });
});

/**
 * Which rule wins when a config carries two defects at once.
 *
 * The order in `validateRelationConfigWrite` is upstream's, and it
 * is observable in exactly the way `tuple-validation.test.ts`
 * describes: one refusal comes back, and which one says which rule
 * ran first. Five of the silent sites, one assertion each.
 */
describe("two config defects at once report the earlier rule", () => {
  let store: MockTupleStore;
  let fga: TsfgaClient;

  beforeEach(() => {
    store = new MockTupleStore();
    fga = createTsfga(store);
  });

  /** The rule that refused, or `"accepted"`. */
  async function ruleFor(written: Promise<unknown>): Promise<string> {
    try {
      await written;
      return "accepted";
    } catch (error) {
      if (!(error instanceof InvalidRelationConfigError)) throw error;
      return error.ruleId ?? "unnamed";
    }
  }

  test("the type name is judged before the relation name", async () => {
    expect(
      await ruleFor(
        fga.writeRelationConfig(
          config({ objectType: "do c", relation: "vie:wer" }),
        ),
      ),
    ).toBe("CONFIG-TYPE-NAME-MALFORMED");
  });

  test("a self-naming rewrite beats a short intersection", async () => {
    expect(
      await ruleFor(
        fga.writeRelationConfig(
          config({
            intersection: [{ type: "computedUserset", relation: "viewer" }],
          }),
        ),
      ),
    ).toBe("CONFIG-REWRITE-NAMES-ITSELF");
  });

  test("a short intersection beats admitting and rewriting nothing", async () => {
    expect(
      await ruleFor(fga.writeRelationConfig(config({ intersection: [] }))),
    ).toBe("CONFIG-INTERSECTION-TOO-FEW-OPERANDS");
  });

  test("a tupleset userset is reported before a tupleset wildcard", async () => {
    await fga.writeRelationConfig(
      config({
        relation: "parent",
        directlyAssignable: [
          { type: "folder", relation: "member", wildcard: true },
        ],
      }),
    );
    expect(
      await ruleFor(
        fga.writeRelationConfig(
          config({
            tupleToUserset: [{ tupleset: "parent", computedUserset: "viewer" }],
          }),
        ),
      ),
    ).toBe("CONFIG-TUPLESET-ADMITS-USERSET");
  });

  test("a condition name is judged before its parameter keys", async () => {
    expect(
      await ruleFor(
        fga.writeConditionDefinition({
          name: "bad name",
          expression: "true",
          parameters: { "bad:key": "string" },
        }),
      ),
    ).toBe("CONDITION-NAME-MALFORMED");
  });
});

/**
 * A rewrite cycle, which upstream refuses outright.
 *
 * The rule follows same-object-type rewrites only — every
 * `impliedBy` arm, the `computedUserset`, the `excludedBy` and
 * every `computedUserset` intersection operand — because
 * upstream's `hasCycle` returns `false` immediately on direct
 * assignment and on a tuple-to-userset. Following either would
 * refuse `viewer: viewer from parent`, which is the commonest
 * shape an OpenFGA model has.
 *
 * The two shapes below the cycles are the ones a wrong
 * implementation gets wrong: a diamond is not a cycle, and a
 * re-convergent graph must not be walked twice.
 */
describe("writeRelationConfig refuses a rewrite cycle", () => {
  let store: MockTupleStore;
  let fga: TsfgaClient;

  beforeEach(() => {
    store = new MockTupleStore();
    fga = createTsfga(store);
  });

  test("a two-relation cycle", async () => {
    await fga.writeRelationConfig(
      config({ relation: "a", computedUserset: "b" }),
    );
    await expect(
      fga.writeRelationConfig(config({ relation: "b", computedUserset: "a" })),
    ).rejects.toBeInstanceOf(InvalidRelationConfigError);
  });

  test("a three-relation cycle", async () => {
    await fga.writeRelationConfig(
      config({ relation: "a", computedUserset: "b" }),
    );
    await fga.writeRelationConfig(
      config({ relation: "b", computedUserset: "c" }),
    );
    await expect(
      fga.writeRelationConfig(config({ relation: "c", computedUserset: "a" })),
    ).rejects.toBeInstanceOf(InvalidRelationConfigError);
  });

  test("the cause names the cycle", async () => {
    await fga.writeRelationConfig(
      config({ relation: "a", computedUserset: "b" }),
    );
    try {
      await fga.writeRelationConfig(
        config({ relation: "b", computedUserset: "a" }),
      );
      throw new Error("expected a refusal");
    } catch (error) {
      if (!(error instanceof InvalidRelationConfigError)) throw error;
      expect(error.cause).toBe("rewrite cycle");
      expect(error.ruleId).toBe("CONFIG-REWRITE-CYCLE");
    }
  });

  test("a union arm closing the loop is a cycle too", async () => {
    // The realistic shape: a relation with a legitimate direct
    // assignment that also unions in a relation pointing back.
    await fga.writeRelationConfig(
      config({
        relation: "a",
        directlyAssignable: [{ type: "user" }],
        impliedBy: ["b"],
      }),
    );
    await expect(
      fga.writeRelationConfig(config({ relation: "b", computedUserset: "a" })),
    ).rejects.toBeInstanceOf(InvalidRelationConfigError);
  });

  test("an exclusion closing the loop is a cycle too", async () => {
    await fga.writeRelationConfig(
      config({
        relation: "a",
        directlyAssignable: [{ type: "user" }],
        excludedBy: "b",
      }),
    );
    await expect(
      fga.writeRelationConfig(config({ relation: "b", computedUserset: "a" })),
    ).rejects.toBeInstanceOf(InvalidRelationConfigError);
  });

  test("a diamond is not a cycle", async () => {
    // `d` is reached twice and is on neither path when it is. A
    // single global visited set would call this a cycle.
    await fga.writeRelationConfig(
      config({ relation: "d", directlyAssignable: [{ type: "user" }] }),
    );
    await fga.writeRelationConfig(
      config({ relation: "b", computedUserset: "d" }),
    );
    await fga.writeRelationConfig(
      config({ relation: "c", computedUserset: "d" }),
    );
    await expect(
      fga.writeRelationConfig(config({ relation: "a", impliedBy: ["b", "c"] })),
    ).resolves.toBeUndefined();
  });

  test("a re-convergent graph is walked once per relation", async () => {
    // Without the finished set this is 2^depth store reads. With
    // it, it is one read per edge.
    const depth = 12;
    await fga.writeRelationConfig(
      config({ relation: "r0", directlyAssignable: [{ type: "user" }] }),
    );
    for (let level = 1; level <= depth; level += 1) {
      await fga.writeRelationConfig(
        config({
          relation: `r${level}`,
          impliedBy: [`r${level - 1}`, `r${level - 1}`],
        }),
      );
    }
    const before = store.callsWith("findRelationConfig");
    await fga.writeRelationConfig(
      config({ relation: "top", impliedBy: [`r${depth}`, `r${depth}`] }),
    );
    // One read per distinct relation on the walk, not per path.
    const reads = store.callsWith("findRelationConfig") - before;
    expect(`${reads} reads, bounded: ${reads <= 2 * depth + 4}`).toBe(
      `${reads} reads, bounded: true`,
    );
  });

  test("a target that is not written yet is skipped", async () => {
    await expect(
      fga.writeRelationConfig(config({ relation: "a", computedUserset: "b" })),
    ).resolves.toBeUndefined();
  });

  test("a tuple-to-userset onto the same relation is not a cycle", async () => {
    await fga.writeRelationConfig(
      config({ relation: "parent", directlyAssignable: [{ type: "folder" }] }),
    );
    await expect(
      fga.writeRelationConfig(
        config({
          relation: "viewer",
          directlyAssignable: [{ type: "user" }],
          tupleToUserset: [{ tupleset: "parent", computedUserset: "viewer" }],
        }),
      ),
    ).resolves.toBeUndefined();
  });
});
