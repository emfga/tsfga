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
 * One small model carrying every subject shape a batch can mix:
 * a bare subject, a wildcard, a nested userset, a conditioned
 * grant, a TTU and an exclusion.
 *
 * Shared by `batch-check.test.ts` (checkMany against upstream's
 * BatchCheck) and `list-subjects-mixed-shapes.test.ts` (listSubjects against
 * ListUsers), which ask different questions of the same rows.
 */

const uuidMap = new Map<string, string>([
  ["alice", "00000000-0000-4000-d500-000000000001"],
  ["bob", "00000000-0000-4000-d500-000000000002"],
  ["carol", "00000000-0000-4000-d500-000000000003"],
  ["dave", "00000000-0000-4000-d500-000000000004"],
  ["g1", "00000000-0000-4000-d500-000000000005"],
  ["g2", "00000000-0000-4000-d500-000000000006"],
  ["f1", "00000000-0000-4000-d500-000000000007"],
  ["d1", "00000000-0000-4000-d500-000000000008"],
  ["d2", "00000000-0000-4000-d500-000000000009"],
  ["d3", "00000000-0000-4000-d500-00000000000a"],
  // Named by no tuple at all.
  ["d4", "00000000-0000-4000-d500-00000000000b"],
]);

export function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

const RELATION_CONFIGS: RelationConfig[] = [
  {
    objectType: "group_c4",
    relation: "member",
    directlyAssignable: [
      { type: "user_c4" },
      { type: "group_c4", relation: "member" },
    ],
    impliedBy: null,
    computedUserset: null,
    tupleToUserset: null,
    excludedBy: null,
    intersection: null,
  },
  {
    objectType: "folder_c4",
    relation: "viewer",
    directlyAssignable: [{ type: "user_c4" }],
    impliedBy: null,
    computedUserset: null,
    tupleToUserset: null,
    excludedBy: null,
    intersection: null,
  },
  {
    objectType: "doc_c4",
    relation: "parent",
    directlyAssignable: [{ type: "folder_c4" }],
    impliedBy: null,
    computedUserset: null,
    tupleToUserset: null,
    excludedBy: null,
    intersection: null,
  },
  {
    objectType: "doc_c4",
    relation: "owner",
    directlyAssignable: [{ type: "user_c4" }],
    impliedBy: null,
    computedUserset: null,
    tupleToUserset: null,
    excludedBy: null,
    intersection: null,
  },
  {
    objectType: "doc_c4",
    relation: "blocked",
    directlyAssignable: [{ type: "user_c4" }],
    impliedBy: null,
    computedUserset: null,
    tupleToUserset: null,
    excludedBy: null,
    intersection: null,
  },
  {
    objectType: "doc_c4",
    relation: "direct_viewer",
    directlyAssignable: [
      { type: "user_c4" },
      { type: "user_c4", wildcard: true },
      { type: "group_c4", relation: "member" },
      { type: "user_c4", condition: "weekday_c4" },
    ],
    impliedBy: null,
    computedUserset: null,
    tupleToUserset: null,
    excludedBy: null,
    intersection: null,
  },
  {
    objectType: "doc_c4",
    relation: "viewer",
    directlyAssignable: [],
    impliedBy: ["direct_viewer", "owner"],
    computedUserset: null,
    tupleToUserset: [{ tupleset: "parent", computedUserset: "viewer" }],
    excludedBy: null,
    intersection: null,
  },
  {
    objectType: "doc_c4",
    relation: "editor",
    directlyAssignable: [],
    impliedBy: null,
    computedUserset: "viewer",
    tupleToUserset: null,
    excludedBy: "blocked",
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

export async function setupBatch(): Promise<Fixture> {
  const db = getDb();
  await beginTransaction(db);

  const tsfgaClient = createTsfga(new KyselyTupleStore(db));
  const fixture = recordFixture(tsfgaClient);

  await tsfgaClient.writeConditionDefinition({
    name: "weekday_c4",
    expression: 'day == "mon"',
    parameters: { day: "string" },
  });

  for (const config of RELATION_CONFIGS) {
    await tsfgaClient.writeRelationConfig(config);
  }

  const tuples: Array<{
    objectType: string;
    object: string;
    relation: string;
    subject: string;
    condition?: string;
  }> = [
    {
      objectType: "group_c4",
      object: "g1",
      relation: "member",
      subject: "user_c4:alice",
    },
    {
      objectType: "group_c4",
      object: "g2",
      relation: "member",
      subject: "group_c4:g1#member",
    },
    {
      objectType: "folder_c4",
      object: "f1",
      relation: "viewer",
      subject: "user_c4:bob",
    },
    {
      objectType: "doc_c4",
      object: "d1",
      relation: "parent",
      subject: "folder_c4:f1",
    },
    {
      objectType: "doc_c4",
      object: "d1",
      relation: "direct_viewer",
      subject: "group_c4:g2#member",
    },
    {
      objectType: "doc_c4",
      object: "d1",
      relation: "owner",
      subject: "user_c4:carol",
    },
    {
      objectType: "doc_c4",
      object: "d1",
      relation: "blocked",
      subject: "user_c4:carol",
    },
    {
      objectType: "doc_c4",
      object: "d2",
      relation: "direct_viewer",
      subject: "user_c4:*",
    },
    {
      objectType: "doc_c4",
      object: "d2",
      relation: "blocked",
      subject: "user_c4:dave",
    },
    {
      objectType: "doc_c4",
      object: "d3",
      relation: "direct_viewer",
      subject: "user_c4:alice",
      condition: "weekday_c4",
    },
    {
      objectType: "doc_c4",
      object: "d3",
      relation: "direct_viewer",
      subject: "user_c4:bob",
    },
  ];

  for (const row of tuples) {
    const hashIdx = row.subject.indexOf("#");
    const base = hashIdx >= 0 ? row.subject.slice(0, hashIdx) : row.subject;
    const subjectRelation =
      hashIdx >= 0 ? row.subject.slice(hashIdx + 1) : null;
    const colonIdx = base.indexOf(":");
    const subjectType = base.slice(0, colonIdx);
    const subjectName = base.slice(colonIdx + 1);
    await tsfgaClient.addTuple({
      objectType: row.objectType,
      objectId: uuid(row.object),
      relation: row.relation,
      subjectType,
      subjectId: subjectName === "*" ? "*" : uuid(subjectName),
      subjectRelation,
      conditionName: row.condition ?? null,
    });
  }

  const storeId = await fgaCreateStore("batch-conformance");
  const authorizationModelId = await fgaWriteModel(
    storeId,
    "./batch/model.dsl",
  );
  await fgaWriteTuples(
    storeId,
    "./batch/tuples.yaml",
    authorizationModelId,
    uuidMap,
  );

  return { db, storeId, authorizationModelId, tsfgaClient, fixture };
}

export async function teardownBatch(db: Kysely<DB>): Promise<void> {
  await rollbackTransaction(db);
  await destroyDb();
}
