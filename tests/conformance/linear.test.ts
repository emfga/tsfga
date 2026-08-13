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
 * A Linear-shaped issue tracker: organization -> team -> project ->
 * issue, four levels of tuple-to-userset.
 *
 * Two seams are the point of this fixture.
 *
 * `project_a6.archived` is a *userset-bearing* subtrahend —
 * `[organization_a6#member, user_a6:*]` — so the exclusion on
 * `can_edit` has to expand a userset and a wildcard to decide
 * whether it bites. `project_a6:borealis` archives exactly the org
 * members, which leaves an outside collaborator editing a project
 * everyone else has lost.
 *
 * `issue_a6.can_close` is `assignee and can_edit from project`: an
 * intersection whose second operand is a TTU that lands on a
 * relation which is itself an exclusion. A grant therefore has to
 * survive an exclusion evaluated one dispatch away.
 */

const uuidMap = new Map<string, string>([
  ["alice", "00000000-0000-4000-d450-000000020001"],
  ["bob", "00000000-0000-4000-d450-000000020002"],
  ["carol", "00000000-0000-4000-d450-000000020003"],
  ["dave", "00000000-0000-4000-d450-000000020004"],
  ["erin", "00000000-0000-4000-d450-000000020005"],
  ["frank", "00000000-0000-4000-d450-000000020006"],
  ["acme", "00000000-0000-4000-d450-000000020010"],
  ["eng", "00000000-0000-4000-d450-000000020011"],
  ["design", "00000000-0000-4000-d450-000000020012"],
  ["apollo", "00000000-0000-4000-d450-000000020020"],
  ["zephyr", "00000000-0000-4000-d450-000000020021"],
  ["borealis", "00000000-0000-4000-d450-000000020022"],
  ["bug1", "00000000-0000-4000-d450-000000020030"],
  ["bug2", "00000000-0000-4000-d450-000000020031"],
  ["bug3", "00000000-0000-4000-d450-000000020032"],
]);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

