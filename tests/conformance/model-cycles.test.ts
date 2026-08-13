import { afterAll, beforeAll, describe, test } from "bun:test";
import type { WriteAuthorizationModelRequest } from "@openfga/sdk";
import {
  createTsfga,
  type RelationConfig,
  type TsfgaClient,
} from "@tsfga/core";
import type { DB } from "@tsfga/kysely";
import { KyselyTupleStore } from "@tsfga/kysely";
import type { Kysely } from "kysely";
import { expectModelWriteConformance } from "./helpers/conformance.ts";
import {
  beginTransaction,
  destroyDb,
  getDb,
  rollbackTransaction,
} from "./helpers/db.ts";
import { fgaCreateStore } from "./helpers/openfga.ts";

/**
 * A model whose rewrites lead back to where they started.
 *
 * OpenFGA refuses all three shapes below outright, from two
 * different functions — `HasCycle` reports "an authorization model
 * cannot contain a cycle", `hasEntrypoints` reports "potential
 * loop" for the ones where nothing can ever enter the relation.
 * Either way the model is not stored. tsfga stored every one of
 * them until this suite, and answered `false` for everything
 * underneath: nothing was granted, but a model upstream will not
 * accept was accepted here, and every later assumption about it
 * started from a premise upstream refuses.
 *
 * **Written as JSON rather than DSL**, like the other model-gate
 * suites: the DSL transformer refuses most of these before OpenFGA
 * ever sees them, and a refusal from the transformer is not the
 * refusal under test.
 *
 * **The controls are the point of the file as much as the cycles
 * are.** A cycle rule that follows the wrong edges refuses
 * ordinary models: a diamond is not a cycle, and neither is a
 * tuple-to-userset onto the same relation of another object, which
 * is the commonest shape an OpenFGA model has. Both are asserted
 * accepted by both engines.
 */

