import { afterAll, beforeAll, describe, test } from "bun:test";
import { createTsfga, type TsfgaClient } from "@tsfga/core";
import type { DB } from "@tsfga/kysely";
import { KyselyTupleStore } from "@tsfga/kysely";
import type { Kysely } from "kysely";
import {
  type CheckOutcome,
  expectConfigsMatchModel,
  expectConformance,
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

/**
 * `CheckTuples.wildcard` is a list rather than a single row, so a
 * contextual `user:*` row does not hide the stored one. This
 * file attacks the join: several rows arriving from both sides,
 * conditioned and unconditioned mixed, duplicates across the two,
 * and each of them against the clamp that re-applies the model's
 * restrictions to whatever the store returned.
 */

const uuidMap = new Map<string, string>([
  ["alice", "00000000-0000-4000-d520-000000000011"],
  ["bob", "00000000-0000-4000-d520-000000000012"],
  ["doc", "00000000-0000-4000-d520-000000000013"],
  ["doc2", "00000000-0000-4000-d520-000000000014"],
]);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

describe("wildcard rows joined across stored and contextual", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let modelId: string;
  let tsfgaClient: TsfgaClient;
  let fixture: FixtureRecord;

  beforeAll(async () => {
    db = getDb();
    await beginTransaction(db);

    tsfgaClient = createTsfga(new KyselyTupleStore(db));
    fixture = recordFixture(tsfgaClient);

    await tsfgaClient.writeConditionDefinition({
      name: "ctx_d1w",
      expression: "ok == true",
      parameters: { ok: "bool" },
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "doc_d1w",
      relation: "viewer",
      directlyAssignable: [
        { type: "user_d1w" },
        { type: "user_d1w", wildcard: true },
        { type: "user_d1w", wildcard: true, condition: "ctx_d1w" },
      ],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "doc_d1w",
      relation: "editor",
      directlyAssignable: [
        { type: "user_d1w", wildcard: true, condition: "ctx_d1w" },
      ],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });

    // `doc` carries a *conditioned* stored wildcard on viewer, so a
    // contextual row has something to be joined with.
    await tsfgaClient.addTuple({
      objectType: "doc_d1w",
      objectId: uuid("doc"),
      relation: "viewer",
      subjectType: "user_d1w",
      subjectId: "*",
      conditionName: "ctx_d1w",
    });
    // `doc` also carries a conditioned stored wildcard on editor.
    await tsfgaClient.addTuple({
      objectType: "doc_d1w",
      objectId: uuid("doc"),
      relation: "editor",
      subjectType: "user_d1w",
      subjectId: "*",
      conditionName: "ctx_d1w",
    });

    storeId = await fgaCreateStore("wildcard-join");
    modelId = await fgaWriteModel(storeId, "./wildcard-join/model.dsl");
    await fgaWriteTuplesRaw(storeId, modelId, [
      {
        user: "user_d1w:*",
        relation: "viewer",
        object: `doc_d1w:${uuid("doc")}`,
        condition: { name: "ctx_d1w" },
      },
      {
        user: "user_d1w:*",
        relation: "editor",
        object: `doc_d1w:${uuid("doc")}`,
        condition: { name: "ctx_d1w" },
      },
    ]);
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  const check = (
    params: {
      objectId: string;
      relation: string;
      subjectId: string;
      context?: Record<string, unknown>;
      contextualTuples?: Parameters<TsfgaClient["addTuple"]>[0][];
    },
    expected: CheckOutcome,
  ) =>
    expectConformance(
      storeId,
      modelId,
      tsfgaClient,
      {
        objectType: "doc_d1w",
        objectId: params.objectId,
        relation: params.relation,
        subjectType: "user_d1w",
        subjectId: params.subjectId,
        context: params.context,
        contextualTuples: params.contextualTuples,
      },
      expected,
    );

  const wildcardTuple = (
    objectId: string,
    relation: string,
    conditionName?: string,
  ) => ({
    objectType: "doc_d1w",
    objectId,
    relation,
    subjectType: "user_d1w",
    subjectId: "*",
    ...(conditionName === undefined ? {} : { conditionName }),
  });

  test("the stored conditioned wildcard alone", async () => {
    await check(
      {
        objectId: uuid("doc"),
        relation: "viewer",
        subjectId: uuid("alice"),
        context: { ok: true },
      },
      true,
    );
    await check(
      {
        objectId: uuid("doc"),
        relation: "viewer",
        subjectId: uuid("alice"),
        context: { ok: false },
      },
      false,
    );
  });

  test("an unconditioned contextual wildcard beside a false stored one", async () => {
    await check(
      {
        objectId: uuid("doc"),
        relation: "viewer",
        subjectId: uuid("alice"),
        context: { ok: false },
        contextualTuples: [wildcardTuple(uuid("doc"), "viewer")],
      },
      true,
    );
  });

  test("a conditioned contextual wildcard duplicating the stored key", async () => {
    await check(
      {
        objectId: uuid("doc"),
        relation: "viewer",
        subjectId: uuid("alice"),
        context: { ok: true },
        contextualTuples: [wildcardTuple(uuid("doc"), "viewer", "ctx_d1w")],
      },
      true,
    );
    await check(
      {
        objectId: uuid("doc"),
        relation: "viewer",
        subjectId: uuid("alice"),
        context: { ok: false },
        contextualTuples: [wildcardTuple(uuid("doc"), "viewer", "ctx_d1w")],
      },
      false,
    );
  });

  test("a contextual wildcard on an object with no stored row", async () => {
    await check(
      {
        objectId: uuid("doc2"),
        relation: "viewer",
        subjectId: uuid("alice"),
        contextualTuples: [wildcardTuple(uuid("doc2"), "viewer")],
      },
      true,
    );
  });

  test("two contextual wildcard rows with the same key", async () => {
    await check(
      {
        objectId: uuid("doc2"),
        relation: "viewer",
        subjectId: uuid("alice"),
        context: { ok: false },
        contextualTuples: [
          wildcardTuple(uuid("doc2"), "viewer", "ctx_d1w"),
          wildcardTuple(uuid("doc2"), "viewer"),
        ],
      },
      true,
    );
  });

  /**
   * The clamp. `editor` admits only the *conditioned* wildcard, so
   * an unconditioned row on it is one the model does not admit —
   * whichever side it arrives from.
   */
  test("an unconditioned contextual wildcard the relation does not admit", async () => {
    await check(
      {
        objectId: uuid("doc"),
        relation: "editor",
        subjectId: uuid("alice"),
        context: { ok: false },
        contextualTuples: [wildcardTuple(uuid("doc"), "editor")],
      },
      "refused",
    );
  });

  test("the conditioned wildcard on editor still grants", async () => {
    await check(
      {
        objectId: uuid("doc"),
        relation: "editor",
        subjectId: uuid("alice"),
        context: { ok: true },
      },
      true,
    );
  });

  test("a second subject sees the same wildcard rows", async () => {
    await check(
      {
        objectId: uuid("doc"),
        relation: "viewer",
        subjectId: uuid("bob"),
        context: { ok: false },
        contextualTuples: [wildcardTuple(uuid("doc"), "viewer")],
      },
      true,
    );
  });

  test("relation configs match the DSL", () => {
    expectConfigsMatchModel("./wildcard-join/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
