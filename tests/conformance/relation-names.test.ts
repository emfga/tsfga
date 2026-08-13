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
 * Type names and relation names, on the model/config write path.
 *
 * Upstream constrains both — a relation must contain no `:`, `#`,
 * `@` or space and no control character
 * (`tuple.IsValidRelation`, `pkg/tuple/tuple.go:441`), and the
 * API layer bounds their lengths besides. A model naming a
 * relation `can:view` is refused as
 * `invalid_authorization_model`, so no tuple against it can ever
 * exist.
 *
 * tsfga has no model document: `writeRelationConfig` is the only
 * place the same defect can be caught, and it is the shape
 * `model-gate.test.ts` covers for rewrites. This file covers
 * the *names*, which nothing validates today.
 *
 * A config stored under a name upstream refuses is not merely a
 * wider write surface. `check` resolves it, so tsfga answers
 * `true` for a model OpenFGA would never have stored — the same
 * silent disagreement the whole-model rules describe.
 */

const USER: WriteAuthorizationModelRequest["type_definitions"][number] = {
  type: "user_b5n",
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
    directlyAssignable: [{ type: "user_b5n" }],
    impliedBy: null,
    computedUserset: null,
    tupleToUserset: null,
    excludedBy: null,
    intersection: null,
    ...overrides,
  };
}

/** A model with one type carrying one directly assignable relation. */
function oneRelationModel(
  objectType: string,
  relation: string,
): WriteAuthorizationModelRequest {
  return {
    schema_version: "1.1",
    type_definitions: [
      USER,
      {
        type: objectType,
        relations: { [relation]: { this: {} } },
        metadata: {
          relations: {
            [relation]: { directly_related_user_types: [{ type: "user_b5n" }] },
          },
        },
      },
    ],
  };
}

describe("Identifier names on the model write path", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let tsfgaClient: TsfgaClient;

  beforeAll(async () => {
    db = getDb();
    await beginTransaction(db);
    tsfgaClient = createTsfga(new KyselyTupleStore(db));
    storeId = await fgaCreateStore("relation-names");
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  async function openfga(
    model: WriteAuthorizationModelRequest,
  ): Promise<"accepted" | "refused"> {
    // A name defect is refused by the API's protobuf pattern
    // before the typesystem runs, with a code of its own; the
    // shared helper knows those codes, so this file no longer
    // keeps a copy of them.
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

  /** Both engines must reach the same verdict on the same model. */
  async function expectBoth(
    objectType: string,
    relation: string,
    expected: "accepted" | "refused",
  ): Promise<void> {
    const [fga, ours] = await Promise.all([
      openfga(oneRelationModel(objectType, relation)),
      tsfga([config(objectType, relation)]),
    ]);
    expect(ours).toBe(fga);
    expect(ours).toBe(expected);
  }

  test("control: ordinary names are stored by both", async () => {
    await expectBoth("doc_b5n0", "viewer", "accepted");
  });

  describe("relation names", () => {
    test("a relation name containing ':'", async () => {
      await expectBoth("doc_b5n1", "can:view", "refused");
    });

    test("a relation name containing '#'", async () => {
      await expectBoth("doc_b5n2", "can#view", "refused");
    });

    test("a relation name containing '@'", async () => {
      await expectBoth("doc_b5n3", "can@view", "refused");
    });

    test("a relation name containing a space", async () => {
      await expectBoth("doc_b5n4", "can view", "refused");
    });

    test("an empty relation name", async () => {
      await expectBoth("doc_b5n5", "", "refused");
    });

    test("a relation name past the length limit", async () => {
      await expectBoth("doc_b5n6", "v".repeat(60), "refused");
    });
  });

  describe("type names", () => {
    test("a type name containing ':'", async () => {
      await expectBoth("doc:b5n7", "viewer", "refused");
    });

    test("a type name containing '#'", async () => {
      await expectBoth("doc#b5n8", "viewer", "refused");
    });

    test("a type name containing a space", async () => {
      await expectBoth("doc b5n9", "viewer", "refused");
    });

    test("an empty type name", async () => {
      await expectBoth("", "viewer", "refused");
    });

    test("a type name past the length limit", async () => {
      await expectBoth(`d${"o".repeat(300)}`, "viewer", "refused");
    });
  });
});
