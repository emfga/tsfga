import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type TsfgaClient, TsfgaError } from "@tsfga/core";
import type { DB } from "@tsfga/kysely";
import type { Kysely } from "kysely";
import {
  expectConfigsMatchModel,
  expectListObjectsConformance,
  type FixtureRecord,
} from "./helpers/conformance.ts";
import { fgaListObjects } from "./helpers/openfga.ts";
import { setupRewrites, teardownRewrites, uuid } from "./rewrites/setup.ts";

/**
 * `listObjects` with every rewrite kind as the *target* relation.
 *
 * The existing `list-objects.test.ts` asks the gdrive fixture what
 * a subject reaches; it never asks the same question once per
 * rewrite kind, and it never asks for a relation the model does
 * not define. Both are done here.
 */

describe("listObjects rewrite parity", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let authorizationModelId: string;
  let tsfgaClient: TsfgaClient;
  let fixture: FixtureRecord;

  beforeAll(async () => {
    ({ db, storeId, authorizationModelId, tsfgaClient, fixture } =
      await setupRewrites());
  });

  afterAll(async () => {
    await teardownRewrites(db);
  });

  async function expectObjects(
    relation: string,
    subject: string,
    expected: string[],
    objectType = "doc_a4",
  ): Promise<void> {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType,
        relation,
        subjectType: "user_a4",
        subjectId: uuid(subject),
      },
      expected.map(uuid),
    );
  }

  describe("one rewrite kind at a time", () => {
    test("direct", async () => {
      await expectObjects("direct_viewer", "alice", [
        "d_direct",
        "d_multi",
        "d_blocked",
      ]);
    });

    test("wildcard reaches a subject written on nothing", async () => {
      await expectObjects("public_viewer", "carol", ["d_public"]);
    });

    test("userset", async () => {
      await expectObjects("group_viewer", "bob", ["d_group", "d_multi"]);
    });

    test("computed userset", async () => {
      await expectObjects("computed_viewer", "alice", [
        "d_direct",
        "d_multi",
        "d_blocked",
      ]);
    });

    test("tuple to userset", async () => {
      await expectObjects("inherited_viewer", "alice", ["d_folder", "d_multi"]);
    });

    test("union over all four", async () => {
      await expectObjects("union_viewer", "alice", [
        "d_direct",
        "d_multi",
        "d_folder",
        "d_blocked",
        "d_public",
      ]);
    });

    test("union reaches the wildcard object alone", async () => {
      await expectObjects("union_viewer", "carol", ["d_public"]);
    });

    test("exclusion drops the blocked object", async () => {
      await expectObjects("guarded_viewer", "alice", [
        "d_direct",
        "d_multi",
        "d_folder",
        "d_public",
      ]);
    });

    test("intersection keeps only the object with both arms", async () => {
      await expectObjects("strict_viewer", "alice", ["d_direct"]);
    });
  });

  describe("more than one path to the same object", () => {
    test("no duplicates for an object reached three ways", async () => {
      const objects = await tsfgaClient.listObjects({
        objectType: "doc_a4",
        relation: "union_viewer",
        subjectType: "user_a4",
        subjectId: uuid("alice"),
      });
      expect(objects.length).toBe(new Set(objects).size);
      const upstream = await fgaListObjects(storeId, authorizationModelId, {
        objectType: "doc_a4",
        relation: "union_viewer",
        subjectType: "user_a4",
        subjectId: uuid("alice"),
      });
      expect(upstream.length).toBe(new Set(upstream).size);
    });
  });

  describe("empty answers", () => {
    test("a subject who reaches nothing", async () => {
      await expectObjects("direct_viewer", "carol", []);
    });

    test("a relation defined but granted to nobody asked about", async () => {
      await expectObjects("unused", "alice", []);
    });

    test("a type whose objects the subject never reaches", async () => {
      await expectObjects("viewer", "bob", [], "folder_a4");
    });

    test("a subject type the relation does not admit", async () => {
      await expectListObjectsConformance(
        storeId,
        authorizationModelId,
        tsfgaClient,
        {
          objectType: "doc_a4",
          relation: "direct_viewer",
          subjectType: "group_a4",
          subjectId: uuid("g1"),
        },
        [],
      );
    });
  });

  describe("refusal parity", () => {
    /** What each engine does when asked something undefined. */
    async function outcomes(
      objectType: string,
      relation: string,
    ): Promise<{ tsfga: string; openfga: string }> {
      const params = {
        objectType,
        relation,
        subjectType: "user_a4",
        subjectId: uuid("alice"),
      };
      const tsfga = await tsfgaClient
        .listObjects(params)
        .then(() => "answered")
        .catch((error: unknown) => {
          if (error instanceof TsfgaError) return "refused";
          throw error;
        });
      const openfga = await fgaListObjects(
        storeId,
        authorizationModelId,
        params,
      )
        .then(() => "answered")
        .catch(() => "refused");
      return { tsfga, openfga };
    }

    test("a relation the model does not define", async () => {
      const { tsfga, openfga } = await outcomes("doc_a4", "no_such_relation");
      expect(tsfga).toBe(openfga);
      expect(tsfga).toBe("refused");
    });

    /**
     * The type is defined and the relation is not, exactly as in
     * the passing case above — the only difference is that no
     * stored tuple names an object of this type, so tsfga's
     * candidate pool is empty and the relation config is never
     * consulted. An undefined relation must be refused whether or
     * not any data happens to exist.
     */
    test("a defined type with no tuples, undefined relation", async () => {
      const { tsfga, openfga } = await outcomes("user_a4", "member");
      expect(openfga).toBe("refused");
      expect(tsfga).toBe("refused");
    });

    /**
     * `user_a4:*` as the *subject* of the request. Upstream
     * rejects it: a wildcard is something a tuple may grant to,
     * not something that can ask a question. tsfga has no such
     * gate, and `doc_a4:d_public` carries a literal `*` row that a
     * naive direct-tuple match would return.
     */
    test("a wildcard as the requesting subject", async () => {
      const params = {
        objectType: "doc_a4",
        relation: "public_viewer",
        subjectType: "user_a4",
        subjectId: "*",
      };
      const tsfga = await tsfgaClient
        .listObjects(params)
        .then((objects) => `answered:${objects.length}`)
        .catch((error: unknown) => {
          if (error instanceof TsfgaError) return "refused";
          throw error;
        });
      const openfga = await fgaListObjects(
        storeId,
        authorizationModelId,
        params,
      )
        .then((objects) => `answered:${objects.length}`)
        .catch(() => "refused");
      expect(tsfga).toBe(openfga);
    });

    test("an object type the model does not define", async () => {
      const { tsfga, openfga } = await outcomes("no_such_type_a4", "viewer");
      expect(openfga).toBe("refused");
      expect(tsfga).toBe("refused");
    });
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./rewrites/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
