import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type AddTupleRequest,
  createTsfga,
  InvalidConditionalTupleError,
  type TsfgaClient,
} from "@tsfga/core";
import type { DB } from "@tsfga/kysely";
import { KyselyTupleStore } from "@tsfga/kysely";
import type { Kysely } from "kysely";
import {
  expectConfigsMatchModel,
  expectWriteConformance,
  type FixtureRecord,
  recordFixture,
} from "./helpers/conformance.ts";
import {
  beginTransaction,
  destroyDb,
  getDb,
  rollbackTransaction,
} from "./helpers/db.ts";
import {
  fgaCreateStore,
  fgaWriteModel,
  fgaWriteOutcome,
} from "./helpers/openfga.ts";

/**
 * The write path validates the condition dimension, the same five
 * ways OpenFGA does.
 *
 * Restrictions are enforced twice upstream — once on write, once
 * on read — and tsfga now matches the condition on both. Without
 * the write half a caller can create a row the model does not
 * admit and get no error, then be surprised when every check
 * ignores it. The read gate makes that safe; it does not make it
 * discoverable.
 *
 * Each cause below was probed against v1.18.2, including the two
 * ordering rules that are otherwise invisible:
 *
 * - an **undefined** condition reports that, even when the
 *   restriction would not have admitted the name either;
 * - a context with both an ill-typed value and a stray key reports
 *   the type error.
 *
 * And the rule that is easy to get wrong in the strict direction:
 * a conditioned tuple with **no context, or a partial one, is
 * accepted**. The rest can still arrive with the check request, so
 * requiring it here would refuse writes OpenFGA takes.
 */

const uuidMap = new Map<string, string>([
  ["alice", "00000000-0000-4000-cd00-000000000001"],
]);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

/** Each case writes its own object, so none can collide. */
let nextObject = 0;
function objectId(): string {
  nextObject++;
  return `00000000-0000-4000-cd00-${String(nextObject).padStart(12, "0")}`;
}

