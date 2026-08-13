import { afterAll, beforeAll, describe, test } from "bun:test";
import { createTsfga, type TsfgaClient } from "@tsfga/core";
import type { DB } from "@tsfga/kysely";
import { KyselyTupleStore } from "@tsfga/kysely";
import type { Kysely } from "kysely";
import {
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
  type FgaTupleYaml,
  fgaCreateStore,
  fgaWriteModel,
  fgaWriteTuples,
  fgaWriteTuplesRaw,
} from "./helpers/openfga.ts";

// Upstream asks the *type graph* whether the subject's type can
// reach the relation at all, at every node, before resolving the
// rewrite: `ResolveCheck` calls `typesys.PathExists(user, relation,
// objectType)` and answers `Allowed:false` when there is no path.
// tsfga narrows only at the node it is standing on -- the relation's
// own `directlyAssignable` -- so a subtree that is unreachable two
// hops down is still walked, and whatever that walk does (raise on a
// condition it cannot evaluate, or exhaust the depth budget) becomes
// the answer.
//
// `ring_a1`, `chain_a1` and `pair_a1` all take their entrypoint
// from `bot_a1`, so no `user_a1` can ever be a member of any of
// them. Every subtree below is therefore `false` upstream, decided
// without a single tuple read -- while tsfga walks it and hits, in
// turn, a condition it cannot evaluate, the depth budget, and a
// cycle.

const CHAIN_LENGTH = 30;

const uuidMap = new Map<string, string>([
  ["alice", "00000000-0000-4000-d400-000000000101"],
  ["r1", "00000000-0000-4000-d400-000000000102"],
  ["r2", "00000000-0000-4000-d400-000000000103"],
  ["d1", "00000000-0000-4000-d400-000000000104"],
  ["d2", "00000000-0000-4000-d400-000000000105"],
  ["p1", "00000000-0000-4000-d400-000000000106"],
  ["p2", "00000000-0000-4000-d400-000000000107"],
]);

for (let i = 0; i <= CHAIN_LENGTH; i++) {
  uuidMap.set(
    `c${i}`,
    `00000000-0000-4000-d400-0000000002${String(i).padStart(2, "0")}`,
  );
}

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

