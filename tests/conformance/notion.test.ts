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
  fgaCreateStore,
  fgaWriteModel,
  fgaWriteTuples,
} from "./helpers/openfga.ts";

/**
 * A Notion-shaped model: workspace -> teamspace -> page tree.
 *
 * The composition worth probing here is the page tree. Three
 * relations recurse up `parent_page` independently — `full_access`,
 * `commenter` — while `viewer` reaches sideways into the teamspace
 * instead, so a page inherits edit rights along one axis and read
 * rights along another. Exclusion (`restricted`) sits on top of both
 * and has to bite on the inherited grant, not just the direct one.
 *
 * Public sharing is a conditioned wildcard (`user_a6:* with
 * link_shared_a6`) reached through a plain rewrite, with the flag
 * supplied by the tuple on two pages and by the request context on a
 * third.
 */

const uuidMap = new Map<string, string>([
  ["alice", "00000000-0000-4000-d450-000000010001"],
  ["bob", "00000000-0000-4000-d450-000000010002"],
  ["carol", "00000000-0000-4000-d450-000000010003"],
  ["dave", "00000000-0000-4000-d450-000000010004"],
  ["erin", "00000000-0000-4000-d450-000000010005"],
  ["frank", "00000000-0000-4000-d450-000000010006"],
  ["gina", "00000000-0000-4000-d450-000000010007"],
  ["acme", "00000000-0000-4000-d450-000000010010"],
  ["eng", "00000000-0000-4000-d450-000000010011"],
  ["design", "00000000-0000-4000-d450-000000010012"],
  ["handbook", "00000000-0000-4000-d450-000000010020"],
  ["roadmap", "00000000-0000-4000-d450-000000010021"],
  ["spec", "00000000-0000-4000-d450-000000010022"],
  ["secret", "00000000-0000-4000-d450-000000010023"],
  ["public_faq", "00000000-0000-4000-d450-000000010024"],
  ["draft_faq", "00000000-0000-4000-d450-000000010025"],
  ["ctx_faq", "00000000-0000-4000-d450-000000010026"],
]);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

