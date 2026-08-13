import { afterAll, beforeAll, describe, test } from "bun:test";
import { createTsfga, type TsfgaClient } from "@tsfga/core";
import type { DB } from "@tsfga/kysely";
import { KyselyTupleStore } from "@tsfga/kysely";
import type { Kysely } from "kysely";
import {
  expectConfigsMatchModel,
  expectConformance,
  expectListObjectsConformance,
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

/**
 * A Salesforce-shaped CRM: a role hierarchy, org-wide defaults, and
 * per-record sharing rules.
 *
 * `role_a6c.at_or_above` is the record-visibility rule written as a
 * recursive relation — a manager sees what a subordinate owns —
 * and `account_a6c.can_view` reaches it through `owner_role`, so a
 * grant travels *up* a chain from the role that owns the record.
 * Siblings must not see each other, which is the assertion a naive
 * "walk the whole role tree" implementation fails.
 *
 * `owd_public_read from org` is a tuple-to-userset landing on a
 * relation whose only admitted subject is a wildcard: the org-wide
 * default, reached one dispatch away rather than written on the
 * record.
 *
 * `group_a6c.member` admits `role_a6c#at_or_above`, so a sharing
 * rule names a *role* and the check has to expand a userset onto a
 * recursive relation.
 */

const uuidMap = new Map<string, string>([
  ["ceo", "00000000-0000-4000-d450-000000070001"],
  ["vp", "00000000-0000-4000-d450-000000070002"],
  ["rep", "00000000-0000-4000-d450-000000070003"],
  ["rep2", "00000000-0000-4000-d450-000000070004"],
  ["sysadmin", "00000000-0000-4000-d450-000000070005"],
  ["outsider", "00000000-0000-4000-d450-000000070006"],
  ["support", "00000000-0000-4000-d450-000000070007"],
  ["r_ceo", "00000000-0000-4000-d450-000000070010"],
  ["r_vp", "00000000-0000-4000-d450-000000070011"],
  ["r_rep", "00000000-0000-4000-d450-000000070012"],
  ["r_rep2", "00000000-0000-4000-d450-000000070013"],
  ["r_support", "00000000-0000-4000-d450-000000070014"],
  ["g_support", "00000000-0000-4000-d450-000000070020"],
  ["acme", "00000000-0000-4000-d450-000000070030"],
  ["pub", "00000000-0000-4000-d450-000000070031"],
  ["a_big", "00000000-0000-4000-d450-000000070040"],
  ["a_small", "00000000-0000-4000-d450-000000070041"],
  ["a_open", "00000000-0000-4000-d450-000000070042"],
]);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

describe("CRM Record Sharing Model Conformance", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let authorizationModelId: string;
  let tsfga: TsfgaClient;
  let fixture: FixtureRecord;

  function can(
    objectType: string,
    object: string,
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
        objectId: uuid(object),
        relation,
        subjectType: "user_a6c",
        subjectId: uuid(subject),
      },
      expected,
    );
  }

  const onAccount = (
    object: string,
    relation: string,
    subject: string,
    expected: boolean,
  ) => can("account_a6c", object, relation, subject, expected);

  beforeAll(async () => {
    db = getDb();
    await beginTransaction(db);

    tsfga = createTsfga(new KyselyTupleStore(db));
    fixture = recordFixture(tsfga);

    // === role_a6c ===
    await tsfga.writeRelationConfig({
      objectType: "role_a6c",
      relation: "parent",
      directlyAssignable: [{ type: "role_a6c" }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfga.writeRelationConfig({
      objectType: "role_a6c",
      relation: "assignee",
      directlyAssignable: [{ type: "user_a6c" }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfga.writeRelationConfig({
      objectType: "role_a6c",
      relation: "at_or_above",
      directlyAssignable: [],
      impliedBy: ["assignee"],
      computedUserset: null,
      tupleToUserset: [{ tupleset: "parent", computedUserset: "at_or_above" }],
      excludedBy: null,
      intersection: null,
    });

    // === group_a6c ===
    await tsfga.writeRelationConfig({
      objectType: "group_a6c",
      relation: "member",
      directlyAssignable: [
        { type: "user_a6c" },
        { type: "role_a6c", relation: "at_or_above" },
      ],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });

    // === org_a6c ===
    for (const relation of ["member", "sysadmin"]) {
      await tsfga.writeRelationConfig({
        objectType: "org_a6c",
        relation,
        directlyAssignable: [{ type: "user_a6c" }],
        impliedBy: null,
        computedUserset: null,
        tupleToUserset: null,
        excludedBy: null,
        intersection: null,
      });
    }
    await tsfga.writeRelationConfig({
      objectType: "org_a6c",
      relation: "owd_public_read",
      directlyAssignable: [{ type: "user_a6c", wildcard: true }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });

    // === account_a6c ===
    await tsfga.writeRelationConfig({
      objectType: "account_a6c",
      relation: "org",
      directlyAssignable: [{ type: "org_a6c" }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    for (const relation of ["owner", "confidential"]) {
      await tsfga.writeRelationConfig({
        objectType: "account_a6c",
        relation,
        directlyAssignable: [{ type: "user_a6c" }],
        impliedBy: null,
        computedUserset: null,
        tupleToUserset: null,
        excludedBy: null,
        intersection: null,
      });
    }
    await tsfga.writeRelationConfig({
      objectType: "account_a6c",
      relation: "owner_role",
      directlyAssignable: [{ type: "role_a6c" }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfga.writeRelationConfig({
      objectType: "account_a6c",
      relation: "shared_with",
      directlyAssignable: [
        { type: "user_a6c" },
        { type: "group_a6c", relation: "member" },
      ],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfga.writeRelationConfig({
      objectType: "account_a6c",
      relation: "can_view",
      directlyAssignable: [],
      impliedBy: ["owner", "shared_with"],
      computedUserset: null,
      tupleToUserset: [
        { tupleset: "owner_role", computedUserset: "at_or_above" },
        { tupleset: "org", computedUserset: "owd_public_read" },
        { tupleset: "org", computedUserset: "sysadmin" },
      ],
      excludedBy: null,
      intersection: null,
    });
    await tsfga.writeRelationConfig({
      objectType: "account_a6c",
      relation: "can_edit",
      directlyAssignable: [],
      impliedBy: ["owner"],
      computedUserset: null,
      tupleToUserset: [
        { tupleset: "owner_role", computedUserset: "at_or_above" },
      ],
      excludedBy: null,
      intersection: null,
    });
    await tsfga.writeRelationConfig({
      objectType: "account_a6c",
      relation: "can_view_gated",
      directlyAssignable: [],
      impliedBy: null,
      computedUserset: "can_view",
      tupleToUserset: null,
      excludedBy: "confidential",
      intersection: null,
    });
    await tsfga.writeRelationConfig({
      objectType: "account_a6c",
      relation: "can_transfer",
      directlyAssignable: [],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: [
        { type: "computedUserset", relation: "can_edit" },
        {
          type: "tupleToUserset",
          tupleset: "org",
          computedUserset: "sysadmin",
        },
      ],
    });

    // === Tuples ===
    const user = (
      objectType: string,
      object: string,
      relation: string,
      subject: string,
    ) =>
      tsfga.addTuple({
        objectType,
        objectId: uuid(object),
        relation,
        subjectType: "user_a6c",
        subjectId: uuid(subject),
      });

    for (const [child, parent] of [
      ["r_vp", "r_ceo"],
      ["r_rep", "r_vp"],
      ["r_rep2", "r_vp"],
    ] as Array<[string, string]>) {
      await tsfga.addTuple({
        objectType: "role_a6c",
        objectId: uuid(child),
        relation: "parent",
        subjectType: "role_a6c",
        subjectId: uuid(parent),
      });
    }
    for (const [role, person] of [
      ["r_ceo", "ceo"],
      ["r_vp", "vp"],
      ["r_rep", "rep"],
      ["r_rep2", "rep2"],
      ["r_support", "support"],
    ] as Array<[string, string]>) {
      await user("role_a6c", role, "assignee", person);
    }

    await tsfga.addTuple({
      objectType: "group_a6c",
      objectId: uuid("g_support"),
      relation: "member",
      subjectType: "role_a6c",
      subjectId: uuid("r_support"),
      subjectRelation: "at_or_above",
    });

    for (const person of ["ceo", "vp", "rep", "rep2", "sysadmin"]) {
      await user("org_a6c", "acme", "member", person);
    }
    await user("org_a6c", "acme", "sysadmin", "sysadmin");
    await user("org_a6c", "acme", "sysadmin", "ceo");
    await tsfga.addTuple({
      objectType: "org_a6c",
      objectId: uuid("pub"),
      relation: "owd_public_read",
      subjectType: "user_a6c",
      subjectId: "*",
    });

    for (const [account, org] of [
      ["a_big", "acme"],
      ["a_small", "acme"],
      ["a_open", "pub"],
    ] as Array<[string, string]>) {
      await tsfga.addTuple({
        objectType: "account_a6c",
        objectId: uuid(account),
        relation: "org",
        subjectType: "org_a6c",
        subjectId: uuid(org),
      });
    }
    await user("account_a6c", "a_big", "owner", "rep");
    await user("account_a6c", "a_big", "confidential", "vp");
    await user("account_a6c", "a_small", "owner", "rep2");
    await user("account_a6c", "a_open", "owner", "rep");
    for (const [account, role] of [
      ["a_big", "r_rep"],
      ["a_small", "r_rep2"],
      ["a_open", "r_rep"],
    ] as Array<[string, string]>) {
      await tsfga.addTuple({
        objectType: "account_a6c",
        objectId: uuid(account),
        relation: "owner_role",
        subjectType: "role_a6c",
        subjectId: uuid(role),
      });
    }
    await tsfga.addTuple({
      objectType: "account_a6c",
      objectId: uuid("a_small"),
      relation: "shared_with",
      subjectType: "group_a6c",
      subjectId: uuid("g_support"),
      subjectRelation: "member",
    });

    storeId = await fgaCreateStore("crm");
    authorizationModelId = await fgaWriteModel(storeId, "./crm/model.dsl");
    await fgaWriteTuples(
      storeId,
      "./crm/tuples.yaml",
      authorizationModelId,
      uuidMap,
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  // --- The role hierarchy on its own ---

  test("1: a rep is at his own role", async () => {
    await can("role_a6c", "r_rep", "at_or_above", "rep", true);
  });

  test("2: the vp is above the rep's role", async () => {
    await can("role_a6c", "r_rep", "at_or_above", "vp", true);
  });

  test("3: the ceo is two levels above it", async () => {
    await can("role_a6c", "r_rep", "at_or_above", "ceo", true);
  });

  test("4: a sibling rep is not above it", async () => {
    await can("role_a6c", "r_rep", "at_or_above", "rep2", false);
  });

  test("5: the rep is not above the ceo's role", async () => {
    await can("role_a6c", "r_ceo", "at_or_above", "rep", false);
  });

  test("6: the vp is not above the ceo's role", async () => {
    await can("role_a6c", "r_ceo", "at_or_above", "vp", false);
  });

  test("7: the detached support role reaches nobody upward", async () => {
    await can("role_a6c", "r_support", "at_or_above", "ceo", false);
  });

  test("8: support is at his own role", async () => {
    await can("role_a6c", "r_support", "at_or_above", "support", true);
  });

  // --- A sharing group naming a role rather than users ---

  test("9: support is a group member through role_a6c:r_support#at_or_above", async () => {
    await can("group_a6c", "g_support", "member", "support", true);
  });

  test("10: the ceo is not, because the support role has no parent", async () => {
    await can("group_a6c", "g_support", "member", "ceo", false);
  });

  // --- Record visibility travelling up the role chain ---

  test("11: the owner sees his own account", async () => {
    await onAccount("a_big", "can_view", "rep", true);
  });

  test("12: the vp sees it through the role hierarchy", async () => {
    await onAccount("a_big", "can_view", "vp", true);
  });

  test("13: the ceo sees it two roles up", async () => {
    await onAccount("a_big", "can_view", "ceo", true);
  });

  test("14: a sibling rep does not see it", async () => {
    await onAccount("a_big", "can_view", "rep2", false);
  });

  test("15: support does not see it", async () => {
    await onAccount("a_big", "can_view", "support", false);
  });

  test("16: an outsider does not see it", async () => {
    await onAccount("a_big", "can_view", "outsider", false);
  });

  test("17: the sysadmin sees it by org privilege", async () => {
    await onAccount("a_big", "can_view", "sysadmin", true);
  });

  // --- Editing follows the hierarchy but not the org privilege ---

  test("18: the vp edits the rep's account", async () => {
    await onAccount("a_big", "can_edit", "vp", true);
  });

  test("19: the sysadmin does not — org privilege grants viewing only", async () => {
    await onAccount("a_big", "can_edit", "sysadmin", false);
  });

  test("20: a sibling rep does not edit it", async () => {
    await onAccount("a_big", "can_edit", "rep2", false);
  });

  test("21: the owner edits it", async () => {
    await onAccount("a_big", "can_edit", "rep", true);
  });

  // --- Per-record exclusion over the inherited grant ---

  test("22: the vp loses the gated view — flagged confidential", async () => {
    await onAccount("a_big", "can_view_gated", "vp", false);
  });

  test("23: the ceo keeps it", async () => {
    await onAccount("a_big", "can_view_gated", "ceo", true);
  });

  test("24: the owner keeps it", async () => {
    await onAccount("a_big", "can_view_gated", "rep", true);
  });

  test("25: the flag does not create access for a sibling", async () => {
    await onAccount("a_big", "can_view_gated", "rep2", false);
  });

  // --- Sharing rules, which the hierarchy does not reach ---

  test("26: support sees a_small through the sharing group", async () => {
    await onAccount("a_small", "can_view", "support", true);
  });

  test("27: but does not edit it", async () => {
    await onAccount("a_small", "can_edit", "support", false);
  });

  test("28: the vp sees a_small through the other branch of the tree", async () => {
    await onAccount("a_small", "can_view", "vp", true);
  });

  test("29: the first rep does not see his sibling's account", async () => {
    await onAccount("a_small", "can_view", "rep", false);
  });

  // --- Org-wide default: a TTU landing on a wildcard-only relation ---

  test("30: an outsider reads the public org's account", async () => {
    await onAccount("a_open", "can_view", "outsider", true);
  });

  test("31: support reads it too", async () => {
    await onAccount("a_open", "can_view", "support", true);
  });

  test("32: the default grants no editing", async () => {
    await onAccount("a_open", "can_edit", "outsider", false);
  });

  test("33: and it survives the confidential gate, which is empty here", async () => {
    await onAccount("a_open", "can_view_gated", "outsider", true);
  });

  test("34: the private org grants an outsider nothing", async () => {
    await onAccount("a_small", "can_view", "outsider", false);
  });

  // --- Intersection: edit rights and org privilege at once ---

  test("35: the ceo transfers a_big — he edits it and is a sysadmin", async () => {
    await onAccount("a_big", "can_transfer", "ceo", true);
  });

  test("36: the vp cannot — he edits it but is no sysadmin", async () => {
    await onAccount("a_big", "can_transfer", "vp", false);
  });

  test("37: the sysadmin cannot — sysadmin, but no edit right", async () => {
    await onAccount("a_big", "can_transfer", "sysadmin", false);
  });

  test("38: the owner cannot transfer his own account", async () => {
    await onAccount("a_big", "can_transfer", "rep", false);
  });

  test("39: the ceo cannot transfer a_open — the public org has no sysadmin", async () => {
    await onAccount("a_open", "can_transfer", "ceo", false);
  });

  // --- listObjects across hierarchy, sharing and defaults ---

  test("40: every account the ceo may view", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "account_a6c",
        relation: "can_view",
        subjectType: "user_a6c",
        subjectId: uuid("ceo"),
      },
      [uuid("a_big"), uuid("a_small"), uuid("a_open")],
    );
  });

  test("41: every account the first rep may view", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "account_a6c",
        relation: "can_view",
        subjectType: "user_a6c",
        subjectId: uuid("rep"),
      },
      [uuid("a_big"), uuid("a_open")],
    );
  });

  test("42: every account an outsider may view", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "account_a6c",
        relation: "can_view",
        subjectType: "user_a6c",
        subjectId: uuid("outsider"),
      },
      [uuid("a_open")],
    );
  });

  test("43: every account support may view", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "account_a6c",
        relation: "can_view",
        subjectType: "user_a6c",
        subjectId: uuid("support"),
      },
      [uuid("a_small"), uuid("a_open")],
    );
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./crm/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
