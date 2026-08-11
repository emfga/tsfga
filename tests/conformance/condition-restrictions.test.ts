import { afterAll, beforeAll, describe, test } from "bun:test";
import {
  createTsfga,
  type TsfgaClient,
  type TypeRestriction,
} from "@tsfga/core";
import type { DB } from "@tsfga/kysely";
import { KyselyTupleStore } from "@tsfga/kysely";
import type { Kysely } from "kysely";
import {
  expectConfigsMatchModel,
  expectConformance,
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

/**
 * The condition is part of the type restriction, and OpenFGA
 * matches it exactly in both directions.
 *
 * A relation admitting `[user with weekday_only]` refuses a tuple
 * that carries no condition — *even when the check context would
 * have satisfied it* — and a relation admitting `[user]` refuses
 * one that carries a condition. Neither is intuitive from the
 * `directly_related_user_types` name, and getting the first
 * backwards grants where OpenFGA denies.
 *
 * Every row here mirrors a probe run against the container at
 * v1.18.2; `expectConformance` re-runs both sides on every
 * execution, so the table is checked rather than quoted.
 *
 * **Rows are pushed straight to the store**, as in
 * `userset-restrictions`. The write path enforces the same
 * restriction, so a fixture that wrote through `addTuple` could
 * only ever contain rows the narrow models admit — precisely the
 * rows that cannot exercise the read gate. OpenFGA reaches the
 * same state by writing under a wide model and narrowing after.
 */

const uuidMap = new Map<string, string>([
  ["alice", "00000000-0000-4000-ca00-000000000001"],
  ["eng", "00000000-0000-4000-ca00-000000000002"],
  ["bare", "00000000-0000-4000-ca00-000000000003"],
  ["cond", "00000000-0000-4000-ca00-000000000004"],
  ["ucond", "00000000-0000-4000-ca00-000000000005"],
  ["wbare", "00000000-0000-4000-ca00-000000000006"],
  ["wcond", "00000000-0000-4000-ca00-000000000007"],
]);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

/** A narrowing, its model file, and what tsfga must record for it. */
interface Narrowing {
  name: string;
  admits: TypeRestriction[];
}

const NARROWINGS: Narrowing[] = [
  {
    name: "bare-and-conditioned",
    admits: [{ type: "user" }, { type: "user", condition: "weekday_only" }],
  },
  {
    name: "conditioned-only",
    admits: [{ type: "user", condition: "weekday_only" }],
  },
  { name: "bare-only", admits: [{ type: "user" }] },
  {
    name: "other-condition",
    admits: [{ type: "user", condition: "other_cond" }],
  },
  { name: "userset-bare", admits: [{ type: "team", relation: "member" }] },
  {
    name: "userset-conditioned",
    admits: [{ type: "team", relation: "member", condition: "weekday_only" }],
  },
  { name: "wildcard-bare", admits: [{ type: "user", wildcard: true }] },
  {
    name: "wildcard-conditioned",
    admits: [{ type: "user", wildcard: true, condition: "weekday_only" }],
  },
];

describe("Condition Type Restrictions Conformance", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let tsfgaClient: TsfgaClient;
  let store: KyselyTupleStore;
  const modelIds = new Map<string, string>();

  beforeAll(async () => {
    db = getDb();
    await beginTransaction(db);

    store = new KyselyTupleStore(db);
    tsfgaClient = createTsfga(store);

    await tsfgaClient.writeConditionDefinition({
      name: "weekday_only",
      expression: "is_weekday == true",
      parameters: { is_weekday: "bool" },
    });
    await tsfgaClient.writeConditionDefinition({
      name: "other_cond",
      expression: "is_weekday == true",
      parameters: { is_weekday: "bool" },
    });

    // `team.member` never narrows, so its userset row is always
    // resolvable and only `document.viewer` is under test.
    await tsfgaClient.writeRelationConfig({
      objectType: "team",
      relation: "member",
      directlyAssignable: [{ type: "user" }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });

    for (const tuple of [
      { objectId: uuid("bare"), subjectId: uuid("alice") },
      {
        objectId: uuid("cond"),
        subjectId: uuid("alice"),
        conditionName: "weekday_only",
      },
      { objectId: uuid("wbare"), subjectId: "*" },
      {
        objectId: uuid("wcond"),
        subjectId: "*",
        conditionName: "weekday_only",
      },
    ]) {
      await store.insertTuple({
        objectType: "document",
        relation: "viewer",
        subjectType: "user",
        ...tuple,
      });
    }
    await store.insertTuple({
      objectType: "document",
      objectId: uuid("ucond"),
      relation: "viewer",
      subjectType: "team",
      subjectId: uuid("eng"),
      subjectRelation: "member",
      conditionName: "weekday_only",
    });
    await store.insertTuple({
      objectType: "team",
      objectId: uuid("eng"),
      relation: "member",
      subjectType: "user",
      subjectId: uuid("alice"),
    });

    storeId = await fgaCreateStore("condition-restrictions-conformance");
    const wide = await fgaWriteModel(
      storeId,
      "./condition-restrictions/model-wide.dsl",
    );
    await fgaWriteTuplesRaw(storeId, wide, [
      {
        user: `user:${uuid("alice")}`,
        relation: "viewer",
        object: `document:${uuid("bare")}`,
      },
      {
        user: `user:${uuid("alice")}`,
        relation: "viewer",
        object: `document:${uuid("cond")}`,
        condition: { name: "weekday_only" },
      },
      {
        user: "user:*",
        relation: "viewer",
        object: `document:${uuid("wbare")}`,
      },
      {
        user: "user:*",
        relation: "viewer",
        object: `document:${uuid("wcond")}`,
        condition: { name: "weekday_only" },
      },
      {
        user: `team:${uuid("eng")}#member`,
        relation: "viewer",
        object: `document:${uuid("ucond")}`,
        condition: { name: "weekday_only" },
      },
      {
        user: `user:${uuid("alice")}`,
        relation: "member",
        object: `team:${uuid("eng")}`,
      },
    ]);

    // Narrowed after the fact, exactly as the rows stay behind.
    for (const { name } of NARROWINGS) {
      modelIds.set(
        name,
        await fgaWriteModel(
          storeId,
          `./condition-restrictions/model-${name}.dsl`,
        ),
      );
    }
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  /** Point `document.viewer` at one narrowing and check one row. */
  async function expectUnder(
    narrowing: string,
    objectId: string,
    expected: boolean,
  ): Promise<void> {
    const admits = NARROWINGS.find((n) => n.name === narrowing)?.admits;
    if (!admits) throw new Error(`No narrowing ${narrowing}`);
    await tsfgaClient.writeRelationConfig({
      objectType: "document",
      relation: "viewer",
      directlyAssignable: admits,
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    const modelId = modelIds.get(narrowing);
    if (!modelId) throw new Error(`No model for ${narrowing}`);
    await expectConformance(
      storeId,
      modelId,
      tsfgaClient,
      {
        objectType: "document",
        objectId,
        relation: "viewer",
        subjectType: "user",
        subjectId: uuid("alice"),
        // Satisfied throughout, so every `false` below is the
        // restriction refusing the row and never the condition
        // evaluating to false.
        context: { is_weekday: true },
      },
      expected,
    );
  }

  describe("an unconditioned row", () => {
    test("is admitted where the bare ref is named", async () => {
      await expectUnder("bare-and-conditioned", uuid("bare"), true);
    });

    test("is refused where only the conditioned ref is named", async () => {
      // The unintuitive one, and the fail-open direction: the
      // context would satisfy `weekday_only`, but the row does not
      // carry the condition and so is not the row this relation
      // admits. tsfga used to find it, see no `conditionName`,
      // call that unconditional access and grant.
      await expectUnder("conditioned-only", uuid("bare"), false);
    });
  });

  describe("a conditioned row", () => {
    test("is refused where only the bare ref is named", async () => {
      await expectUnder("bare-only", uuid("cond"), false);
    });

    test("is refused where another condition is named", async () => {
      // Same type, same shape, different condition — and the two
      // conditions here even have the same expression, so nothing
      // but the name distinguishes them.
      await expectUnder("other-condition", uuid("cond"), false);
    });

    test("is admitted where its own condition is named", async () => {
      await expectUnder("bare-and-conditioned", uuid("cond"), true);
    });
  });

  describe("a conditioned userset row", () => {
    test("is refused where only the bare userset ref is named", async () => {
      await expectUnder("userset-bare", uuid("ucond"), false);
    });

    test("is admitted where the conditioned userset ref is named", async () => {
      await expectUnder("userset-conditioned", uuid("ucond"), true);
    });
  });

  describe("each narrowing says what its own model says", () => {
    // This fixture rewrites `document.viewer` per case, so the
    // usual end-of-file drift assertion would only ever check
    // whichever narrowing ran last. Each one is checked against
    // its own `.dsl` instead — nine model files and nine
    // `admits` lists, and nothing else would notice them
    // disagreeing.
    for (const { name, admits } of NARROWINGS) {
      test(name, () => {
        expectConfigsMatchModel(
          `./condition-restrictions/model-${name}.dsl`,
          {
            configs: [
              {
                objectType: "team",
                relation: "member",
                directlyAssignable: [{ type: "user" }],
                impliedBy: null,
                computedUserset: null,
                tupleToUserset: null,
                excludedBy: null,
                intersection: null,
              },
              {
                objectType: "document",
                relation: "viewer",
                directlyAssignable: admits,
                impliedBy: null,
                computedUserset: null,
                tupleToUserset: null,
                excludedBy: null,
                intersection: null,
              },
            ],
            tupleRelations: new Set(),
          },
          { coverage: "complete" },
        );
      });
    }
  });

  describe("the wildcard row mirrors it exactly", () => {
    test("bare row, bare ref", async () => {
      await expectUnder("wildcard-bare", uuid("wbare"), true);
    });

    test("bare row, conditioned ref", async () => {
      await expectUnder("wildcard-conditioned", uuid("wbare"), false);
    });

    test("conditioned row, bare ref", async () => {
      await expectUnder("wildcard-bare", uuid("wcond"), false);
    });

    test("conditioned row, conditioned ref", async () => {
      await expectUnder("wildcard-conditioned", uuid("wcond"), true);
    });
  });
});
