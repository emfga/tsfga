import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { WriteAuthorizationModelRequest } from "@openfga/sdk";
import {
  createTsfga,
  type RelationConfig,
  type TsfgaClient,
  TsfgaError,
} from "@tsfga/core";
import type { DB } from "@tsfga/kysely";
import { KyselyTupleStore } from "@tsfga/kysely";
import type { Kysely } from "kysely";
import {
  beginTransaction,
  destroyDb,
  getDb,
  rollbackTransaction,
} from "./helpers/db.ts";
import { fgaCreateStore, fgaWriteModelOutcome } from "./helpers/openfga.ts";

/**
 * The rules `pkg/typesystem/typesystem.go` enforces on a model,
 * enumerated rather than sampled.
 *
 * `model-gate.test.ts` covers the eight shapes the config gate
 * closes and the two it leaves open. This file walks the remainder of
 * `validateRelation` and `validateNames` and asks, for each rule,
 * whether it is decidable from a single `RelationConfig` — and if
 * it is, whether tsfga applies it.
 *
 * Rules that need the whole model (a rewrite naming an undefined
 * relation, a TTU whose computed relation no tupleset type
 * defines, a type restriction on an undefined type) are not
 * decidable from one config and are deliberately absent.
 *
 * What is left, and is decidable from one config alone:
 *
 * - `validateNames`: `self` and `this` are reserved, as an object
 *   type name and as a relation name.
 * - `isUsersetRewriteValid`: a computed userset naming **its own
 *   relation** is `ErrInvalidUsersetRewrite`, in every position
 *   the rewrite tree can hold one — a bare rewrite, a union
 *   child, an intersection child, and either side of a
 *   difference.
 */

const USER: WriteAuthorizationModelRequest["type_definitions"][number] = {
  type: "user_d3g",
  relations: {},
  metadata: { relations: {} },
};

function config(
  objectType: string,
  relation: string,
  overrides: Partial<RelationConfig> = {},
): RelationConfig {
  return {
    objectType,
    relation,
    directlyAssignable: [],
    impliedBy: null,
    computedUserset: null,
    tupleToUserset: null,
    excludedBy: null,
    intersection: null,
    ...overrides,
  };
}

