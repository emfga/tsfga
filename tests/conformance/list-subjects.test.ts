import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type TsfgaClient, TsfgaError } from "@tsfga/core";
import type { DB } from "@tsfga/kysely";
import type { Kysely } from "kysely";
import { fgaListUsers, renderSubject } from "./rewrites/listusers.ts";
import { setupRewrites, teardownRewrites, uuid } from "./rewrites/setup.ts";

/**
 * `listSubjects` against OpenFGA's ListUsers.
 *
 * **Not apples to apples, and deliberately bounded.** tsfga's
 * `listSubjects` reports the *direct* subjects written on one
 * relation of one object, filtered by that relation's
 * `directlyAssignable`. ListUsers answers a strictly larger
 * question: it resolves the relation, so a computed userset, a
 * TTU, a union or an exclusion all contribute users that no tuple
 * on the object names.
 *
 * The two therefore only coincide on relations whose rewrite is
 * *just* direct assignment. Those are asserted as equalities. The
 * rewritten relations are asserted the other way round — as
 * containments — since the interesting failure is not "tsfga
 * returns fewer" (that is the documented scope) but "tsfga returns
 * a subject upstream would not admit at all", which would be the
 * granting direction.
 */

describe("listSubjects vs. ListUsers", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let authorizationModelId: string;
  let tsfgaClient: TsfgaClient;

  beforeAll(async () => {
    ({ db, storeId, authorizationModelId, tsfgaClient } =
      await setupRewrites());
  });

  afterAll(async () => {
    await teardownRewrites(db);
  });

  async function tsfgaSubjects(
    objectType: string,
    object: string,
    relation: string,
  ): Promise<string[]> {
    const rows = await tsfgaClient.listSubjects(
      objectType,
      uuid(object),
      relation,
    );
    return rows.map(renderSubject).sort();
  }

  async function upstreamSubjects(
    objectType: string,
    object: string,
    relation: string,
    filters: Array<{ type: string; relation?: string }>,
  ): Promise<string[]> {
    const rows = await fgaListUsers(storeId, authorizationModelId, {
      objectType,
      objectId: uuid(object),
      relation,
      filters,
    });
    return rows.map(renderSubject).sort();
  }

  describe("relations whose rewrite is only direct assignment", () => {
    test("a plain direct relation", async () => {
      const mine = await tsfgaSubjects("doc_a4", "d_direct", "direct_viewer");
      const theirs = await upstreamSubjects(
        "doc_a4",
        "d_direct",
        "direct_viewer",
        [{ type: "user_a4" }],
      );
      expect(mine).toEqual(theirs);
      expect(mine).toEqual([`user_a4:${uuid("alice")}`]);
    });

    test("a wildcard is reported as a wildcard by both", async () => {
      const mine = await tsfgaSubjects("doc_a4", "d_public", "public_viewer");
      const theirs = await upstreamSubjects(
        "doc_a4",
        "d_public",
        "public_viewer",
        [{ type: "user_a4" }],
      );
      expect(mine).toEqual(theirs);
      expect(mine).toEqual(["user_a4:*"]);
    });

    test("a userset subject, asked for as a userset", async () => {
      const mine = await tsfgaSubjects("doc_a4", "d_group", "group_viewer");
      const theirs = await upstreamSubjects(
        "doc_a4",
        "d_group",
        "group_viewer",
        [{ type: "group_a4", relation: "member" }],
      );
      expect(mine).toEqual(theirs);
      expect(mine).toEqual([`group_a4:${uuid("g1")}#member`]);
    });

    test("an object subject on a tupleset relation", async () => {
      const mine = await tsfgaSubjects("doc_a4", "d_folder", "parent");
      const theirs = await upstreamSubjects("doc_a4", "d_folder", "parent", [
        { type: "folder_a4" },
      ]);
      expect(mine).toEqual(theirs);
      expect(mine).toEqual([`folder_a4:${uuid("f1")}`]);
    });

    test("an object nothing is written on", async () => {
      const mine = await tsfgaSubjects("doc_a4", "d_absent", "direct_viewer");
      const theirs = await upstreamSubjects(
        "doc_a4",
        "d_absent",
        "direct_viewer",
        [{ type: "user_a4" }],
      );
      expect(mine).toEqual(theirs);
      expect(mine).toEqual([]);
    });

    test("three paths, three direct rows on three relations", async () => {
      expect(await tsfgaSubjects("doc_a4", "d_multi", "direct_viewer")).toEqual(
        [`user_a4:${uuid("alice")}`],
      );
      expect(await tsfgaSubjects("doc_a4", "d_multi", "group_viewer")).toEqual([
        `group_a4:${uuid("g1")}#member`,
      ]);
      expect(await tsfgaSubjects("doc_a4", "d_multi", "parent")).toEqual([
        `folder_a4:${uuid("f1")}`,
      ]);
    });
  });

  describe("rewritten relations: tsfga must never exceed upstream", () => {
    /**
     * tsfga reports the direct rows only, so the answer is a subset
     * of what upstream resolves — empty, for a relation with no
     * direct assignment at all. A row tsfga reported that upstream
     * did not would be the granting direction and is what this
     * asserts against.
     */
    async function expectSubset(
      relation: string,
      object: string,
    ): Promise<void> {
      const mine = await tsfgaSubjects("doc_a4", object, relation);
      // ListUsers takes exactly one filter per call, so the two
      // shapes tsfga can report are asked for separately.
      const theirs = new Set([
        ...(await upstreamSubjects("doc_a4", object, relation, [
          { type: "user_a4" },
        ])),
        ...(await upstreamSubjects("doc_a4", object, relation, [
          { type: "group_a4", relation: "member" },
        ])),
      ]);
      for (const row of mine) expect(theirs.has(row)).toBe(true);
    }

    test("computed userset", async () => {
      await expectSubset("computed_viewer", "d_direct");
      expect(
        await tsfgaSubjects("doc_a4", "d_direct", "computed_viewer"),
      ).toEqual([]);
    });

    test("tuple to userset", async () => {
      await expectSubset("inherited_viewer", "d_folder");
    });

    test("union", async () => {
      await expectSubset("union_viewer", "d_multi");
    });

    test("exclusion", async () => {
      await expectSubset("guarded_viewer", "d_direct");
    });

    test("intersection", async () => {
      await expectSubset("strict_viewer", "d_direct");
    });
  });

  describe("refusal parity", () => {
    test("a relation the model does not define", async () => {
      const mine = await tsfgaClient
        .listSubjects("doc_a4", uuid("d_direct"), "no_such_relation")
        .then(() => "answered")
        .catch((error: unknown) => {
          if (error instanceof TsfgaError) return "refused";
          throw error;
        });
      const theirs = await fgaListUsers(storeId, authorizationModelId, {
        objectType: "doc_a4",
        objectId: uuid("d_direct"),
        relation: "no_such_relation",
        filters: [{ type: "user_a4" }],
      })
        .then(() => "answered")
        .catch(() => "refused");
      expect(mine).toBe(theirs);
      expect(mine).toBe("refused");
    });

    test("an object type the model does not define", async () => {
      const mine = await tsfgaClient
        .listSubjects("no_such_type_a4", uuid("d_direct"), "direct_viewer")
        .then(() => "answered")
        .catch((error: unknown) => {
          if (error instanceof TsfgaError) return "refused";
          throw error;
        });
      const theirs = await fgaListUsers(storeId, authorizationModelId, {
        objectType: "no_such_type_a4",
        objectId: uuid("d_direct"),
        relation: "direct_viewer",
        filters: [{ type: "user_a4" }],
      })
        .then(() => "answered")
        .catch(() => "refused");
      expect(mine).toBe(theirs);
      expect(mine).toBe("refused");
    });
  });
});
