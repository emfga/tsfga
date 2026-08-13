import {
  createTsfga,
  type RelationConfig,
  type TsfgaClient,
} from "@tsfga/core";
import { type DB, KyselyTupleStore } from "@tsfga/kysely";
import type { Kysely } from "kysely";
import { type FixtureRecord, recordFixture } from "../helpers/conformance.ts";
import {
  beginTransaction,
  destroyDb,
  getDb,
  rollbackTransaction,
} from "../helpers/db.ts";
import {
  fgaCreateStore,
  fgaWriteModel,
  fgaWriteTuples,
} from "../helpers/openfga.ts";

/**
 * One `doc_a4` type carrying every rewrite kind as a *target*
 * relation, so `listObjects` can be asked the same question of
 * each: direct, wildcard, userset, computed userset, TTU, union,
 * intersection and exclusion.
 *
 * Shared by the `listObjects` suite and the `listSubjects` suite,
 * which ask different questions of the same model.
 */

const uuidMap = new Map<string, string>([
  ["alice", "00000000-0000-4000-d430-000000000001"],
  ["bob", "00000000-0000-4000-d430-000000000002"],
  ["carol", "00000000-0000-4000-d430-000000000003"],
  ["g1", "00000000-0000-4000-d430-000000000004"],
  ["f1", "00000000-0000-4000-d430-000000000005"],
  ["d_direct", "00000000-0000-4000-d430-000000000006"],
  ["d_public", "00000000-0000-4000-d430-000000000007"],
  ["d_group", "00000000-0000-4000-d430-000000000008"],
  ["d_folder", "00000000-0000-4000-d430-000000000009"],
  ["d_multi", "00000000-0000-4000-d430-00000000000a"],
  ["d_blocked", "00000000-0000-4000-d430-00000000000b"],
  ["d_none", "00000000-0000-4000-d430-00000000000c"],
  // Named by no stored tuple at all.
  ["d_absent", "00000000-0000-4000-d430-00000000000d"],
]);

export function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

const RELATION_CONFIGS: RelationConfig[] = [
  {
    objectType: "group_a4",
    relation: "member",
    directlyAssignable: [{ type: "user_a4" }],
    impliedBy: null,
    computedUserset: null,
    tupleToUserset: null,
    excludedBy: null,
    intersection: null,
  },
  {
    objectType: "folder_a4",
    relation: "viewer",
    directlyAssignable: [{ type: "user_a4" }],
    impliedBy: null,
    computedUserset: null,
    tupleToUserset: null,
    excludedBy: null,
    intersection: null,
  },
  {
    objectType: "doc_a4",
    relation: "parent",
    directlyAssignable: [{ type: "folder_a4" }],
    impliedBy: null,
    computedUserset: null,
    tupleToUserset: null,
    excludedBy: null,
    intersection: null,
  },
  {
    objectType: "doc_a4",
    relation: "direct_viewer",
    directlyAssignable: [{ type: "user_a4" }],
    impliedBy: null,
    computedUserset: null,
    tupleToUserset: null,
    excludedBy: null,
    intersection: null,
  },
  {
    objectType: "doc_a4",
    relation: "public_viewer",
    directlyAssignable: [{ type: "user_a4", wildcard: true }],
    impliedBy: null,
    computedUserset: null,
    tupleToUserset: null,
    excludedBy: null,
    intersection: null,
  },
  {
    objectType: "doc_a4",
    relation: "group_viewer",
    directlyAssignable: [{ type: "group_a4", relation: "member" }],
    impliedBy: null,
    computedUserset: null,
    tupleToUserset: null,
    excludedBy: null,
    intersection: null,
  },
  {
    objectType: "doc_a4",
    relation: "computed_viewer",
    directlyAssignable: [],
    impliedBy: null,
    computedUserset: "direct_viewer",
    tupleToUserset: null,
    excludedBy: null,
    intersection: null,
  },
  {
    objectType: "doc_a4",
    relation: "inherited_viewer",
    directlyAssignable: [],
    impliedBy: null,
    computedUserset: null,
    tupleToUserset: [{ tupleset: "parent", computedUserset: "viewer" }],
    excludedBy: null,
    intersection: null,
  },
  {
    objectType: "doc_a4",
    relation: "union_viewer",
    directlyAssignable: [],
    impliedBy: [
      "direct_viewer",
      "group_viewer",
      "inherited_viewer",
      "public_viewer",
    ],
    computedUserset: null,
    tupleToUserset: null,
    excludedBy: null,
    intersection: null,
  },
  {
    objectType: "doc_a4",
    relation: "blocked",
    directlyAssignable: [{ type: "user_a4" }],
    impliedBy: null,
    computedUserset: null,
    tupleToUserset: null,
    excludedBy: null,
    intersection: null,
  },
  {
    objectType: "doc_a4",
    relation: "guarded_viewer",
    directlyAssignable: [],
    impliedBy: null,
    computedUserset: "union_viewer",
    tupleToUserset: null,
    excludedBy: "blocked",
    intersection: null,
  },
  {
    objectType: "doc_a4",
    relation: "required",
    directlyAssignable: [{ type: "user_a4" }],
    impliedBy: null,
    computedUserset: null,
    tupleToUserset: null,
    excludedBy: null,
    intersection: null,
  },
  {
    objectType: "doc_a4",
    relation: "strict_viewer",
    directlyAssignable: [],
    impliedBy: null,
    computedUserset: null,
    tupleToUserset: null,
    excludedBy: null,
    intersection: [
      { type: "computedUserset", relation: "union_viewer" },
      { type: "computedUserset", relation: "required" },
    ],
  },
  {
    objectType: "doc_a4",
    relation: "unused",
    directlyAssignable: [{ type: "user_a4" }],
    impliedBy: null,
    computedUserset: null,
    tupleToUserset: null,
    excludedBy: null,
    intersection: null,
  },
];

