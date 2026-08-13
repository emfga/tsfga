import { afterAll, beforeAll, describe, test } from "bun:test";
import { createTsfga, type TsfgaClient } from "@tsfga/core";
import type { DB } from "@tsfga/kysely";
import { KyselyTupleStore } from "@tsfga/kysely";
import type { Kysely } from "kysely";
import {
  expectConfigsMatchModel,
  expectConformance,
  expectPinnedDivergence,
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
import { fgaCreateStore, fgaWriteModel } from "./helpers/openfga.ts";

/**
 * CEL's **evaluation cost** budget, which tsfga has too.
 *
 * `internal/modelgraph/model.go:36` builds every condition with
 * `WithMaxEvaluationCost(config.MaxConditionEvaluationCost())`,
 * which is `cel.CostLimit` on the program. The default is
 * `DefaultMaxConditionEvaluationCost = 100`
 * (`pkg/server/config/config.go:67`), and `config.go:547` refuses
 * to start with anything below 100 — so 100 is not merely a
 * default, it is the floor. A program whose *actual* cost passes
 * it is cancelled mid-evaluation and the check comes back as an
 * error rather than as a boolean.
 *
 * cel-go prices comparison and membership by operand **size**, so
 * the budget is reached by data rather than by expression shape:
 * `internal/condition/condition_test.go:374` spends 3 on
 * `x == y` for two two-character strings, and `:395` spends 4 on
 * `'a' in strlist` for a three-element list. Scale either operand
 * and the same expression crosses 100.
 *
 * That is the whole point of the limit: the expression is stored
 * at model-write time and passes every gate tsfga has, and the
 * *request* decides what it costs. `@marcbachmann/cel-js` has no
 * cost accounting at all, so tsfga charges the expression itself,
 * in `maxConditionEvaluationCost` — a pre-pass over the AST that
 * refuses **before** evaluating rather than cancelling part way
 * through. It is a port of the server limit, so what it must get
 * right is not the exact figure but the *direction* of the
 * residue: an expression upstream refuses on cost is never granted
 * here.
 *
 * The first four conditions are ordinary — one string equality,
 * one list membership — and are asked twice: once with operands
 * that fit inside the budget, and once with operands that do not.
 * The first pair is the control that proves the divergence is the
 * *size*, not the model.
 *
 * The comprehension rows exist because a comprehension is the one
 * node whose cost is both data-driven and unbounded, and because
 * the pre-pass got it wrong in the granting direction: it charged
 * one flat unit of loop bookkeeping per element where cel-go
 * charges every node the desugared macro evaluates — 3 for `all`,
 * 4 for `exists`, and 12 and 13 for `map` and `filter`, which
 * build a one-element list every pass at `ListCreateBaseCost` 10.
 * `map` and `filter` therefore granted for N ∈ [7, 32] where
 * upstream refuses from N=7. Each macro is asked at the last N
 * both engines answer and at the first N upstream refuses, so
 * `expectConformance` fails on either side of the boundary moving.
 */

const ALICE = "00000000-0000-4000-d540-000000000101";
const DOC_EQUAL = "00000000-0000-4000-d540-000000000110";
const DOC_MEMBER = "00000000-0000-4000-d540-000000000111";
const DOC_COMPREHENSION = "00000000-0000-4000-d540-000000000112";

/**
 * One relation and one condition per comprehension macro, with the
 * N at which OpenFGA first refuses the check on cost.
 *
 * The boundaries are measured against `openfga/openfga:v1.18.2`,
 * not derived: `answer` is what both engines say at `N - 1`, and
 * `boundary` is the first N at which upstream cancels the
 * evaluation. tsfga's own boundary lands on the same N for all
 * four, which is the assertion these rows exist to make.
 */
const MACROS = [
  {
    relation: "exists_viewer",
    condition: "exists_d3c",
    boundary: 17,
    answer: false,
  },
  {
    relation: "all_viewer",
    condition: "all_d3c",
    boundary: 20,
    answer: true,
  },
  {
    relation: "map_viewer",
    condition: "map_d3c",
    boundary: 7,
    answer: true,
  },
  {
    relation: "filter_viewer",
    condition: "filter_d3c",
    boundary: 7,
    answer: true,
  },
] as const;

/** A list of N short strings, none of which is the needle. */
function elements(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `e${index}`);
}

