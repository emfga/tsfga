import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { TsfgaClient } from "@tsfga/core";
import type { DB } from "@tsfga/kysely";
import type { Kysely } from "kysely";
import { setupBatch, teardownBatch, uuid } from "./batch/setup.ts";
import { fgaListUsers, renderSubject } from "./batch/upstream.ts";

/**
 * `listSubjects` against ListUsers, pushed at the seams
 * `list-subjects.test.ts` leaves alone.
 *
 * `list-subjects.test.ts` establishes the bound: tsfga reports
 * the *direct* rows of one relation, upstream resolves the whole
 * relation, so the two coincide only where the rewrite is direct
 * assignment. This asks the questions that bound leaves open —
 * what happens when the direct assignment is *conditioned*, when
 * one relation admits four shapes at once, and when the subject is
 * a userset of a userset.
 *
 * The direction that matters is the same one: a subject tsfga
 * reports that upstream would not is the granting direction.
 */

describe("listSubjects: conditions, wildcards and mixed shapes", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let authorizationModelId: string;
  let tsfgaClient: TsfgaClient;

  beforeAll(async () => {
    ({ db, storeId, authorizationModelId, tsfgaClient } = await setupBatch());
  });

  afterAll(async () => {
    await teardownBatch(db);
  });

  async function mine(
    object: string,
    relation: string,
    context?: Record<string, unknown>,
  ): Promise<string[]> {
    const rows = await tsfgaClient.listSubjects(
      "doc_c4",
      uuid(object),
      relation,
      { context },
    );
    return rows.map(renderSubject).sort();
  }

  async function theirs(
    object: string,
    relation: string,
    filters: Array<{ type: string; relation?: string }>,
    context?: Record<string, unknown>,
  ): Promise<string[]> {
    const rows = await fgaListUsers(storeId, authorizationModelId, {
      objectType: "doc_c4",
      objectId: uuid(object),
      relation,
      filters,
      context,
    });
    return rows.map(renderSubject).sort();
  }

  describe("a relation admitting four shapes at once", () => {
    // doc_c4.direct_viewer is
    // `[user_c4, user_c4:*, group_c4#member, user_c4 with weekday_c4]`.

    test("the userset row is reported as the userset it is", async () => {
      const ours = await mine("d1", "direct_viewer");
      expect(ours).toEqual([`group_c4:${uuid("g2")}#member`]);
      // Upstream resolves the userset rather than reporting it, so
      // the comparison is a containment: everything tsfga names
      // must be something upstream names too.
      const upstream = new Set([
        ...(await theirs("d1", "direct_viewer", [
          { type: "group_c4", relation: "member" },
        ])),
        ...(await theirs("d1", "direct_viewer", [{ type: "user_c4" }])),
      ]);
      for (const row of ours) expect(upstream.has(row)).toBe(true);
    });

    test("the wildcard row is reported as a wildcard by both", async () => {
      expect(await mine("d2", "direct_viewer")).toEqual(["user_c4:*"]);
      expect(
        await theirs("d2", "direct_viewer", [{ type: "user_c4" }]),
      ).toEqual(["user_c4:*"]);
    });

    test("an object nothing is written on", async () => {
      expect(await mine("d4", "direct_viewer")).toEqual([]);
      expect(
        await theirs("d4", "direct_viewer", [{ type: "user_c4" }]),
      ).toEqual([]);
    });
  });

  describe("a conditioned direct assignment", () => {
    // d3 carries two rows on one relation: alice's is conditioned
    // on `weekday_c4`, bob's is not.

    test("tsfga reports the conditioned row when the context satisfies it", async () => {
      expect(await mine("d3", "direct_viewer", { day: "mon" })).toEqual([
        `user_c4:${uuid("alice")}`,
        `user_c4:${uuid("bob")}`,
      ]);
    });

    test("upstream reports it when the context satisfies the condition", async () => {
      expect(
        await theirs("d3", "direct_viewer", [{ type: "user_c4" }], {
          day: "mon",
        }),
      ).toEqual([`user_c4:${uuid("alice")}`, `user_c4:${uuid("bob")}`]);
    });

    test("upstream drops it when the context does not", async () => {
      // The one direction that matters: a subject tsfga names that
      // upstream, given the same request, does not. Both sides are
      // asked under `{ day: "tue" }`, so a row tsfga reports here
      // is one a `check` under this context would deny.
      const upstream = await theirs(
        "d3",
        "direct_viewer",
        [{ type: "user_c4" }],
        { day: "tue" },
      );
      expect(upstream).toEqual([`user_c4:${uuid("bob")}`]);
      expect(await mine("d3", "direct_viewer", { day: "tue" })).toEqual(
        upstream,
      );
    });

    test("with no context at all, upstream refuses", async () => {
      // `failed to evaluate relationship condition: 'weekday_c4' —
      // tuple ... is missing context parameters '[day]'`. Both
      // sides are asked with no context, so a conditioned row on
      // the relation is unevaluable and the call must refuse
      // rather than report the row unevaluated.
      const upstream = await theirs("d3", "direct_viewer", [
        { type: "user_c4" },
      ])
        .then(() => "answered")
        .catch(() => "refused");
      const ours = await mine("d3", "direct_viewer")
        .then(() => "answered")
        .catch(() => "refused");
      expect(ours).toBe(upstream);
    });
  });

  describe("rewritten relations stay a subset", () => {
    async function expectSubset(
      object: string,
      relation: string,
    ): Promise<void> {
      const ours = await mine(object, relation);
      const upstream = new Set([
        ...(await theirs(object, relation, [{ type: "user_c4" }], {
          day: "mon",
        })),
        ...(await theirs(
          object,
          relation,
          [{ type: "group_c4", relation: "member" }],
          { day: "mon" },
        )),
      ]);
      for (const row of ours) expect(upstream.has(row)).toBe(true);
    }

    test("a union of direct, computed and TTU reports nothing directly", async () => {
      expect(await mine("d1", "viewer")).toEqual([]);
      await expectSubset("d1", "viewer");
    });

    test("an exclusion reports nothing directly", async () => {
      expect(await mine("d1", "editor")).toEqual([]);
      await expectSubset("d1", "editor");
    });

    test("the excluding relation itself is direct and agrees exactly", async () => {
      expect(await mine("d1", "blocked")).toEqual([`user_c4:${uuid("carol")}`]);
      expect(await theirs("d1", "blocked", [{ type: "user_c4" }])).toEqual([
        `user_c4:${uuid("carol")}`,
      ]);
    });
  });
});
