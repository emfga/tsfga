import { createTsfga, type RelationConfig } from "@tsfga/core";
import { type DB, KyselyTupleStore } from "@tsfga/kysely";
import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";

// ── Connect to PostgreSQL ──────────────────────────────────────────

const db = new Kysely<DB>({
  dialect: new PostgresDialect({
    pool: new pg.Pool({
      host: process.env["POSTGRES_HOST"],
      port: Number(process.env["POSTGRES_PORT"]),
      database: process.env["POSTGRES_DB"],
      user: process.env["POSTGRES_USER"],
      password: process.env["POSTGRES_PASSWORD"],
    }),
  }),
});

const store = new KyselyTupleStore(db);
const tsfga = createTsfga(store);

// ── Define a document authorization model ──────────────────────────
//
//   document
//     relations
//       define owner: [user]
//       define editor: [user] or owner
//       define viewer: [user] or editor

const configs: RelationConfig[] = [
  {
    objectType: "document",
    relation: "owner",
    directlyAssignableTypes: ["user"],
    impliedBy: null,
    computedUserset: null,
    tupleToUserset: null,
    excludedBy: null,
    intersection: null,
    allowsUsersetSubjects: false,
  },
  {
    objectType: "document",
    relation: "editor",
    directlyAssignableTypes: ["user"],
    impliedBy: ["owner"],
    computedUserset: null,
    tupleToUserset: null,
    excludedBy: null,
    intersection: null,
    allowsUsersetSubjects: false,
  },
  {
    objectType: "document",
    relation: "viewer",
    directlyAssignableTypes: ["user"],
    impliedBy: ["editor"],
    computedUserset: null,
    tupleToUserset: null,
    excludedBy: null,
    intersection: null,
    allowsUsersetSubjects: false,
  },
];

for (const config of configs) {
  await tsfga.writeRelationConfig(config);
}

// ── Write tuples ───────────────────────────────────────────────────

const docId = "10000000-0000-0000-0000-000000000001";
const alice = "20000000-0000-0000-0000-000000000001";
const bob = "20000000-0000-0000-0000-000000000002";

await tsfga.addTuple({
  objectType: "document",
  objectId: docId,
  relation: "owner",
  subjectType: "user",
  subjectId: alice,
});

await tsfga.addTuple({
  objectType: "document",
  objectId: docId,
  relation: "editor",
  subjectType: "user",
  subjectId: bob,
});

// ── Run permission checks ──────────────────────────────────────────

const checks = [
  { user: "alice", id: alice, relation: "owner" },
  { user: "alice", id: alice, relation: "editor" },
  { user: "alice", id: alice, relation: "viewer" },
  { user: "bob", id: bob, relation: "owner" },
  { user: "bob", id: bob, relation: "editor" },
  { user: "bob", id: bob, relation: "viewer" },
];

console.log("Permission checks for document:%s\n", docId);

for (const { user, id, relation } of checks) {
  const allowed = await tsfga.check({
    objectType: "document",
    objectId: docId,
    relation,
    subjectType: "user",
    subjectId: id,
  });
  console.log("  %s → %s: %s", user, relation, allowed);
}

// ── Clean up ───────────────────────────────────────────────────────

await tsfga.removeTuple({
  objectType: "document",
  objectId: docId,
  relation: "owner",
  subjectType: "user",
  subjectId: alice,
});

await tsfga.removeTuple({
  objectType: "document",
  objectId: docId,
  relation: "editor",
  subjectType: "user",
  subjectId: bob,
});

for (const config of configs) {
  await tsfga.deleteRelationConfig(config.objectType, config.relation);
}

await db.destroy();
console.log("\nDone.");