/**
 * Long enough to pass 100 with room to spare. cel-go prices a
 * string comparison at roughly one unit per eight bytes of the
 * shorter operand, so 4 000 characters is about 500.
 */
const LONG = "x".repeat(4000);

/**
 * `in` walks the list, so the cost scales with its length. 300
 * entries is about three times the budget; the needle is absent so
 * the walk cannot end early.
 */
const LONG_LIST = Array.from({ length: 300 }, (_, index) => `item-${index}`);

describe("CEL evaluation-cost conformance", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let authorizationModelId: string;
  let tsfgaClient: TsfgaClient;
  let fixture: FixtureRecord;

  beforeAll(async () => {
    db = getDb();
    await beginTransaction(db);

    tsfgaClient = createTsfga(new KyselyTupleStore(db));
    fixture = recordFixture(tsfgaClient);

    await tsfgaClient.writeConditionDefinition({
      name: "equal_d3c",
      expression: "x == y",
      parameters: { x: "string", y: "string" },
    });
    await tsfgaClient.writeConditionDefinition({
      name: "member_d3c",
      expression: "needle in haystack",
      parameters: { needle: "string", haystack: "list<string>" },
    });
    await tsfgaClient.writeConditionDefinition({
      name: "exists_d3c",
      expression: "l.exists(x, x == 'zz')",
      parameters: { l: "list<string>" },
    });
    await tsfgaClient.writeConditionDefinition({
      name: "all_d3c",
      expression: "l.all(x, x != 'nope')",
      parameters: { l: "list<string>" },
    });
    await tsfgaClient.writeConditionDefinition({
      name: "map_d3c",
      expression: "size(l.map(x, x + '!')) > 0",
      parameters: { l: "list<string>" },
    });
    await tsfgaClient.writeConditionDefinition({
      name: "filter_d3c",
      expression: "size(l.filter(x, x != 'nope')) >= 0",
      parameters: { l: "list<string>" },
    });
    await tsfgaClient.writeConditionDefinition({
      name: "one_d3c",
      expression: "l.exists_one(x, x == 'zz')",
      parameters: { l: "list<string>" },
    });

    const plain = {
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    } as const;

    await tsfgaClient.writeRelationConfig({
      objectType: "doc_d3c",
      relation: "viewer",
      directlyAssignable: [{ type: "user_d3c", condition: "equal_d3c" }],
      ...plain,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "doc_d3c",
      relation: "member",
      directlyAssignable: [{ type: "user_d3c", condition: "member_d3c" }],
      ...plain,
    });
    for (const { relation, condition } of [
      ...MACROS,
      { relation: "one_viewer", condition: "one_d3c" },
    ]) {
      await tsfgaClient.writeRelationConfig({
        objectType: "doc_d3c",
        relation,
        directlyAssignable: [{ type: "user_d3c", condition }],
        ...plain,
      });
    }

    storeId = await fgaCreateStore("cel-cost");
    authorizationModelId = await fgaWriteModel(storeId, "./cel-cost/model.dsl");

    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "doc_d3c",
        objectId: DOC_EQUAL,
        relation: "viewer",
        subjectType: "user_d3c",
        subjectId: ALICE,
        conditionName: "equal_d3c",
      },
      "accepted",
    );
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "doc_d3c",
        objectId: DOC_MEMBER,
        relation: "member",
        subjectType: "user_d3c",
        subjectId: ALICE,
        conditionName: "member_d3c",
      },
      "accepted",
    );
    for (const { relation, condition } of [
      ...MACROS,
      { relation: "one_viewer", condition: "one_d3c" },
    ]) {
      await expectWriteConformance(
        storeId,
        authorizationModelId,
        tsfgaClient,
        {
          objectType: "doc_d3c",
          objectId: DOC_COMPREHENSION,
          relation,
          subjectType: "user_d3c",
          subjectId: ALICE,
          conditionName: condition,
        },
        "accepted",
      );
    }
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  test("control: a cheap string equality is answered by both", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "doc_d3c",
        objectId: DOC_EQUAL,
        relation: "viewer",
        subjectType: "user_d3c",
        subjectId: ALICE,
        context: { x: "ab", y: "ab" },
      },
      true,
    );
  });

  test("control: a cheap list membership is answered by both", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "doc_d3c",
        objectId: DOC_MEMBER,
        relation: "member",
        subjectType: "user_d3c",
        subjectId: ALICE,
        context: { needle: "b", haystack: ["a", "b", "c"] },
      },
      true,
    );
  });

  test("a string equality over the cost budget is refused", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "doc_d3c",
        objectId: DOC_EQUAL,
        relation: "viewer",
        subjectType: "user_d3c",
        subjectId: ALICE,
        context: { x: LONG, y: LONG },
      },
      "refused",
    );
  });

  test("a list membership over the cost budget is refused", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "doc_d3c",
        objectId: DOC_MEMBER,
        relation: "member",
        subjectType: "user_d3c",
        subjectId: ALICE,
        context: { needle: "absent", haystack: LONG_LIST },
      },
      "refused",
    );
  });

  for (const { relation, condition, boundary, answer } of MACROS) {
    test(`${condition} is answered by both one element under the budget`, async () => {
      await expectConformance(
        storeId,
        authorizationModelId,
        tsfgaClient,
        {
          objectType: "doc_d3c",
          objectId: DOC_COMPREHENSION,
          relation,
          subjectType: "user_d3c",
          subjectId: ALICE,
          context: { l: elements(boundary - 1) },
        },
        answer,
      );
    });

    test(`${condition} is refused by both at the budget`, async () => {
      await expectConformance(
        storeId,
        authorizationModelId,
        tsfgaClient,
        {
          objectType: "doc_d3c",
          objectId: DOC_COMPREHENSION,
          relation,
          subjectType: "user_d3c",
          subjectId: ALICE,
          context: { l: elements(boundary) },
        },
        "refused",
      );
    });
  }

  /**
   * `exists_one` is the one macro tsfga refuses early, and it is
   * the direction the port is required to fail in.
   *
   * cel-go's desugaring counts matches — `body ? __result__ + 1 :
   * __result__` — so the step costs 2 only on the iterations whose
   * predicate holds, and 1 on the rest. The pre-pass cannot know
   * which is which without evaluating the predicate, which is the
   * one thing it exists to avoid, so it charges the branch it
   * cannot rule out on every element. That is `chargeNode`'s
   * stated no-short-circuit policy, and it is why the constant 2
   * is not an over-estimate of the *step*: with an all-true
   * predicate upstream refuses at the same N tsfga does.
   *
   * The consequence is this pin. With a predicate that never
   * matches, upstream spends 1 per element and answers to N=48;
   * tsfga charges 2 and refuses from N=25. The controls on either
   * side are the evidence that the divergence is the band and not
   * the shape.
   */
  test("control: exists_one is answered by both below the band", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "doc_d3c",
        objectId: DOC_COMPREHENSION,
        relation: "one_viewer",
        subjectType: "user_d3c",
        subjectId: ALICE,
        context: { l: elements(24) },
      },
      false,
    );
  });

  test("exists_one is refused by tsfga inside upstream's budget", async () => {
    await expectPinnedDivergence(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "doc_d3c",
        objectId: DOC_COMPREHENSION,
        relation: "one_viewer",
        subjectType: "user_d3c",
        subjectId: ALICE,
        context: { l: elements(25) },
      },
      { openfga: false, tsfga: "refused" },
    );
  });

  test("control: exists_one is refused by both above the band", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "doc_d3c",
        objectId: DOC_COMPREHENSION,
        relation: "one_viewer",
        subjectType: "user_d3c",
        subjectId: ALICE,
        context: { l: elements(49) },
      },
      "refused",
    );
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./cel-cost/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