interface Fixture {
  db: Kysely<DB>;
  storeId: string;
  authorizationModelId: string;
  tsfgaClient: TsfgaClient;
  fixture: FixtureRecord;
}

export async function setupRewrites(): Promise<Fixture> {
  const db = getDb();
  await beginTransaction(db);

  const tsfgaClient = createTsfga(new KyselyTupleStore(db));
  const fixture = recordFixture(tsfgaClient);

  for (const config of RELATION_CONFIGS) {
    await tsfgaClient.writeRelationConfig(config);
  }

  const tuples: Array<[string, string, string, string, string?]> = [
    ["doc_a4", "d_direct", "direct_viewer", "user_a4:alice"],
    ["doc_a4", "d_direct", "required", "user_a4:alice"],
    ["doc_a4", "d_public", "public_viewer", "user_a4:*"],
    ["group_a4", "g1", "member", "user_a4:bob"],
    ["doc_a4", "d_group", "group_viewer", "group_a4:g1#member"],
    ["folder_a4", "f1", "viewer", "user_a4:alice"],
    ["doc_a4", "d_folder", "parent", "folder_a4:f1"],
    ["doc_a4", "d_multi", "direct_viewer", "user_a4:alice"],
    ["doc_a4", "d_multi", "group_viewer", "group_a4:g1#member"],
    ["doc_a4", "d_multi", "parent", "folder_a4:f1"],
    ["doc_a4", "d_blocked", "direct_viewer", "user_a4:alice"],
    ["doc_a4", "d_blocked", "blocked", "user_a4:alice"],
    ["doc_a4", "d_none", "unused", "user_a4:carol"],
  ];

  for (const [objectType, objectName, relation, subject] of tuples) {
    const hashIdx = subject.indexOf("#");
    const base = hashIdx >= 0 ? subject.slice(0, hashIdx) : subject;
    const subjectRelation = hashIdx >= 0 ? subject.slice(hashIdx + 1) : null;
    const colonIdx = base.indexOf(":");
    const subjectType = base.slice(0, colonIdx);
    const subjectName = base.slice(colonIdx + 1);
    await tsfgaClient.addTuple({
      objectType,
      objectId: uuid(objectName),
      relation,
      subjectType,
      subjectId: subjectName === "*" ? "*" : uuid(subjectName),
      subjectRelation,
    });
  }

  const storeId = await fgaCreateStore("rewrites-conformance");
  const authorizationModelId = await fgaWriteModel(
    storeId,
    "./rewrites/model.dsl",
  );
  await fgaWriteTuples(
    storeId,
    "./rewrites/tuples.yaml",
    authorizationModelId,
    uuidMap,
  );

  return { db, storeId, authorizationModelId, tsfgaClient, fixture };
}

export async function teardownRewrites(db: Kysely<DB>): Promise<void> {
  await rollbackTransaction(db);
  await destroyDb();
}
