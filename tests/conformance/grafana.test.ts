import { afterAll, beforeAll, describe, test } from "bun:test";
import { createTsfga, type TsfgaClient } from "@tsfga/core";
import type { DB } from "@tsfga/kysely";
import { KyselyTupleStore } from "@tsfga/kysely";
import type { Kysely } from "kysely";
import { expectConformance } from "./helpers/conformance.ts";
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

// Ref: Grafana Zanzana authorization schema
// Tests folder parent TTU cascade, deep impliedBy hierarchy,
// userset subjects (team#member, role#assignee), CEL conditions
// with string equality and list membership (`in` operator),
// hyphenated type names (service-account), group_resource with render,
// anonymous assignee, and subresource hierarchy on folder/team/user/role

const uuidMap = new Map<string, string>([
  ["alice", "00000000-0000-4000-c100-000000000001"],
  ["bob", "00000000-0000-4000-c100-000000000002"],
  ["charlie", "00000000-0000-4000-c100-000000000003"],
  ["diana", "00000000-0000-4000-c100-000000000004"],
  ["eve", "00000000-0000-4000-c100-000000000005"],
  ["bot", "00000000-0000-4000-c100-000000000006"],
  ["platform", "00000000-0000-4000-c100-000000000007"],
  ["viewer", "00000000-0000-4000-c100-000000000008"],
  ["root", "00000000-0000-4000-c100-000000000009"],
  ["dashboards", "00000000-0000-4000-c100-00000000000a"],
  ["alerts", "00000000-0000-4000-c100-00000000000b"],
  ["res_dashboards", "00000000-0000-4000-c100-00000000000c"],
  ["anon", "00000000-0000-4000-c100-00000000000d"],
  ["renderer", "00000000-0000-4000-c100-00000000000e"],
  ["gr_dashboards", "00000000-0000-4000-c100-00000000000f"],
  ["editor", "00000000-0000-4000-c100-000000000010"],
  ["frank", "00000000-0000-4000-c100-000000000011"],
  ["monitor", "00000000-0000-4000-c100-000000000012"],
]);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

