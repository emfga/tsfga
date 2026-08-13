import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type AddTupleRequest,
  type TsfgaClient,
  TsfgaError,
} from "@tsfga/core";
import type { DB } from "@tsfga/kysely";
import type { Kysely } from "kysely";
import { expectListObjectsConformance } from "./helpers/conformance.ts";
import { fgaListObjects } from "./helpers/openfga.ts";
import { setupRewrites, teardownRewrites, uuid } from "./rewrites/setup.ts";

/**
 * `listObjects` with contextual tuples, across every edge kind.
 *
 * `list-objects.test.ts` covers a contextual direct tuple, a
 * contextual userset tuple, and an object no stored tuple names.
 * What it does not cover is the *set operators*: a contextual
 * tuple on the excluded side of a `but not` takes an object away
 * rather than adding one, which is the only way a contextual tuple
 * can ever shrink the answer — OpenFGA has no negative contextual
 * tuple, so a revocation has to be expressed as a grant on the
 * subtracted relation.
 */

describe("listObjects contextual-tuple parity", () => {
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

  async function expectObjects(
    relation: string,
    subject: string,
    contextualTuples: AddTupleRequest[],
    expected: string[],
  ): Promise<void> {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "doc_a4",
        relation,
        subjectType: "user_a4",
        subjectId: uuid(subject),
        contextualTuples,
      },
      expected.map(uuid),
    );
  }

  /** `user_a4:<subject>` on `doc_a4:<object>` for `relation`. */
  function grant(
    object: string,
    relation: string,
    subject: string,
  ): AddTupleRequest {
    return {
      objectType: "doc_a4",
      objectId: uuid(object),
      relation,
      subjectType: "user_a4",
      subjectId: uuid(subject),
    };
  }

  describe("adding objects", () => {
    test("a direct grant on an object no stored tuple names", async () => {
      await expectObjects(
        "direct_viewer",
        "carol",
        [grant("d_absent", "direct_viewer", "carol")],
        ["d_absent"],
      );
    });

    test("a wildcard grant", async () => {
      await expectObjects(
        "public_viewer",
        "carol",
        [
          {
            objectType: "doc_a4",
            objectId: uuid("d_absent"),
            relation: "public_viewer",
            subjectType: "user_a4",
            subjectId: "*",
          },
        ],
        ["d_public", "d_absent"],
      );
    });

    test("a userset grant expands through stored membership", async () => {
      await expectObjects(
        "group_viewer",
        "bob",
        [
          {
            objectType: "doc_a4",
            objectId: uuid("d_absent"),
            relation: "group_viewer",
            subjectType: "group_a4",
            subjectId: uuid("g1"),
            subjectRelation: "member",
          },
        ],
        ["d_group", "d_multi", "d_absent"],
      );
    });

    test("a tupleset grant reaches through the TTU", async () => {
      await expectObjects(
        "inherited_viewer",
        "alice",
        [
          {
            objectType: "doc_a4",
            objectId: uuid("d_absent"),
            relation: "parent",
            subjectType: "folder_a4",
            subjectId: uuid("f1"),
          },
        ],
        ["d_folder", "d_multi", "d_absent"],
      );
    });

    test("a grant completing an intersection's second arm", async () => {
      await expectObjects(
        "strict_viewer",
        "alice",
        [grant("d_multi", "required", "alice")],
        ["d_direct", "d_multi"],
      );
    });
  });

  describe("taking objects away", () => {
    test("a grant on the excluded side removes an object", async () => {
      await expectObjects(
        "guarded_viewer",
        "alice",
        [grant("d_direct", "blocked", "alice")],
        ["d_multi", "d_folder", "d_public"],
      );
    });

    test("the excluded side bites an object only context names", async () => {
      await expectObjects(
        "guarded_viewer",
        "carol",
        [
          grant("d_absent", "direct_viewer", "carol"),
          grant("d_absent", "blocked", "carol"),
        ],
        ["d_public"],
      );
    });
  });

  describe("shadowing", () => {
    test("restating a stored tuple changes nothing", async () => {
      await expectObjects(
        "direct_viewer",
        "alice",
        [grant("d_direct", "direct_viewer", "alice")],
        ["d_direct", "d_multi", "d_blocked"],
      );
    });

    test("a contextual tuple the model does not admit", async () => {
      // `direct_viewer` admits `user_a4` only, so a `group_a4`
      // subject is a tuple neither engine would ever have let be
      // written.
      const params = {
        objectType: "doc_a4",
        relation: "direct_viewer",
        subjectType: "user_a4",
        subjectId: uuid("alice"),
        contextualTuples: [
          {
            objectType: "doc_a4",
            objectId: uuid("d_absent"),
            relation: "direct_viewer",
            subjectType: "group_a4",
            subjectId: uuid("g1"),
          },
        ],
      };
      const tsfga = await tsfgaClient
        .listObjects(params)
        .then((objects) => `answered:${objects.length}`)
        .catch((error: unknown) => {
          if (error instanceof TsfgaError) return "refused";
          throw error;
        });
      const openfga = await fgaListObjects(storeId, authorizationModelId, {
        ...params,
        contextualTuples: [
          {
            user: `group_a4:${uuid("g1")}`,
            relation: "direct_viewer",
            object: `doc_a4:${uuid("d_absent")}`,
          },
        ],
      })
        .then((objects) => `answered:${objects.length}`)
        .catch(() => "refused");
      expect(tsfga).toBe(openfga);
    });

    test("a contextual grant to another subject changes nothing", async () => {
      await expectObjects(
        "direct_viewer",
        "carol",
        [grant("d_direct", "direct_viewer", "bob")],
        [],
      );
    });
  });
});
