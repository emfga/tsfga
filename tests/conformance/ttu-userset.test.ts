import { afterAll, beforeAll, describe, test } from "bun:test";
import {
  type CheckRequest,
  createTsfga,
  type RelationConfig,
  type TsfgaClient,
} from "@tsfga/core";
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
  fgaWriteTuples,
} from "./helpers/openfga.ts";

// Usersets and tuple-to-usersets pointed at every rewrite kind:
// a userset onto an exclusion, onto a computed relation, onto
// itself (userset of userset), onto an object with no rows at all;
// two TTU arms sharing one tupleset relation; a TTU landing on a
// relation that is itself a TTU; and a tupleset whose admitted
// types do not all define the computed relation.

const uuidMap = new Map<string, string>();
const names = [
  "alice",
  "bob",
  "o1",
  "s1",
  "s2",
  "s9",
  "fa",
  "fb",
  "fc",
  "b1",
  "c1",
  "y1",
  "y2",
  "y3",
  "y4",
  "y5",
  "y6",
  "y7",
  "y8",
];
for (const [i, name] of names.entries()) {
  uuidMap.set(
    name,
    `00000000-0000-4000-d400-0000000004${String(i).padStart(2, "0")}`,
  );
}

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

const EMPTY = {
  directlyAssignable: [],
  impliedBy: null,
  computedUserset: null,
  tupleToUserset: null,
  excludedBy: null,
  intersection: null,
} satisfies Omit<RelationConfig, "objectType" | "relation">;