describe("Model validation rules the config gate has left", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let tsfgaClient: TsfgaClient;

  beforeAll(async () => {
    db = getDb();
    await beginTransaction(db);
    tsfgaClient = createTsfga(new KyselyTupleStore(db));
    storeId = await fgaCreateStore("model-gate-rules");
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  async function openfga(
    model: WriteAuthorizationModelRequest,
  ): Promise<"accepted" | "refused"> {
    const outcome = await fgaWriteModelOutcome(storeId, model);
    return outcome === "accepted" ? "accepted" : "refused";
  }

  async function tsfga(
    configs: readonly RelationConfig[],
  ): Promise<"accepted" | "refused"> {
    for (const relationConfig of configs) {
      try {
        await tsfgaClient.writeRelationConfig(relationConfig);
      } catch (error) {
        if (error instanceof TsfgaError) return "refused";
        throw error;
      }
    }
    return "accepted";
  }

  test("control: a plain direct relation is stored by both", async () => {
    const type = "doc_d3g0";
    expect(
      await openfga({
        schema_version: "1.1",
        type_definitions: [
          USER,
          {
            type,
            relations: { viewer: { this: {} } },
            metadata: {
              relations: {
                viewer: { directly_related_user_types: [{ type: "user_d3g" }] },
              },
            },
          },
        ],
      }),
    ).toBe("accepted");
    expect(
      await tsfga([
        config(type, "viewer", { directlyAssignable: [{ type: "user_d3g" }] }),
      ]),
    ).toBe("accepted");
  });

  describe("reserved keywords", () => {
    for (const reserved of ["self", "this"]) {
      test(`'${reserved}' as an object type name is refused`, async () => {
        expect(
          await openfga({
            schema_version: "1.1",
            type_definitions: [
              USER,
              {
                type: reserved,
                relations: { viewer: { this: {} } },
                metadata: {
                  relations: {
                    viewer: {
                      directly_related_user_types: [{ type: "user_d3g" }],
                    },
                  },
                },
              },
            ],
          }),
        ).toBe("refused");
        expect(
          await tsfga([
            config(reserved, "viewer", {
              directlyAssignable: [{ type: "user_d3g" }],
            }),
          ]),
        ).toBe("refused");
      });

      test(`'${reserved}' as a relation name is refused`, async () => {
        const type = `doc_d3g_r_${reserved}`;
        expect(
          await openfga({
            schema_version: "1.1",
            type_definitions: [
              USER,
              {
                type,
                relations: { [reserved]: { this: {} } },
                metadata: {
                  relations: {
                    [reserved]: {
                      directly_related_user_types: [{ type: "user_d3g" }],
                    },
                  },
                },
              },
            ],
          }),
        ).toBe("refused");
        expect(
          await tsfga([
            config(type, reserved, {
              directlyAssignable: [{ type: "user_d3g" }],
            }),
          ]),
        ).toBe("refused");
      });
    }
  });

  describe("a rewrite naming its own relation", () => {
    test("a bare computed userset onto itself is refused", async () => {
      const type = "doc_d3g1";
      expect(
        await openfga({
          schema_version: "1.1",
          type_definitions: [
            USER,
            {
              type,
              relations: {
                viewer: { computedUserset: { relation: "viewer" } },
              },
              metadata: { relations: { viewer: {} } },
            },
          ],
        }),
      ).toBe("refused");
      expect(
        await tsfga([config(type, "viewer", { computedUserset: "viewer" })]),
      ).toBe("refused");
    });

    test("a union arm onto itself is refused", async () => {
      const type = "doc_d3g2";
      expect(
        await openfga({
          schema_version: "1.1",
          type_definitions: [
            USER,
            {
              type,
              relations: {
                viewer: {
                  union: {
                    child: [
                      { this: {} },
                      { computedUserset: { relation: "viewer" } },
                    ],
                  },
                },
              },
              metadata: {
                relations: {
                  viewer: {
                    directly_related_user_types: [{ type: "user_d3g" }],
                  },
                },
              },
            },
          ],
        }),
      ).toBe("refused");
      expect(
        await tsfga([
          config(type, "viewer", {
            directlyAssignable: [{ type: "user_d3g" }],
            impliedBy: ["viewer"],
          }),
        ]),
      ).toBe("refused");
    });

    test("an intersection operand onto itself is refused", async () => {
      const type = "doc_d3g3";
      expect(
        await openfga({
          schema_version: "1.1",
          type_definitions: [
            USER,
            {
              type,
              relations: {
                viewer: {
                  intersection: {
                    child: [
                      { this: {} },
                      { computedUserset: { relation: "viewer" } },
                    ],
                  },
                },
              },
              metadata: {
                relations: {
                  viewer: {
                    directly_related_user_types: [{ type: "user_d3g" }],
                  },
                },
              },
            },
          ],
        }),
      ).toBe("refused");
      expect(
        await tsfga([
          config(type, "viewer", {
            directlyAssignable: [{ type: "user_d3g" }],
            intersection: [
              { type: "direct" },
              { type: "computedUserset", relation: "viewer" },
            ],
          }),
        ]),
      ).toBe("refused");
    });

    test("an exclusion subtracting itself is refused", async () => {
      const type = "doc_d3g4";
      expect(
        await openfga({
          schema_version: "1.1",
          type_definitions: [
            USER,
            {
              type,
              relations: {
                viewer: {
                  difference: {
                    base: { this: {} },
                    subtract: { computedUserset: { relation: "viewer" } },
                  },
                },
              },
              metadata: {
                relations: {
                  viewer: {
                    directly_related_user_types: [{ type: "user_d3g" }],
                  },
                },
              },
            },
          ],
        }),
      ).toBe("refused");
      expect(
        await tsfga([
          config(type, "viewer", {
            directlyAssignable: [{ type: "user_d3g" }],
            excludedBy: "viewer",
          }),
        ]),
      ).toBe("refused");
    });
  });
});
