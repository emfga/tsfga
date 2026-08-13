import { afterAll, beforeAll, describe, test } from "bun:test";
import { createTsfga, type TsfgaClient } from "@tsfga/core";
import type { DB } from "@tsfga/kysely";
import { KyselyTupleStore } from "@tsfga/kysely";
import type { Kysely } from "kysely";
import {
  expectConfigsMatchModel,
  expectConformance,
  expectListObjectsConformance,
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
  fgaWriteTuples,
} from "./helpers/openfga.ts";
import {
  assertUuidMapCovers,
  assertUuidMapInjective,
} from "./helpers/uuid-map.ts";

/**
 * An Airtable/Coda-shaped tree: workspace -> base -> table -> view
 * and workspace -> base -> table -> record, five levels of
 * tuple-to-userset with a subtraction at three of them.
 *
 * What this fixture is for is **where a right enters the tree**.
 * `dan` is an editor of the base and nothing else: he has no
 * workspace row at all, so every one of his answers arrives from
 * the middle of the chain rather than the top, and every check
 * that walks *upwards* has to stop asking once it reaches him.
 * `bob` is the mirror image — a workspace collaborator, so his
 * view of a table is four dispatches from the row that grants it,
 * through a group userset.
 *
 * The subtractions are placed so each cuts a different length of
 * chain: `table_c3t:archive` is hidden from everyone, which costs
 * `record_c3t:r3` its view but not its edit; `view_c3t:mine` is
 * locked to all but its personal owner, so one user sees a view of
 * a table everyone else can see.
 *
 * `record_c3t.can_view` is `can_view from table and visible_to`,
 * an intersection of a tuple-to-userset with a local union — the
 * shape record-level permissions actually take, and the one where
 * a naive union grants a record to somebody who cannot open the
 * table it lives in.
 */

const uuidMap = new Map<string, string>([
  ["bob", "00000000-0000-4000-d571-000000000001"],
  ["eng", "00000000-0000-4000-d571-000000000002"],
  ["carol", "00000000-0000-4000-d571-000000000003"],
  ["alice", "00000000-0000-4000-d571-000000000004"],
  ["acme", "00000000-0000-4000-d571-000000000005"],
  ["crm", "00000000-0000-4000-d571-000000000006"],
  ["dan", "00000000-0000-4000-d571-000000000007"],
  ["leads", "00000000-0000-4000-d571-000000000008"],
  ["archive", "00000000-0000-4000-d571-000000000009"],
  ["board", "00000000-0000-4000-d571-000000000010"],
  ["mine", "00000000-0000-4000-d571-000000000011"],
  ["r1", "00000000-0000-4000-d571-000000000012"],
  ["r2", "00000000-0000-4000-d571-000000000013"],
  ["r3", "00000000-0000-4000-d571-000000000014"],
  ["zoe", "00000000-0000-4000-d571-000000000015"],
]);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