describe("a1: usersets and tuple-to-usersets", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let authorizationModelId: string;
  let tsfgaClient: TsfgaClient;
  let fixture: FixtureRecord;

  async function check(
    request: CheckRequest,
    expected: CheckOutcome,
  ): Promise<void> {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      request,
      expected,
    );
  }

  function on(object: string, relation: string, subject: string): CheckRequest {
    return {
      objectType: "doc_a1",
      objectId: uuid(object),
      relation,
      subjectType: "user_a1",
      subjectId: uuid(subject),
    };
  }

  beforeAll(async () => {
    db = getDb();
    await beginTransaction(db);

    tsfgaClient = createTsfga(new KyselyTupleStore(db));
    fixture = recordFixture(tsfgaClient);

    const configs: RelationConfig[] = [
      {
        ...EMPTY,
        objectType: "org_a1",
        relation: "blocked",
        directlyAssignable: [{ type: "user_a1" }],
      },
      {
        ...EMPTY,
        objectType: "org_a1",
        relation: "base",
        directlyAssignable: [
          { type: "user_a1" },
          { type: "user_a1", wildcard: true },
        ],
      },
      {
        ...EMPTY,
        objectType: "org_a1",
        relation: "ok",
        computedUserset: "base",
        excludedBy: "blocked",
      },
      {
        ...EMPTY,
        objectType: "org_a1",
        relation: "admin",
        directlyAssignable: [{ type: "user_a1" }],
      },
      {
        ...EMPTY,
        objectType: "org_a1",
        relation: "super",
        computedUserset: "admin",
      },
      {
        ...EMPTY,
        objectType: "squad_a1",
        relation: "crew",
        directlyAssignable: [
          { type: "user_a1" },
          { type: "squad_a1", relation: "crew" },
        ],
      },
      {
        ...EMPTY,
        objectType: "folder_a1",
        relation: "parent",
        directlyAssignable: [{ type: "folder_a1" }],
      },
      {
        ...EMPTY,
        objectType: "folder_a1",
        relation: "viewer",
        directlyAssignable: [{ type: "user_a1" }],
        tupleToUserset: [{ tupleset: "parent", computedUserset: "viewer" }],
      },
      {
        ...EMPTY,
        objectType: "folder_a1",
        relation: "editor",
        directlyAssignable: [{ type: "user_a1" }],
      },
      {
        ...EMPTY,
        objectType: "box_a1",
        relation: "viewer",
        directlyAssignable: [{ type: "user_a1" }],
      },
      {
        ...EMPTY,
        objectType: "crate_a1",
        relation: "holder",
        directlyAssignable: [{ type: "user_a1" }],
      },
      {
        ...EMPTY,
        objectType: "doc_a1",
        relation: "parent",
        directlyAssignable: [{ type: "folder_a1" }],
      },
      {
        ...EMPTY,
        objectType: "doc_a1",
        relation: "container",
        directlyAssignable: [{ type: "box_a1" }, { type: "crate_a1" }],
      },
      {
        ...EMPTY,
        objectType: "doc_a1",
        relation: "via_excl",
        directlyAssignable: [{ type: "org_a1", relation: "ok" }],
      },
      {
        ...EMPTY,
        objectType: "doc_a1",
        relation: "via_computed",
        directlyAssignable: [{ type: "org_a1", relation: "super" }],
      },
      {
        ...EMPTY,
        objectType: "doc_a1",
        relation: "via_crew",
        directlyAssignable: [{ type: "squad_a1", relation: "crew" }],
      },
      {
        ...EMPTY,
        objectType: "doc_a1",
        relation: "two_from_parent",
        tupleToUserset: [
          { tupleset: "parent", computedUserset: "viewer" },
          { tupleset: "parent", computedUserset: "editor" },
        ],
      },
      {
        ...EMPTY,
        objectType: "doc_a1",
        relation: "chained",
        tupleToUserset: [{ tupleset: "parent", computedUserset: "viewer" }],
      },
      {
        ...EMPTY,
        objectType: "doc_a1",
        relation: "via_container",
        tupleToUserset: [{ tupleset: "container", computedUserset: "viewer" }],
      },
    ];
    for (const config of configs) {
      await tsfgaClient.writeRelationConfig(config);
    }

    const tuples = [
      ["org_a1", "o1", "base", "user_a1", "*", null],
      ["org_a1", "o1", "blocked", "user_a1", "bob", null],
      ["org_a1", "o1", "admin", "user_a1", "alice", null],
      ["squad_a1", "s1", "crew", "squad_a1", "s2", "crew"],
      ["squad_a1", "s2", "crew", "user_a1", "alice", null],
      ["folder_a1", "fa", "parent", "folder_a1", "fb", null],
      ["folder_a1", "fb", "viewer", "user_a1", "alice", null],
      ["folder_a1", "fc", "editor", "user_a1", "bob", null],
      ["box_a1", "b1", "viewer", "user_a1", "alice", null],
      ["crate_a1", "c1", "holder", "user_a1", "alice", null],
      ["doc_a1", "y1", "via_excl", "org_a1", "o1", "ok"],
      ["doc_a1", "y2", "via_computed", "org_a1", "o1", "super"],
      ["doc_a1", "y3", "parent", "folder_a1", "fa", null],
      ["doc_a1", "y4", "parent", "folder_a1", "fc", null],
      ["doc_a1", "y5", "via_crew", "squad_a1", "s1", "crew"],
      ["doc_a1", "y6", "via_crew", "squad_a1", "s9", "crew"],
      ["doc_a1", "y7", "container", "box_a1", "b1", null],
      ["doc_a1", "y7", "container", "crate_a1", "c1", null],
      ["doc_a1", "y8", "container", "crate_a1", "c1", null],
    ] as const;
    for (const [
      objectType,
      object,
      relation,
      subjectType,
      subject,
      subjectRelation,
    ] of tuples) {
      await tsfgaClient.addTuple({
        objectType,
        objectId: uuid(object),
        relation,
        subjectType,
        subjectId: subject === "*" ? "*" : uuid(subject),
        subjectRelation,
      });
    }

    storeId = await fgaCreateStore("ttu-userset");
    authorizationModelId = await fgaWriteModel(
      storeId,
      "./ttu-userset/model.dsl",
    );
    await fgaWriteTuples(
      storeId,
      "./ttu-userset/tuples.yaml",
      authorizationModelId,
      uuidMap,
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  test("a userset onto a relation that is itself an exclusion", async () => {
    await check(on("y1", "via_excl", "alice"), true);
    await check(on("y1", "via_excl", "bob"), false);
  });

  test("a userset onto a computed relation", async () => {
    await check(on("y2", "via_computed", "alice"), true);
    await check(on("y2", "via_computed", "bob"), false);
  });

  test("a userset of a userset", async () => {
    await check(on("y5", "via_crew", "alice"), true);
    await check(on("y5", "via_crew", "bob"), false);
  });

  test("a userset onto an object with no rows denies", async () => {
    await check(on("y6", "via_crew", "alice"), false);
  });

  test("two TTU arms sharing one tupleset relation", async () => {
    await check(on("y3", "two_from_parent", "alice"), true);
    await check(on("y3", "two_from_parent", "bob"), false);
    await check(on("y4", "two_from_parent", "bob"), true);
    await check(on("y4", "two_from_parent", "alice"), false);
  });

  test("a TTU landing on a relation that is itself a TTU", async () => {
    await check(on("y3", "chained", "alice"), true);
    await check(on("y3", "chained", "bob"), false);
    await check(on("y4", "chained", "bob"), false);
  });

  test("a tupleset type that does not define the computed relation", async () => {
    await check(on("y7", "via_container", "alice"), true);
    await check(on("y8", "via_container", "alice"), false);
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./ttu-userset/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
