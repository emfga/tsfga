import { afterAll, beforeAll, describe, test } from "bun:test";
import { createTsfga, type TsfgaClient } from "@tsfga/core";
import type { DB } from "@tsfga/kysely";
import { KyselyTupleStore } from "@tsfga/kysely";
import type { Kysely } from "kysely";
import {
  type CheckOutcome,
  expectConfigsMatchModel,
  expectConformance,
  expectListObjectsConformance,
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
 * A Snowflake-shaped warehouse: account -> database -> schema ->
 * table, with privileges granted to roles and roles inheriting
 * from roles.
 *
 * Two seams are the point of this fixture.
 *
 * **USAGE is required at every level.** `schema_c3s.can_use` is
 * `local_use and can_use from database`, and
 * `table_c3s.can_select` is `local_select and can_use from
 * schema`: an intersection whose second operand is a
 * tuple-to-userset onto another intersection. A `SELECT` grant on
 * a table therefore means nothing without USAGE on the schema
 * *and* the database above it, which is the actual Snowflake rule
 * and the one a naive union model gets wrong in the granting
 * direction.
 *
 * **Ownership is a separate chain.** `can_admin` walks table ->
 * schema -> database -> account, and feeds both `local_select` and
 * `local_use`, so an owner three levels up satisfies both operands
 * of every intersection below.
 *
 * The 30-link role chain exercises depth on a recursive TTU
 * (`member: direct_member or member from parent`) without
 * dragging the resource tree into it, so what the ladder measures
 * is the dispatch budget and nothing else.
 */

const CHAIN = 30;

/** `r01` … `r30`, the chain the role hierarchy is built from. */
function role(index: number): string {
  return `r${String(index).padStart(2, "0")}`;
}

const uuidMap = new Map<string, string>([
  ["r02", "00000000-0000-4000-d575-000000000001"],
  ["r01", "00000000-0000-4000-d575-000000000002"],
  ["r03", "00000000-0000-4000-d575-000000000003"],
  ["r04", "00000000-0000-4000-d575-000000000004"],
  ["r05", "00000000-0000-4000-d575-000000000005"],
  ["r06", "00000000-0000-4000-d575-000000000006"],
  ["r07", "00000000-0000-4000-d575-000000000007"],
  ["r08", "00000000-0000-4000-d575-000000000008"],
  ["r09", "00000000-0000-4000-d575-000000000009"],
  ["r10", "00000000-0000-4000-d575-000000000010"],
  ["r11", "00000000-0000-4000-d575-000000000011"],
  ["r12", "00000000-0000-4000-d575-000000000012"],
  ["r13", "00000000-0000-4000-d575-000000000013"],
  ["r14", "00000000-0000-4000-d575-000000000014"],
  ["r15", "00000000-0000-4000-d575-000000000015"],
  ["r16", "00000000-0000-4000-d575-000000000016"],
  ["r17", "00000000-0000-4000-d575-000000000017"],
  ["r18", "00000000-0000-4000-d575-000000000018"],
  ["r19", "00000000-0000-4000-d575-000000000019"],
  ["r20", "00000000-0000-4000-d575-000000000020"],
  ["r21", "00000000-0000-4000-d575-000000000021"],
  ["r22", "00000000-0000-4000-d575-000000000022"],
  ["r23", "00000000-0000-4000-d575-000000000023"],
  ["r24", "00000000-0000-4000-d575-000000000024"],
  ["r25", "00000000-0000-4000-d575-000000000025"],
  ["r26", "00000000-0000-4000-d575-000000000026"],
  ["r27", "00000000-0000-4000-d575-000000000027"],
  ["r28", "00000000-0000-4000-d575-000000000028"],
  ["r29", "00000000-0000-4000-d575-000000000029"],
  ["r30", "00000000-0000-4000-d575-000000000030"],
  ["alice", "00000000-0000-4000-d575-000000000031"],
  ["bob", "00000000-0000-4000-d575-000000000032"],
  ["analyst", "00000000-0000-4000-d575-000000000033"],
  ["carol", "00000000-0000-4000-d575-000000000034"],
  ["engineer", "00000000-0000-4000-d575-000000000035"],
  ["dan", "00000000-0000-4000-d575-000000000036"],
  ["sysadmin", "00000000-0000-4000-d575-000000000037"],
  ["acme", "00000000-0000-4000-d575-000000000038"],
  ["prod", "00000000-0000-4000-d575-000000000039"],
  ["dev", "00000000-0000-4000-d575-000000000040"],
  ["sales", "00000000-0000-4000-d575-000000000041"],
  ["hr", "00000000-0000-4000-d575-000000000042"],
  ["scratch", "00000000-0000-4000-d575-000000000043"],
  ["orders", "00000000-0000-4000-d575-000000000044"],
  ["customers", "00000000-0000-4000-d575-000000000045"],
  ["salaries", "00000000-0000-4000-d575-000000000046"],
  ["notes", "00000000-0000-4000-d575-000000000047"],
  ["erin", "00000000-0000-4000-d575-000000000048"],
]);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

describe("Snowflake Model Conformance", () => {
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
    expected: CheckOutcome,
  ): Promise<void> {
    return expectConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType,
        objectId: uuid(objectId),
        relation,
        subjectType: "user_c3s",
        subjectId: uuid(subject),
      },
      expected,
    );
  }

  beforeAll(async () => {
    assertUuidMapInjective(uuidMap);
    assertUuidMapCovers("./snowflake/tuples.yaml", uuidMap);

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
    const roleMember = { type: "role_c3s", relation: "member" } as const;

    // === role_c3s ===
    await tsfga.writeRelationConfig({
      objectType: "role_c3s",
      relation: "parent",
      directlyAssignable: [{ type: "role_c3s" }],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "role_c3s",
      relation: "direct_member",
      directlyAssignable: [{ type: "user_c3s" }],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "role_c3s",
      relation: "member",
      directlyAssignable: [],
      ...plain,
      impliedBy: ["direct_member"],
      tupleToUserset: [{ tupleset: "parent", computedUserset: "member" }],
    });

    // === account_c3s ===
    await tsfga.writeRelationConfig({
      objectType: "account_c3s",
      relation: "admin",
      directlyAssignable: [roleMember],
      ...plain,
    });

    // === database_c3s ===
    await tsfga.writeRelationConfig({
      objectType: "database_c3s",
      relation: "account",
      directlyAssignable: [{ type: "account_c3s" }],
      ...plain,
    });
    for (const relation of ["owner", "usage_grant"]) {
      await tsfga.writeRelationConfig({
        objectType: "database_c3s",
        relation,
        directlyAssignable: [roleMember],
        ...plain,
      });
    }
    await tsfga.writeRelationConfig({
      objectType: "database_c3s",
      relation: "can_admin",
      directlyAssignable: [],
      ...plain,
      impliedBy: ["owner"],
      tupleToUserset: [{ tupleset: "account", computedUserset: "admin" }],
    });
    await tsfga.writeRelationConfig({
      objectType: "database_c3s",
      relation: "can_use",
      directlyAssignable: [],
      ...plain,
      impliedBy: ["usage_grant", "can_admin"],
    });

    // === schema_c3s ===
    await tsfga.writeRelationConfig({
      objectType: "schema_c3s",
      relation: "database",
      directlyAssignable: [{ type: "database_c3s" }],
      ...plain,
    });
    for (const relation of ["owner", "usage_grant"]) {
      await tsfga.writeRelationConfig({
        objectType: "schema_c3s",
        relation,
        directlyAssignable: [roleMember],
        ...plain,
      });
    }
    await tsfga.writeRelationConfig({
      objectType: "schema_c3s",
      relation: "can_admin",
      directlyAssignable: [],
      ...plain,
      impliedBy: ["owner"],
      tupleToUserset: [{ tupleset: "database", computedUserset: "can_admin" }],
    });
    await tsfga.writeRelationConfig({
      objectType: "schema_c3s",
      relation: "local_use",
      directlyAssignable: [],
      ...plain,
      impliedBy: ["usage_grant", "can_admin"],
    });
    await tsfga.writeRelationConfig({
      objectType: "schema_c3s",
      relation: "can_use",
      directlyAssignable: [],
      ...plain,
      intersection: [
        { type: "computedUserset", relation: "local_use" },
        {
          type: "tupleToUserset",
          tupleset: "database",
          computedUserset: "can_use",
        },
      ],
    });

    // === table_c3s ===
    await tsfga.writeRelationConfig({
      objectType: "table_c3s",
      relation: "schema",
      directlyAssignable: [{ type: "schema_c3s" }],
      ...plain,
    });
    for (const relation of ["owner", "masked"]) {
      await tsfga.writeRelationConfig({
        objectType: "table_c3s",
        relation,
        directlyAssignable: [roleMember],
        ...plain,
      });
    }
    await tsfga.writeRelationConfig({
      objectType: "table_c3s",
      relation: "select_grant",
      directlyAssignable: [roleMember, { type: "user_c3s" }],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "table_c3s",
      relation: "can_admin",
      directlyAssignable: [],
      ...plain,
      impliedBy: ["owner"],
      tupleToUserset: [{ tupleset: "schema", computedUserset: "can_admin" }],
    });
    await tsfga.writeRelationConfig({
      objectType: "table_c3s",
      relation: "local_select",
      directlyAssignable: [],
      ...plain,
      impliedBy: ["select_grant", "can_admin"],
    });
    await tsfga.writeRelationConfig({
      objectType: "table_c3s",
      relation: "can_select",
      directlyAssignable: [],
      ...plain,
      intersection: [
        { type: "computedUserset", relation: "local_select" },
        {
          type: "tupleToUserset",
          tupleset: "schema",
          computedUserset: "can_use",
        },
      ],
    });
    await tsfga.writeRelationConfig({
      objectType: "table_c3s",
      relation: "can_select_pii",
      directlyAssignable: [],
      ...plain,
      computedUserset: "can_select",
      excludedBy: "masked",
    });

    // === Tuples (mirroring ./snowflake/tuples.yaml) ===
    for (let i = 1; i < CHAIN; i++) {
      await tsfga.addTuple({
        objectType: "role_c3s",
        objectId: uuid(role(i)),
        relation: "parent",
        subjectType: "role_c3s",
        subjectId: uuid(role(i + 1)),
      });
    }
    const members: Array<[string, string]> = [
      [role(CHAIN), "alice"],
      ["analyst", "bob"],
      ["engineer", "carol"],
      ["sysadmin", "dan"],
    ];
    for (const [roleId, user] of members) {
      await tsfga.addTuple({
        objectType: "role_c3s",
        objectId: uuid(roleId),
        relation: "direct_member",
        subjectType: "user_c3s",
        subjectId: uuid(user),
      });
    }

    /** A grant of `relation` on an object to a role's members. */
    const grant = (
      objectType: string,
      objectId: string,
      relation: string,
      roleId: string,
    ) =>
      tsfga.addTuple({
        objectType,
        objectId: uuid(objectId),
        relation,
        subjectType: "role_c3s",
        subjectId: uuid(roleId),
        subjectRelation: "member",
      });

    await grant("account_c3s", "acme", "admin", "sysadmin");

    for (const database of ["prod", "dev"]) {
      await tsfga.addTuple({
        objectType: "database_c3s",
        objectId: uuid(database),
        relation: "account",
        subjectType: "account_c3s",
        subjectId: uuid("acme"),
      });
    }
    await grant("database_c3s", "prod", "usage_grant", "analyst");
    await grant("database_c3s", "prod", "owner", "engineer");

    const schemas: Array<[string, string]> = [
      ["sales", "prod"],
      ["hr", "prod"],
      ["scratch", "dev"],
    ];
    for (const [schema, database] of schemas) {
      await tsfga.addTuple({
        objectType: "schema_c3s",
        objectId: uuid(schema),
        relation: "database",
        subjectType: "database_c3s",
        subjectId: uuid(database),
      });
    }
    await grant("schema_c3s", "sales", "usage_grant", "analyst");
    await grant("schema_c3s", "hr", "owner", "engineer");
    await grant("schema_c3s", "scratch", "usage_grant", "analyst");

    const tables: Array<[string, string]> = [
      ["orders", "sales"],
      ["customers", "sales"],
      ["salaries", "hr"],
      ["notes", "scratch"],
    ];
    for (const [table, schema] of tables) {
      await tsfga.addTuple({
        objectType: "table_c3s",
        objectId: uuid(table),
        relation: "schema",
        subjectType: "schema_c3s",
        subjectId: uuid(schema),
      });
    }
    await grant("table_c3s", "orders", "select_grant", "analyst");
    await tsfga.addTuple({
      objectType: "table_c3s",
      objectId: uuid("customers"),
      relation: "select_grant",
      subjectType: "user_c3s",
      subjectId: uuid("bob"),
    });
    await grant("table_c3s", "customers", "masked", "analyst");
    await grant("table_c3s", "salaries", "select_grant", "analyst");
    await grant("table_c3s", "notes", "select_grant", "analyst");

    storeId = await fgaCreateStore("snowflake");
    authorizationModelId = await fgaWriteModel(
      storeId,
      "./snowflake/model.dsl",
    );
    await fgaWriteTuples(
      storeId,
      "./snowflake/tuples.yaml",
      authorizationModelId,
      uuidMap,
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  // --- Role inheritance ---

  test("1: alice is a direct member of the last role", async () => {
    await can("role_c3s", role(CHAIN), "member", "alice", true);
  });

  test("2: and an inherited member one link up", async () => {
    await can("role_c3s", role(CHAIN - 1), "member", "alice", true);
  });

  test("3: ten links up", async () => {
    await can("role_c3s", role(CHAIN - 10), "member", "alice", true);
  });

  test("4: bob's flat role is nobody else's", async () => {
    await can("role_c3s", "engineer", "member", "bob", false);
  });

  test("5: the chain does not run backwards", async () => {
    await can("role_c3s", role(CHAIN), "member", "bob", false);
  });

  // --- USAGE required at every level ---

  test("6: bob may select orders — grant, schema and database", async () => {
    await can("table_c3s", "orders", "can_select", "bob", true);
  });

  test("7: bob may select customers on a direct user grant", async () => {
    await can("table_c3s", "customers", "can_select", "bob", true);
  });

  test("8: the mask takes the PII column back", async () => {
    await can("table_c3s", "customers", "can_select_pii", "bob", false);
  });

  test("9: the mask does not touch the plain select", async () => {
    await can("table_c3s", "customers", "can_select", "bob", true);
  });

  test("10: no schema usage, so the salaries grant is inert", async () => {
    await can("schema_c3s", "hr", "can_use", "bob", false);
    await can("table_c3s", "salaries", "local_select", "bob", true);
    await can("table_c3s", "salaries", "can_select", "bob", false);
  });

  test("11: schema usage without database usage is inert too", async () => {
    await can("schema_c3s", "scratch", "local_use", "bob", true);
    await can("database_c3s", "dev", "can_use", "bob", false);
    await can("schema_c3s", "scratch", "can_use", "bob", false);
    await can("table_c3s", "notes", "can_select", "bob", false);
  });

  // --- Ownership reaching down ---

  test("12: the database owner administers the table below", async () => {
    await can("table_c3s", "orders", "can_admin", "carol", true);
  });

  test("13: and therefore selects it, both operands satisfied", async () => {
    await can("table_c3s", "orders", "can_select", "carol", true);
  });

  test("14: the mask bites the owner too — it names analyst", async () => {
    await can("table_c3s", "customers", "can_select_pii", "carol", true);
  });

  test("15: the account admin reaches the dev tree", async () => {
    await can("table_c3s", "notes", "can_select", "dan", true);
  });

  test("16: the prod owner does not reach dev", async () => {
    await can("table_c3s", "notes", "can_select", "carol", false);
  });

  test("17: a stranger reaches nothing", async () => {
    await can("table_c3s", "orders", "can_select", "erin", false);
  });

  test("18: nor does the account admin lose what he never used", async () => {
    await can("database_c3s", "dev", "usage_grant", "dan", false);
  });

  // --- Depth on the recursive role chain ---

  test("19: 20 links resolve", async () => {
    await can("role_c3s", role(CHAIN - 20), "member", "alice", true);
  });

  test("20: 23 links resolve", async () => {
    await can("role_c3s", role(CHAIN - 23), "member", "alice", true);
  });

  test("21: 24 links resolve", async () => {
    await can("role_c3s", role(CHAIN - 24), "member", "alice", true);
  });

  test("22: 29 links is past every budget — both refuse", async () => {
    await can("role_c3s", role(1), "member", "alice", "refused");
  });

  test("23: 24 links deny a stranger", async () => {
    await can("role_c3s", role(CHAIN - 24), "member", "erin", false);
  });

  test("24: a subject with a tuple elsewhere refuses past the budget", async () => {
    // bob holds `role_c3s:analyst#direct_member`, a row on the same
    // relation but off the chain. Upstream cannot rule him out from
    // the tuples alone, so it walks and exhausts, as tsfga does.
    await can("role_c3s", role(1), "member", "bob", "refused");
  });

  test("a subject with no tuples is answered past the budget", async () => {
    // Pinned, and fail-closed: tsfga refuses where upstream denies.
    //
    // erin holds no `direct_member` row anywhere. Upstream's
    // `recursiveFastPath` streams the usersets reachable from the
    // *user* alongside those reachable from the object and
    // short-circuits to `false` the moment the user side closes
    // empty — before any recursive descent, so no resolution depth
    // is spent and the answer is `false` at any chain length.
    // tsfga dispatches one hop at a time from the object side,
    // has no user-side reachability step, and so spends the same
    // 25 dispatches on an absent subject as on a present one.
    //
    // Test 24 above is the control that makes this precise: `bob`
    // holds a row on the same relation off the chain, so upstream
    // cannot rule him out from the tuples alone and exhausts
    // exactly as tsfga does. The divergence is confined to a
    // subject who reaches *nothing* through the recursive
    // relation, and it disappears below the budget — test 23 has
    // both engines answering `false` for erin at 24 links.
    //
    // Not fixed here: closing it needs a new `TupleStore` read and
    // a slice of upstream's recursive resolver, which belongs with
    // the weighted-graph work that several open divergences all
    // point at, and which should be decided as one.
    await expectPinnedDivergence(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "role_c3s",
        objectId: uuid(role(1)),
        relation: "member",
        subjectType: "user_c3s",
        subjectId: uuid("erin"),
      },
      { openfga: false, tsfga: "refused" },
    );
  });

  // --- listObjects ---

  test("25: the tables bob may select", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "table_c3s",
        relation: "can_select",
        subjectType: "user_c3s",
        subjectId: uuid("bob"),
      },
      [uuid("orders"), uuid("customers")],
    );
  });

  test("26: the tables carol may select", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "table_c3s",
        relation: "can_select",
        subjectType: "user_c3s",
        subjectId: uuid("carol"),
      },
      [uuid("orders"), uuid("customers"), uuid("salaries")],
    );
  });

  test("27: the tables dan may select", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "table_c3s",
        relation: "can_select",
        subjectType: "user_c3s",
        subjectId: uuid("dan"),
      },
      [uuid("orders"), uuid("customers"), uuid("salaries"), uuid("notes")],
    );
  });

  test("28: the databases bob may use", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "database_c3s",
        relation: "can_use",
        subjectType: "user_c3s",
        subjectId: uuid("bob"),
      },
      [uuid("prod")],
    );
  });

  test("29: the tables bob may select unmasked", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "table_c3s",
        relation: "can_select_pii",
        subjectType: "user_c3s",
        subjectId: uuid("bob"),
      },
      [uuid("orders")],
    );
  });

  // --- Userset subjects ---

  test("30: the analyst userset may itself select orders", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "table_c3s",
        objectId: uuid("orders"),
        relation: "can_select",
        subjectType: "role_c3s",
        subjectId: uuid("analyst"),
        subjectRelation: "member",
      },
      true,
    );
  });

  test("31: the engineer userset does not select notes", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "table_c3s",
        objectId: uuid("notes"),
        relation: "can_select",
        subjectType: "role_c3s",
        subjectId: uuid("engineer"),
        subjectRelation: "member",
      },
      false,
    );
  });

  // --- The write gate ---

  test("31: a user may hold a table select grant", async () => {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "table_c3s",
        objectId: uuid("orders"),
        relation: "select_grant",
        subjectType: "user_c3s",
        subjectId: uuid("erin"),
      },
      "accepted",
    );
  });

  test("32: but not a database usage grant — roles only", async () => {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "database_c3s",
        objectId: uuid("dev"),
        relation: "usage_grant",
        subjectType: "user_c3s",
        subjectId: uuid("erin"),
      },
      "refused",
    );
  });

  test("33: a bare role is not a role's members", async () => {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "database_c3s",
        objectId: uuid("dev"),
        relation: "usage_grant",
        subjectType: "role_c3s",
        subjectId: uuid("analyst"),
      },
      "refused",
    );
  });

  test("34: a table may not be a schema's database", async () => {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "schema_c3s",
        objectId: uuid("sales"),
        relation: "database",
        subjectType: "table_c3s",
        subjectId: uuid("orders"),
      },
      "refused",
    );
  });

  test("35: the intersection relation takes no tuple", async () => {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "table_c3s",
        objectId: uuid("orders"),
        relation: "can_select",
        subjectType: "user_c3s",
        subjectId: uuid("erin"),
      },
      "refused",
    );
  });

  test("36: the grant from test 31 is still gated by usage", async () => {
    await can("table_c3s", "orders", "local_select", "erin", true);
    await can("table_c3s", "orders", "can_select", "erin", false);
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./snowflake/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
