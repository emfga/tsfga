import { afterAll, beforeAll, describe, test } from "bun:test";
import {
  type AddTupleRequest,
  type ConditionDefinition,
  createTsfga,
  type TsfgaClient,
} from "@tsfga/core";
import type { DB } from "@tsfga/kysely";
import { KyselyTupleStore } from "@tsfga/kysely";
import type { Kysely } from "kysely";
import {
  type CheckOutcome,
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
 * GitHub Actions-shaped deployment gating: org -> repo ->
 * environment -> deployment.
 *
 * Two seams are the point of this fixture.
 *
 * **The branch rule used to be the third, and it is gone.**
 * `branch_allowed` was a conditioned wildcard whose *pattern* came
 * from the tuple — `branch.matches(pattern)` — which is how a real
 * environment protection rule works and which put a regular
 * expression on the evaluation path rather than the model-write
 * path. tsfga no longer supports `matches()`, and this is the one
 * condition in the corpus with no rewrite: `prod`'s rule is an
 * alternation (`main` or `release/…`) and no declared string
 * predicate expresses alternation. Rewriting it would have meant
 * moving an expected boolean, which is the one substitution the
 * rewrite rule forbids.
 *
 * So it is pinned instead — see `cel-matches.test.ts`, whose
 * `expectPinnedModelWriteDivergence` cell is exactly this
 * condition — and the arm is preserved verbatim in
 * `docs/cel-js/retired/actions-branch-rule/`. The 23 cells that
 * exercised it went with it; the graph seams below did not depend
 * on them.
 *
 * **`deployment_c3a.can_approve` is an exclusion whose minuend is
 * a tuple-to-userset**: `required_reviewer from environment but
 * not requester`. The reviewer set is resolved one object away and
 * the requester is subtracted here, which is the shape "you cannot
 * approve your own deployment" actually takes.
 *
 * **Nested usersets**: `team_c3a:platform#member` is a member of
 * `team_c3a:eng`, which is the org's member set and the repo's
 * writer set, so `bob`'s push right is three userset hops from the
 * row that grants it.
 */

const CONDITIONS: ConditionDefinition[] = [];

const uuidMap = new Map<string, string>([
  ["alice", "00000000-0000-4000-d570-000000000001"],
  ["bob", "00000000-0000-4000-d570-000000000002"],
  ["carol", "00000000-0000-4000-d570-000000000003"],
  ["zoe", "00000000-0000-4000-d570-000000000004"],
  ["platform", "00000000-0000-4000-d570-000000000010"],
  ["eng", "00000000-0000-4000-d570-000000000011"],
  ["acme", "00000000-0000-4000-d570-000000000020"],
  ["api", "00000000-0000-4000-d570-000000000030"],
  ["docs", "00000000-0000-4000-d570-000000000031"],
  ["prod", "00000000-0000-4000-d570-000000000040"],
  ["staging", "00000000-0000-4000-d570-000000000041"],
  ["canary", "00000000-0000-4000-d570-000000000042"],
  ["d1", "00000000-0000-4000-d570-000000000050"],
  ["d2", "00000000-0000-4000-d570-000000000051"],
]);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

describe("Actions Model Conformance", () => {
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
    extra?: {
      context?: Record<string, unknown>;
      contextualTuples?: AddTupleRequest[];
    },
  ): Promise<void> {
    return expectConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType,
        objectId: uuid(objectId),
        relation,
        subjectType: "user_c3a",
        subjectId: uuid(subject),
        ...(extra?.context ? { context: extra.context } : {}),
        ...(extra?.contextualTuples
          ? { contextualTuples: extra.contextualTuples }
          : {}),
      },
      expected,
    );
  }

  beforeAll(async () => {
    assertUuidMapInjective(uuidMap);
    assertUuidMapCovers("./actions/tuples.yaml", uuidMap);

    db = getDb();
    await beginTransaction(db);

    tsfga = createTsfga(new KyselyTupleStore(db));
    fixture = recordFixture(tsfga);

    for (const condition of CONDITIONS) {
      await tsfga.writeConditionDefinition(condition);
    }

    const plain = {
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    } as const;
    const teamMember = { type: "team_c3a", relation: "member" } as const;

    await tsfga.writeRelationConfig({
      objectType: "team_c3a",
      relation: "member",
      directlyAssignable: [{ type: "user_c3a" }, teamMember],
      ...plain,
    });

    await tsfga.writeRelationConfig({
      objectType: "org_c3a",
      relation: "admin",
      directlyAssignable: [{ type: "user_c3a" }],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "org_c3a",
      relation: "member",
      directlyAssignable: [{ type: "user_c3a" }, teamMember],
      ...plain,
      impliedBy: ["admin"],
    });

    await tsfga.writeRelationConfig({
      objectType: "repo_c3a",
      relation: "org",
      directlyAssignable: [{ type: "org_c3a" }],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "repo_c3a",
      relation: "public",
      directlyAssignable: [{ type: "user_c3a", wildcard: true }],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "repo_c3a",
      relation: "writer",
      directlyAssignable: [{ type: "user_c3a" }, teamMember],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "repo_c3a",
      relation: "can_read",
      directlyAssignable: [],
      ...plain,
      impliedBy: ["writer", "public"],
      tupleToUserset: [{ tupleset: "org", computedUserset: "member" }],
    });
    await tsfga.writeRelationConfig({
      objectType: "repo_c3a",
      relation: "can_push",
      directlyAssignable: [],
      ...plain,
      impliedBy: ["writer"],
      tupleToUserset: [{ tupleset: "org", computedUserset: "admin" }],
    });

    await tsfga.writeRelationConfig({
      objectType: "environment_c3a",
      relation: "repo",
      directlyAssignable: [{ type: "repo_c3a" }],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "environment_c3a",
      relation: "required_reviewer",
      directlyAssignable: [{ type: "user_c3a" }, teamMember],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "environment_c3a",
      relation: "can_deploy",
      directlyAssignable: [],
      ...plain,
      tupleToUserset: [{ tupleset: "repo", computedUserset: "can_push" }],
    });
    await tsfga.writeRelationConfig({
      objectType: "deployment_c3a",
      relation: "environment",
      directlyAssignable: [{ type: "environment_c3a" }],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "deployment_c3a",
      relation: "requester",
      directlyAssignable: [{ type: "user_c3a" }],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "deployment_c3a",
      relation: "can_approve",
      directlyAssignable: [],
      ...plain,
      tupleToUserset: [
        { tupleset: "environment", computedUserset: "required_reviewer" },
      ],
      excludedBy: "requester",
    });
    // === Tuples (mirroring ./actions/tuples.yaml) ===
    for (const user of ["alice", "bob"]) {
      await tsfga.addTuple({
        objectType: "team_c3a",
        objectId: uuid("platform"),
        relation: "member",
        subjectType: "user_c3a",
        subjectId: uuid(user),
      });
    }
    await tsfga.addTuple({
      objectType: "team_c3a",
      objectId: uuid("eng"),
      relation: "member",
      subjectType: "team_c3a",
      subjectId: uuid("platform"),
      subjectRelation: "member",
    });
    await tsfga.addTuple({
      objectType: "team_c3a",
      objectId: uuid("eng"),
      relation: "member",
      subjectType: "user_c3a",
      subjectId: uuid("carol"),
    });

    await tsfga.addTuple({
      objectType: "org_c3a",
      objectId: uuid("acme"),
      relation: "admin",
      subjectType: "user_c3a",
      subjectId: uuid("alice"),
    });
    await tsfga.addTuple({
      objectType: "org_c3a",
      objectId: uuid("acme"),
      relation: "member",
      subjectType: "team_c3a",
      subjectId: uuid("eng"),
      subjectRelation: "member",
    });

    for (const repo of ["api", "docs"]) {
      await tsfga.addTuple({
        objectType: "repo_c3a",
        objectId: uuid(repo),
        relation: "org",
        subjectType: "org_c3a",
        subjectId: uuid("acme"),
      });
    }
    await tsfga.addTuple({
      objectType: "repo_c3a",
      objectId: uuid("api"),
      relation: "writer",
      subjectType: "team_c3a",
      subjectId: uuid("eng"),
      subjectRelation: "member",
    });
    await tsfga.addTuple({
      objectType: "repo_c3a",
      objectId: uuid("docs"),
      relation: "public",
      subjectType: "user_c3a",
      subjectId: "*",
    });

    for (const environment of ["prod", "staging", "canary"]) {
      await tsfga.addTuple({
        objectType: "environment_c3a",
        objectId: uuid(environment),
        relation: "repo",
        subjectType: "repo_c3a",
        subjectId: uuid("api"),
      });
    }
    await tsfga.addTuple({
      objectType: "environment_c3a",
      objectId: uuid("prod"),
      relation: "required_reviewer",
      subjectType: "team_c3a",
      subjectId: uuid("platform"),
      subjectRelation: "member",
    });
    await tsfga.addTuple({
      objectType: "environment_c3a",
      objectId: uuid("staging"),
      relation: "required_reviewer",
      subjectType: "user_c3a",
      subjectId: uuid("carol"),
    });
    await tsfga.addTuple({
      objectType: "environment_c3a",
      objectId: uuid("canary"),
      relation: "required_reviewer",
      subjectType: "team_c3a",
      subjectId: uuid("platform"),
      subjectRelation: "member",
    });
    const deployments: Array<[string, string, string]> = [
      ["d1", "prod", "bob"],
      ["d2", "staging", "carol"],
    ];
    for (const [deployment, environment, requester] of deployments) {
      await tsfga.addTuple({
        objectType: "deployment_c3a",
        objectId: uuid(deployment),
        relation: "environment",
        subjectType: "environment_c3a",
        subjectId: uuid(environment),
      });
      await tsfga.addTuple({
        objectType: "deployment_c3a",
        objectId: uuid(deployment),
        relation: "requester",
        subjectType: "user_c3a",
        subjectId: uuid(requester),
      });
    }

    storeId = await fgaCreateStore("actions");
    authorizationModelId = await fgaWriteModel(storeId, "./actions/model.dsl");
    await fgaWriteTuples(
      storeId,
      "./actions/tuples.yaml",
      authorizationModelId,
      uuidMap,
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  // --- Nested usersets reaching the repo ---

  test("1: bob is an eng member through platform", async () => {
    await can("team_c3a", "eng", "member", "bob", true);
  });

  test("2: and a repo writer three hops from the row", async () => {
    await can("repo_c3a", "api", "writer", "bob", true);
  });

  test("3: carol is a member directly", async () => {
    await can("repo_c3a", "api", "writer", "carol", true);
  });

  test("4: the org admin is no writer, but pushes anyway", async () => {
    await can("repo_c3a", "api", "writer", "alice", true);
    await can("repo_c3a", "api", "can_push", "alice", true);
  });

  test("5: a stranger pushes nothing", async () => {
    await can("repo_c3a", "api", "can_push", "zoe", false);
  });

  // --- The public wildcard ---

  test("6: anyone reads the public repo", async () => {
    await can("repo_c3a", "docs", "can_read", "zoe", true);
  });

  test("7: and nobody reads the private one uninvited", async () => {
    await can("repo_c3a", "api", "can_read", "zoe", false);
  });

  test("8: public does not mean pushable", async () => {
    await can("repo_c3a", "docs", "can_push", "zoe", false);
  });

  test("9: the org member reads the private repo", async () => {
    await can("repo_c3a", "api", "can_read", "carol", true);
  });

  // --- The branch pattern, held in the tuple ---

  // --- The gate: push right and branch together ---

  // --- Approval: the reviewer set minus the requester ---

  test("23: bob is a required reviewer of prod", async () => {
    await can("environment_c3a", "prod", "required_reviewer", "bob", true);
  });

  test("24: and may not approve his own deployment", async () => {
    await can("deployment_c3a", "d1", "can_approve", "bob", false);
  });

  test("25: alice may", async () => {
    await can("deployment_c3a", "d1", "can_approve", "alice", true);
  });

  test("26: carol may not — she is no prod reviewer", async () => {
    await can("deployment_c3a", "d1", "can_approve", "carol", false);
  });

  test("27: the only staging reviewer requested it herself", async () => {
    await can("environment_c3a", "staging", "required_reviewer", "carol", true);
    await can("deployment_c3a", "d2", "can_approve", "carol", false);
    await can("deployment_c3a", "d2", "can_approve", "alice", false);
  });

  // --- Running: approval and the branch gate together ---

  // --- Userset subjects ---

  test("32: the platform userset is a required reviewer of prod", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "environment_c3a",
        objectId: uuid("prod"),
        relation: "required_reviewer",
        subjectType: "team_c3a",
        subjectId: uuid("platform"),
        subjectRelation: "member",
      },
      true,
    );
  });

  test("33: the eng userset is not", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "environment_c3a",
        objectId: uuid("prod"),
        relation: "required_reviewer",
        subjectType: "team_c3a",
        subjectId: uuid("eng"),
        subjectRelation: "member",
      },
      false,
    );
  });

  test("34: but it does write the api repo", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "repo_c3a",
        objectId: uuid("api"),
        relation: "can_push",
        subjectType: "team_c3a",
        subjectId: uuid("eng"),
        subjectRelation: "member",
      },
      true,
    );
  });

  // --- listObjects ---

  test("35: the repos zoe may read", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "repo_c3a",
        relation: "can_read",
        subjectType: "user_c3a",
        subjectId: uuid("zoe"),
      },
      [uuid("docs")],
    );
  });

  test("36: the repos carol may read", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "repo_c3a",
        relation: "can_read",
        subjectType: "user_c3a",
        subjectId: uuid("carol"),
      },
      [uuid("api"), uuid("docs")],
    );
  });

  test("37: the environments bob may deploy to at all", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "environment_c3a",
        relation: "can_deploy",
        subjectType: "user_c3a",
        subjectId: uuid("bob"),
      },
      [uuid("prod"), uuid("staging"), uuid("canary")],
    );
  });

  test("39: the deployments alice may approve", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "deployment_c3a",
        relation: "can_approve",
        subjectType: "user_c3a",
        subjectId: uuid("alice"),
      },
      [uuid("d1")],
    );
  });

  test("40: the deployments bob may approve", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "deployment_c3a",
        relation: "can_approve",
        subjectType: "user_c3a",
        subjectId: uuid("bob"),
      },
      [],
    );
  });

  // --- The write gate ---

  test("43: `public` takes only the wildcard", async () => {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "repo_c3a",
        objectId: uuid("api"),
        relation: "public",
        subjectType: "user_c3a",
        subjectId: uuid("zoe"),
      },
      "refused",
    );
  });

  test("44: a repo is not an environment's repo twice over", async () => {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "environment_c3a",
        objectId: uuid("staging"),
        relation: "repo",
        subjectType: "environment_c3a",
        subjectId: uuid("prod"),
      },
      "refused",
    );
  });

  test("45: a reviewer may be added, and approves at once", async () => {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "environment_c3a",
        objectId: uuid("staging"),
        relation: "required_reviewer",
        subjectType: "user_c3a",
        subjectId: uuid("alice"),
      },
      "accepted",
    );
    await can("deployment_c3a", "d2", "can_approve", "alice", true);
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./actions/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
