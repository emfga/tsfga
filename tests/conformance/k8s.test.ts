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
 * A Kubernetes RBAC-shaped model: cluster role bindings, namespaced
 * role bindings, and pods that inherit from whatever owns them.
 *
 * Two shapes here are not reachable from a model whose only subject
 * type is `user`.
 *
 * `serviceaccount_a6k` is a first-class subject: it sits directly in
 * a role binding, and it sits inside a `group_a6k#member` userset
 * beside a human. The cluster's `system:authenticated` binding is a
 * `user_a6k:*` wildcard, which a service account subject must *not*
 * match — a wildcard is typed, and a model that mixes subject types
 * is where that stops being academic.
 *
 * `pod_a6k.owner` admits `[namespace_a6k, cluster_a6k]` while
 * `can_get from owner` is defined on namespaces only. Upstream
 * accepts such a model and drops the rows whose type does not define
 * the computed relation, one by one, rather than refusing the check
 * — so a pod owned by a cluster answers `false`, and a pod owned by
 * both still answers from its namespace.
 */

const uuidMap = new Map<string, string>([
  ["alice", "00000000-0000-4000-d450-000000060001"],
  ["bob", "00000000-0000-4000-d450-000000060002"],
  ["carol", "00000000-0000-4000-d450-000000060003"],
  ["dave", "00000000-0000-4000-d450-000000060004"],
  ["sa_ci", "00000000-0000-4000-d450-000000060010"],
  ["sa_bot", "00000000-0000-4000-d450-000000060011"],
  ["devs", "00000000-0000-4000-d450-000000060020"],
  ["prod", "00000000-0000-4000-d450-000000060030"],
  ["web", "00000000-0000-4000-d450-000000060040"],
  ["kube_system", "00000000-0000-4000-d450-000000060041"],
  ["nginx", "00000000-0000-4000-d450-000000060050"],
  ["etcd", "00000000-0000-4000-d450-000000060051"],
  ["orphan", "00000000-0000-4000-d450-000000060052"],
  ["mixed", "00000000-0000-4000-d450-000000060053"],
]);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

