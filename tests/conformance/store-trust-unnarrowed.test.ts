import { afterAll, beforeAll, describe, test } from "bun:test";
import type { CheckTuples, CheckTuplesQuery, TsfgaClient } from "@tsfga/core";
import { createTsfga } from "@tsfga/core";
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

/**
 * The clamp, tested where the conformance suite can see it.
 *
 * `userset-restrictions` pins the same model and the same rows and
 * passes with the clamp deleted, because it cannot reach it: the
 * adapter's SQL removes the inadmissible rows before the clamp is
 * asked about them, so at this layer the clamp is dead code. That
 * is the mechanism that hides the defect, not a mitigation for it —
 * replacing both `refsAdmit` calls in `clampToQuery` with `true`
 * leaves all 477 conformance tests green.
 *
 * `UnnarrowedStore` removes the SQL narrowing so the rows arrive.
 * The relation configs are unchanged, so `clampToQuery` still
 * clamps against the query **core** built rather than the one the
 * store saw, and it is then the only thing between an inadmissible
 * row and a grant. Every expectation below is therefore an
 * assertion about the clamp, and every one is compared against
 * OpenFGA rather than against tsfga's own prior behaviour.
 *
 * This suite exists to fail when the clamp is weakened. If it ever
 * passes with `refsAdmit` stubbed to `true`, it has stopped doing
 * its job.
 */

/**
 * Declines every narrowing the query offers. `null` is a store
 * saying "I did not narrow this", which is what the adapter's own
 * contract already means, so nothing here is a lie the adapter
 * could not tell on its own — a hand-written store that ignores
 * the ref lists behaves exactly like this.
 */
class UnnarrowedStore extends KyselyTupleStore {
  override findCheckTuples(query: CheckTuplesQuery): Promise<CheckTuples> {
    return super.findCheckTuples({
      ...query,
      directRefs: null,
      wildcardRefs: null,
      usersetRefs: null,
    });
  }
}

const uuidMap = new Map<string, string>([
  ["alice", "00000000-0000-4000-ca00-000000000001"],
  ["bob", "00000000-0000-4000-ca00-000000000002"],
  ["eng", "00000000-0000-4000-ca00-000000000010"],
  ["budget", "00000000-0000-4000-ca00-000000000020"],
  ["roadmap", "00000000-0000-4000-ca00-000000000021"],
  ["plan", "00000000-0000-4000-ca00-000000000022"],
  ["charter", "00000000-0000-4000-ca00-000000000023"],
  ["notice", "00000000-0000-4000-ca00-000000000024"],
]);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

