import { afterAll, beforeAll, describe, test } from "bun:test";
import {
  type AddTupleRequest,
  createTsfga,
  type RelationConfig,
  type TsfgaClient,
} from "@tsfga/core";
import type { DB } from "@tsfga/kysely";
import { KyselyTupleStore } from "@tsfga/kysely";
import type { Kysely } from "kysely";
import {
  expectConfigsMatchModel,
  expectConformance,
  expectPinnedDivergence,
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
  fgaWriteTuplesRaw,
} from "./helpers/openfga.ts";
import { cfg, ids } from "./matrix-corpus.ts";

/**
 * A conditioned row on an **unrelated object** decides the check.
 *
 * Found while porting upstream's `check_ttu.go` / `check_userset.go`
 * matrices: upstream runs every stage in its own store, and merging
 * two stages into one store changed OpenFGA's answers for checks
 * neither stage's rows touch. This is that observation, reduced.
 *
 * The model below has `or_computed: computed or computed_cond`,
 * where only the second arm is conditioned. One object, `du:a`,
 * grants unconditionally. A second object, `du:b`, carries a
 * conditioned row for the same subject and is linked to nothing.
 *
 * Checking `du:a` directly answers `true` on both engines. Checking
 * one hop above it — through a tuple-to-userset, through a userset,
 * or through the base of an exclusion — makes OpenFGA **refuse**:
 * its weight-2 fast path resolves the hop by reading every object
 * of that type the subject relates to (`fastPathDirect` ->
 * `IteratorReadStartingFromUser`), so `du:b` is read, its condition
 * has no parameter, and the error aborts the whole check.
 *
 * tsfga reads per object, from the object under check downward, so
 * `du:b` is never visited and the answer stays `true`.
 *
 * Both engines see the same rows; only the reads differ, so the
 * three hops are pinned two-sided rather than fixed — see the
 * comment on the first of them for why tsfga keeps its reading.
 * Upstream's side was measured against the v1.18.2 container over
 * five isolated runs and inside the full suite: stable, not the
 * planner coin-flip that the sibling-error rule turns on.
 */

const u = ids(
  ["a", "b", "c", "d", "1", "2", "3", "valid", "other", "solo", "g1", "g2"],
  "d480",
);

const USER = "user_b1g";
const DU = "du_b1g";
const TT = "tt_b1g";
const UU = "uu_b1g";
const XCOND = "xcond_b1g";

const CONFIGS: RelationConfig[] = [
  cfg(DU, "direct", { directlyAssignable: [{ type: USER }] }),
  cfg(DU, "direct_cond", {
    directlyAssignable: [{ type: USER, condition: XCOND }],
  }),
  cfg(DU, "computed", { computedUserset: "direct" }),
  cfg(DU, "computed_cond", { computedUserset: "direct_cond" }),
  cfg(DU, "or_computed", { impliedBy: ["computed", "computed_cond"] }),
  cfg(TT, "direct_parent", { directlyAssignable: [{ type: DU }] }),
  cfg(TT, "ttu", {
    tupleToUserset: [
      { tupleset: "direct_parent", computedUserset: "or_computed" },
    ],
  }),
  cfg(UU, "userset", {
    directlyAssignable: [{ type: DU, relation: "or_computed" }],
  }),
  cfg(UU, "blocked", {
    directlyAssignable: [{ type: DU, relation: "or_computed" }],
  }),
  cfg(UU, "allowed", { computedUserset: "userset", excludedBy: "blocked" }),
];

const TUPLES: AddTupleRequest[] = [
  // The row that grants, unconditionally.
  {
    objectType: DU,
    objectId: u("a"),
    relation: "direct",
    subjectType: USER,
    subjectId: u("valid"),
  },
  // A conditioned row for the same subject, on an object nothing
  // links to. No path under check reaches it.
  {
    objectType: DU,
    objectId: u("b"),
    relation: "direct_cond",
    subjectType: USER,
    subjectId: u("valid"),
    conditionName: XCOND,
  },
  // The same again for a *different* subject, so the control below
  // separates "a conditioned row exists" from "a conditioned row
  // exists for this subject".
  {
    objectType: DU,
    objectId: u("c"),
    relation: "direct_cond",
    subjectType: USER,
    subjectId: u("other"),
    conditionName: XCOND,
  },
  // A subject with no conditioned row anywhere.
  {
    objectType: DU,
    objectId: u("d"),
    relation: "direct",
    subjectType: USER,
    subjectId: u("solo"),
  },
  // The three hops: a tuple-to-userset, a userset, and an
  // exclusion whose base is a userset.
  {
    objectType: TT,
    objectId: u("1"),
    relation: "direct_parent",
    subjectType: DU,
    subjectId: u("a"),
  },
  {
    objectType: TT,
    objectId: u("3"),
    relation: "direct_parent",
    subjectType: DU,
    subjectId: u("d"),
  },
  {
    objectType: UU,
    objectId: u("g1"),
    relation: "userset",
    subjectType: DU,
    subjectId: u("a"),
    subjectRelation: "or_computed",
  },
  {
    objectType: UU,
    objectId: u("g2"),
    relation: "userset",
    subjectType: DU,
    subjectId: u("a"),
    subjectRelation: "or_computed",
  },
];