describe("Grafana Model Conformance", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let authorizationModelId: string;
  let tsfgaClient: TsfgaClient;

  beforeAll(async () => {
    db = getDb();
    await beginTransaction(db);

    const store = new KyselyTupleStore(db);
    tsfgaClient = createTsfga(store);

    // === Condition definitions ===
    await tsfgaClient.writeConditionDefinition({
      name: "group_filter",
      expression: "requested_group == group_resource",
      parameters: {
        requested_group: "string",
        group_resource: "string",
      },
    });
    await tsfgaClient.writeConditionDefinition({
      name: "subresource_filter",
      expression: "subresource in subresources",
      parameters: {
        subresource: "string",
        subresources: "list",
      },
    });

    // === Relation configs ===

    // --- Core types: user ---
    await tsfgaClient.writeRelationConfig({
      objectType: "user",
      relation: "get",
      directlyAssignable: [
        "user",
        "service-account",
        "team#member",
        "role#assignee",
      ],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "user",
      relation: "update",
      directlyAssignable: [
        "user",
        "service-account",
        "team#member",
        "role#assignee",
      ],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "user",
      relation: "delete",
      directlyAssignable: [
        "user",
        "service-account",
        "team#member",
        "role#assignee",
      ],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    // user subresource hierarchy
    await tsfgaClient.writeRelationConfig({
      objectType: "user",
      relation: "resource_admin",
      directlyAssignable: [
        "user",
        "service-account",
        "team#member",
        "role#assignee",
      ],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "user",
      relation: "resource_edit",
      directlyAssignable: [
        "user",
        "service-account",
        "team#member",
        "role#assignee",
      ],
      impliedBy: ["resource_admin"],
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "user",
      relation: "resource_view",
      directlyAssignable: [
        "user",
        "service-account",
        "team#member",
        "role#assignee",
      ],
      impliedBy: ["resource_edit"],
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "user",
      relation: "resource_get",
      directlyAssignable: [
        "user",
        "service-account",
        "team#member",
        "role#assignee",
      ],
      impliedBy: ["resource_view"],
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "user",
      relation: "resource_create",
      directlyAssignable: [
        "user",
        "service-account",
        "team#member",
        "role#assignee",
      ],
      impliedBy: ["resource_edit"],
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "user",
      relation: "resource_update",
      directlyAssignable: [
        "user",
        "service-account",
        "team#member",
        "role#assignee",
      ],
      impliedBy: ["resource_edit"],
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "user",
      relation: "resource_delete",
      directlyAssignable: [
        "user",
        "service-account",
        "team#member",
        "role#assignee",
      ],
      impliedBy: ["resource_edit"],
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });

    // --- Core types: service-account ---
    await tsfgaClient.writeRelationConfig({
      objectType: "service-account",
      relation: "get",
      directlyAssignable: [
        "user",
        "service-account",
        "team#member",
        "role#assignee",
      ],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "service-account",
      relation: "update",
      directlyAssignable: [
        "user",
        "service-account",
        "team#member",
        "role#assignee",
      ],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "service-account",
      relation: "delete",
      directlyAssignable: [
        "user",
        "service-account",
        "team#member",
        "role#assignee",
      ],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    // service-account subresource hierarchy
    await tsfgaClient.writeRelationConfig({
      objectType: "service-account",
      relation: "resource_admin",
      directlyAssignable: [
        "user",
        "service-account",
        "team#member",
        "role#assignee",
      ],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "service-account",
      relation: "resource_edit",
      directlyAssignable: [
        "user",
        "service-account",
        "team#member",
        "role#assignee",
      ],
      impliedBy: ["resource_admin"],
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "service-account",
      relation: "resource_view",
      directlyAssignable: [
        "user",
        "service-account",
        "team#member",
        "role#assignee",
      ],
      impliedBy: ["resource_edit"],
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "service-account",
      relation: "resource_get",
      directlyAssignable: [
        "user",
        "service-account",
        "team#member",
        "role#assignee",
      ],
      impliedBy: ["resource_view"],
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "service-account",
      relation: "resource_create",
      directlyAssignable: [
        "user",
        "service-account",
        "team#member",
        "role#assignee",
      ],
      impliedBy: ["resource_edit"],
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "service-account",
      relation: "resource_update",
      directlyAssignable: [
        "user",
        "service-account",
        "team#member",
        "role#assignee",
      ],
      impliedBy: ["resource_edit"],
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "service-account",
      relation: "resource_delete",
      directlyAssignable: [
        "user",
        "service-account",
        "team#member",
        "role#assignee",
      ],
      impliedBy: ["resource_edit"],
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });

    // --- role ---
    await tsfgaClient.writeRelationConfig({
      objectType: "role",
      relation: "assignee",
      directlyAssignable: [
        "user",
        "service-account",
        "anonymous",
        "team#member",
        "role#assignee",
      ],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "role",
      relation: "get",
      directlyAssignable: [
        "user",
        "service-account",
        "team#member",
        "role#assignee",
      ],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "role",
      relation: "update",
      directlyAssignable: [
        "user",
        "service-account",
        "team#member",
        "role#assignee",
      ],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "role",
      relation: "delete",
      directlyAssignable: [
        "user",
        "service-account",
        "team#member",
        "role#assignee",
      ],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    // role subresource hierarchy
    await tsfgaClient.writeRelationConfig({
      objectType: "role",
      relation: "resource_admin",
      directlyAssignable: [
        "user",
        "service-account",
        "team#member",
        "role#assignee",
      ],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "role",
      relation: "resource_edit",
      directlyAssignable: [
        "user",
        "service-account",
        "team#member",
        "role#assignee",
      ],
      impliedBy: ["resource_admin"],
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "role",
      relation: "resource_view",
      directlyAssignable: [
        "user",
        "service-account",
        "team#member",
        "role#assignee",
      ],
      impliedBy: ["resource_edit"],
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "role",
      relation: "resource_get",
      directlyAssignable: [
        "user",
        "service-account",
        "team#member",
        "role#assignee",
      ],
      impliedBy: ["resource_view"],
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "role",
      relation: "resource_create",
      directlyAssignable: [
        "user",
        "service-account",
        "team#member",
        "role#assignee",
      ],
      impliedBy: ["resource_edit"],
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "role",
      relation: "resource_update",
      directlyAssignable: [
        "user",
        "service-account",
        "team#member",
        "role#assignee",
      ],
      impliedBy: ["resource_edit"],
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "role",
      relation: "resource_delete",
      directlyAssignable: [
        "user",
        "service-account",
        "team#member",
        "role#assignee",
      ],
      impliedBy: ["resource_edit"],
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });

    // --- team ---
    await tsfgaClient.writeRelationConfig({
      objectType: "team",
      relation: "admin",
      directlyAssignable: ["user", "service-account"],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "team",
      relation: "member",
      directlyAssignable: ["user", "service-account"],
      impliedBy: ["admin"],
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "team",
      relation: "get",
      directlyAssignable: [
        "user",
        "service-account",
        "team#member",
        "role#assignee",
      ],
      impliedBy: ["member"],
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "team",
      relation: "update",
      directlyAssignable: [
        "user",
        "service-account",
        "team#member",
        "role#assignee",
      ],
      impliedBy: ["admin"],
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "team",
      relation: "delete",
      directlyAssignable: [
        "user",
        "service-account",
        "team#member",
        "role#assignee",
      ],
      impliedBy: ["admin"],
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "team",
      relation: "get_permissions",
      directlyAssignable: [
        "user",
        "service-account",
        "team#member",
        "role#assignee",
      ],
      impliedBy: ["admin"],
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "team",
      relation: "set_permissions",
      directlyAssignable: [
        "user",
        "service-account",
        "team#member",
        "role#assignee",
      ],
      impliedBy: ["admin"],
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    // team subresource hierarchy
    await tsfgaClient.writeRelationConfig({
      objectType: "team",
      relation: "resource_admin",
      directlyAssignable: [
        "user",
        "service-account",
        "team#member",
        "role#assignee",
      ],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "team",
      relation: "resource_edit",
      directlyAssignable: [
        "user",
        "service-account",
        "team#member",
        "role#assignee",
      ],
      impliedBy: ["resource_admin"],
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "team",
      relation: "resource_view",
      directlyAssignable: [
        "user",
        "service-account",
        "team#member",
        "role#assignee",
      ],
      impliedBy: ["resource_edit"],
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "team",
      relation: "resource_get",
      directlyAssignable: [
        "user",
        "service-account",
        "team#member",
        "role#assignee",
      ],
      impliedBy: ["resource_view"],
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "team",
      relation: "resource_create",
      directlyAssignable: [
        "user",
        "service-account",
        "team#member",
        "role#assignee",
      ],
      impliedBy: ["resource_edit"],
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "team",
      relation: "resource_update",
      directlyAssignable: [
        "user",
        "service-account",
        "team#member",
        "role#assignee",
      ],
      impliedBy: ["resource_edit"],
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "team",
      relation: "resource_delete",
      directlyAssignable: [
        "user",
        "service-account",
        "team#member",
        "role#assignee",
      ],
      impliedBy: ["resource_edit"],
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });

    // --- folder ---
    await tsfgaClient.writeRelationConfig({
      objectType: "folder",
      relation: "parent",
      directlyAssignable: ["folder"],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "folder",
      relation: "admin",
      directlyAssignable: [
        "user",
        "service-account",
        "team#member",
        "role#assignee",
      ],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: [{ tupleset: "parent", computedUserset: "admin" }],
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "folder",
      relation: "edit",
      directlyAssignable: [
        "user",
        "service-account",
        "team#member",
        "role#assignee",
      ],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: [{ tupleset: "parent", computedUserset: "edit" }],
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "folder",
      relation: "view",
      directlyAssignable: [
        "user",
        "service-account",
        "team#member",
        "role#assignee",
      ],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: [{ tupleset: "parent", computedUserset: "view" }],
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "folder",
      relation: "get",
      directlyAssignable: [
        "user",
        "service-account",
        "team#member",
        "role#assignee",
      ],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: [{ tupleset: "parent", computedUserset: "get" }],
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "folder",
      relation: "create",
      directlyAssignable: [
        "user",
        "service-account",
        "team#member",
        "role#assignee",
      ],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: [{ tupleset: "parent", computedUserset: "create" }],
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "folder",
      relation: "update",
      directlyAssignable: [
        "user",
        "service-account",
        "team#member",
        "role#assignee",
      ],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: [{ tupleset: "parent", computedUserset: "update" }],
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "folder",
      relation: "delete",
      directlyAssignable: [
        "user",
        "service-account",
        "team#member",
        "role#assignee",
      ],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: [{ tupleset: "parent", computedUserset: "delete" }],
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "folder",
      relation: "get_permissions",
      directlyAssignable: [
        "user",
        "service-account",
        "team#member",
        "role#assignee",
      ],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: [
        { tupleset: "parent", computedUserset: "get_permissions" },
      ],
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "folder",
      relation: "set_permissions",
      directlyAssignable: [
        "user",
        "service-account",
        "team#member",
        "role#assignee",
      ],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: [
        { tupleset: "parent", computedUserset: "set_permissions" },
      ],
      excludedBy: null,
      intersection: null,
    });
    // folder computed can_* relations
    await tsfgaClient.writeRelationConfig({
      objectType: "folder",
      relation: "can_get",
      directlyAssignable: [],
      impliedBy: ["admin", "edit", "view", "get"],
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "folder",
      relation: "can_create",
      directlyAssignable: [],
      impliedBy: ["admin", "edit", "create"],
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "folder",
      relation: "can_update",
      directlyAssignable: [],
      impliedBy: ["admin", "edit", "update"],
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "folder",
      relation: "can_delete",
      directlyAssignable: [],
      impliedBy: ["admin", "edit", "delete"],
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "folder",
      relation: "can_get_permissions",
      directlyAssignable: [],
      impliedBy: ["admin", "get_permissions"],
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "folder",
      relation: "can_set_permissions",
      directlyAssignable: [],
      impliedBy: ["admin", "set_permissions"],
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    // folder subresource hierarchy
    await tsfgaClient.writeRelationConfig({
      objectType: "folder",
      relation: "resource_admin",
      directlyAssignable: [
        "user",
        "service-account",
        "team#member",
        "role#assignee",
      ],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: [
        { tupleset: "parent", computedUserset: "resource_admin" },
      ],
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "folder",
      relation: "resource_edit",
      directlyAssignable: [
        "user",
        "service-account",
        "team#member",
        "role#assignee",
      ],
      impliedBy: ["resource_admin"],
      computedUserset: null,
      tupleToUserset: [
        { tupleset: "parent", computedUserset: "resource_edit" },
      ],
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "folder",
      relation: "resource_view",
      directlyAssignable: [
        "user",
        "service-account",
        "team#member",
        "role#assignee",
      ],
      impliedBy: ["resource_edit"],
      computedUserset: null,
      tupleToUserset: [
        { tupleset: "parent", computedUserset: "resource_view" },
      ],
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "folder",
      relation: "resource_get",
      directlyAssignable: [
        "user",
        "service-account",
        "team#member",
        "role#assignee",
      ],
      impliedBy: ["resource_view"],
      computedUserset: null,
      tupleToUserset: [{ tupleset: "parent", computedUserset: "resource_get" }],
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "folder",
      relation: "resource_create",
      directlyAssignable: [
        "user",
        "service-account",
        "team#member",
        "role#assignee",
      ],
      impliedBy: ["resource_edit"],
      computedUserset: null,
      tupleToUserset: [
        { tupleset: "parent", computedUserset: "resource_create" },
      ],
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "folder",
      relation: "resource_update",
      directlyAssignable: [
        "user",
        "service-account",
        "team#member",
        "role#assignee",
      ],
      impliedBy: ["resource_edit"],
      computedUserset: null,
      tupleToUserset: [
        { tupleset: "parent", computedUserset: "resource_update" },
      ],
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "folder",
      relation: "resource_delete",
      directlyAssignable: [
        "user",
        "service-account",
        "team#member",
        "role#assignee",
      ],
      impliedBy: ["resource_edit"],
      computedUserset: null,
      tupleToUserset: [
        { tupleset: "parent", computedUserset: "resource_delete" },
      ],
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "folder",
      relation: "resource_get_permissions",
      directlyAssignable: [
        "user",
        "service-account",
        "team#member",
        "role#assignee",
      ],
      impliedBy: ["resource_admin"],
      computedUserset: null,
      tupleToUserset: [
        { tupleset: "parent", computedUserset: "resource_get_permissions" },
      ],
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "folder",
      relation: "resource_set_permissions",
      directlyAssignable: [
        "user",
        "service-account",
        "team#member",
        "role#assignee",
      ],
      impliedBy: ["resource_admin"],
      computedUserset: null,
      tupleToUserset: [
        { tupleset: "parent", computedUserset: "resource_set_permissions" },
      ],
      excludedBy: null,
      intersection: null,
    });

    // --- group_resource ---
    await tsfgaClient.writeRelationConfig({
      objectType: "group_resource",
      relation: "admin",
      directlyAssignable: [
        "user",
        "service-account",
        "team#member",
        "role#assignee",
      ],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "group_resource",
      relation: "edit",
      directlyAssignable: [
        "user",
        "service-account",
        "team#member",
        "role#assignee",
      ],
      impliedBy: ["admin"],
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "group_resource",
      relation: "view",
      directlyAssignable: [
        "user",
        "service-account",
        "render",
        "team#member",
        "role#assignee",
      ],
      impliedBy: ["edit"],
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "group_resource",
      relation: "get",
      directlyAssignable: [
        "user",
        "service-account",
        "render",
        "team#member",
        "role#assignee",
      ],
      impliedBy: ["view"],
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "group_resource",
      relation: "create",
      directlyAssignable: [
        "user",
        "service-account",
        "team#member",
        "role#assignee",
      ],
      impliedBy: ["edit"],
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "group_resource",
      relation: "update",
      directlyAssignable: [
        "user",
        "service-account",
        "team#member",
        "role#assignee",
      ],
      impliedBy: ["edit"],
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "group_resource",
      relation: "delete",
      directlyAssignable: [
        "user",
        "service-account",
        "team#member",
        "role#assignee",
      ],
      impliedBy: ["edit"],
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "group_resource",
      relation: "get_permissions",
      directlyAssignable: [
        "user",
        "service-account",
        "render",
        "team#member",
        "role#assignee",
      ],
      impliedBy: ["admin"],
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "group_resource",
      relation: "set_permissions",
      directlyAssignable: [
        "user",
        "service-account",
        "render",
        "team#member",
        "role#assignee",
      ],
      impliedBy: ["admin"],
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });

    // --- resource ---
    await tsfgaClient.writeRelationConfig({
      objectType: "resource",
      relation: "admin",
      directlyAssignable: [
        "user",
        "service-account",
        "team#member",
        "role#assignee",
      ],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "resource",
      relation: "edit",
      directlyAssignable: [
        "user",
        "service-account",
        "team#member",
        "role#assignee",
      ],
      impliedBy: ["admin"],
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "resource",
      relation: "view",
      directlyAssignable: [
        "user",
        "service-account",
        "team#member",
        "role#assignee",
      ],
      impliedBy: ["edit"],
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "resource",
      relation: "get",
      directlyAssignable: [
        "user",
        "service-account",
        "team#member",
        "role#assignee",
      ],
      impliedBy: ["view"],
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "resource",
      relation: "update",
      directlyAssignable: [
        "user",
        "service-account",
        "team#member",
        "role#assignee",
      ],
      impliedBy: ["edit"],
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "resource",
      relation: "delete",
      directlyAssignable: [
        "user",
        "service-account",
        "team#member",
        "role#assignee",
      ],
      impliedBy: ["edit"],
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "resource",
      relation: "get_permissions",
      directlyAssignable: [
        "user",
        "service-account",
        "team#member",
        "role#assignee",
      ],
      impliedBy: ["admin"],
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "resource",
      relation: "set_permissions",
      directlyAssignable: [
        "user",
        "service-account",
        "team#member",
        "role#assignee",
      ],
      impliedBy: ["admin"],
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });

    // === Tuples ===

    // Team membership
    await tsfgaClient.addTuple({
      objectType: "team",
      objectId: uuid("platform"),
      relation: "admin",
      subjectType: "user",
      subjectId: uuid("alice"),
    });
    await tsfgaClient.addTuple({
      objectType: "team",
      objectId: uuid("platform"),
      relation: "member",
      subjectType: "user",
      subjectId: uuid("bob"),
    });
    await tsfgaClient.addTuple({
      objectType: "team",
      objectId: uuid("platform"),
      relation: "member",
      subjectType: "user",
      subjectId: uuid("charlie"),
    });

    // Role assignment
    await tsfgaClient.addTuple({
      objectType: "role",
      objectId: uuid("viewer"),
      relation: "assignee",
      subjectType: "user",
      subjectId: uuid("diana"),
    });
    await tsfgaClient.addTuple({
      objectType: "role",
      objectId: uuid("viewer"),
      relation: "assignee",
      subjectType: "anonymous",
      subjectId: uuid("anon"),
    });

    // Folder hierarchy: root -> dashboards -> alerts
    await tsfgaClient.addTuple({
      objectType: "folder",
      objectId: uuid("dashboards"),
      relation: "parent",
      subjectType: "folder",
      subjectId: uuid("root"),
    });
    await tsfgaClient.addTuple({
      objectType: "folder",
      objectId: uuid("alerts"),
      relation: "parent",
      subjectType: "folder",
      subjectId: uuid("dashboards"),
    });

    // Folder permissions
    await tsfgaClient.addTuple({
      objectType: "folder",
      objectId: uuid("root"),
      relation: "admin",
      subjectType: "user",
      subjectId: uuid("alice"),
    });
    await tsfgaClient.addTuple({
      objectType: "folder",
      objectId: uuid("dashboards"),
      relation: "edit",
      subjectType: "team",
      subjectId: uuid("platform"),
      subjectRelation: "member",
    });
    await tsfgaClient.addTuple({
      objectType: "folder",
      objectId: uuid("root"),
      relation: "view",
      subjectType: "role",
      subjectId: uuid("viewer"),
      subjectRelation: "assignee",
    });
    await tsfgaClient.addTuple({
      objectType: "folder",
      objectId: uuid("dashboards"),
      relation: "get",
      subjectType: "service-account",
      subjectId: uuid("bot"),
    });
    await tsfgaClient.addTuple({
      objectType: "folder",
      objectId: uuid("root"),
      relation: "update",
      subjectType: "service-account",
      subjectId: uuid("bot"),
    });

    // Folder subresource permissions (with condition)
    await tsfgaClient.addTuple({
      objectType: "folder",
      objectId: uuid("root"),
      relation: "resource_create",
      subjectType: "user",
      subjectId: uuid("alice"),
      conditionName: "subresource_filter",
      conditionContext: { subresources: ["dashboard", "library-panel"] },
    });
    await tsfgaClient.addTuple({
      objectType: "folder",
      objectId: uuid("dashboards"),
      relation: "resource_get",
      subjectType: "team",
      subjectId: uuid("platform"),
      subjectRelation: "member",
      conditionName: "subresource_filter",
      conditionContext: { subresources: ["dashboard"] },
    });

    // Folder subresource hierarchy (unconditional)
    await tsfgaClient.addTuple({
      objectType: "folder",
      objectId: uuid("root"),
      relation: "resource_admin",
      subjectType: "user",
      subjectId: uuid("frank"),
    });
    await tsfgaClient.addTuple({
      objectType: "folder",
      objectId: uuid("dashboards"),
      relation: "resource_edit",
      subjectType: "user",
      subjectId: uuid("charlie"),
    });
    await tsfgaClient.addTuple({
      objectType: "folder",
      objectId: uuid("dashboards"),
      relation: "resource_view",
      subjectType: "user",
      subjectId: uuid("diana"),
    });

    // Core type management
    await tsfgaClient.addTuple({
      objectType: "user",
      objectId: uuid("bob"),
      relation: "get",
      subjectType: "user",
      subjectId: uuid("alice"),
    });
    await tsfgaClient.addTuple({
      objectType: "user",
      objectId: uuid("bob"),
      relation: "get",
      subjectType: "service-account",
      subjectId: uuid("bot"),
    });
    await tsfgaClient.addTuple({
      objectType: "user",
      objectId: uuid("bob"),
      relation: "update",
      subjectType: "team",
      subjectId: uuid("platform"),
      subjectRelation: "member",
    });

    // group_resource permissions
    await tsfgaClient.addTuple({
      objectType: "group_resource",
      objectId: uuid("gr_dashboards"),
      relation: "admin",
      subjectType: "user",
      subjectId: uuid("alice"),
    });
    await tsfgaClient.addTuple({
      objectType: "group_resource",
      objectId: uuid("gr_dashboards"),
      relation: "view",
      subjectType: "render",
      subjectId: uuid("renderer"),
    });
    await tsfgaClient.addTuple({
      objectType: "group_resource",
      objectId: uuid("gr_dashboards"),
      relation: "edit",
      subjectType: "team",
      subjectId: uuid("platform"),
      subjectRelation: "member",
    });

    // Team subresource hierarchy
    await tsfgaClient.addTuple({
      objectType: "team",
      objectId: uuid("platform"),
      relation: "resource_admin",
      subjectType: "user",
      subjectId: uuid("frank"),
    });
    await tsfgaClient.addTuple({
      objectType: "team",
      objectId: uuid("platform"),
      relation: "resource_get",
      subjectType: "user",
      subjectId: uuid("eve"),
      conditionName: "subresource_filter",
      conditionContext: { subresources: ["dashboard"] },
    });

    // Resource permissions (with group_filter condition)
    await tsfgaClient.addTuple({
      objectType: "resource",
      objectId: uuid("res_dashboards"),
      relation: "admin",
      subjectType: "user",
      subjectId: uuid("alice"),
      conditionName: "group_filter",
      conditionContext: { group_resource: "grafana" },
    });
    await tsfgaClient.addTuple({
      objectType: "resource",
      objectId: uuid("res_dashboards"),
      relation: "view",
      subjectType: "team",
      subjectId: uuid("platform"),
      subjectRelation: "member",
      conditionName: "group_filter",
      conditionContext: { group_resource: "grafana" },
    });
    await tsfgaClient.addTuple({
      objectType: "resource",
      objectId: uuid("res_dashboards"),
      relation: "get",
      subjectType: "user",
      subjectId: uuid("eve"),
      conditionName: "group_filter",
      conditionContext: { group_resource: "prometheus" },
    });
    await tsfgaClient.addTuple({
      objectType: "resource",
      objectId: uuid("res_dashboards"),
      relation: "edit",
      subjectType: "service-account",
      subjectId: uuid("monitor"),
      conditionName: "group_filter",
      conditionContext: { group_resource: "grafana" },
    });

    // Role subresource
    await tsfgaClient.addTuple({
      objectType: "role",
      objectId: uuid("editor"),
      relation: "resource_edit",
      subjectType: "user",
      subjectId: uuid("alice"),
    });

    // Setup OpenFGA
    storeId = await fgaCreateStore("grafana-conformance");
    authorizationModelId = await fgaWriteModel(storeId, "./grafana/model.dsl");
    await fgaWriteTuples(
      storeId,
      "./grafana/tuples.yaml",
      authorizationModelId,
      uuidMap,
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  // --- Group 1: Team membership ---
  test("1: alice has get on team:platform (admin implies member implies get)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "team",
        objectId: uuid("platform"),
        relation: "get",
        subjectType: "user",
        subjectId: uuid("alice"),
      },
      true,
    );
  });

  test("2: bob has get on team:platform (member implies get)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "team",
        objectId: uuid("platform"),
        relation: "get",
        subjectType: "user",
        subjectId: uuid("bob"),
      },
      true,
    );
  });

  test("3: diana does not have get on team:platform", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "team",
        objectId: uuid("platform"),
        relation: "get",
        subjectType: "user",
        subjectId: uuid("diana"),
      },
      false,
    );
  });

  // --- Group 2: Folder admin cascade via parent TTU ---
  test("4: alice can_get folder:root (direct admin)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("root"),
        relation: "can_get",
        subjectType: "user",
        subjectId: uuid("alice"),
      },
      true,
    );
  });

  test("5: alice can_get folder:dashboards (admin from parent TTU)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("dashboards"),
        relation: "can_get",
        subjectType: "user",
        subjectId: uuid("alice"),
      },
      true,
    );
  });

  test("6: alice can_get folder:alerts (admin from grandparent, 2-hop TTU)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("alerts"),
        relation: "can_get",
        subjectType: "user",
        subjectId: uuid("alice"),
      },
      true,
    );
  });

  test("7: alice can_create folder:alerts (admin via TTU)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("alerts"),
        relation: "can_create",
        subjectType: "user",
        subjectId: uuid("alice"),
      },
      true,
    );
  });

  test("8: alice can_set_permissions folder:dashboards (admin via TTU)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("dashboards"),
        relation: "can_set_permissions",
        subjectType: "user",
        subjectId: uuid("alice"),
      },
      true,
    );
  });

  // --- Group 3: Team userset + TTU ---
  test("9: bob can_get folder:dashboards (team:platform#member has edit)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("dashboards"),
        relation: "can_get",
        subjectType: "user",
        subjectId: uuid("bob"),
      },
      true,
    );
  });

  test("10: bob can_create folder:dashboards (edit implies can_create)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("dashboards"),
        relation: "can_create",
        subjectType: "user",
        subjectId: uuid("bob"),
      },
      true,
    );
  });

  test("11: bob can_get folder:alerts (edit from parent TTU)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("alerts"),
        relation: "can_get",
        subjectType: "user",
        subjectId: uuid("bob"),
      },
      true,
    );
  });

  test("12: bob does not can_get folder:root (no relation on root)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("root"),
        relation: "can_get",
        subjectType: "user",
        subjectId: uuid("bob"),
      },
      false,
    );
  });

  test("13: charlie can_get folder:dashboards (team:platform#member)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("dashboards"),
        relation: "can_get",
        subjectType: "user",
        subjectId: uuid("charlie"),
      },
      true,
    );
  });

  // --- Group 4: Role assignee userset ---
  test("14: diana can_get folder:root (role:viewer#assignee has view)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("root"),
        relation: "can_get",
        subjectType: "user",
        subjectId: uuid("diana"),
      },
      true,
    );
  });

  test("15: diana can_get folder:dashboards (view from parent TTU)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("dashboards"),
        relation: "can_get",
        subjectType: "user",
        subjectId: uuid("diana"),
      },
      true,
    );
  });

  test("16: diana can_get folder:alerts (view from grandparent, 2-hop)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("alerts"),
        relation: "can_get",
        subjectType: "user",
        subjectId: uuid("diana"),
      },
      true,
    );
  });

  test("17: diana does not can_create folder:root (view does not imply create)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("root"),
        relation: "can_create",
        subjectType: "user",
        subjectId: uuid("diana"),
      },
      false,
    );
  });

  // --- Group 5: Service account access ---
  test("18: bot can_get folder:dashboards (direct get)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("dashboards"),
        relation: "can_get",
        subjectType: "service-account",
        subjectId: uuid("bot"),
      },
      true,
    );
  });

  test("19: bot can_get folder:alerts (get from parent TTU)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("alerts"),
        relation: "can_get",
        subjectType: "service-account",
        subjectId: uuid("bot"),
      },
      true,
    );
  });

  test("20: bot does not can_get folder:root (no relation on root)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("root"),
        relation: "can_get",
        subjectType: "service-account",
        subjectId: uuid("bot"),
      },
      false,
    );
  });

  // --- Group 6: Computed can_* hierarchy ---
  test("21: alice can_delete folder:root (admin implies can_delete)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("root"),
        relation: "can_delete",
        subjectType: "user",
        subjectId: uuid("alice"),
      },
      true,
    );
  });

  test("22: alice can_get_permissions folder:root (admin implies can_get_permissions)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("root"),
        relation: "can_get_permissions",
        subjectType: "user",
        subjectId: uuid("alice"),
      },
      true,
    );
  });

  test("23: bob can_delete folder:dashboards (edit implies can_delete)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("dashboards"),
        relation: "can_delete",
        subjectType: "user",
        subjectId: uuid("bob"),
      },
      true,
    );
  });

  test("24: bob does not can_set_permissions folder:dashboards (edit does not imply set_permissions)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("dashboards"),
        relation: "can_set_permissions",
        subjectType: "user",
        subjectId: uuid("bob"),
      },
      false,
    );
  });

  test("25: bob does not can_get_permissions folder:dashboards (edit does not imply get_permissions)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("dashboards"),
        relation: "can_get_permissions",
        subjectType: "user",
        subjectId: uuid("bob"),
      },
      false,
    );
  });

  // --- Group 7: Subresource filter with CEL `in` operator ---
  test("26: alice resource_create folder:root {subresource:dashboard} -> true", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("root"),
        relation: "resource_create",
        subjectType: "user",
        subjectId: uuid("alice"),
        context: { subresource: "dashboard" },
      },
      true,
    );
  });

  test("27: alice resource_create folder:root {subresource:library-panel} -> true", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("root"),
        relation: "resource_create",
        subjectType: "user",
        subjectId: uuid("alice"),
        context: { subresource: "library-panel" },
      },
      true,
    );
  });

  test("28: alice resource_create folder:root {subresource:alert-rule} -> false", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("root"),
        relation: "resource_create",
        subjectType: "user",
        subjectId: uuid("alice"),
        context: { subresource: "alert-rule" },
      },
      false,
    );
  });

  test("29: alice resource_create folder:dashboards {subresource:dashboard} -> true (parent TTU)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("dashboards"),
        relation: "resource_create",
        subjectType: "user",
        subjectId: uuid("alice"),
        context: { subresource: "dashboard" },
      },
      true,
    );
  });

  test("30: bob resource_get folder:dashboards {subresource:dashboard} -> true (team#member + condition)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("dashboards"),
        relation: "resource_get",
        subjectType: "user",
        subjectId: uuid("bob"),
        context: { subresource: "dashboard" },
      },
      true,
    );
  });

  test("31: bob resource_get folder:dashboards {subresource:alert-rule} -> false (not in list)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("dashboards"),
        relation: "resource_get",
        subjectType: "user",
        subjectId: uuid("bob"),
        context: { subresource: "alert-rule" },
      },
      false,
    );
  });

  test("32: bob resource_get folder:alerts {subresource:dashboard} -> true (parent TTU)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("alerts"),
        relation: "resource_get",
        subjectType: "user",
        subjectId: uuid("bob"),
        context: { subresource: "dashboard" },
      },
      true,
    );
  });

  // --- Group 8: Resource group_filter condition ---
  test("33: alice get resource:dashboards {requested_group:grafana} -> true (admin implies get)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "resource",
        objectId: uuid("res_dashboards"),
        relation: "get",
        subjectType: "user",
        subjectId: uuid("alice"),
        context: { requested_group: "grafana" },
      },
      true,
    );
  });

  test("34: alice get resource:dashboards {requested_group:prometheus} -> false (wrong group)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "resource",
        objectId: uuid("res_dashboards"),
        relation: "get",
        subjectType: "user",
        subjectId: uuid("alice"),
        context: { requested_group: "prometheus" },
      },
      false,
    );
  });

  test("35: bob get resource:dashboards {requested_group:grafana} -> true (team#member view implies get)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "resource",
        objectId: uuid("res_dashboards"),
        relation: "get",
        subjectType: "user",
        subjectId: uuid("bob"),
        context: { requested_group: "grafana" },
      },
      true,
    );
  });

  test("36: bob get resource:dashboards {requested_group:prometheus} -> false (wrong group)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "resource",
        objectId: uuid("res_dashboards"),
        relation: "get",
        subjectType: "user",
        subjectId: uuid("bob"),
        context: { requested_group: "prometheus" },
      },
      false,
    );
  });

  test("37: eve get resource:dashboards {requested_group:prometheus} -> true (matching group)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "resource",
        objectId: uuid("res_dashboards"),
        relation: "get",
        subjectType: "user",
        subjectId: uuid("eve"),
        context: { requested_group: "prometheus" },
      },
      true,
    );
  });

  test("38: eve get resource:dashboards {requested_group:grafana} -> false (wrong group)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "resource",
        objectId: uuid("res_dashboards"),
        relation: "get",
        subjectType: "user",
        subjectId: uuid("eve"),
        context: { requested_group: "grafana" },
      },
      false,
    );
  });

  // --- Group 9: Negative / cross-cutting ---
  test("39: eve does not can_get folder:root (no folder relation)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("root"),
        relation: "can_get",
        subjectType: "user",
        subjectId: uuid("eve"),
      },
      false,
    );
  });

  test("40: eve does not edit resource:dashboards {requested_group:prometheus} (only has get)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "resource",
        objectId: uuid("res_dashboards"),
        relation: "edit",
        subjectType: "user",
        subjectId: uuid("eve"),
        context: { requested_group: "prometheus" },
      },
      false,
    );
  });

  test("41: diana does not get resource:dashboards {requested_group:grafana} (no resource relation)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "resource",
        objectId: uuid("res_dashboards"),
        relation: "get",
        subjectType: "user",
        subjectId: uuid("diana"),
        context: { requested_group: "grafana" },
      },
      false,
    );
  });

  test("42: bob does not resource_get folder:root {subresource:dashboard} (no resource_get on root for team)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("root"),
        relation: "resource_get",
        subjectType: "user",
        subjectId: uuid("bob"),
        context: { subresource: "dashboard" },
      },
      false,
    );
  });

  test("43: diana does not can_delete folder:dashboards (view does not imply delete)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("dashboards"),
        relation: "can_delete",
        subjectType: "user",
        subjectId: uuid("diana"),
      },
      false,
    );
  });

  test("44: charlie can_create folder:alerts (team member, edit from parent TTU)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("alerts"),
        relation: "can_create",
        subjectType: "user",
        subjectId: uuid("charlie"),
      },
      true,
    );
  });

  test("45: bot does not can_create folder:dashboards (get does not imply create)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("dashboards"),
        relation: "can_create",
        subjectType: "service-account",
        subjectId: uuid("bot"),
      },
      false,
    );
  });

  // --- Group 10: Anonymous role assignee ---
  test("46: anon can_get folder:root (anonymous assignee of role:viewer, view on root)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("root"),
        relation: "can_get",
        subjectType: "anonymous",
        subjectId: uuid("anon"),
      },
      true,
    );
  });

  test("47: anon does not can_create folder:root (view does not imply create)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("root"),
        relation: "can_create",
        subjectType: "anonymous",
        subjectId: uuid("anon"),
      },
      false,
    );
  });

  // --- Group 11: Core type management ---
  test("48: alice get user:bob (direct)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "user",
        objectId: uuid("bob"),
        relation: "get",
        subjectType: "user",
        subjectId: uuid("alice"),
      },
      true,
    );
  });

  test("49: bot get user:bob (service-account direct)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "user",
        objectId: uuid("bob"),
        relation: "get",
        subjectType: "service-account",
        subjectId: uuid("bot"),
      },
      true,
    );
  });

  test("50: bob update user:bob (team:platform#member userset)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "user",
        objectId: uuid("bob"),
        relation: "update",
        subjectType: "user",
        subjectId: uuid("bob"),
      },
      true,
    );
  });

  test("51: diana does not get user:bob (no tuple)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "user",
        objectId: uuid("bob"),
        relation: "get",
        subjectType: "user",
        subjectId: uuid("diana"),
      },
      false,
    );
  });

  // --- Group 12: Team management ---
  test("52: alice update team:platform (admin implies update)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "team",
        objectId: uuid("platform"),
        relation: "update",
        subjectType: "user",
        subjectId: uuid("alice"),
      },
      true,
    );
  });

  test("53: alice delete team:platform (admin implies delete)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "team",
        objectId: uuid("platform"),
        relation: "delete",
        subjectType: "user",
        subjectId: uuid("alice"),
      },
      true,
    );
  });

  test("54: alice set_permissions team:platform (admin implies set_permissions)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "team",
        objectId: uuid("platform"),
        relation: "set_permissions",
        subjectType: "user",
        subjectId: uuid("alice"),
      },
      true,
    );
  });

  test("55: bob does not update team:platform (member does not imply update)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "team",
        objectId: uuid("platform"),
        relation: "update",
        subjectType: "user",
        subjectId: uuid("bob"),
      },
      false,
    );
  });

  test("56: alice get_permissions team:platform (admin implies get_permissions)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "team",
        objectId: uuid("platform"),
        relation: "get_permissions",
        subjectType: "user",
        subjectId: uuid("alice"),
      },
      true,
    );
  });

  // --- Group 13: Folder update/can_update ---
  test("57: alice can_update folder:root (admin implies can_update)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("root"),
        relation: "can_update",
        subjectType: "user",
        subjectId: uuid("alice"),
      },
      true,
    );
  });

  test("58: bob can_update folder:dashboards (edit implies can_update)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("dashboards"),
        relation: "can_update",
        subjectType: "user",
        subjectId: uuid("bob"),
      },
      true,
    );
  });

  test("59: bot can_update folder:root (direct update tuple)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("root"),
        relation: "can_update",
        subjectType: "service-account",
        subjectId: uuid("bot"),
      },
      true,
    );
  });

  test("60: diana does not can_update folder:root (view does not imply update)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("root"),
        relation: "can_update",
        subjectType: "user",
        subjectId: uuid("diana"),
      },
      false,
    );
  });

  // --- Group 14: group_resource with render ---
  test("61: alice get group_resource:gr_dashboards (admin chain)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "group_resource",
        objectId: uuid("gr_dashboards"),
        relation: "get",
        subjectType: "user",
        subjectId: uuid("alice"),
      },
      true,
    );
  });

  test("62: alice get_permissions group_resource:gr_dashboards (admin implies)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "group_resource",
        objectId: uuid("gr_dashboards"),
        relation: "get_permissions",
        subjectType: "user",
        subjectId: uuid("alice"),
      },
      true,
    );
  });

  test("63: renderer get group_resource:gr_dashboards (view implies get)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "group_resource",
        objectId: uuid("gr_dashboards"),
        relation: "get",
        subjectType: "render",
        subjectId: uuid("renderer"),
      },
      true,
    );
  });

  test("64: renderer does not edit group_resource:gr_dashboards (view does not imply edit)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "group_resource",
        objectId: uuid("gr_dashboards"),
        relation: "edit",
        subjectType: "render",
        subjectId: uuid("renderer"),
      },
      false,
    );
  });

  test("65: bob create group_resource:gr_dashboards (team#member edit implies create)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "group_resource",
        objectId: uuid("gr_dashboards"),
        relation: "create",
        subjectType: "user",
        subjectId: uuid("bob"),
      },
      true,
    );
  });

  // --- Group 15: Folder subresource hierarchy ---
  test("66: frank resource_view folder:root (resource_admin implied chain)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("root"),
        relation: "resource_view",
        subjectType: "user",
        subjectId: uuid("frank"),
      },
      true,
    );
  });

  test("67: frank resource_view folder:dashboards (parent TTU)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("dashboards"),
        relation: "resource_view",
        subjectType: "user",
        subjectId: uuid("frank"),
      },
      true,
    );
  });

  test("68: frank resource_get folder:root (resource_admin -> resource_edit -> resource_view implies resource_get)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("root"),
        relation: "resource_get",
        subjectType: "user",
        subjectId: uuid("frank"),
        context: { subresource: "anything" },
      },
      true,
    );
  });

  test("69: charlie resource_get folder:dashboards (resource_edit -> resource_view implies resource_get)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("dashboards"),
        relation: "resource_get",
        subjectType: "user",
        subjectId: uuid("charlie"),
        context: { subresource: "anything" },
      },
      true,
    );
  });

  test("70: diana resource_get folder:dashboards (resource_view implies resource_get)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("dashboards"),
        relation: "resource_get",
        subjectType: "user",
        subjectId: uuid("diana"),
        context: { subresource: "anything" },
      },
      true,
    );
  });

  test("71: diana does not resource_create folder:dashboards (resource_view does not reach resource_edit)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("dashboards"),
        relation: "resource_create",
        subjectType: "user",
        subjectId: uuid("diana"),
        context: { subresource: "dashboard" },
      },
      false,
    );
  });

  // --- Group 16: Folder subresource conditional operations ---
  test("72: charlie resource_update folder:dashboards (resource_edit implies)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("dashboards"),
        relation: "resource_update",
        subjectType: "user",
        subjectId: uuid("charlie"),
        context: { subresource: "anything" },
      },
      true,
    );
  });

  test("73: charlie resource_delete folder:dashboards (resource_edit implies)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("dashboards"),
        relation: "resource_delete",
        subjectType: "user",
        subjectId: uuid("charlie"),
        context: { subresource: "anything" },
      },
      true,
    );
  });

  test("74: frank resource_get_permissions folder:root (resource_admin implies)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("root"),
        relation: "resource_get_permissions",
        subjectType: "user",
        subjectId: uuid("frank"),
        context: { subresource: "anything" },
      },
      true,
    );
  });

  test("75: frank resource_set_permissions folder:dashboards (parent TTU cascade)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("dashboards"),
        relation: "resource_set_permissions",
        subjectType: "user",
        subjectId: uuid("frank"),
        context: { subresource: "anything" },
      },
      true,
    );
  });

  test("76: diana does not resource_set_permissions folder:dashboards (resource_view does not reach)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("dashboards"),
        relation: "resource_set_permissions",
        subjectType: "user",
        subjectId: uuid("diana"),
        context: { subresource: "anything" },
      },
      false,
    );
  });

  // --- Group 17: Team subresource ---
  test("77: frank resource_view team:platform (resource_admin implied chain)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "team",
        objectId: uuid("platform"),
        relation: "resource_view",
        subjectType: "user",
        subjectId: uuid("frank"),
      },
      true,
    );
  });

  test("78: frank resource_get team:platform (resource_admin -> resource_view implies)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "team",
        objectId: uuid("platform"),
        relation: "resource_get",
        subjectType: "user",
        subjectId: uuid("frank"),
        context: { subresource: "anything" },
      },
      true,
    );
  });

  test("79: eve resource_get team:platform {subresource:dashboard} -> true (conditional direct)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "team",
        objectId: uuid("platform"),
        relation: "resource_get",
        subjectType: "user",
        subjectId: uuid("eve"),
        context: { subresource: "dashboard" },
      },
      true,
    );
  });

  test("80: eve resource_get team:platform {subresource:alert-rule} -> false (not in list)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "team",
        objectId: uuid("platform"),
        relation: "resource_get",
        subjectType: "user",
        subjectId: uuid("eve"),
        context: { subresource: "alert-rule" },
      },
      false,
    );
  });

  // --- Group 18: Resource update/delete/get_permissions/set_permissions ---
  test("81: alice update resource:dashboards {requested_group:grafana} -> true (admin > edit > update)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "resource",
        objectId: uuid("res_dashboards"),
        relation: "update",
        subjectType: "user",
        subjectId: uuid("alice"),
        context: { requested_group: "grafana" },
      },
      true,
    );
  });

  test("82: alice get_permissions resource:dashboards {requested_group:grafana} -> true (admin implies)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "resource",
        objectId: uuid("res_dashboards"),
        relation: "get_permissions",
        subjectType: "user",
        subjectId: uuid("alice"),
        context: { requested_group: "grafana" },
      },
      true,
    );
  });

  test("83: alice update resource:dashboards {requested_group:prometheus} -> false (wrong group)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "resource",
        objectId: uuid("res_dashboards"),
        relation: "update",
        subjectType: "user",
        subjectId: uuid("alice"),
        context: { requested_group: "prometheus" },
      },
      false,
    );
  });

  test("84: monitor update resource:dashboards {requested_group:grafana} -> true (edit implies update)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "resource",
        objectId: uuid("res_dashboards"),
        relation: "update",
        subjectType: "service-account",
        subjectId: uuid("monitor"),
        context: { requested_group: "grafana" },
      },
      true,
    );
  });

  test("85: monitor does not get_permissions resource:dashboards {requested_group:grafana} (edit does not imply admin)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "resource",
        objectId: uuid("res_dashboards"),
        relation: "get_permissions",
        subjectType: "service-account",
        subjectId: uuid("monitor"),
        context: { requested_group: "grafana" },
      },
      false,
    );
  });

  // --- Group 19: Role subresource ---
  test("86: alice resource_view role:editor (resource_edit implies resource_view)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "role",
        objectId: uuid("editor"),
        relation: "resource_view",
        subjectType: "user",
        subjectId: uuid("alice"),
      },
      true,
    );
  });

  test("87: alice resource_get role:editor (resource_edit -> resource_view implies resource_get)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "role",
        objectId: uuid("editor"),
        relation: "resource_get",
        subjectType: "user",
        subjectId: uuid("alice"),
        context: { subresource: "anything" },
      },
      true,
    );
  });
});