describe("Notion Model Conformance", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let authorizationModelId: string;
  let tsfga: TsfgaClient;
  let fixture: FixtureRecord;

  /** `expectConformance` with the store/model/client already bound. */
  function can(
    relation: string,
    object: string,
    subject: string,
    expected: boolean,
    context?: Record<string, unknown>,
  ): Promise<void> {
    return expectConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "page_a6",
        objectId: uuid(object),
        relation,
        subjectType: "user_a6",
        subjectId: uuid(subject),
        ...(context ? { context } : {}),
      },
      expected,
    );
  }

  beforeAll(async () => {
    db = getDb();
    await beginTransaction(db);

    tsfga = createTsfga(new KyselyTupleStore(db));
    fixture = recordFixture(tsfga);

    await tsfga.writeConditionDefinition({
      name: "link_shared_a6",
      expression: "link_enabled == true",
      parameters: { link_enabled: "bool" },
    });

    // === workspace_a6 ===
    await tsfga.writeRelationConfig({
      objectType: "workspace_a6",
      relation: "owner",
      directlyAssignable: [{ type: "user_a6" }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfga.writeRelationConfig({
      objectType: "workspace_a6",
      relation: "admin",
      directlyAssignable: [{ type: "user_a6" }],
      impliedBy: ["owner"],
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfga.writeRelationConfig({
      objectType: "workspace_a6",
      relation: "member",
      directlyAssignable: [{ type: "user_a6" }],
      impliedBy: ["admin"],
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfga.writeRelationConfig({
      objectType: "workspace_a6",
      relation: "guest",
      directlyAssignable: [{ type: "user_a6" }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });

    // === teamspace_a6 ===
    await tsfga.writeRelationConfig({
      objectType: "teamspace_a6",
      relation: "workspace",
      directlyAssignable: [{ type: "workspace_a6" }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfga.writeRelationConfig({
      objectType: "teamspace_a6",
      relation: "owner",
      directlyAssignable: [{ type: "user_a6" }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfga.writeRelationConfig({
      objectType: "teamspace_a6",
      relation: "member",
      directlyAssignable: [
        { type: "user_a6" },
        { type: "workspace_a6", relation: "member" },
      ],
      impliedBy: ["owner"],
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfga.writeRelationConfig({
      objectType: "teamspace_a6",
      relation: "can_view",
      directlyAssignable: [],
      impliedBy: ["member"],
      computedUserset: null,
      tupleToUserset: [{ tupleset: "workspace", computedUserset: "admin" }],
      excludedBy: null,
      intersection: null,
    });

    // === page_a6 ===
    await tsfga.writeRelationConfig({
      objectType: "page_a6",
      relation: "parent_teamspace",
      directlyAssignable: [{ type: "teamspace_a6" }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfga.writeRelationConfig({
      objectType: "page_a6",
      relation: "parent_page",
      directlyAssignable: [{ type: "page_a6" }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfga.writeRelationConfig({
      objectType: "page_a6",
      relation: "owner",
      directlyAssignable: [{ type: "user_a6" }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfga.writeRelationConfig({
      objectType: "page_a6",
      relation: "restricted",
      directlyAssignable: [{ type: "user_a6" }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfga.writeRelationConfig({
      objectType: "page_a6",
      relation: "full_access",
      directlyAssignable: [
        { type: "user_a6" },
        { type: "teamspace_a6", relation: "member" },
      ],
      impliedBy: ["owner"],
      computedUserset: null,
      tupleToUserset: [
        { tupleset: "parent_page", computedUserset: "full_access" },
      ],
      excludedBy: null,
      intersection: null,
    });
    await tsfga.writeRelationConfig({
      objectType: "page_a6",
      relation: "can_comment_direct",
      directlyAssignable: [
        { type: "user_a6" },
        { type: "workspace_a6", relation: "guest" },
      ],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfga.writeRelationConfig({
      objectType: "page_a6",
      relation: "commenter",
      directlyAssignable: [],
      impliedBy: ["can_comment_direct", "full_access"],
      computedUserset: null,
      tupleToUserset: [
        { tupleset: "parent_page", computedUserset: "commenter" },
      ],
      excludedBy: null,
      intersection: null,
    });
    await tsfga.writeRelationConfig({
      objectType: "page_a6",
      relation: "public_viewer",
      directlyAssignable: [
        { type: "user_a6", wildcard: true, condition: "link_shared_a6" },
      ],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfga.writeRelationConfig({
      objectType: "page_a6",
      relation: "viewer",
      directlyAssignable: [{ type: "user_a6" }],
      impliedBy: ["commenter", "public_viewer"],
      computedUserset: null,
      tupleToUserset: [
        { tupleset: "parent_teamspace", computedUserset: "can_view" },
      ],
      excludedBy: null,
      intersection: null,
    });
    await tsfga.writeRelationConfig({
      objectType: "page_a6",
      relation: "can_read",
      directlyAssignable: [],
      impliedBy: null,
      computedUserset: "viewer",
      tupleToUserset: null,
      excludedBy: "restricted",
      intersection: null,
    });
    await tsfga.writeRelationConfig({
      objectType: "page_a6",
      relation: "can_edit",
      directlyAssignable: [],
      impliedBy: null,
      computedUserset: "full_access",
      tupleToUserset: null,
      excludedBy: "restricted",
      intersection: null,
    });

    // === Tuples ===
    const w = (relation: string, object: string, subject: string) =>
      tsfga.addTuple({
        objectType: "workspace_a6",
        objectId: uuid(object),
        relation,
        subjectType: "user_a6",
        subjectId: uuid(subject),
      });

    await w("owner", "acme", "alice");
    await w("admin", "acme", "bob");
    await w("member", "acme", "carol");
    await w("guest", "acme", "gina");

    await tsfga.addTuple({
      objectType: "teamspace_a6",
      objectId: uuid("eng"),
      relation: "workspace",
      subjectType: "workspace_a6",
      subjectId: uuid("acme"),
    });
    await tsfga.addTuple({
      objectType: "teamspace_a6",
      objectId: uuid("eng"),
      relation: "owner",
      subjectType: "user_a6",
      subjectId: uuid("dave"),
    });
    await tsfga.addTuple({
      objectType: "teamspace_a6",
      objectId: uuid("eng"),
      relation: "member",
      subjectType: "workspace_a6",
      subjectId: uuid("acme"),
      subjectRelation: "member",
    });
    await tsfga.addTuple({
      objectType: "teamspace_a6",
      objectId: uuid("design"),
      relation: "workspace",
      subjectType: "workspace_a6",
      subjectId: uuid("acme"),
    });

    await tsfga.addTuple({
      objectType: "page_a6",
      objectId: uuid("handbook"),
      relation: "parent_teamspace",
      subjectType: "teamspace_a6",
      subjectId: uuid("eng"),
    });
    await tsfga.addTuple({
      objectType: "page_a6",
      objectId: uuid("handbook"),
      relation: "full_access",
      subjectType: "teamspace_a6",
      subjectId: uuid("eng"),
      subjectRelation: "member",
    });
    await tsfga.addTuple({
      objectType: "page_a6",
      objectId: uuid("handbook"),
      relation: "can_comment_direct",
      subjectType: "workspace_a6",
      subjectId: uuid("acme"),
      subjectRelation: "guest",
    });

    await tsfga.addTuple({
      objectType: "page_a6",
      objectId: uuid("roadmap"),
      relation: "parent_page",
      subjectType: "page_a6",
      subjectId: uuid("handbook"),
    });
    await tsfga.addTuple({
      objectType: "page_a6",
      objectId: uuid("roadmap"),
      relation: "parent_teamspace",
      subjectType: "teamspace_a6",
      subjectId: uuid("eng"),
    });
    await tsfga.addTuple({
      objectType: "page_a6",
      objectId: uuid("roadmap"),
      relation: "viewer",
      subjectType: "user_a6",
      subjectId: uuid("erin"),
    });

    await tsfga.addTuple({
      objectType: "page_a6",
      objectId: uuid("spec"),
      relation: "parent_page",
      subjectType: "page_a6",
      subjectId: uuid("roadmap"),
    });
    await tsfga.addTuple({
      objectType: "page_a6",
      objectId: uuid("spec"),
      relation: "restricted",
      subjectType: "user_a6",
      subjectId: uuid("carol"),
    });

    await tsfga.addTuple({
      objectType: "page_a6",
      objectId: uuid("secret"),
      relation: "parent_page",
      subjectType: "page_a6",
      subjectId: uuid("handbook"),
    });
    await tsfga.addTuple({
      objectType: "page_a6",
      objectId: uuid("secret"),
      relation: "restricted",
      subjectType: "user_a6",
      subjectId: uuid("dave"),
    });

    for (const page of ["public_faq", "draft_faq", "ctx_faq"]) {
      await tsfga.addTuple({
        objectType: "page_a6",
        objectId: uuid(page),
        relation: "parent_teamspace",
        subjectType: "teamspace_a6",
        subjectId: uuid("design"),
      });
    }
    await tsfga.addTuple({
      objectType: "page_a6",
      objectId: uuid("public_faq"),
      relation: "public_viewer",
      subjectType: "user_a6",
      subjectId: "*",
      conditionName: "link_shared_a6",
      conditionContext: { link_enabled: true },
    });
    await tsfga.addTuple({
      objectType: "page_a6",
      objectId: uuid("draft_faq"),
      relation: "public_viewer",
      subjectType: "user_a6",
      subjectId: "*",
      conditionName: "link_shared_a6",
      conditionContext: { link_enabled: false },
    });
    await tsfga.addTuple({
      objectType: "page_a6",
      objectId: uuid("ctx_faq"),
      relation: "public_viewer",
      subjectType: "user_a6",
      subjectId: "*",
      conditionName: "link_shared_a6",
    });

    storeId = await fgaCreateStore("notion");
    authorizationModelId = await fgaWriteModel(storeId, "./notion/model.dsl");
    await fgaWriteTuples(
      storeId,
      "./notion/tuples.yaml",
      authorizationModelId,
      uuidMap,
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  // --- Workspace role chain reaches the teamspace ---

  test("1: carol is a teamspace member via workspace_a6:acme#member", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "teamspace_a6",
        objectId: uuid("eng"),
        relation: "member",
        subjectType: "user_a6",
        subjectId: uuid("carol"),
      },
      true,
    );
  });

  test("2: bob is a teamspace member — admin implies workspace member", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "teamspace_a6",
        objectId: uuid("eng"),
        relation: "member",
        subjectType: "user_a6",
        subjectId: uuid("bob"),
      },
      true,
    );
  });

  test("3: gina is not a teamspace member — guest is outside the chain", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "teamspace_a6",
        objectId: uuid("eng"),
        relation: "member",
        subjectType: "user_a6",
        subjectId: uuid("gina"),
      },
      false,
    );
  });

  test("4: dave owns teamspace:eng but is no workspace member", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "workspace_a6",
        objectId: uuid("acme"),
        relation: "member",
        subjectType: "user_a6",
        subjectId: uuid("dave"),
      },
      false,
    );
  });

  test("5: teamspace can_view reaches the workspace admin via TTU", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "teamspace_a6",
        objectId: uuid("design"),
        relation: "can_view",
        subjectType: "user_a6",
        subjectId: uuid("bob"),
      },
      true,
    );
  });

  test("6: teamspace:design can_view denies a plain workspace member", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "teamspace_a6",
        objectId: uuid("design"),
        relation: "can_view",
        subjectType: "user_a6",
        subjectId: uuid("carol"),
      },
      false,
    );
  });

  // --- full_access recursing up parent_page ---

  test("7: carol has full_access on the handbook", async () => {
    await can("full_access", "handbook", "carol", true);
  });

  test("8: carol inherits full_access one page down", async () => {
    await can("full_access", "roadmap", "carol", true);
  });

  test("9: carol inherits full_access two pages down", async () => {
    await can("full_access", "spec", "carol", true);
  });

  test("10: dave inherits full_access via teamspace ownership", async () => {
    await can("full_access", "spec", "dave", true);
  });

  test("11: gina never gains full_access — commenting is not editing", async () => {
    await can("full_access", "handbook", "gina", false);
  });

  test("12: frank has no full_access anywhere in the tree", async () => {
    await can("full_access", "spec", "frank", false);
  });

  // --- Exclusion bites on the inherited grant ---

  test("13: carol can edit the handbook", async () => {
    await can("can_edit", "handbook", "carol", true);
  });

  test("14: carol cannot edit spec — restricted overrides inherited access", async () => {
    await can("can_edit", "spec", "carol", false);
  });

  test("15: carol cannot read spec either", async () => {
    await can("can_read", "spec", "carol", false);
  });

  test("16: dave can edit spec — the restriction is on another page", async () => {
    await can("can_edit", "spec", "dave", true);
  });

  test("17: dave cannot edit secret — restricted there", async () => {
    await can("can_edit", "secret", "dave", false);
  });

  test("18: carol can edit secret — dave's restriction is not hers", async () => {
    await can("can_edit", "secret", "carol", true);
  });

  // --- commenter recursing on its own axis ---

  test("19: gina comments on the handbook via workspace_a6:acme#guest", async () => {
    await can("commenter", "handbook", "gina", true);
  });

  test("20: gina's comment right descends to roadmap", async () => {
    await can("commenter", "roadmap", "gina", true);
  });

  test("21: gina's comment right descends two levels to spec", async () => {
    await can("commenter", "spec", "gina", true);
  });

  test("22: gina can read spec but not edit it", async () => {
    await can("can_read", "spec", "gina", true);
  });

  test("23: gina cannot edit spec", async () => {
    await can("can_edit", "spec", "gina", false);
  });

  // --- viewer reaching sideways into the teamspace ---

  test("24: bob reads the handbook via parent_teamspace can_view", async () => {
    await can("can_read", "handbook", "bob", true);
  });

  test("25: erin reads roadmap by a direct viewer tuple", async () => {
    await can("can_read", "roadmap", "erin", true);
  });

  test("26: erin's direct viewer grant does not descend to spec", async () => {
    await can("can_read", "spec", "erin", false);
  });

  test("27: erin cannot read the handbook — viewer does not climb", async () => {
    await can("can_read", "handbook", "erin", false);
  });

  // --- Conditioned public link ---

  test("28: frank reads public_faq through the shared link", async () => {
    await can("can_read", "public_faq", "frank", true);
  });

  test("29: frank cannot read draft_faq — the link is switched off", async () => {
    await can("can_read", "draft_faq", "frank", false);
  });

  test("30: ctx_faq opens when the request context enables the link", async () => {
    await can("can_read", "ctx_faq", "frank", true, { link_enabled: true });
  });

  test("31: ctx_faq stays shut when the request context disables it", async () => {
    await can("can_read", "ctx_faq", "frank", false, { link_enabled: false });
  });

  test("32: the tuple's context wins over the request context", async () => {
    await can("can_read", "draft_faq", "frank", false, { link_enabled: true });
  });

  test("33: a shared link grants reading, never editing", async () => {
    await can("can_edit", "public_faq", "frank", false);
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./notion/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