describe("Airtable Model Conformance", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let authorizationModelId: string;
  let tsfga: TsfgaClient;
  let fixture: FixtureRecord;

  function can(
    objectType: string,
    objectId: string,
    relation: string,
    subject: string,
    expected: boolean,
  ): Promise<void> {
    return expectConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType,
        objectId: uuid(objectId),
        relation,
        subjectType: "user_c3t",
        subjectId: uuid(subject),
      },
      expected,
    );
  }

  beforeAll(async () => {
    assertUuidMapInjective(uuidMap);
    assertUuidMapCovers("./airtable/tuples.yaml", uuidMap);

    db = getDb();
    await beginTransaction(db);

    tsfga = createTsfga(new KyselyTupleStore(db));
    fixture = recordFixture(tsfga);

    const plain = {
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    } as const;
    const groupMember = { type: "group_c3t", relation: "member" } as const;

    await tsfga.writeRelationConfig({
      objectType: "group_c3t",
      relation: "member",
      directlyAssignable: [{ type: "user_c3t" }, groupMember],
      ...plain,
    });

    await tsfga.writeRelationConfig({
      objectType: "workspace_c3t",
      relation: "owner",
      directlyAssignable: [{ type: "user_c3t" }],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "workspace_c3t",
      relation: "collaborator",
      directlyAssignable: [{ type: "user_c3t" }, groupMember],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "workspace_c3t",
      relation: "can_manage",
      directlyAssignable: [],
      ...plain,
      computedUserset: "owner",
    });
    await tsfga.writeRelationConfig({
      objectType: "workspace_c3t",
      relation: "can_access",
      directlyAssignable: [],
      ...plain,
      impliedBy: ["collaborator", "owner"],
    });

    await tsfga.writeRelationConfig({
      objectType: "base_c3t",
      relation: "workspace",
      directlyAssignable: [{ type: "workspace_c3t" }],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "base_c3t",
      relation: "editor",
      directlyAssignable: [{ type: "user_c3t" }, groupMember],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "base_c3t",
      relation: "can_manage",
      directlyAssignable: [],
      ...plain,
      tupleToUserset: [
        { tupleset: "workspace", computedUserset: "can_manage" },
      ],
    });
    await tsfga.writeRelationConfig({
      objectType: "base_c3t",
      relation: "can_edit",
      directlyAssignable: [],
      ...plain,
      impliedBy: ["editor", "can_manage"],
    });
    await tsfga.writeRelationConfig({
      objectType: "base_c3t",
      relation: "can_view",
      directlyAssignable: [],
      ...plain,
      impliedBy: ["can_edit"],
      tupleToUserset: [
        { tupleset: "workspace", computedUserset: "can_access" },
      ],
    });

    await tsfga.writeRelationConfig({
      objectType: "table_c3t",
      relation: "base",
      directlyAssignable: [{ type: "base_c3t" }],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "table_c3t",
      relation: "hidden",
      directlyAssignable: [{ type: "user_c3t", wildcard: true }],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "table_c3t",
      relation: "inherited_view",
      directlyAssignable: [],
      ...plain,
      tupleToUserset: [{ tupleset: "base", computedUserset: "can_view" }],
    });
    await tsfga.writeRelationConfig({
      objectType: "table_c3t",
      relation: "can_edit",
      directlyAssignable: [],
      ...plain,
      tupleToUserset: [{ tupleset: "base", computedUserset: "can_edit" }],
    });
    await tsfga.writeRelationConfig({
      objectType: "table_c3t",
      relation: "can_view",
      directlyAssignable: [],
      ...plain,
      computedUserset: "inherited_view",
      excludedBy: "hidden",
    });

    await tsfga.writeRelationConfig({
      objectType: "view_c3t",
      relation: "table",
      directlyAssignable: [{ type: "table_c3t" }],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "view_c3t",
      relation: "locked",
      directlyAssignable: [{ type: "user_c3t", wildcard: true }],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "view_c3t",
      relation: "personal_owner",
      directlyAssignable: [{ type: "user_c3t" }],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "view_c3t",
      relation: "inherited_view",
      directlyAssignable: [],
      ...plain,
      tupleToUserset: [{ tupleset: "table", computedUserset: "can_view" }],
    });
    await tsfga.writeRelationConfig({
      objectType: "view_c3t",
      relation: "open_view",
      directlyAssignable: [],
      ...plain,
      computedUserset: "inherited_view",
      excludedBy: "locked",
    });
    await tsfga.writeRelationConfig({
      objectType: "view_c3t",
      relation: "can_view",
      directlyAssignable: [],
      ...plain,
      impliedBy: ["open_view", "personal_owner"],
    });

    await tsfga.writeRelationConfig({
      objectType: "record_c3t",
      relation: "table",
      directlyAssignable: [{ type: "table_c3t" }],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "record_c3t",
      relation: "restricted_to",
      directlyAssignable: [{ type: "user_c3t" }, groupMember],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "record_c3t",
      relation: "open",
      directlyAssignable: [{ type: "user_c3t", wildcard: true }],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "record_c3t",
      relation: "visible_to",
      directlyAssignable: [],
      ...plain,
      impliedBy: ["restricted_to", "open"],
    });
    await tsfga.writeRelationConfig({
      objectType: "record_c3t",
      relation: "can_view",
      directlyAssignable: [],
      ...plain,
      intersection: [
        {
          type: "tupleToUserset",
          tupleset: "table",
          computedUserset: "can_view",
        },
        { type: "computedUserset", relation: "visible_to" },
      ],
    });
    await tsfga.writeRelationConfig({
      objectType: "record_c3t",
      relation: "can_edit",
      directlyAssignable: [],
      ...plain,
      intersection: [
        {
          type: "tupleToUserset",
          tupleset: "table",
          computedUserset: "can_edit",
        },
        { type: "computedUserset", relation: "visible_to" },
      ],
    });

    // === Tuples (mirroring ./airtable/tuples.yaml) ===
    for (const user of ["bob", "carol"]) {
      await tsfga.addTuple({
        objectType: "group_c3t",
        objectId: uuid("eng"),
        relation: "member",
        subjectType: "user_c3t",
        subjectId: uuid(user),
      });
    }
    await tsfga.addTuple({
      objectType: "workspace_c3t",
      objectId: uuid("acme"),
      relation: "owner",
      subjectType: "user_c3t",
      subjectId: uuid("alice"),
    });
    await tsfga.addTuple({
      objectType: "workspace_c3t",
      objectId: uuid("acme"),
      relation: "collaborator",
      subjectType: "group_c3t",
      subjectId: uuid("eng"),
      subjectRelation: "member",
    });

    await tsfga.addTuple({
      objectType: "base_c3t",
      objectId: uuid("crm"),
      relation: "workspace",
      subjectType: "workspace_c3t",
      subjectId: uuid("acme"),
    });
    await tsfga.addTuple({
      objectType: "base_c3t",
      objectId: uuid("crm"),
      relation: "editor",
      subjectType: "user_c3t",
      subjectId: uuid("dan"),
    });

    for (const table of ["leads", "archive"]) {
      await tsfga.addTuple({
        objectType: "table_c3t",
        objectId: uuid(table),
        relation: "base",
        subjectType: "base_c3t",
        subjectId: uuid("crm"),
      });
    }
    await tsfga.addTuple({
      objectType: "table_c3t",
      objectId: uuid("archive"),
      relation: "hidden",
      subjectType: "user_c3t",
      subjectId: "*",
    });

    for (const view of ["board", "mine"]) {
      await tsfga.addTuple({
        objectType: "view_c3t",
        objectId: uuid(view),
        relation: "table",
        subjectType: "table_c3t",
        subjectId: uuid("leads"),
      });
    }
    await tsfga.addTuple({
      objectType: "view_c3t",
      objectId: uuid("mine"),
      relation: "locked",
      subjectType: "user_c3t",
      subjectId: "*",
    });
    await tsfga.addTuple({
      objectType: "view_c3t",
      objectId: uuid("mine"),
      relation: "personal_owner",
      subjectType: "user_c3t",
      subjectId: uuid("carol"),
    });

    const records: Array<[string, string]> = [
      ["r1", "leads"],
      ["r2", "leads"],
      ["r3", "archive"],
    ];
    for (const [record, table] of records) {
      await tsfga.addTuple({
        objectType: "record_c3t",
        objectId: uuid(record),
        relation: "table",
        subjectType: "table_c3t",
        subjectId: uuid(table),
      });
    }
    for (const record of ["r1", "r3"]) {
      await tsfga.addTuple({
        objectType: "record_c3t",
        objectId: uuid(record),
        relation: "open",
        subjectType: "user_c3t",
        subjectId: "*",
      });
    }
    await tsfga.addTuple({
      objectType: "record_c3t",
      objectId: uuid("r2"),
      relation: "restricted_to",
      subjectType: "group_c3t",
      subjectId: uuid("eng"),
      subjectRelation: "member",
    });

    storeId = await fgaCreateStore("airtable");
    authorizationModelId = await fgaWriteModel(storeId, "./airtable/model.dsl");
    await fgaWriteTuples(
      storeId,
      "./airtable/tuples.yaml",
      authorizationModelId,
      uuidMap,
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  // --- Where each right enters the tree ---

  test("1: the owner manages the workspace", async () => {
    await can("workspace_c3t", "acme", "can_manage", "alice", true);
  });

  test("2: a collaborator does not", async () => {
    await can("workspace_c3t", "acme", "can_manage", "bob", false);
  });

  test("3: the group userset carries collaboration", async () => {
    await can("workspace_c3t", "acme", "can_access", "bob", true);
    await can("workspace_c3t", "acme", "can_access", "carol", true);
  });

  test("4: the base editor has no workspace access at all", async () => {
    await can("workspace_c3t", "acme", "can_access", "dan", false);
  });

  test("5: and edits the base regardless", async () => {
    await can("base_c3t", "crm", "can_edit", "dan", true);
  });

  test("6: the owner edits it through can_manage", async () => {
    await can("base_c3t", "crm", "can_edit", "alice", true);
  });

  test("7: a collaborator only views it", async () => {
    await can("base_c3t", "crm", "can_view", "bob", true);
    await can("base_c3t", "crm", "can_edit", "bob", false);
  });

  test("8: a stranger reaches neither", async () => {
    await can("base_c3t", "crm", "can_view", "zoe", false);
  });

  // --- The table, and the one that is hidden ---

  test("9: everyone with base access views the leads table", async () => {
    await can("table_c3t", "leads", "can_view", "alice", true);
    await can("table_c3t", "leads", "can_view", "bob", true);
    await can("table_c3t", "leads", "can_view", "dan", true);
  });

  test("10: the archive is hidden from all of them", async () => {
    await can("table_c3t", "archive", "inherited_view", "alice", true);
    await can("table_c3t", "archive", "can_view", "alice", false);
    await can("table_c3t", "archive", "can_view", "dan", false);
  });

  test("11: hiding a table does not stop editing it", async () => {
    await can("table_c3t", "archive", "can_edit", "dan", true);
    await can("table_c3t", "archive", "can_edit", "bob", false);
  });

  // --- Views, and the personal one ---

  test("12: the shared view follows the table", async () => {
    await can("view_c3t", "board", "can_view", "bob", true);
    await can("view_c3t", "board", "can_view", "dan", true);
    await can("view_c3t", "board", "can_view", "zoe", false);
  });

  test("13: the locked view belongs to its owner alone", async () => {
    await can("view_c3t", "mine", "can_view", "carol", true);
    await can("view_c3t", "mine", "can_view", "bob", false);
    await can("view_c3t", "mine", "can_view", "alice", false);
  });

  test("14: the lock is what does it, not the table", async () => {
    await can("view_c3t", "mine", "inherited_view", "bob", true);
    await can("view_c3t", "mine", "open_view", "bob", false);
  });

  test("15: a personal owner outside the table sees nothing else", async () => {
    await can("view_c3t", "board", "can_view", "carol", true);
    await can("table_c3t", "archive", "can_view", "carol", false);
  });

  // --- Records: the intersection of table access and row visibility ---

  test("16: an open record follows the table", async () => {
    await can("record_c3t", "r1", "can_view", "alice", true);
    await can("record_c3t", "r1", "can_view", "bob", true);
    await can("record_c3t", "r1", "can_view", "dan", true);
  });

  test("17: and still stops at the table's edge", async () => {
    await can("record_c3t", "r1", "visible_to", "zoe", true);
    await can("record_c3t", "r1", "can_view", "zoe", false);
  });

  test("18: a restricted record narrows the table's viewers", async () => {
    await can("record_c3t", "r2", "can_view", "bob", true);
    await can("record_c3t", "r2", "can_view", "carol", true);
  });

  test("19: the base editor cannot see it", async () => {
    await can("table_c3t", "leads", "can_view", "dan", true);
    await can("record_c3t", "r2", "visible_to", "dan", false);
    await can("record_c3t", "r2", "can_view", "dan", false);
  });

  test("20: nor can the workspace owner", async () => {
    await can("record_c3t", "r2", "can_view", "alice", false);
  });

  test("21: and nobody edits it — the editors are not visible_to", async () => {
    await can("record_c3t", "r2", "can_edit", "alice", false);
    await can("record_c3t", "r2", "can_edit", "dan", false);
    await can("record_c3t", "r2", "can_edit", "bob", false);
  });

  test("22: a hidden table takes its records' view", async () => {
    await can("record_c3t", "r3", "can_view", "alice", false);
    await can("record_c3t", "r3", "can_view", "dan", false);
  });

  test("23: but not their edit", async () => {
    await can("record_c3t", "r3", "can_edit", "dan", true);
    await can("record_c3t", "r3", "can_edit", "alice", true);
    await can("record_c3t", "r3", "can_edit", "bob", false);
  });

  test("24: an open record is open to a stranger, and no more", async () => {
    await can("record_c3t", "r3", "visible_to", "zoe", true);
    await can("record_c3t", "r3", "can_edit", "zoe", false);
  });

  // --- Userset subjects at three levels ---

  test("25: the eng userset collaborates on the workspace", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "workspace_c3t",
        objectId: uuid("acme"),
        relation: "can_access",
        subjectType: "group_c3t",
        subjectId: uuid("eng"),
        subjectRelation: "member",
      },
      true,
    );
  });

  test("26: and reaches the table four dispatches down", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "table_c3t",
        objectId: uuid("leads"),
        relation: "can_view",
        subjectType: "group_c3t",
        subjectId: uuid("eng"),
        subjectRelation: "member",
      },
      true,
    );
  });

  test("27: and into the hidden one, which a `user:*` cannot hide from", async () => {
    // `hidden` admits `user_c3t:*`, and a typed wildcard covers
    // subjects of that type — not a `group_c3t#member` userset. The
    // subtraction therefore misses the userset it would catch every
    // member of.
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "table_c3t",
        objectId: uuid("archive"),
        relation: "can_view",
        subjectType: "group_c3t",
        subjectId: uuid("eng"),
        subjectRelation: "member",
      },
      true,
    );
  });

  // --- listObjects at every level ---

  test("28: the records bob may view", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "record_c3t",
        relation: "can_view",
        subjectType: "user_c3t",
        subjectId: uuid("bob"),
      },
      [uuid("r1"), uuid("r2")],
    );
  });

  test("29: the records dan may view", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "record_c3t",
        relation: "can_view",
        subjectType: "user_c3t",
        subjectId: uuid("dan"),
      },
      [uuid("r1")],
    );
  });

  test("30: the records alice may edit", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "record_c3t",
        relation: "can_edit",
        subjectType: "user_c3t",
        subjectId: uuid("alice"),
      },
      [uuid("r1"), uuid("r3")],
    );
  });

  test("31: the views carol may open", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "view_c3t",
        relation: "can_view",
        subjectType: "user_c3t",
        subjectId: uuid("carol"),
      },
      [uuid("board"), uuid("mine")],
    );
  });

  test("32: the views bob may open", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "view_c3t",
        relation: "can_view",
        subjectType: "user_c3t",
        subjectId: uuid("bob"),
      },
      [uuid("board")],
    );
  });

  test("33: the tables dan may edit", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "table_c3t",
        relation: "can_edit",
        subjectType: "user_c3t",
        subjectId: uuid("dan"),
      },
      [uuid("leads"), uuid("archive")],
    );
  });

  test("34: the records a stranger may view", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "record_c3t",
        relation: "can_view",
        subjectType: "user_c3t",
        subjectId: uuid("zoe"),
      },
      [],
    );
  });

  // --- The write gate ---

  test("35: `open` takes the wildcard only", async () => {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "record_c3t",
        objectId: uuid("r2"),
        relation: "open",
        subjectType: "user_c3t",
        subjectId: uuid("dan"),
      },
      "refused",
    );
  });

  test("36: `personal_owner` takes a person only", async () => {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "view_c3t",
        objectId: uuid("board"),
        relation: "personal_owner",
        subjectType: "group_c3t",
        subjectId: uuid("eng"),
        subjectRelation: "member",
      },
      "refused",
    );
  });

  test("37: a view is not a table's base", async () => {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "table_c3t",
        objectId: uuid("leads"),
        relation: "base",
        subjectType: "view_c3t",
        subjectId: uuid("board"),
      },
      "refused",
    );
  });

  test("38: an intersection relation takes no tuple", async () => {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "record_c3t",
        objectId: uuid("r1"),
        relation: "can_view",
        subjectType: "user_c3t",
        subjectId: uuid("zoe"),
      },
      "refused",
    );
  });

  test("39: restricting a record to one person is allowed", async () => {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "record_c3t",
        objectId: uuid("r2"),
        relation: "restricted_to",
        subjectType: "user_c3t",
        subjectId: uuid("dan"),
      },
      "accepted",
    );
    await can("record_c3t", "r2", "can_view", "dan", true);
    await can("record_c3t", "r2", "can_edit", "dan", true);
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./airtable/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
