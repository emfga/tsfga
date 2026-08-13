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
 * A GitLab-shaped model: a subgroup chain six deep, with four
 * concentric roles each of which climbs the chain on its own
 * `X from parent` edge.
 *
 * This is the recursive shape OpenFGA resolves with a dedicated
 * resolver rather than by ordinary dispatch, so it is worth pinning
 * hard: `owner`, `maintainer`, `developer` and `guest` are each
 * self-recursive *and* mutually implied, which means a check at the
 * bottom of the chain reaches the top by several routes of different
 * length at once.
 *
 * `can_admin` puts an exclusion on a recursive relation — the ban is
 * recorded on the group that granted the role, and the question is
 * whether it travels down the chain with the grant. It does not: the
 * exclusion is read on the object being checked, so a ban at the root
 * is invisible to a subgroup.
 */

const uuidMap = new Map<string, string>([
  ["alice", "00000000-0000-4000-d450-000000040001"],
  ["bob", "00000000-0000-4000-d450-000000040002"],
  ["carol", "00000000-0000-4000-d450-000000040003"],
  ["dave", "00000000-0000-4000-d450-000000040004"],
  ["erin", "00000000-0000-4000-d450-000000040005"],
  ["frank", "00000000-0000-4000-d450-000000040006"],
  ["root", "00000000-0000-4000-d450-000000040010"],
  ["mid", "00000000-0000-4000-d450-000000040011"],
  ["leaf", "00000000-0000-4000-d450-000000040012"],
  ["deep", "00000000-0000-4000-d450-000000040013"],
  ["deeper", "00000000-0000-4000-d450-000000040014"],
  ["deepest", "00000000-0000-4000-d450-000000040015"],
  ["other", "00000000-0000-4000-d450-000000040016"],
  ["web", "00000000-0000-4000-d450-000000040020"],
  ["api", "00000000-0000-4000-d450-000000040021"],
  ["legacy", "00000000-0000-4000-d450-000000040022"],
  ["sandbox", "00000000-0000-4000-d450-000000040023"],
]);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