describe("Kubernetes RBAC Model Conformance", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let authorizationModelId: string;
  let tsfga: TsfgaClient;
  let fixture: FixtureRecord;

  function can(
    objectType: string,
    object: string,
    relation: string,
    subjectType: string,
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
        subjectType,
        subjectId: uuid(subject),
      },
      expected,
    );
  }

  /** A check whose subject is a human. */
  const byUser = (
    objectType: string,
    object: string,
    relation: string,
    subject: string,
    expected: boolean,
  ) => can(objectType, object, relation, "user_a6k", subject, expected);

  /** A check whose subject is a service account. */
  const bySa = (
    objectType: string,
    object: string,
    relation: string,
    subject: string,
    expected: boolean,
  ) =>
    can(objectType, object, relation, "serviceaccount_a6k", subject, expected);

  beforeAll(async () => {
    db = getDb();
    await beginTransaction(db);

    tsfga = createTsfga(new KyselyTupleStore(db));
    fixture = recordFixture(tsfga);

    await tsfga.writeRelationConfig({
      objectType: "serviceaccount_a6k",
      relation: "namespace",
      directlyAssignable: [{ type: "namespace_a6k" }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfga.writeRelationConfig({
      objectType: "group_a6k",
      relation: "member",
      directlyAssignable: [
        { type: "user_a6k" },
        { type: "serviceaccount_a6k" },
      ],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });

    // === cluster_a6k ===
    await tsfga.writeRelationConfig({
      objectType: "cluster_a6k",
      relation: "crb_view",
      directlyAssignable: [
        { type: "user_a6k" },
        { type: "group_a6k", relation: "member" },
        { type: "user_a6k", wildcard: true },
      ],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    for (const relation of ["crb_edit", "crb_admin"]) {
      await tsfga.writeRelationConfig({
        objectType: "cluster_a6k",
        relation,
        directlyAssignable: [
          { type: "user_a6k" },
          { type: "group_a6k", relation: "member" },
        ],
        impliedBy: null,
        computedUserset: null,
        tupleToUserset: null,
        excludedBy: null,
        intersection: null,
      });
    }

    // === namespace_a6k ===
    await tsfga.writeRelationConfig({
      objectType: "namespace_a6k",
      relation: "cluster",
      directlyAssignable: [{ type: "cluster_a6k" }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    for (const relation of ["rb_view", "rb_edit", "rb_admin"]) {
      await tsfga.writeRelationConfig({
        objectType: "namespace_a6k",
        relation,
        directlyAssignable: [
          { type: "user_a6k" },
          { type: "group_a6k", relation: "member" },
          { type: "serviceaccount_a6k" },
        ],
        impliedBy: null,
        computedUserset: null,
        tupleToUserset: null,
        excludedBy: null,
        intersection: null,
      });
    }
    await tsfga.writeRelationConfig({
      objectType: "namespace_a6k",
      relation: "can_admin",
      directlyAssignable: [],
      impliedBy: ["rb_admin"],
      computedUserset: null,
      tupleToUserset: [{ tupleset: "cluster", computedUserset: "crb_admin" }],
      excludedBy: null,
      intersection: null,
    });
    await tsfga.writeRelationConfig({
      objectType: "namespace_a6k",
      relation: "can_update",
      directlyAssignable: [],
      impliedBy: ["rb_edit", "can_admin"],
      computedUserset: null,
      tupleToUserset: [{ tupleset: "cluster", computedUserset: "crb_edit" }],
      excludedBy: null,
      intersection: null,
    });
    await tsfga.writeRelationConfig({
      objectType: "namespace_a6k",
      relation: "can_get",
      directlyAssignable: [],
      impliedBy: ["rb_view", "can_update"],
      computedUserset: null,
      tupleToUserset: [{ tupleset: "cluster", computedUserset: "crb_view" }],
      excludedBy: null,
      intersection: null,
    });

    // === pod_a6k ===
    await tsfga.writeRelationConfig({
      objectType: "pod_a6k",
      relation: "owner",
      directlyAssignable: [{ type: "namespace_a6k" }, { type: "cluster_a6k" }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    for (const [relation, computed] of [
      ["can_get", "can_get"],
      ["can_delete", "can_update"],
      ["can_exec", "can_admin"],
    ] as Array<[string, string]>) {
      await tsfga.writeRelationConfig({
        objectType: "pod_a6k",
        relation,
        directlyAssignable: [],
        impliedBy: null,
        computedUserset: null,
        tupleToUserset: [{ tupleset: "owner", computedUserset: computed }],
        excludedBy: null,
        intersection: null,
      });
    }

    // === Tuples ===
    for (const [sa, namespace] of [
      ["sa_ci", "web"],
      ["sa_bot", "kube_system"],
    ] as Array<[string, string]>) {
      await tsfga.addTuple({
        objectType: "serviceaccount_a6k",
        objectId: uuid(sa),
        relation: "namespace",
        subjectType: "namespace_a6k",
        subjectId: uuid(namespace),
      });
    }

    await tsfga.addTuple({
      objectType: "group_a6k",
      objectId: uuid("devs"),
      relation: "member",
      subjectType: "user_a6k",
      subjectId: uuid("bob"),
    });
    await tsfga.addTuple({
      objectType: "group_a6k",
      objectId: uuid("devs"),
      relation: "member",
      subjectType: "serviceaccount_a6k",
      subjectId: uuid("sa_ci"),
    });

    await tsfga.addTuple({
      objectType: "cluster_a6k",
      objectId: uuid("prod"),
      relation: "crb_admin",
      subjectType: "user_a6k",
      subjectId: uuid("alice"),
    });
    await tsfga.addTuple({
      objectType: "cluster_a6k",
      objectId: uuid("prod"),
      relation: "crb_view",
      subjectType: "user_a6k",
      subjectId: "*",
    });

    for (const namespace of ["web", "kube_system"]) {
      await tsfga.addTuple({
        objectType: "namespace_a6k",
        objectId: uuid(namespace),
        relation: "cluster",
        subjectType: "cluster_a6k",
        subjectId: uuid("prod"),
      });
    }
    await tsfga.addTuple({
      objectType: "namespace_a6k",
      objectId: uuid("web"),
      relation: "rb_edit",
      subjectType: "group_a6k",
      subjectId: uuid("devs"),
      subjectRelation: "member",
    });
    await tsfga.addTuple({
      objectType: "namespace_a6k",
      objectId: uuid("web"),
      relation: "rb_view",
      subjectType: "user_a6k",
      subjectId: uuid("carol"),
    });
    await tsfga.addTuple({
      objectType: "namespace_a6k",
      objectId: uuid("kube_system"),
      relation: "rb_view",
      subjectType: "serviceaccount_a6k",
      subjectId: uuid("sa_bot"),
    });

    for (const [pod, ownerType, owner] of [
      ["nginx", "namespace_a6k", "web"],
      ["etcd", "namespace_a6k", "kube_system"],
      ["orphan", "cluster_a6k", "prod"],
      ["mixed", "namespace_a6k", "web"],
      ["mixed", "cluster_a6k", "prod"],
    ] as Array<[string, string, string]>) {
      await tsfga.addTuple({
        objectType: "pod_a6k",
        objectId: uuid(pod),
        relation: "owner",
        subjectType: ownerType,
        subjectId: uuid(owner),
      });
    }

    storeId = await fgaCreateStore("k8s");
    authorizationModelId = await fgaWriteModel(storeId, "./k8s/model.dsl");
    await fgaWriteTuples(
      storeId,
      "./k8s/tuples.yaml",
      authorizationModelId,
      uuidMap,
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  // --- Namespaced bindings and the concentric verb chain ---

  test("1: bob updates web through group_a6k:devs#member", async () => {
    await byUser("namespace_a6k", "web", "can_update", "bob", true);
  });

  test("2: updating implies getting", async () => {
    await byUser("namespace_a6k", "web", "can_get", "bob", true);
  });

  test("3: carol only gets web", async () => {
    await byUser("namespace_a6k", "web", "can_get", "carol", true);
  });

  test("4: carol does not update web", async () => {
    await byUser("namespace_a6k", "web", "can_update", "carol", false);
  });

  test("5: nobody in devs administers web", async () => {
    await byUser("namespace_a6k", "web", "can_admin", "bob", false);
  });

  // --- Cluster role bindings reaching every namespace ---

  test("6: alice administers web from the cluster binding", async () => {
    await byUser("namespace_a6k", "web", "can_admin", "alice", true);
  });

  test("7: alice administers kube_system too", async () => {
    await byUser("namespace_a6k", "kube_system", "can_admin", "alice", true);
  });

  test("8: cluster admin implies update in the namespace", async () => {
    await byUser("namespace_a6k", "kube_system", "can_update", "alice", true);
  });

  test("9: the system:authenticated wildcard lets dave get web", async () => {
    await byUser("namespace_a6k", "web", "can_get", "dave", true);
  });

  test("10: it does not let him update it", async () => {
    await byUser("namespace_a6k", "web", "can_update", "dave", false);
  });

  test("11: bob does not update kube_system", async () => {
    await byUser("namespace_a6k", "kube_system", "can_update", "bob", false);
  });

  // --- Service accounts as subjects ---

  test("12: sa_ci updates web through the group it shares with bob", async () => {
    await bySa("namespace_a6k", "web", "can_update", "sa_ci", true);
  });

  test("13: sa_ci therefore gets web", async () => {
    await bySa("namespace_a6k", "web", "can_get", "sa_ci", true);
  });

  test("14: sa_bot gets kube_system by its own binding", async () => {
    await bySa("namespace_a6k", "kube_system", "can_get", "sa_bot", true);
  });

  test("15: the user_a6k wildcard does not admit a service account", async () => {
    await bySa("namespace_a6k", "web", "can_get", "sa_bot", false);
  });

  test("16: sa_bot does not update its own namespace", async () => {
    await bySa("namespace_a6k", "kube_system", "can_update", "sa_bot", false);
  });

  test("17: sa_ci is no cluster admin", async () => {
    await bySa("namespace_a6k", "web", "can_admin", "sa_ci", false);
  });

  // --- Pods inheriting from their namespace ---

  test("18: dave gets nginx through the namespace", async () => {
    await byUser("pod_a6k", "nginx", "can_get", "dave", true);
  });

  test("19: bob deletes nginx", async () => {
    await byUser("pod_a6k", "nginx", "can_delete", "bob", true);
  });

  test("20: carol does not delete nginx", async () => {
    await byUser("pod_a6k", "nginx", "can_delete", "carol", false);
  });

  test("21: alice execs into nginx", async () => {
    await byUser("pod_a6k", "nginx", "can_exec", "alice", true);
  });

  test("22: bob does not exec into nginx", async () => {
    await byUser("pod_a6k", "nginx", "can_exec", "bob", false);
  });

  test("23: bob does not delete etcd", async () => {
    await byUser("pod_a6k", "etcd", "can_delete", "bob", false);
  });

  test("24: sa_ci deletes nginx", async () => {
    await bySa("pod_a6k", "nginx", "can_delete", "sa_ci", true);
  });

  test("25: sa_bot gets etcd", async () => {
    await bySa("pod_a6k", "etcd", "can_get", "sa_bot", true);
  });

  // --- A tupleset row whose type does not define the relation ---

  test("26: a cluster-owned pod answers false, not a refusal", async () => {
    await byUser("pod_a6k", "orphan", "can_get", "dave", false);
  });

  test("27: the cluster admin gets nothing from it either", async () => {
    await byUser("pod_a6k", "orphan", "can_get", "alice", false);
  });

  test("28: nor can she exec into it", async () => {
    await byUser("pod_a6k", "orphan", "can_exec", "alice", false);
  });

  test("29: a service account subject sees the same false", async () => {
    await bySa("pod_a6k", "orphan", "can_get", "sa_ci", false);
  });

  test("30: a pod owned by both still answers from its namespace", async () => {
    await byUser("pod_a6k", "mixed", "can_get", "dave", true);
  });

  test("31: and the skipped cluster row does not add a grant", async () => {
    await byUser("pod_a6k", "mixed", "can_delete", "carol", false);
  });

  test("32: bob deletes the mixed pod through the namespace", async () => {
    await byUser("pod_a6k", "mixed", "can_delete", "bob", true);
  });

  // --- listObjects over the mixed-type tupleset ---

  test("33: the pods dave may get", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "pod_a6k",
        relation: "can_get",
        subjectType: "user_a6k",
        subjectId: uuid("dave"),
      },
      [uuid("nginx"), uuid("etcd"), uuid("mixed")],
    );
  });

  test("34: the pods sa_ci may delete", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "pod_a6k",
        relation: "can_delete",
        subjectType: "serviceaccount_a6k",
        subjectId: uuid("sa_ci"),
      },
      [uuid("nginx"), uuid("mixed")],
    );
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./k8s/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