describe("Condition Write Validation Conformance", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let authorizationModelId: string;
  let tsfgaClient: TsfgaClient;
  let fixture: FixtureRecord;

  beforeAll(async () => {
    db = getDb();
    await beginTransaction(db);

    const store = new KyselyTupleStore(db);
    tsfgaClient = createTsfga(store);
    fixture = recordFixture(tsfgaClient);

    for (const [name, expression] of [
      ["cond_a", "n >= 40"],
      ["cond_b", "n >= 10"],
    ] as const) {
      await tsfgaClient.writeConditionDefinition({
        name,
        expression,
        parameters: { n: "int" },
      });
    }

    await tsfgaClient.writeRelationConfig({
      objectType: "doc",
      relation: "both",
      directlyAssignable: [
        { type: "user" },
        { type: "user", condition: "cond_a" },
      ],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "doc",
      relation: "conditioned",
      directlyAssignable: [{ type: "user", condition: "cond_a" }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });

    storeId = await fgaCreateStore("condition-writes-conformance");
    authorizationModelId = await fgaWriteModel(
      storeId,
      "./condition-writes/model.dsl",
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  function tuple(overrides: Partial<AddTupleRequest>): AddTupleRequest {
    return {
      objectType: "doc",
      objectId: objectId(),
      relation: "both",
      subjectType: "user",
      subjectId: uuid("alice"),
      ...overrides,
    };
  }

  async function expectWrite(
    overrides: Partial<AddTupleRequest>,
    expected: "accepted" | "refused",
  ): Promise<void> {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      tuple(overrides),
      expected,
    );
  }

  describe("what is accepted", () => {
    test("an unconditioned tuple where the bare ref is admitted", async () => {
      await expectWrite({}, "accepted");
    });

    test("a conditioned tuple naming an admitted condition", async () => {
      await expectWrite(
        { conditionName: "cond_a", conditionContext: { n: 50 } },
        "accepted",
      );
    });

    test("a conditioned tuple with no context at all", async () => {
      // The context can still arrive with the check request, so
      // requiring it here would refuse a write OpenFGA takes.
      await expectWrite({ conditionName: "cond_a" }, "accepted");
    });

    test("a conditioned tuple with an empty context", async () => {
      await expectWrite(
        { conditionName: "cond_a", conditionContext: {} },
        "accepted",
      );
    });

    test("a numeric string for an int parameter", async () => {
      // The same coercion table the check path uses, which is why
      // it is one function: a value accepted here must be readable
      // by every check that reads the row.
      await expectWrite(
        { conditionName: "cond_a", conditionContext: { n: "42" } },
        "accepted",
      );
    });
  });

  describe("what is refused", () => {
    test("condition is missing", async () => {
      await expectWrite({ relation: "conditioned" }, "refused");
    });

    test("invalid condition for type restriction", async () => {
      // `cond_b` is defined, and simply not one this relation
      // names.
      await expectWrite({ conditionName: "cond_b" }, "refused");
    });

    test("undefined condition", async () => {
      await expectWrite({ conditionName: "cond_missing" }, "refused");
    });

    test("parameter type error", async () => {
      await expectWrite(
        { conditionName: "cond_a", conditionContext: { n: 4.5 } },
        "refused",
      );
    });

    test("invalid context parameter", async () => {
      await expectWrite(
        { conditionName: "cond_a", conditionContext: { n: 50, stray: 1 } },
        "refused",
      );
    });
  });

  /**
   * These assert tsfga's own cause strings, which upstream does not
   * share -- OpenFGA's prose is its own and pinning it here would
   * pin its wording rather than its behaviour. The two-sided claim
   * this block makes is the one below it: that upstream separates
   * the same five refusals into five distinct reasons, so tsfga's
   * discrimination is no finer than what the model actually
   * distinguishes. That both engines refuse at all is covered by
   * "what is refused".
   */
  describe("the cause is discriminated, as upstream discriminates it", () => {
    async function causeOf(
      overrides: Partial<AddTupleRequest>,
    ): Promise<string> {
      try {
        await tsfgaClient.addTuple(tuple(overrides));
        return "accepted";
      } catch (error) {
        if (error instanceof InvalidConditionalTupleError) return error.cause;
        throw error;
      }
    }

    test("each refusal reports its own cause", async () => {
      expect(await causeOf({ relation: "conditioned" })).toBe(
        "condition is missing",
      );
      expect(await causeOf({ conditionName: "cond_b" })).toBe(
        "invalid condition for type restriction",
      );
      expect(await causeOf({ conditionName: "cond_missing" })).toBe(
        "undefined condition",
      );
      expect(
        await causeOf({
          conditionName: "cond_a",
          conditionContext: { n: 4.5 },
        }),
      ).toBe("parameter type error");
      expect(
        await causeOf({
          conditionName: "cond_a",
          conditionContext: { n: 50, stray: 1 },
        }),
      ).toBe("invalid context parameter");
    });

    test("an undefined name reports that, not the restriction", async () => {
      // Ordering, probed: `cond_missing` is also not a condition
      // `both` admits, so a naive implementation reports the
      // restriction mismatch instead.
      expect(await causeOf({ conditionName: "cond_missing" })).toBe(
        "undefined condition",
      );
    });

    test("an ill-typed value outranks a stray key", async () => {
      expect(
        await causeOf({
          conditionName: "cond_a",
          conditionContext: { n: 4.5, stray: 1 },
        }),
      ).toBe("parameter type error");
    });

    test("upstream separates the same five refusals", async () => {
      const cases: Array<Partial<AddTupleRequest>> = [
        { relation: "conditioned" },
        { conditionName: "cond_b" },
        { conditionName: "cond_missing" },
        { conditionName: "cond_a", conditionContext: { n: 4.5 } },
        { conditionName: "cond_a", conditionContext: { n: 50, stray: 1 } },
      ];

      const reasons: string[] = [];
      for (const overrides of cases) {
        const outcome = await fgaWriteOutcome(
          storeId,
          authorizationModelId,
          tuple(overrides),
        );
        // Every one of these must be refused upstream too, or the
        // tsfga-side cause above is discriminating something the
        // model does not.
        expect(outcome).not.toBe("accepted");
        if (outcome !== "accepted") reasons.push(outcome.reason);
      }

      expect(reasons).toHaveLength(5);
      expect(new Set(reasons).size).toBe(5);
    });
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./condition-writes/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
