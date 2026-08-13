import { afterAll, beforeAll, describe, test } from "bun:test";
import { createTsfga, type TsfgaClient } from "@tsfga/core";
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

/**
 * A Figma-shaped model: org -> team -> project -> file -> branch,
 * with link sharing and branch merge rights.
 *
 * Three shapes here are not covered elsewhere in the suite.
 *
 * `file_a6f.can_publish` is `(editor or publisher) and (owner or
 * org_admin from project)` — an intersection of two *unions*. tsfga
 * has one union slot per relation (the `direct` operand's own
 * `checkBase`), so the second union has to be decomposed onto a
 * helper relation that exists in tsfga and not in the model.
 *
 * `link_active_a6f` takes two parameters and the tuple supplies only
 * one of them, so the link opens or shuts on the *request* context —
 * and a request that omits it leaves a declared parameter unbound.
 *
 * `branch_a6f.can_merge` is `author and can_edit from source_file`,
 * an intersection operand that dispatches onto an exclusion.
 */

const uuidMap = new Map<string, string>([
  ["alice", "00000000-0000-4000-d450-000000030001"],
  ["bob", "00000000-0000-4000-d450-000000030002"],
  ["carol", "00000000-0000-4000-d450-000000030003"],
  ["dave", "00000000-0000-4000-d450-000000030004"],
  ["erin", "00000000-0000-4000-d450-000000030005"],
  ["frank", "00000000-0000-4000-d450-000000030006"],
  ["acme", "00000000-0000-4000-d450-000000030010"],
  ["product", "00000000-0000-4000-d450-000000030011"],
  ["web", "00000000-0000-4000-d450-000000030020"],
  ["mobile", "00000000-0000-4000-d450-000000030021"],
  ["home", "00000000-0000-4000-d450-000000030030"],
  ["about", "00000000-0000-4000-d450-000000030031"],
  ["draft", "00000000-0000-4000-d450-000000030032"],
  ["b1", "00000000-0000-4000-d450-000000030040"],
  ["b2", "00000000-0000-4000-d450-000000030041"],
]);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

/** The domain the shared link admits. */
const ACME = { viewer_domain: "acme.com" };