describe("a1: type-graph reachability", () => {
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
      name: "valid_ip_a1",
      expression: 'user_ip == "192.168.0.1"',
      parameters: { user_ip: "string" },
    });

    await tsfgaClient.writeRelationConfig({
      objectType: "ring_a1",
      relation: "member",
      directlyAssignable: [
        { type: "bot_a1" },
        { type: "ring_a1", relation: "member", condition: "valid_ip_a1" },
      ],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "chain_a1",
      relation: "member",
      directlyAssignable: [
        { type: "bot_a1" },
        { type: "chain_a1", relation: "member" },
      ],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "pair_a1",
      relation: "member",
      directlyAssignable: [
        { type: "bot_a1" },
        { type: "pair_a1", relation: "owner" },
      ],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "pair_a1",
      relation: "owner",
      directlyAssignable: [
        { type: "bot_a1" },
        { type: "pair_a1", relation: "member" },
      ],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "doc_a1",
      relation: "via_pair",
      directlyAssignable: [{ type: "pair_a1", relation: "member" }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "doc_a1",
      relation: "via_ring",
      directlyAssignable: [{ type: "ring_a1", relation: "member" }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "doc_a1",
      relation: "via_chain",
      directlyAssignable: [{ type: "chain_a1", relation: "member" }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "doc_a1",
      relation: "granted",
      directlyAssignable: [{ type: "user_a1" }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "doc_a1",
      relation: "ring_excluded",
      directlyAssignable: [],
      impliedBy: null,
      computedUserset: "granted",
      tupleToUserset: null,
      excludedBy: "via_ring",
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "doc_a1",
      relation: "pair_excluded",
      directlyAssignable: [],
      impliedBy: null,
      computedUserset: "granted",
      tupleToUserset: null,
      excludedBy: "via_pair",
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "doc_a1",
      relation: "chain_excluded",
      directlyAssignable: [],
      impliedBy: null,
      computedUserset: "granted",
      tupleToUserset: null,
      excludedBy: "via_chain",
      intersection: null,
    });

    await tsfgaClient.addTuple({
      objectType: "ring_a1",
      objectId: uuid("r1"),
      relation: "member",
      subjectType: "ring_a1",
      subjectId: uuid("r2"),
      subjectRelation: "member",
      conditionName: "valid_ip_a1",
    });
    await tsfgaClient.addTuple({
      objectType: "doc_a1",
      objectId: uuid("d1"),
      relation: "via_ring",
      subjectType: "ring_a1",
      subjectId: uuid("r1"),
      subjectRelation: "member",
    });
    await tsfgaClient.addTuple({
      objectType: "doc_a1",
      objectId: uuid("d1"),
      relation: "granted",
      subjectType: "user_a1",
      subjectId: uuid("alice"),
    });
    await tsfgaClient.addTuple({
      objectType: "pair_a1",
      objectId: uuid("p1"),
      relation: "member",
      subjectType: "pair_a1",
      subjectId: uuid("p2"),
      subjectRelation: "owner",
    });
    await tsfgaClient.addTuple({
      objectType: "pair_a1",
      objectId: uuid("p2"),
      relation: "owner",
      subjectType: "pair_a1",
      subjectId: uuid("p1"),
      subjectRelation: "member",
    });
    await tsfgaClient.addTuple({
      objectType: "doc_a1",
      objectId: uuid("d1"),
      relation: "via_pair",
      subjectType: "pair_a1",
      subjectId: uuid("p1"),
      subjectRelation: "member",
    });
    await tsfgaClient.addTuple({
      objectType: "doc_a1",
      objectId: uuid("d2"),
      relation: "granted",
      subjectType: "user_a1",
      subjectId: uuid("alice"),
    });

    // The chain, long enough that walking it exhausts the default
    // depth budget of 25.
    const chain: FgaTupleYaml[] = [
      {
        user: `chain_a1:${uuid("c0")}#member`,
        relation: "via_chain",
        object: `doc_a1:${uuid("d2")}`,
      },
    ];
    await tsfgaClient.addTuple({
      objectType: "doc_a1",
      objectId: uuid("d2"),
      relation: "via_chain",
      subjectType: "chain_a1",
      subjectId: uuid("c0"),
      subjectRelation: "member",
    });
    for (let i = 0; i < CHAIN_LENGTH; i++) {
      chain.push({
        user: `chain_a1:${uuid(`c${i + 1}`)}#member`,
        relation: "member",
        object: `chain_a1:${uuid(`c${i}`)}`,
      });
      await tsfgaClient.addTuple({
        objectType: "chain_a1",
        objectId: uuid(`c${i}`),
        relation: "member",
        subjectType: "chain_a1",
        subjectId: uuid(`c${i + 1}`),
        subjectRelation: "member",
      });
    }

    storeId = await fgaCreateStore("type-graph-prune");
    authorizationModelId = await fgaWriteModel(
      storeId,
      "./type-graph-prune/model.dsl",
    );
    await fgaWriteTuples(
      storeId,
      "./type-graph-prune/tuples.yaml",
      authorizationModelId,
      uuidMap,
    );
    await fgaWriteTuplesRaw(storeId, authorizationModelId, chain);
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  test("002: an unreachable userset subtree denies, it does not raise", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "doc_a1",
        objectId: uuid("d1"),
        relation: "via_ring",
        subjectType: "user_a1",
        subjectId: uuid("alice"),
      },
      false,
    );
  });

  test("002: an unreachable subtrahend does not sink the exclusion", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "doc_a1",
        objectId: uuid("d1"),
        relation: "ring_excluded",
        subjectType: "user_a1",
        subjectId: uuid("alice"),
      },
      true,
    );
  });

  test("002: an unreachable subtree is not walked, so it cannot exhaust depth", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "doc_a1",
        objectId: uuid("d2"),
        relation: "via_chain",
        subjectType: "user_a1",
        subjectId: uuid("alice"),
      },
      false,
    );
  });

  test("002: an unreachable subtrahend cannot exhaust depth either", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "doc_a1",
        objectId: uuid("d2"),
        relation: "chain_excluded",
        subjectType: "user_a1",
        subjectId: uuid("alice"),
      },
      true,
    );
  });

  test("002: an unreachable cyclic subtrahend does not deny", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "doc_a1",
        objectId: uuid("d1"),
        relation: "via_pair",
        subjectType: "user_a1",
        subjectId: uuid("alice"),
      },
      false,
    );
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "doc_a1",
        objectId: uuid("d1"),
        relation: "pair_excluded",
        subjectType: "user_a1",
        subjectId: uuid("alice"),
      },
      true,
    );
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./type-graph-prune/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