const USER: WriteAuthorizationModelRequest["type_definitions"][number] = {
  type: "user_e1c",
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

describe("Rewrite cycle conformance", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let tsfgaClient: TsfgaClient;

  beforeAll(async () => {
    db = getDb();
    await beginTransaction(db);
    tsfgaClient = createTsfga(new KyselyTupleStore(db));
    storeId = await fgaCreateStore("model-cycles");
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  /**
   * Write every config in order and let a refusal out.
   *
   * The order matters and is deliberately the natural one:
   * definition order. The last config written is the one that
   * closes the loop, because it is the only one that can see the
   * whole loop — the earlier ones name a relation that does not
   * exist yet, which is the documented write-order gap and not a
   * defect.
   */
  function writeAll(configs: readonly RelationConfig[]): () => Promise<void> {
    return async () => {
      for (const each of configs) {
        await tsfgaClient.writeRelationConfig(each);
      }
    };
  }

  test("two relations rewriting onto each other", async () => {
    const type = "doc_e1c1";
    await expectModelWriteConformance(
      storeId,
      {
        schema_version: "1.1",
        type_definitions: [
          USER,
          {
            type,
            relations: {
              a: { computedUserset: { relation: "b" } },
              b: { computedUserset: { relation: "a" } },
            },
            metadata: {
              relations: {
                a: { directly_related_user_types: [] },
                b: { directly_related_user_types: [] },
              },
            },
          },
        ],
      },
      writeAll([
        config(type, "a", { computedUserset: "b" }),
        config(type, "b", { computedUserset: "a" }),
      ]),
      "refused",
    );
  });

  test("three relations round a loop", async () => {
    const type = "doc_e1c2";
    await expectModelWriteConformance(
      storeId,
      {
        schema_version: "1.1",
        type_definitions: [
          USER,
          {
            type,
            relations: {
              a: { computedUserset: { relation: "b" } },
              b: { computedUserset: { relation: "c" } },
              c: { computedUserset: { relation: "a" } },
            },
            metadata: {
              relations: {
                a: { directly_related_user_types: [] },
                b: { directly_related_user_types: [] },
                c: { directly_related_user_types: [] },
              },
            },
          },
        ],
      },
      writeAll([
        config(type, "a", { computedUserset: "b" }),
        config(type, "b", { computedUserset: "c" }),
        config(type, "c", { computedUserset: "a" }),
      ]),
      "refused",
    );
  });

  test("a union arm closing the loop", async () => {
    // The realistic shape, and the one a partial port misses: `a`
    // has a legitimate direct assignment *and* unions in a
    // relation that points back at it, so nothing about it looks
    // inert.
    const type = "doc_e1c3";
    await expectModelWriteConformance(
      storeId,
      {
        schema_version: "1.1",
        type_definitions: [
          USER,
          {
            type,
            relations: {
              a: {
                union: {
                  child: [{ this: {} }, { computedUserset: { relation: "b" } }],
                },
              },
              b: { computedUserset: { relation: "a" } },
            },
            metadata: {
              relations: {
                a: { directly_related_user_types: [{ type: "user_e1c" }] },
                b: { directly_related_user_types: [] },
              },
            },
          },
        ],
      },
      writeAll([
        config(type, "a", {
          directlyAssignable: [{ type: "user_e1c" }],
          impliedBy: ["b"],
        }),
        config(type, "b", { computedUserset: "a" }),
      ]),
      "refused",
    );
  });

  test("the control: a diamond is not a cycle", async () => {
    // `d` is reached along two paths and is on neither of them
    // when it is reached. A walk carrying one global visited set
    // instead of a path set per branch calls this a cycle and
    // refuses a model OpenFGA stores.
    const type = "doc_e1c4";
    await expectModelWriteConformance(
      storeId,
      {
        schema_version: "1.1",
        type_definitions: [
          USER,
          {
            type,
            relations: {
              d: { this: {} },
              b: { computedUserset: { relation: "d" } },
              c: { computedUserset: { relation: "d" } },
              a: {
                union: {
                  child: [
                    { computedUserset: { relation: "b" } },
                    { computedUserset: { relation: "c" } },
                  ],
                },
              },
            },
            metadata: {
              relations: {
                d: { directly_related_user_types: [{ type: "user_e1c" }] },
                b: { directly_related_user_types: [] },
                c: { directly_related_user_types: [] },
                a: { directly_related_user_types: [] },
              },
            },
          },
        ],
      },
      writeAll([
        config(type, "d", { directlyAssignable: [{ type: "user_e1c" }] }),
        config(type, "b", { computedUserset: "d" }),
        config(type, "c", { computedUserset: "d" }),
        config(type, "a", { impliedBy: ["b", "c"] }),
      ]),
      "accepted",
    );
  });

  test("the control: a tuple-to-userset onto itself is not a cycle", async () => {
    // `viewer: viewer from parent` names *this* relation on
    // another object. Upstream's `hasCycle` returns false
    // immediately on a tuple-to-userset for exactly this reason,
    // and a rule that followed the edge would refuse most of the
    // corpus.
    const type = "doc_e1c5";
    await expectModelWriteConformance(
      storeId,
      {
        schema_version: "1.1",
        type_definitions: [
          USER,
          {
            // The linked type has to define `viewer` itself:
            // upstream refuses a tuple-to-userset whose computed
            // relation no tupleset type defines, and that refusal
            // is a different rule from the one under test.
            type: "folder_e1c",
            relations: { viewer: { this: {} } },
            metadata: {
              relations: {
                viewer: {
                  directly_related_user_types: [{ type: "user_e1c" }],
                },
              },
            },
          },
          {
            type,
            relations: {
              parent: { this: {} },
              viewer: {
                union: {
                  child: [
                    { this: {} },
                    {
                      tupleToUserset: {
                        tupleset: { relation: "parent" },
                        computedUserset: { relation: "viewer" },
                      },
                    },
                  ],
                },
              },
            },
            metadata: {
              relations: {
                parent: {
                  directly_related_user_types: [{ type: "folder_e1c" }],
                },
                viewer: {
                  directly_related_user_types: [{ type: "user_e1c" }],
                },
              },
            },
          },
        ],
      },
      writeAll([
        config("folder_e1c", "viewer", {
          directlyAssignable: [{ type: "user_e1c" }],
        }),
        config(type, "parent", {
          directlyAssignable: [{ type: "folder_e1c" }],
        }),
        config(type, "viewer", {
          directlyAssignable: [{ type: "user_e1c" }],
          tupleToUserset: [{ tupleset: "parent", computedUserset: "viewer" }],
        }),
      ]),
      "accepted",
    );
  });
});