describe("Linear Model Conformance", () => {
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
        subjectType: "user_a6",
        subjectId: uuid(subject),
      },
      expected,
    );
  }

  beforeAll(async () => {
    db = getDb();
    await beginTransaction(db);

    tsfga = createTsfga(new KyselyTupleStore(db));
    fixture = recordFixture(tsfga);

    // === organization_a6 ===
    for (const relation of ["member", "admin", "suspended"]) {
      await tsfga.writeRelationConfig({
        objectType: "organization_a6",
        relation,
        directlyAssignable: [{ type: "user_a6" }],
        impliedBy: null,
        computedUserset: null,
        tupleToUserset: null,
        excludedBy: null,
        intersection: null,
      });
    }
    await tsfga.writeRelationConfig({
      objectType: "organization_a6",
      relation: "billing",
      directlyAssignable: [{ type: "user_a6" }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: "suspended",
      intersection: null,
    });

    // === team_a6 ===
    await tsfga.writeRelationConfig({
      objectType: "team_a6",
      relation: "organization",
      directlyAssignable: [{ type: "organization_a6" }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfga.writeRelationConfig({
      objectType: "team_a6",
      relation: "member",
      directlyAssignable: [
        { type: "user_a6" },
        { type: "organization_a6", relation: "member" },
      ],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfga.writeRelationConfig({
      objectType: "team_a6",
      relation: "lead",
      directlyAssignable: [{ type: "user_a6" }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfga.writeRelationConfig({
      objectType: "team_a6",
      relation: "can_view",
      directlyAssignable: [],
      impliedBy: ["member", "lead"],
      computedUserset: null,
      tupleToUserset: [{ tupleset: "organization", computedUserset: "admin" }],
      excludedBy: null,
      intersection: null,
    });

    // === project_a6 ===
    await tsfga.writeRelationConfig({
      objectType: "project_a6",
      relation: "team",
      directlyAssignable: [{ type: "team_a6" }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    for (const relation of ["lead", "guest_viewer"]) {
      await tsfga.writeRelationConfig({
        objectType: "project_a6",
        relation,
        directlyAssignable: [{ type: "user_a6" }],
        impliedBy: null,
        computedUserset: null,
        tupleToUserset: null,
        excludedBy: null,
        intersection: null,
      });
    }
    await tsfga.writeRelationConfig({
      objectType: "project_a6",
      relation: "archived",
      directlyAssignable: [
        { type: "organization_a6", relation: "member" },
        { type: "user_a6", wildcard: true },
      ],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfga.writeRelationConfig({
      objectType: "project_a6",
      relation: "member",
      directlyAssignable: [{ type: "user_a6" }],
      impliedBy: ["lead"],
      computedUserset: null,
      tupleToUserset: [{ tupleset: "team", computedUserset: "member" }],
      excludedBy: null,
      intersection: null,
    });
    await tsfga.writeRelationConfig({
      objectType: "project_a6",
      relation: "can_view",
      directlyAssignable: [],
      impliedBy: ["member", "guest_viewer"],
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfga.writeRelationConfig({
      objectType: "project_a6",
      relation: "can_edit",
      directlyAssignable: [],
      impliedBy: null,
      computedUserset: "member",
      tupleToUserset: null,
      excludedBy: "archived",
      intersection: null,
    });

    // === issue_a6 ===
    await tsfga.writeRelationConfig({
      objectType: "issue_a6",
      relation: "project",
      directlyAssignable: [{ type: "project_a6" }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    for (const relation of ["assignee", "creator", "confidential"]) {
      await tsfga.writeRelationConfig({
        objectType: "issue_a6",
        relation,
        directlyAssignable: [{ type: "user_a6" }],
        impliedBy: null,
        computedUserset: null,
        tupleToUserset: null,
        excludedBy: null,
        intersection: null,
      });
    }
    await tsfga.writeRelationConfig({
      objectType: "issue_a6",
      relation: "subscriber",
      directlyAssignable: [
        { type: "user_a6" },
        { type: "team_a6", relation: "member" },
      ],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfga.writeRelationConfig({
      objectType: "issue_a6",
      relation: "can_view",
      directlyAssignable: [],
      impliedBy: ["assignee", "creator", "subscriber"],
      computedUserset: null,
      tupleToUserset: [{ tupleset: "project", computedUserset: "can_view" }],
      excludedBy: null,
      intersection: null,
    });
    await tsfga.writeRelationConfig({
      objectType: "issue_a6",
      relation: "can_assign",
      directlyAssignable: [],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: [{ tupleset: "project", computedUserset: "can_edit" }],
      excludedBy: null,
      intersection: null,
    });
    await tsfga.writeRelationConfig({
      objectType: "issue_a6",
      relation: "can_close",
      directlyAssignable: [],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: [
        { type: "computedUserset", relation: "assignee" },
        {
          type: "tupleToUserset",
          tupleset: "project",
          computedUserset: "can_edit",
        },
      ],
    });
    await tsfga.writeRelationConfig({
      objectType: "issue_a6",
      relation: "can_comment",
      directlyAssignable: [],
      impliedBy: null,
      computedUserset: "can_view",
      tupleToUserset: null,
      excludedBy: "confidential",
      intersection: null,
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
        subjectType: "user_a6",
        subjectId: uuid(subject),
      });

    await user("organization_a6", "acme", "admin", "alice");
    await user("organization_a6", "acme", "member", "bob");
    await user("organization_a6", "acme", "member", "carol");
    await user("organization_a6", "acme", "member", "dave");
    await user("organization_a6", "acme", "suspended", "dave");
    await user("organization_a6", "acme", "billing", "alice");
    await user("organization_a6", "acme", "billing", "dave");

    for (const team of ["eng", "design"]) {
      await tsfga.addTuple({
        objectType: "team_a6",
        objectId: uuid(team),
        relation: "organization",
        subjectType: "organization_a6",
        subjectId: uuid("acme"),
      });
      await tsfga.addTuple({
        objectType: "team_a6",
        objectId: uuid(team),
        relation: "member",
        subjectType: "organization_a6",
        subjectId: uuid("acme"),
        subjectRelation: "member",
      });
    }
    await user("team_a6", "eng", "lead", "carol");

    const projectTeam: Array<[string, string]> = [
      ["apollo", "eng"],
      ["zephyr", "design"],
      ["borealis", "eng"],
    ];
    for (const [project, team] of projectTeam) {
      await tsfga.addTuple({
        objectType: "project_a6",
        objectId: uuid(project),
        relation: "team",
        subjectType: "team_a6",
        subjectId: uuid(team),
      });
    }
    await user("project_a6", "apollo", "guest_viewer", "erin");
    await tsfga.addTuple({
      objectType: "project_a6",
      objectId: uuid("zephyr"),
      relation: "archived",
      subjectType: "user_a6",
      subjectId: "*",
    });
    await user("project_a6", "borealis", "member", "erin");
    await tsfga.addTuple({
      objectType: "project_a6",
      objectId: uuid("borealis"),
      relation: "archived",
      subjectType: "organization_a6",
      subjectId: uuid("acme"),
      subjectRelation: "member",
    });

    const issueProject: Array<[string, string]> = [
      ["bug1", "apollo"],
      ["bug2", "zephyr"],
      ["bug3", "borealis"],
    ];
    for (const [issue, project] of issueProject) {
      await tsfga.addTuple({
        objectType: "issue_a6",
        objectId: uuid(issue),
        relation: "project",
        subjectType: "project_a6",
        subjectId: uuid(project),
      });
    }
    await user("issue_a6", "bug1", "assignee", "bob");
    await user("issue_a6", "bug1", "creator", "carol");
    await tsfga.addTuple({
      objectType: "issue_a6",
      objectId: uuid("bug1"),
      relation: "subscriber",
      subjectType: "team_a6",
      subjectId: uuid("eng"),
      subjectRelation: "member",
    });
    await user("issue_a6", "bug1", "confidential", "dave");
    await user("issue_a6", "bug2", "assignee", "carol");
    await user("issue_a6", "bug3", "assignee", "erin");

    storeId = await fgaCreateStore("linear");
    authorizationModelId = await fgaWriteModel(storeId, "./linear/model.dsl");
    await fgaWriteTuples(
      storeId,
      "./linear/tuples.yaml",
      authorizationModelId,
      uuidMap,
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  // --- Exclusion at the organization level ---

  test("1: alice keeps billing — she is not suspended", async () => {
    await can("organization_a6", "acme", "billing", "alice", true);
  });

  test("2: dave loses billing to the suspension", async () => {
    await can("organization_a6", "acme", "billing", "dave", false);
  });

  test("3: bob has no billing to lose", async () => {
    await can("organization_a6", "acme", "billing", "bob", false);
  });

  // --- The org#member userset reaching down two levels ---

  test("4: bob is a team member through organization_a6:acme#member", async () => {
    await can("team_a6", "eng", "member", "bob", true);
  });

  test("5: alice is no team member — admin is not member here", async () => {
    await can("team_a6", "eng", "member", "alice", false);
  });

  test("6: alice still sees the team via admin from organization", async () => {
    await can("team_a6", "eng", "can_view", "alice", true);
  });

  test("7: bob is a project member two dispatches from the org tuple", async () => {
    await can("project_a6", "apollo", "member", "bob", true);
  });

  test("8: erin is no apollo member — a guest viewer only", async () => {
    await can("project_a6", "apollo", "member", "erin", false);
  });

  test("9: erin can still view apollo", async () => {
    await can("project_a6", "apollo", "can_view", "erin", true);
  });

  test("10: frank reaches nothing", async () => {
    await can("project_a6", "apollo", "can_view", "frank", false);
  });

  // --- Exclusion by wildcard: the whole project is archived ---

  test("11: carol is a zephyr member", async () => {
    await can("project_a6", "zephyr", "member", "carol", true);
  });

  test("12: the archive wildcard strips carol's edit right", async () => {
    await can("project_a6", "zephyr", "can_edit", "carol", false);
  });

  test("13: archiving does not touch viewing", async () => {
    await can("project_a6", "zephyr", "can_view", "carol", true);
  });

  // --- Exclusion by userset: archived for org members only ---

  test("14: bob is a borealis member via the team", async () => {
    await can("project_a6", "borealis", "member", "bob", true);
  });

  test("15: bob loses borealis edit — the archive userset covers him", async () => {
    await can("project_a6", "borealis", "can_edit", "bob", false);
  });

  test("16: erin keeps borealis edit — outside the archived userset", async () => {
    await can("project_a6", "borealis", "can_edit", "erin", true);
  });

  test("17: apollo has no archive, so bob edits it", async () => {
    await can("project_a6", "apollo", "can_edit", "bob", true);
  });

  // --- Issue-level union across four levels ---

  test("18: bob sees bug1 as its assignee", async () => {
    await can("issue_a6", "bug1", "can_view", "bob", true);
  });

  test("19: dave sees bug1 through team_a6:eng#member", async () => {
    await can("issue_a6", "bug1", "can_view", "dave", true);
  });

  test("20: erin sees bug1 through the project's guest viewer", async () => {
    await can("issue_a6", "bug1", "can_view", "erin", true);
  });

  test("21: alice does not see bug1 — org admin is not project access", async () => {
    await can("issue_a6", "bug1", "can_view", "alice", false);
  });

  test("22: frank does not see bug1", async () => {
    await can("issue_a6", "bug1", "can_view", "frank", false);
  });

  // --- Exclusion on top of the four-level union ---

  test("23: dave cannot comment on bug1 — marked confidential", async () => {
    await can("issue_a6", "bug1", "can_comment", "dave", false);
  });

  test("24: bob comments on bug1", async () => {
    await can("issue_a6", "bug1", "can_comment", "bob", true);
  });

  test("25: frank cannot comment on what he cannot see", async () => {
    await can("issue_a6", "bug1", "can_comment", "frank", false);
  });

  // --- TTU landing on a relation that is itself an exclusion ---

  test("26: bob can assign bug1 — apollo is editable", async () => {
    await can("issue_a6", "bug1", "can_assign", "bob", true);
  });

  test("27: carol cannot assign bug2 — zephyr is archived", async () => {
    await can("issue_a6", "bug2", "can_assign", "carol", false);
  });

  test("28: bob cannot assign bug3 — borealis is archived for him", async () => {
    await can("issue_a6", "bug3", "can_assign", "bob", false);
  });

  test("29: erin can assign bug3 — the archive misses her", async () => {
    await can("issue_a6", "bug3", "can_assign", "erin", true);
  });

  // --- Intersection whose second operand is a TTU into an exclusion ---

  test("30: bob closes bug1 — assignee and can edit apollo", async () => {
    await can("issue_a6", "bug1", "can_close", "bob", true);
  });

  test("31: carol cannot close bug1 — creator is not assignee", async () => {
    await can("issue_a6", "bug1", "can_close", "carol", false);
  });

  test("32: carol cannot close bug2 — assignee, but zephyr is archived", async () => {
    await can("issue_a6", "bug2", "can_close", "carol", false);
  });

  test("33: erin closes bug3 — assignee, and the archive misses her", async () => {
    await can("issue_a6", "bug3", "can_close", "erin", true);
  });

  test("34: bob cannot close bug3 — neither operand holds", async () => {
    await can("issue_a6", "bug3", "can_close", "bob", false);
  });

  test("35: dave cannot close bug1 — subscriber is not assignee", async () => {
    await can("issue_a6", "bug1", "can_close", "dave", false);
  });

  // --- listObjects across the same graph ---

  test("36: the issues erin may view", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "issue_a6",
        relation: "can_view",
        subjectType: "user_a6",
        subjectId: uuid("erin"),
      },
      [uuid("bug1"), uuid("bug3")],
    );
  });

  test("37: the projects bob may edit", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "project_a6",
        relation: "can_edit",
        subjectType: "user_a6",
        subjectId: uuid("bob"),
      },
      [uuid("apollo")],
    );
  });

  test("38: the issues frank may view", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "issue_a6",
        relation: "can_view",
        subjectType: "user_a6",
        subjectId: uuid("frank"),
      },
      [],
    );
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./linear/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