describe("B1 a condition error spreading from an unrelated object", () => {
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
      name: XCOND,
      expression: "x == '1'",
      parameters: { x: "string" },
    });
    for (const config of CONFIGS) {
      await tsfgaClient.writeRelationConfig(config);
    }
    for (const tuple of TUPLES) {
      await tsfgaClient.addTuple(tuple);
    }

    storeId = await fgaCreateStore("condition-spread");
    authorizationModelId = await fgaWriteModel(
      storeId,
      "./condition-spread/model.dsl",
    );
    await fgaWriteTuplesRaw(
      storeId,
      authorizationModelId,
      TUPLES.map((tuple) => ({
        user: tuple.subjectRelation
          ? `${tuple.subjectType}:${tuple.subjectId}#${tuple.subjectRelation}`
          : `${tuple.subjectType}:${tuple.subjectId}`,
        relation: tuple.relation,
        object: `${tuple.objectType}:${tuple.objectId}`,
        ...(tuple.conditionName
          ? { condition: { name: tuple.conditionName } }
          : {}),
      })),
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  test("control: the granting object answers true on its own", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: DU,
        objectId: u("a"),
        relation: "or_computed",
        subjectType: USER,
        subjectId: u("valid"),
      },
      true,
    );
  });

  /**
   * The three hops, pinned rather than fixed.
   *
   * This is the **granting** direction — tsfga answers `true` where
   * upstream refuses — which is the uncomfortable kind of pin, so
   * the reasoning belongs here and not only in the tracker.
   *
   * Reproducing upstream's answer would mean giving `check` a read
   * the `TupleStore` interface does not have — "every object of
   * type T the subject relates to" — and then failing a check on
   * the strength of a row no dispatch visits. tsfga's answer would
   * then depend on rows the model author would not call relevant,
   * and any writer able to add one conditioned tuple could turn an
   * unrelated, already-granted check into a refusal. That is
   * bug-compatibility with a fast path whose two known symptoms
   * contradict each other: the wildcard case is the same resolver
   * *swallowing* a condition error a dispatch would have raised,
   * and this is it *raising* one a dispatch would never have seen.
   * Whatever the resolver should do, it cannot be both, so tsfga
   * keeps the per-object reading and documents the difference.
   *
   * Pinned, not tolerated: measured `refused` on five consecutive
   * isolated runs and in the full suite, so unlike 003 this one
   * does not flap.
   */
  test("a tuple-to-userset hop refuses over an unrelated row", async () => {
    await expectPinnedDivergence(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: TT,
        objectId: u("1"),
        relation: "ttu",
        subjectType: USER,
        subjectId: u("valid"),
      },
      { openfga: "refused", tsfga: true },
    );
  });

  test("a userset hop refuses over an unrelated row", async () => {
    await expectPinnedDivergence(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: UU,
        objectId: u("g1"),
        relation: "userset",
        subjectType: USER,
        subjectId: u("valid"),
      },
      { openfga: "refused", tsfga: true },
    );
  });

  test("the base of an exclusion refuses the same way", async () => {
    await expectPinnedDivergence(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: UU,
        objectId: u("g2"),
        relation: "allowed",
        subjectType: USER,
        subjectId: u("valid"),
      },
      { openfga: "refused", tsfga: true },
    );
  });

  // The controls that make the shape above a finding rather than a
  // misreading: supplying the parameter, failing the condition, and
  // moving the unrelated row to another subject all answer.
  test("control: the same hop answers when the parameter is given", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: TT,
        objectId: u("1"),
        relation: "ttu",
        subjectType: USER,
        subjectId: u("valid"),
        context: { x: "1" },
      },
      true,
    );
  });

  test("control: and when the unrelated row's condition is false", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: TT,
        objectId: u("1"),
        relation: "ttu",
        subjectType: USER,
        subjectId: u("valid"),
        context: { x: "2" },
      },
      true,
    );
  });

  test("control: a conditioned row for another subject does not refuse", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: TT,
        objectId: u("3"),
        relation: "ttu",
        subjectType: USER,
        subjectId: u("solo"),
      },
      true,
    );
  });

  test("control: an object with no parent denies rather than refusing", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: TT,
        objectId: u("2"),
        relation: "ttu",
        subjectType: USER,
        subjectId: u("valid"),
      },
      false,
    );
  });

  test("the configs say what the model says", () => {
    expectConfigsMatchModel("./condition-spread/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
