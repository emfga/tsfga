import { afterAll, beforeAll, describe, test } from "bun:test";
import * as fs from "node:fs";
import {
  type CheckRequest,
  createTsfga,
  type RelationConfig,
  type TsfgaClient,
} from "@tsfga/core";
import type { DB } from "@tsfga/kysely";
import { KyselyTupleStore } from "@tsfga/kysely";
import type { Kysely } from "kysely";
import { parse as parseYaml } from "yaml";
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
  type FgaTupleYaml,
  fgaCreateStore,
  fgaWriteModel,
  fgaWriteTuples,
} from "./helpers/openfga.ts";

// Mined from upstream's AuthZEN suite,
// `tests/authzen/evaluation_test.go` (v1.18.2). Its models are
// plain `[user with <condition>]` relations, so the interesting
// part is the conditions: `in` over a list, `size()` over a list,
// indexing a map, and a three-parameter condition combining them.
// `size()` and map indexing are the two CEL forms the rest of the
// suite never reaches.

const FIXTURE = "./authzen";
const MODEL = `${FIXTURE}/model.dsl`;
const TUPLES = `${FIXTURE}/tuples.yaml`;

const U = "user_b2a";
const D = "doc_b2a";

const names = ["alice", "bob", "d1", "d2"];
const uuidMap = new Map<string, string>();
for (const [i, name] of names.entries()) {
  uuidMap.set(
    name,
    `00000000-0000-4000-d490-${String(900 + i).padStart(12, "0")}`,
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

function parseRef(ref: string): { type: string; id: string } {
  const colon = ref.indexOf(":");
  return { type: ref.slice(0, colon), id: uuid(ref.slice(colon + 1)) };
}

describe("b2: container-typed conditions from the AuthZEN suite", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let authorizationModelId: string;
  let tsfgaClient: TsfgaClient;
  let fixture: FixtureRecord;

  async function check(
    relation: string,
    context: Record<string, unknown>,
    expected: CheckOutcome,
    object = "d1",
  ): Promise<void> {
    const request: CheckRequest = {
      objectType: D,
      objectId: uuid(object),
      relation,
      subjectType: U,
      subjectId: uuid("alice"),
      context,
    };
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      request,
      expected,
    );
  }

  beforeAll(async () => {
    db = getDb();
    await beginTransaction(db);

    tsfgaClient = createTsfga(new KyselyTupleStore(db));
    fixture = recordFixture(tsfgaClient);

    const conditions = [
      {
        name: "roles_c_b2a",
        expression: '"admin" in subject_roles || "editor" in subject_roles',
        parameters: { subject_roles: "list<string>" },
      },
      {
        name: "perms_c_b2a",
        expression: "size(subject_permissions) >= 2",
        parameters: { subject_permissions: "list<string>" },
      },
      {
        name: "empty_c_b2a",
        expression: "size(subject_roles) == 0",
        parameters: { subject_roles: "list<string>" },
      },
      {
        name: "meta_c_b2a",
        expression: 'subject_metadata["role"] == "admin"',
        parameters: { subject_metadata: "map<string>" },
      },
      {
        name: "limits_c_b2a",
        expression:
          'resource_limits["max_views"] > 0 && ' +
          'resource_limits["max_views"] <= 100',
        parameters: { resource_limits: "map<int>" },
      },
      {
        name: "port_c_b2a",
        expression: "action_port in resource_allowed_ports",
        parameters: {
          resource_allowed_ports: "list<int>",
          action_port: "int",
        },
      },
      {
        name: "upload_c_b2a",
        expression:
          '"verified" in subject_tags && ' +
          "size(resource_allowed_users) > 0 && action_max_size > 0",
        parameters: {
          subject_tags: "list<string>",
          resource_allowed_users: "list<string>",
          action_max_size: "int",
        },
      },
      {
        name: "meta_missing_c_b2a",
        expression: 'subject_metadata["absent"] == "x"',
        parameters: { subject_metadata: "map<string>" },
      },
    ] as const;
    for (const condition of conditions) {
      await tsfgaClient.writeConditionDefinition({
        name: condition.name,
        expression: condition.expression,
        parameters: { ...condition.parameters },
      });
    }

    const relations: Array<[string, string]> = [
      ["roles_any", "roles_c_b2a"],
      ["perms_two", "perms_c_b2a"],
      ["roles_empty", "empty_c_b2a"],
      ["meta_admin", "meta_c_b2a"],
      ["limits_ok", "limits_c_b2a"],
      ["port_ok", "port_c_b2a"],
      ["upload_ok", "upload_c_b2a"],
      ["meta_missing", "meta_missing_c_b2a"],
    ];
    for (const [relation, condition] of relations) {
      await tsfgaClient.writeRelationConfig({
        ...EMPTY,
        objectType: D,
        relation,
        directlyAssignable: [{ type: U, condition }],
      });
    }

    const yamlTuples = parseYaml(
      fs.readFileSync(TUPLES, "utf-8"),
    ) as FgaTupleYaml[];
    for (const tuple of yamlTuples) {
      const object = parseRef(tuple.object);
      const subject = parseRef(tuple.user);
      await tsfgaClient.addTuple({
        objectType: object.type,
        objectId: object.id,
        relation: tuple.relation,
        subjectType: subject.type,
        subjectId: subject.id,
        subjectRelation: null,
        conditionName: tuple.condition?.name ?? null,
        conditionContext: tuple.condition?.context ?? null,
      });
    }

    storeId = await fgaCreateStore("authzen");
    authorizationModelId = await fgaWriteModel(storeId, MODEL);
    await fgaWriteTuples(storeId, TUPLES, authorizationModelId, uuidMap);
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  test("`in` over a list<string>", async () => {
    await check("roles_any", { subject_roles: ["admin", "viewer"] }, true);
    await check("roles_any", { subject_roles: ["editor"] }, true);
    await check("roles_any", { subject_roles: ["viewer"] }, false);
    await check("roles_any", { subject_roles: [] }, false);
  });

  test("size() over a list<string>", async () => {
    await check("perms_two", { subject_permissions: ["a", "b"] }, true);
    await check("perms_two", { subject_permissions: ["a", "b", "c"] }, true);
    await check("perms_two", { subject_permissions: ["a"] }, false);
    await check("perms_two", { subject_permissions: [] }, false);
  });

  test("size() of an empty list is zero", async () => {
    await check("roles_empty", { subject_roles: [] }, true);
    await check("roles_empty", { subject_roles: ["admin"] }, false);
  });

  test("indexing a map<string>", async () => {
    await check(
      "meta_admin",
      { subject_metadata: { role: "admin", department: "engineering" } },
      true,
    );
    await check(
      "meta_admin",
      { subject_metadata: { role: "viewer", department: "sales" } },
      false,
    );
  });

  test("indexing a map<int>, twice in one expression", async () => {
    await check("limits_ok", { resource_limits: { max_views: 50 } }, true);
    await check("limits_ok", { resource_limits: { max_views: 100 } }, true);
    await check("limits_ok", { resource_limits: { max_views: 0 } }, false);
    await check("limits_ok", { resource_limits: { max_views: 101 } }, false);
  });

  test("`in` over a list<int>, the needle from another parameter", async () => {
    await check(
      "port_ok",
      { resource_allowed_ports: [80, 443, 8080], action_port: 443 },
      true,
    );
    await check(
      "port_ok",
      { resource_allowed_ports: [80, 443, 8080], action_port: 22 },
      false,
    );
    await check(
      "port_ok",
      { resource_allowed_ports: [], action_port: 80 },
      false,
    );
  });

  test("three parameters, three container forms", async () => {
    await check(
      "upload_ok",
      {
        subject_tags: ["verified"],
        resource_allowed_users: ["alice"],
        action_max_size: 100,
      },
      true,
    );
    await check(
      "upload_ok",
      {
        subject_tags: ["unverified"],
        resource_allowed_users: ["alice"],
        action_max_size: 100,
      },
      false,
    );
    await check(
      "upload_ok",
      {
        subject_tags: ["verified"],
        resource_allowed_users: [],
        action_max_size: 100,
      },
      false,
    );
    await check(
      "upload_ok",
      {
        subject_tags: ["verified"],
        resource_allowed_users: ["alice"],
        action_max_size: 0,
      },
      false,
    );
  });

  test("indexing a key the map does not have", async () => {
    // CEL has no null: an absent key is an error, not a miss.
    await check(
      "meta_missing",
      { subject_metadata: { role: "admin" } },
      "refused",
    );
    await check("meta_missing", { subject_metadata: { absent: "x" } }, true);
    await check("meta_missing", { subject_metadata: { absent: "y" } }, false);
  });

  test("the tuple's own context wins over the request's", async () => {
    await check("roles_any", { subject_roles: ["viewer"] }, true, "d2");
    await check("roles_any", {}, true, "d2");
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel(MODEL, fixture, { coverage: "complete" });
  });
});