describe("Clamp Conformance Through an Unnarrowing Store", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let narrowModelId: string;
  let tsfgaClient: TsfgaClient;

  beforeAll(async () => {
    db = getDb();
    await beginTransaction(db);

    const store = new UnnarrowedStore(db);
    tsfgaClient = createTsfga(store);

    for (const relation of ["member", "owner"]) {
      await tsfgaClient.writeRelationConfig({
        objectType: "team",
        relation,
        directlyAssignable: [{ type: "user" }],
        impliedBy: null,
        computedUserset: null,
        tupleToUserset: null,
        excludedBy: null,
        intersection: null,
      });
    }
    await tsfgaClient.writeRelationConfig({
      objectType: "document",
      relation: "viewer",
      directlyAssignable: [
        { type: "user" },
        { type: "team", relation: "member" },
      ],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "document",
      relation: "editor",
      directlyAssignable: [
        { type: "team", relation: "member" },
        { type: "team", relation: "owner" },
      ],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "document",
      relation: "owner",
      directlyAssignable: [{ type: "user" }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "document",
      relation: "public",
      directlyAssignable: [{ type: "user", wildcard: true }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });

    // Onto the store, bypassing the write gate: these are rows the
    // model does not admit, which is the population the clamp
    // exists for and the one a write-gated fixture cannot contain.
    for (const tuple of [
      {
        objectType: "team",
        objectId: uuid("eng"),
        relation: "owner",
        subjectType: "user",
        subjectId: uuid("alice"),
      },
      {
        objectType: "team",
        objectId: uuid("eng"),
        relation: "member",
        subjectType: "user",
        subjectId: uuid("bob"),
      },
      {
        objectType: "document",
        objectId: uuid("budget"),
        relation: "viewer",
        subjectType: "team",
        subjectId: uuid("eng"),
        subjectRelation: "owner",
      },
      {
        objectType: "document",
        objectId: uuid("roadmap"),
        relation: "viewer",
        subjectType: "team",
        subjectId: uuid("eng"),
        subjectRelation: "member",
      },
      {
        objectType: "document",
        objectId: uuid("plan"),
        relation: "editor",
        subjectType: "team",
        subjectId: uuid("eng"),
        subjectRelation: "owner",
      },
      {
        objectType: "document",
        objectId: uuid("charter"),
        relation: "owner",
        subjectType: "team",
        subjectId: uuid("eng"),
        subjectRelation: "member",
      },
      {
        objectType: "document",
        objectId: uuid("charter"),
        relation: "owner",
        subjectType: "user",
        subjectId: "*",
      },
      {
        objectType: "document",
        objectId: uuid("notice"),
        relation: "public",
        subjectType: "user",
        subjectId: "*",
      },
    ]) {
      await store.insertTuple(tuple);
    }

    storeId = await fgaCreateStore("clamp-unnarrowed-conformance");
    const wideModelId = await fgaWriteModel(
      storeId,
      "./userset-restrictions/model-wide.dsl",
    );
    await fgaWriteTuples(
      storeId,
      "./userset-restrictions/tuples.yaml",
      wideModelId,
      uuidMap,
    );
    narrowModelId = await fgaWriteModel(
      storeId,
      "./userset-restrictions/model-narrow.dsl",
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  /**
   * Each of these reaches the clamp with a row the model does not
   * admit. With `refsAdmit` stubbed to `true` every one of them
   * grants, and every one of them diverges from OpenFGA.
   */
  describe("the clamp drops rows the read gate would have filtered", () => {
    test("a userset row naming an unadmitted relation is dropped", async () => {
      // document:budget#viewer@team:eng#owner, but viewer admits
      // only team#member. alice is an owner.
      await expectConformance(
        storeId,
        narrowModelId,
        tsfgaClient,
        {
          objectType: "document",
          objectId: uuid("budget"),
          relation: "viewer",
          subjectType: "user",
          subjectId: uuid("alice"),
        },
        false,
      );
    });

    test("a userset row on a relation admitting no userset is dropped", async () => {
      // document:charter#owner@team:eng#member, but owner admits
      // only a bare user. bob is a member.
      await expectConformance(
        storeId,
        narrowModelId,
        tsfgaClient,
        {
          objectType: "document",
          objectId: uuid("charter"),
          relation: "owner",
          subjectType: "user",
          subjectId: uuid("bob"),
        },
        false,
      );
    });

    test("a wildcard row on a relation admitting no wildcard is dropped", async () => {
      // document:charter#owner@user:*, but owner admits `user`
      // bare, not `user:*`.
      await expectConformance(
        storeId,
        narrowModelId,
        tsfgaClient,
        {
          objectType: "document",
          objectId: uuid("charter"),
          relation: "owner",
          subjectType: "user",
          subjectId: uuid("alice"),
        },
        false,
      );
    });
  });

  /**
   * The other half of the assertion. Without these the suite could
   * pass by denying everything, which is the failure mode a test
   * about a narrowing rule is most likely to have.
   */
  describe("admissible rows still grant", () => {
    test("an admitted userset expands", async () => {
      await expectConformance(
        storeId,
        narrowModelId,
        tsfgaClient,
        {
          objectType: "document",
          objectId: uuid("roadmap"),
          relation: "viewer",
          subjectType: "user",
          subjectId: uuid("bob"),
        },
        true,
      );
    });

    test("a relation admitting two usersets expands the matching one", async () => {
      await expectConformance(
        storeId,
        narrowModelId,
        tsfgaClient,
        {
          objectType: "document",
          objectId: uuid("plan"),
          relation: "editor",
          subjectType: "user",
          subjectId: uuid("alice"),
        },
        true,
      );
    });

    test("an admitted wildcard still grants", async () => {
      await expectConformance(
        storeId,
        narrowModelId,
        tsfgaClient,
        {
          objectType: "document",
          objectId: uuid("notice"),
          relation: "public",
          subjectType: "user",
          subjectId: uuid("alice"),
        },
        true,
      );
    });
  });
});