describe("GitLab Model Conformance", () => {
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
        subjectType: "user_a6g",
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

    // === group_a6g ===
    await tsfga.writeRelationConfig({
      objectType: "group_a6g",
      relation: "parent",
      directlyAssignable: [{ type: "group_a6g" }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    for (const relation of [
      "direct_owner",
      "direct_maintainer",
      "direct_developer",
      "banned",
    ]) {
      await tsfga.writeRelationConfig({
        objectType: "group_a6g",
        relation,
        directlyAssignable: [{ type: "user_a6g" }],
        impliedBy: null,
        computedUserset: null,
        tupleToUserset: null,
        excludedBy: null,
        intersection: null,
      });
    }
    await tsfga.writeRelationConfig({
      objectType: "group_a6g",
      relation: "direct_guest",
      directlyAssignable: [
        { type: "user_a6g" },
        { type: "user_a6g", wildcard: true },
      ],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });

    const climbing: Array<[string, string[]]> = [
      ["owner", ["direct_owner"]],
      ["maintainer", ["direct_maintainer", "owner"]],
      ["developer", ["direct_developer", "maintainer"]],
      ["guest", ["direct_guest", "developer"]],
    ];
    for (const [relation, impliedBy] of climbing) {
      await tsfga.writeRelationConfig({
        objectType: "group_a6g",
        relation,
        directlyAssignable: [],
        impliedBy,
        computedUserset: null,
        tupleToUserset: [{ tupleset: "parent", computedUserset: relation }],
        excludedBy: null,
        intersection: null,
      });
    }
    await tsfga.writeRelationConfig({
      objectType: "group_a6g",
      relation: "can_admin",
      directlyAssignable: [],
      impliedBy: null,
      computedUserset: "owner",
      tupleToUserset: null,
      excludedBy: "banned",
      intersection: null,
    });

    // === project_a6g ===
    await tsfga.writeRelationConfig({
      objectType: "project_a6g",
      relation: "group",
      directlyAssignable: [{ type: "group_a6g" }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    for (const relation of ["direct_developer", "direct_guest"]) {
      await tsfga.writeRelationConfig({
        objectType: "project_a6g",
        relation,
        directlyAssignable: [{ type: "user_a6g" }],
        impliedBy: null,
        computedUserset: null,
        tupleToUserset: null,
        excludedBy: null,
        intersection: null,
      });
    }
    await tsfga.writeRelationConfig({
      objectType: "project_a6g",
      relation: "archived",
      directlyAssignable: [{ type: "user_a6g", wildcard: true }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfga.writeRelationConfig({
      objectType: "project_a6g",
      relation: "maintainer",
      directlyAssignable: [],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: [{ tupleset: "group", computedUserset: "maintainer" }],
      excludedBy: null,
      intersection: null,
    });
    await tsfga.writeRelationConfig({
      objectType: "project_a6g",
      relation: "developer",
      directlyAssignable: [],
      impliedBy: ["direct_developer", "maintainer"],
      computedUserset: null,
      tupleToUserset: [{ tupleset: "group", computedUserset: "developer" }],
      excludedBy: null,
      intersection: null,
    });
    await tsfga.writeRelationConfig({
      objectType: "project_a6g",
      relation: "guest",
      directlyAssignable: [],
      impliedBy: ["direct_guest", "developer"],
      computedUserset: null,
      tupleToUserset: [{ tupleset: "group", computedUserset: "guest" }],
      excludedBy: null,
      intersection: null,
    });
    await tsfga.writeRelationConfig({
      objectType: "project_a6g",
      relation: "can_read",
      directlyAssignable: [],
      impliedBy: null,
      computedUserset: "guest",
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfga.writeRelationConfig({
      objectType: "project_a6g",
      relation: "can_push",
      directlyAssignable: [],
      impliedBy: null,
      computedUserset: "developer",
      tupleToUserset: null,
      excludedBy: "archived",
      intersection: null,
    });
    await tsfga.writeRelationConfig({
      objectType: "project_a6g",
      relation: "can_admin",
      directlyAssignable: [],
      impliedBy: null,
      computedUserset: "maintainer",
      tupleToUserset: null,
      excludedBy: "archived",
      intersection: null,
    });

    // === Tuples ===
    const chain: Array<[string, string]> = [
      ["mid", "root"],
      ["leaf", "mid"],
      ["deep", "leaf"],
      ["deeper", "deep"],
      ["deepest", "deeper"],
    ];
    for (const [child, parent] of chain) {
      await tsfga.addTuple({
        objectType: "group_a6g",
        objectId: uuid(child),
        relation: "parent",
        subjectType: "group_a6g",
        subjectId: uuid(parent),
      });
    }

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
        subjectType: "user_a6g",
        subjectId: uuid(subject),
      });

    await user("group_a6g", "root", "direct_owner", "alice");
    await user("group_a6g", "root", "direct_owner", "erin");
    await user("group_a6g", "root", "banned", "erin");
    await user("group_a6g", "mid", "direct_maintainer", "bob");
    await user("group_a6g", "leaf", "direct_developer", "carol");
    await user("group_a6g", "leaf", "direct_guest", "dave");
    await tsfga.addTuple({
      objectType: "group_a6g",
      objectId: uuid("other"),
      relation: "direct_guest",
      subjectType: "user_a6g",
      subjectId: "*",
    });

    const projectGroup: Array<[string, string]> = [
      ["web", "leaf"],
      ["api", "root"],
      ["legacy", "mid"],
      ["sandbox", "deepest"],
    ];
    for (const [project, group] of projectGroup) {
      await tsfga.addTuple({
        objectType: "project_a6g",
        objectId: uuid(project),
        relation: "group",
        subjectType: "group_a6g",
        subjectId: uuid(group),
      });
    }
    await user("project_a6g", "api", "direct_guest", "frank");
    await tsfga.addTuple({
      objectType: "project_a6g",
      objectId: uuid("legacy"),
      relation: "archived",
      subjectType: "user_a6g",
      subjectId: "*",
    });

    storeId = await fgaCreateStore("gitlab");
    authorizationModelId = await fgaWriteModel(storeId, "./gitlab/model.dsl");
    await fgaWriteTuples(
      storeId,
      "./gitlab/tuples.yaml",
      authorizationModelId,
      uuidMap,
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  // --- One role climbing the whole chain ---

  test("1: alice owns root directly", async () => {
    await can("group_a6g", "root", "owner", "alice", true);
  });

  test("2: alice owns mid, one hop down", async () => {
    await can("group_a6g", "mid", "owner", "alice", true);
  });

  test("3: alice owns leaf, two hops down", async () => {
    await can("group_a6g", "leaf", "owner", "alice", true);
  });

  test("4: alice owns deepest, five hops down", async () => {
    await can("group_a6g", "deepest", "owner", "alice", true);
  });

  test("5: alice owns nothing in the detached group", async () => {
    await can("group_a6g", "other", "owner", "alice", false);
  });

  test("6: ownership never climbs upward", async () => {
    await can("group_a6g", "root", "developer", "carol", false);
  });

  // --- Roles reached by several routes of different length ---

  test("7: alice is deepest maintainer — owner implies it at every level", async () => {
    await can("group_a6g", "deepest", "maintainer", "alice", true);
  });

  test("8: alice is deepest guest — three implications and five hops", async () => {
    await can("group_a6g", "deepest", "guest", "alice", true);
  });

  test("9: bob is deepest maintainer from mid", async () => {
    await can("group_a6g", "deepest", "maintainer", "bob", true);
  });

  test("10: bob is not root maintainer — mid is below root", async () => {
    await can("group_a6g", "root", "maintainer", "bob", false);
  });

  test("11: carol is deepest developer from leaf", async () => {
    await can("group_a6g", "deepest", "developer", "carol", true);
  });

  test("12: carol is no maintainer anywhere", async () => {
    await can("group_a6g", "deepest", "maintainer", "carol", false);
  });

  test("13: dave is a guest below leaf", async () => {
    await can("group_a6g", "deepest", "guest", "dave", true);
  });

  test("14: dave is no developer", async () => {
    await can("group_a6g", "deepest", "developer", "dave", false);
  });

  test("15: dave is no guest above leaf", async () => {
    await can("group_a6g", "mid", "guest", "dave", false);
  });

  test("16: frank reaches no group in the chain", async () => {
    await can("group_a6g", "deepest", "guest", "frank", false);
  });

  test("17: the wildcard guest opens the detached group to anyone", async () => {
    await can("group_a6g", "other", "guest", "frank", true);
  });

  // --- Exclusion over a recursive relation ---

  test("18: erin is banned at the root, so she cannot admin it", async () => {
    await can("group_a6g", "root", "can_admin", "erin", false);
  });

  test("19: alice can admin the root", async () => {
    await can("group_a6g", "root", "can_admin", "alice", true);
  });

  test("20: erin still owns leaf — the ban did not travel down", async () => {
    await can("group_a6g", "leaf", "owner", "erin", true);
  });

  test("21: and so erin can admin leaf despite the root ban", async () => {
    await can("group_a6g", "leaf", "can_admin", "erin", true);
  });

  test("22: alice can admin deepest", async () => {
    await can("group_a6g", "deepest", "can_admin", "alice", true);
  });

  // --- Projects hanging off the chain ---

  test("23: carol pushes to web, whose group is leaf", async () => {
    await can("project_a6g", "web", "can_push", "carol", true);
  });

  test("24: dave only reads web", async () => {
    await can("project_a6g", "web", "can_read", "dave", true);
  });

  test("25: dave cannot push to web", async () => {
    await can("project_a6g", "web", "can_push", "dave", false);
  });

  test("26: bob pushes to web through mid", async () => {
    await can("project_a6g", "web", "can_push", "bob", true);
  });

  test("27: carol cannot push to api — api hangs above her group", async () => {
    await can("project_a6g", "api", "can_push", "carol", false);
  });

  test("28: frank reads api by a direct project grant", async () => {
    await can("project_a6g", "api", "can_read", "frank", true);
  });

  test("29: frank cannot push to api", async () => {
    await can("project_a6g", "api", "can_push", "frank", false);
  });

  test("30: alice admins api", async () => {
    await can("project_a6g", "api", "can_admin", "alice", true);
  });

  test("31: archiving legacy stops bob pushing", async () => {
    await can("project_a6g", "legacy", "can_push", "bob", false);
  });

  test("32: archiving legacy stops alice administering it", async () => {
    await can("project_a6g", "legacy", "can_admin", "alice", false);
  });

  test("33: archiving legacy does not stop bob reading it", async () => {
    await can("project_a6g", "legacy", "can_read", "bob", true);
  });

  // --- The longest path in the fixture: project -> six groups ---

  test("34: alice pushes to sandbox, six hops from her grant", async () => {
    await can("project_a6g", "sandbox", "can_push", "alice", true);
  });

  test("35: carol pushes to sandbox from leaf", async () => {
    await can("project_a6g", "sandbox", "can_push", "carol", true);
  });

  test("36: dave reads sandbox but does not push", async () => {
    await can("project_a6g", "sandbox", "can_push", "dave", false);
  });

  test("37: dave reads sandbox", async () => {
    await can("project_a6g", "sandbox", "can_read", "dave", true);
  });

  test("38: frank reaches sandbox not at all", async () => {
    await can("project_a6g", "sandbox", "can_read", "frank", false);
  });

  // --- listObjects over the recursive shape ---

  test("39: every group alice owns", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "group_a6g",
        relation: "owner",
        subjectType: "user_a6g",
        subjectId: uuid("alice"),
      },
      [
        uuid("root"),
        uuid("mid"),
        uuid("leaf"),
        uuid("deep"),
        uuid("deeper"),
        uuid("deepest"),
      ],
    );
  });

  test("40: every group dave may see", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "group_a6g",
        relation: "guest",
        subjectType: "user_a6g",
        subjectId: uuid("dave"),
      },
      [
        uuid("leaf"),
        uuid("deep"),
        uuid("deeper"),
        uuid("deepest"),
        uuid("other"),
      ],
    );
  });

  test("41: every project bob may push to", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "project_a6g",
        relation: "can_push",
        subjectType: "user_a6g",
        subjectId: uuid("bob"),
      },
      [uuid("web"), uuid("sandbox")],
    );
  });

  test("42: every project frank may read", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "project_a6g",
        relation: "can_read",
        subjectType: "user_a6g",
        subjectId: uuid("frank"),
      },
      [uuid("api")],
    );
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./gitlab/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