describe("Figma Model Conformance", () => {
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
    expected: CheckOutcome,
    context?: Record<string, unknown>,
  ): Promise<void> {
    return expectConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType,
        objectId: uuid(object),
        relation,
        subjectType: "user_a6f",
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
      name: "link_active_a6f",
      expression: 'link_enabled && viewer_domain == "acme.com"',
      parameters: { link_enabled: "bool", viewer_domain: "string" },
    });

    // === org_a6f ===
    for (const relation of ["member", "admin"]) {
      await tsfga.writeRelationConfig({
        objectType: "org_a6f",
        relation,
        directlyAssignable: [{ type: "user_a6f" }],
        impliedBy: null,
        computedUserset: null,
        tupleToUserset: null,
        excludedBy: null,
        intersection: null,
      });
    }

    // === team_a6f ===
    await tsfga.writeRelationConfig({
      objectType: "team_a6f",
      relation: "org",
      directlyAssignable: [{ type: "org_a6f" }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfga.writeRelationConfig({
      objectType: "team_a6f",
      relation: "member",
      directlyAssignable: [
        { type: "user_a6f" },
        { type: "org_a6f", relation: "member" },
      ],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfga.writeRelationConfig({
      objectType: "team_a6f",
      relation: "admin",
      directlyAssignable: [{ type: "user_a6f" }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: [{ tupleset: "org", computedUserset: "admin" }],
      excludedBy: null,
      intersection: null,
    });

    // === project_a6f ===
    await tsfga.writeRelationConfig({
      objectType: "project_a6f",
      relation: "team",
      directlyAssignable: [{ type: "team_a6f" }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfga.writeRelationConfig({
      objectType: "project_a6f",
      relation: "editor",
      directlyAssignable: [
        { type: "user_a6f" },
        { type: "team_a6f", relation: "member" },
      ],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfga.writeRelationConfig({
      objectType: "project_a6f",
      relation: "viewer",
      directlyAssignable: [{ type: "user_a6f" }],
      impliedBy: ["editor"],
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfga.writeRelationConfig({
      objectType: "project_a6f",
      relation: "org_admin",
      directlyAssignable: [],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: [{ tupleset: "team", computedUserset: "admin" }],
      excludedBy: null,
      intersection: null,
    });

    // === file_a6f ===
    await tsfga.writeRelationConfig({
      objectType: "file_a6f",
      relation: "project",
      directlyAssignable: [{ type: "project_a6f" }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    for (const relation of ["owner", "publisher"]) {
      await tsfga.writeRelationConfig({
        objectType: "file_a6f",
        relation,
        directlyAssignable: [{ type: "user_a6f" }],
        impliedBy: null,
        computedUserset: null,
        tupleToUserset: null,
        excludedBy: null,
        intersection: null,
      });
    }
    await tsfga.writeRelationConfig({
      objectType: "file_a6f",
      relation: "locked",
      directlyAssignable: [{ type: "user_a6f", wildcard: true }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    for (const relation of ["link_editor", "link_viewer"]) {
      await tsfga.writeRelationConfig({
        objectType: "file_a6f",
        relation,
        directlyAssignable: [
          { type: "user_a6f", wildcard: true, condition: "link_active_a6f" },
        ],
        impliedBy: null,
        computedUserset: null,
        tupleToUserset: null,
        excludedBy: null,
        intersection: null,
      });
    }
    await tsfga.writeRelationConfig({
      objectType: "file_a6f",
      relation: "editor",
      directlyAssignable: [{ type: "user_a6f" }],
      impliedBy: ["owner", "link_editor"],
      computedUserset: null,
      tupleToUserset: [{ tupleset: "project", computedUserset: "editor" }],
      excludedBy: null,
      intersection: null,
    });
    await tsfga.writeRelationConfig({
      objectType: "file_a6f",
      relation: "viewer",
      directlyAssignable: [{ type: "user_a6f" }],
      impliedBy: ["editor", "link_viewer"],
      computedUserset: null,
      tupleToUserset: [{ tupleset: "project", computedUserset: "viewer" }],
      excludedBy: null,
      intersection: null,
    });
    await tsfga.writeRelationConfig({
      objectType: "file_a6f",
      relation: "can_edit",
      directlyAssignable: [],
      impliedBy: null,
      computedUserset: "editor",
      tupleToUserset: null,
      excludedBy: "locked",
      intersection: null,
    });
    // tsfga-only: the second union of `can_publish`. One relation
    // carries one union, and the `direct` operand below has already
    // spent it on `editor or publisher`.
    await tsfga.writeRelationConfig({
      objectType: "file_a6f",
      relation: "h_publish_gate",
      directlyAssignable: [],
      impliedBy: ["owner"],
      computedUserset: null,
      tupleToUserset: [{ tupleset: "project", computedUserset: "org_admin" }],
      excludedBy: null,
      intersection: null,
    });
    await tsfga.writeRelationConfig({
      objectType: "file_a6f",
      relation: "can_publish",
      directlyAssignable: [],
      impliedBy: ["editor", "publisher"],
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: [
        { type: "direct" },
        { type: "computedUserset", relation: "h_publish_gate" },
      ],
    });

    // === branch_a6f ===
    await tsfga.writeRelationConfig({
      objectType: "branch_a6f",
      relation: "source_file",
      directlyAssignable: [{ type: "file_a6f" }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfga.writeRelationConfig({
      objectType: "branch_a6f",
      relation: "author",
      directlyAssignable: [{ type: "user_a6f" }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfga.writeRelationConfig({
      objectType: "branch_a6f",
      relation: "can_view",
      directlyAssignable: [],
      impliedBy: ["author"],
      computedUserset: null,
      tupleToUserset: [{ tupleset: "source_file", computedUserset: "viewer" }],
      excludedBy: null,
      intersection: null,
    });
    await tsfga.writeRelationConfig({
      objectType: "branch_a6f",
      relation: "can_edit",
      directlyAssignable: [],
      impliedBy: ["author"],
      computedUserset: null,
      tupleToUserset: [
        { tupleset: "source_file", computedUserset: "can_edit" },
      ],
      excludedBy: null,
      intersection: null,
    });
    await tsfga.writeRelationConfig({
      objectType: "branch_a6f",
      relation: "can_merge",
      directlyAssignable: [],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: [
        { type: "computedUserset", relation: "author" },
        {
          type: "tupleToUserset",
          tupleset: "source_file",
          computedUserset: "can_edit",
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
        subjectType: "user_a6f",
        subjectId: uuid(subject),
      });

    await user("org_a6f", "acme", "admin", "alice");
    for (const person of ["alice", "bob", "carol", "dave"]) {
      await user("org_a6f", "acme", "member", person);
    }

    await tsfga.addTuple({
      objectType: "team_a6f",
      objectId: uuid("product"),
      relation: "org",
      subjectType: "org_a6f",
      subjectId: uuid("acme"),
    });
    await tsfga.addTuple({
      objectType: "team_a6f",
      objectId: uuid("product"),
      relation: "member",
      subjectType: "org_a6f",
      subjectId: uuid("acme"),
      subjectRelation: "member",
    });

    for (const project of ["web", "mobile"]) {
      await tsfga.addTuple({
        objectType: "project_a6f",
        objectId: uuid(project),
        relation: "team",
        subjectType: "team_a6f",
        subjectId: uuid("product"),
      });
    }
    await tsfga.addTuple({
      objectType: "project_a6f",
      objectId: uuid("web"),
      relation: "editor",
      subjectType: "team_a6f",
      subjectId: uuid("product"),
      subjectRelation: "member",
    });
    await user("project_a6f", "web", "viewer", "erin");

    for (const file of ["home", "about"]) {
      await tsfga.addTuple({
        objectType: "file_a6f",
        objectId: uuid(file),
        relation: "project",
        subjectType: "project_a6f",
        subjectId: uuid("web"),
      });
    }
    await user("file_a6f", "home", "owner", "dave");
    await user("file_a6f", "home", "publisher", "bob");
    await tsfga.addTuple({
      objectType: "file_a6f",
      objectId: uuid("about"),
      relation: "locked",
      subjectType: "user_a6f",
      subjectId: "*",
    });

    await tsfga.addTuple({
      objectType: "file_a6f",
      objectId: uuid("draft"),
      relation: "project",
      subjectType: "project_a6f",
      subjectId: uuid("mobile"),
    });
    await tsfga.addTuple({
      objectType: "file_a6f",
      objectId: uuid("draft"),
      relation: "link_viewer",
      subjectType: "user_a6f",
      subjectId: "*",
      conditionName: "link_active_a6f",
      conditionContext: { link_enabled: true },
    });
    await tsfga.addTuple({
      objectType: "file_a6f",
      objectId: uuid("draft"),
      relation: "link_editor",
      subjectType: "user_a6f",
      subjectId: "*",
      conditionName: "link_active_a6f",
      conditionContext: { link_enabled: false },
    });

    for (const [branch, file] of [
      ["b1", "home"],
      ["b2", "about"],
    ] as Array<[string, string]>) {
      await tsfga.addTuple({
        objectType: "branch_a6f",
        objectId: uuid(branch),
        relation: "source_file",
        subjectType: "file_a6f",
        subjectId: uuid(file),
      });
      await user("branch_a6f", branch, "author", "carol");
    }

    storeId = await fgaCreateStore("figma");
    authorizationModelId = await fgaWriteModel(storeId, "./figma/model.dsl");
    await fgaWriteTuples(
      storeId,
      "./figma/tuples.yaml",
      authorizationModelId,
      uuidMap,
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  // --- team admin climbing to the org ---

  test("1: alice is team admin via admin from org", async () => {
    await can("team_a6f", "product", "admin", "alice", true);
  });

  test("2: bob is a team member but no admin", async () => {
    await can("team_a6f", "product", "admin", "bob", false);
  });

  // --- file editor through the project ---

  test("3: carol edits home through team_a6f:product#member", async () => {
    await can("file_a6f", "home", "editor", "carol", true);
  });

  test("4: erin views home but does not edit it", async () => {
    await can("file_a6f", "home", "editor", "erin", false);
  });

  test("5: erin views home through the project viewer", async () => {
    await can("file_a6f", "home", "viewer", "erin", true);
  });

  test("6: frank reaches home not at all", async () => {
    await can("file_a6f", "home", "viewer", "frank", false);
  });

  // --- locked: a wildcard exclusion over an inherited grant ---

  test("7: carol edits home — nothing is locked there", async () => {
    await can("file_a6f", "home", "can_edit", "carol", true);
  });

  test("8: the lock wildcard denies carol on about", async () => {
    await can("file_a6f", "about", "can_edit", "carol", false);
  });

  test("9: the lock does not remove carol's editor relation", async () => {
    await can("file_a6f", "about", "editor", "carol", true);
  });

  test("10: the lock does not remove viewing", async () => {
    await can("file_a6f", "about", "viewer", "erin", true);
  });

  // --- Conditioned link sharing, flag from tuple, domain from request ---

  test("11: the view link opens for an acme.com request", async () => {
    await can("file_a6f", "draft", "viewer", "frank", true, ACME);
  });

  test("12: the same link shuts for another domain", async () => {
    await can("file_a6f", "draft", "viewer", "frank", false, {
      viewer_domain: "evil.com",
    });
  });

  test("13: the edit link is switched off in its own tuple", async () => {
    await can("file_a6f", "draft", "editor", "frank", false, ACME);
  });

  test("14: so draft cannot be edited even from acme.com", async () => {
    await can("file_a6f", "draft", "can_edit", "frank", false, ACME);
  });

  test("15: a team member gets no draft access — the project is empty", async () => {
    await can("file_a6f", "draft", "editor", "carol", false, ACME);
  });

  test("16: carol still reaches draft by the same public link", async () => {
    await can("file_a6f", "draft", "viewer", "carol", true, ACME);
  });

  test("17: a request that binds no viewer_domain is refused by both", async () => {
    await can("file_a6f", "draft", "viewer", "frank", "refused");
  });

  // --- Intersection of two unions (the decomposed relation) ---

  test("18: alice publishes home — editor, and org admin of the project", async () => {
    await can("file_a6f", "home", "can_publish", "alice", true);
  });

  test("19: dave publishes home — editor, and its owner", async () => {
    await can("file_a6f", "home", "can_publish", "dave", true);
  });

  test("20: carol cannot publish — the second union does not hold", async () => {
    await can("file_a6f", "home", "can_publish", "carol", false);
  });

  test("21: bob cannot publish — publisher alone is not enough", async () => {
    await can("file_a6f", "home", "can_publish", "bob", false);
  });

  test("22: frank cannot publish — neither union holds", async () => {
    await can("file_a6f", "home", "can_publish", "frank", false);
  });

  test("23: alice publishes about — publishing ignores the lock", async () => {
    await can("file_a6f", "about", "can_publish", "alice", true);
  });

  test("24: erin cannot publish about", async () => {
    await can("file_a6f", "about", "can_publish", "erin", false);
  });

  // --- Branch rights dispatching onto the file ---

  test("25: carol views her own branch", async () => {
    await can("branch_a6f", "b1", "can_view", "carol", true);
  });

  test("26: erin views b1 through the source file", async () => {
    await can("branch_a6f", "b1", "can_view", "erin", true);
  });

  test("27: frank views no branch", async () => {
    await can("branch_a6f", "b1", "can_view", "frank", false);
  });

  test("28: dave edits b1 through can_edit from source_file", async () => {
    await can("branch_a6f", "b1", "can_edit", "dave", true);
  });

  test("29: carol merges b1 — author and the file is editable", async () => {
    await can("branch_a6f", "b1", "can_merge", "carol", true);
  });

  test("30: carol cannot merge b2 — the source file is locked", async () => {
    await can("branch_a6f", "b2", "can_merge", "carol", false);
  });

  test("31: dave cannot merge b1 — he is not the author", async () => {
    await can("branch_a6f", "b1", "can_merge", "dave", false);
  });

  test("32: carol still edits b2, because she authored it", async () => {
    await can("branch_a6f", "b2", "can_edit", "carol", true);
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./figma/model.dsl", fixture, {
      coverage: "complete",
      tsfgaOnlyHelpers: ["file_a6f.h_publish_gate"],
    });
  });
});
