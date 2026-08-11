import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { WriteAuthorizationModelRequest } from "@openfga/sdk";
import {
  createTsfga,
  InvalidRelationConfigError,
  type RelationConfig,
  type TsfgaClient,
  TsfgaError,
} from "@tsfga/core";
import type { DB } from "@tsfga/kysely";
import { KyselyTupleStore } from "@tsfga/kysely";
import type { Kysely } from "kysely";
import {
  expectConformance,
  expectPinnedDivergence,
  expectWriteConformance,
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
  fgaWriteModelOutcome,
  fgaWriteTuples,
} from "./helpers/openfga.ts";

/**
 * Shapes OpenFGA's typesystem rejects when it validates a model,
 * and the one tuple it rejects as implicit.
 *
 * Two of them changed an answer rather than merely widening the
 * write surface: a single-operand `intersection` resolved to
 * whatever that operand said, and a tupleset relation admitting a
 * userset had its subject relation discarded on dispatch, landing
 * on a different relation of the linked object and **granting**.
 *
 * **Hand-built models.** The single-operand intersection is not
 * expressible in the DSL — `define viewer: a and a` is accepted
 * upstream, because the transformer emits two children — so a
 * DSL-driven test would pass against an accepted model and prove
 * nothing. The rest are built the same way for consistency.
 */

const uuidMap = new Map<string, string>([
  ["alice", "00000000-0000-4000-cf00-000000000001"],
  ["doc1", "00000000-0000-4000-cf00-000000000002"],
]);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

type Ref = { type: string; relation?: string; wildcard?: object };

/** A `doc` whose `viewer` is a tuple-to-userset over `parent`. */
function ttuModel(parentRefs: Ref[]): WriteAuthorizationModelRequest {
  return {
    schema_version: "1.1",
    type_definitions: [
      { type: "user", relations: {}, metadata: { relations: {} } },
      {
        type: "folder",
        relations: { owner: { this: {} }, viewer: { this: {} } },
        metadata: {
          relations: {
            owner: { directly_related_user_types: [{ type: "user" }] },
            viewer: {
              directly_related_user_types: [
                { type: "user" },
                { type: "user", wildcard: {} },
              ],
            },
          },
        },
      },
      {
        type: "doc",
        relations: {
          parent: { this: {} },
          viewer: {
            tupleToUserset: {
              tupleset: { relation: "parent" },
              computedUserset: { relation: "viewer" },
            },
          },
        },
        metadata: {
          relations: {
            parent: { directly_related_user_types: parentRefs },
            viewer: { directly_related_user_types: [] },
          },
        },
      },
    ],
  };
}

/** A `doc` whose `viewer` is an intersection with `children` operands. */
function intersectionModel(children: number): WriteAuthorizationModelRequest {
  return {
    schema_version: "1.1",
    type_definitions: [
      { type: "user", relations: {}, metadata: { relations: {} } },
      {
        type: "doc",
        relations: {
          a: { this: {} },
          viewer: {
            intersection: {
              child: Array.from({ length: children }, () => ({
                computedUserset: { relation: "a" },
              })),
            },
          },
        },
        metadata: {
          relations: {
            a: { directly_related_user_types: [{ type: "user" }] },
            viewer: { directly_related_user_types: [] },
          },
        },
      },
    ],
  };
}

/** A `doc.viewer` restricted under a condition named `condition`. */
function conditionModel(
  condition: string,
  defined: boolean,
): WriteAuthorizationModelRequest {
  return {
    schema_version: "1.1",
    type_definitions: [
      { type: "user", relations: {}, metadata: { relations: {} } },
      {
        type: "doc",
        relations: { viewer: { this: {} } },
        metadata: {
          relations: {
            viewer: {
              directly_related_user_types: [{ type: "user", condition }],
            },
          },
        },
      },
    ],
    conditions: defined
      ? {
          [condition]: {
            name: condition,
            expression: "true",
            parameters: {},
          },
        }
      : {},
  };
}

function config(overrides: Partial<RelationConfig>): RelationConfig {
  return {
    objectType: "doc",
    relation: "viewer",
    directlyAssignable: [],
    impliedBy: null,
    computedUserset: null,
    tupleToUserset: null,
    excludedBy: null,
    intersection: null,
    ...overrides,
  };
}

describe("Relation Config Validation Conformance", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let tsfgaClient: TsfgaClient;

  beforeAll(async () => {
    db = getDb();
    await beginTransaction(db);
    tsfgaClient = createTsfga(new KyselyTupleStore(db));
    storeId = await fgaCreateStore("config-validation-conformance");
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  /**
   * Both engines must agree on whether a shape may be defined at
   * all: the model write upstream, the config write here.
   */
  async function expectConfigConformance(
    model: WriteAuthorizationModelRequest,
    configs: RelationConfig[],
    expected: "accepted" | "refused",
  ): Promise<void> {
    const [tsfgaOutcome, openFgaOutcome] = await Promise.all([
      (async () => {
        for (const each of configs) {
          await tsfgaClient.writeRelationConfig(each);
        }
        return "accepted" as const;
      })().catch((error: unknown) => {
        // A TsfgaError is the model refusing. Anything else -- a
        // dropped connection, a broken fixture -- would otherwise
        // satisfy the assertion it exists to make.
        if (error instanceof TsfgaError) return "refused" as const;
        throw error;
      }),
      fgaWriteModelOutcome(storeId, model).then((outcome) =>
        outcome === "accepted" ? "accepted" : "refused",
      ),
    ]);

    expect(tsfgaOutcome).toBe(openFgaOutcome);
    expect(tsfgaOutcome).toBe(expected);
  }

  describe("an intersection with fewer than two operands", () => {
    test("one operand is refused by both", async () => {
      await expectConfigConformance(
        intersectionModel(1),
        [
          config({ objectType: "one", relation: "a" }),
          config({
            objectType: "one",
            intersection: [{ type: "computedUserset", relation: "a" }],
          }),
        ],
        "refused",
      );
    });

    test("the control: two operands are accepted by both", async () => {
      await expectConfigConformance(
        intersectionModel(2),
        [
          config({ objectType: "two", relation: "a" }),
          config({
            objectType: "two",
            intersection: [
              { type: "computedUserset", relation: "a" },
              { type: "computedUserset", relation: "a" },
            ],
          }),
        ],
        "accepted",
      );
    });
  });

  describe("what a tupleset relation may admit", () => {
    /**
     * The tupleset relation's config is written first, so the check
     * has something to read. The reverse order is the stated gap,
     * pinned below.
     */
    function ttuConfigs(objectType: string, parentRefs: Ref[]) {
      return [
        config({
          objectType,
          relation: "parent",
          directlyAssignable: parentRefs.map((ref) => ({
            type: ref.type,
            ...(ref.relation === undefined ? {} : { relation: ref.relation }),
            ...(ref.wildcard === undefined ? {} : { wildcard: true as const }),
          })),
        }),
        config({
          objectType,
          tupleToUserset: [{ tupleset: "parent", computedUserset: "viewer" }],
        }),
      ];
    }

    test("a userset ref is refused by both", async () => {
      await expectConfigConformance(
        ttuModel([{ type: "folder", relation: "owner" }]),
        ttuConfigs("uset", [{ type: "folder", relation: "owner" }]),
        "refused",
      );
    });

    test("a wildcard ref is refused by both", async () => {
      await expectConfigConformance(
        ttuModel([{ type: "folder", wildcard: {} }]),
        ttuConfigs("wild", [{ type: "folder", wildcard: {} }]),
        "refused",
      );
    });

    test("the control: a bare type is accepted by both", async () => {
      // Without this the rule could be "refuse every tupleset" and
      // every assertion above would still pass.
      await expectConfigConformance(
        ttuModel([{ type: "folder" }]),
        ttuConfigs("bare", [{ type: "folder" }]),
        "accepted",
      );
    });

    /**
     * The stated gap, asserted so it is a decision rather than a
     * surprise. A model is one document upstream; here configs
     * arrive one at a time, and these two rules are properties of a
     * *different* relation than the one being written. Declaring
     * the tuple-to-userset first leaves nothing to read, and the
     * check is skipped rather than guessing.
     *
     * One-sided on purpose: upstream has no equivalent, because it
     * has no write order to have a gap in.
     */
    test("the gap: declared before its tupleset, it is not checked", async () => {
      const [ttu, parent] = ttuConfigs("gap", [
        { type: "folder", relation: "owner" },
      ]).reverse();
      if (!ttu || !parent) throw new Error("unreachable");
      await tsfgaClient.writeRelationConfig(ttu);
      await tsfgaClient.writeRelationConfig(parent);
    });
  });

  describe("a type restriction naming a condition", () => {
    test("an undefined one is refused by both", async () => {
      await expectConfigConformance(
        conditionModel("nope", false),
        [
          config({
            objectType: "cond",
            directlyAssignable: [{ type: "user", condition: "nope" }],
          }),
        ],
        "refused",
      );
    });

    test("the control: a defined one is accepted by both", async () => {
      await tsfgaClient.writeConditionDefinition({
        name: "yep",
        expression: "true",
        parameters: {},
      });
      await expectConfigConformance(
        conditionModel("yep", true),
        [
          config({
            objectType: "cond_ok",
            directlyAssignable: [{ type: "user", condition: "yep" }],
          }),
        ],
        "accepted",
      );
    });

    test("the refusal names its cause", async () => {
      const failure = tsfgaClient.writeRelationConfig(
        config({
          objectType: "cond_cause",
          directlyAssignable: [{ type: "user", condition: "missing" }],
        }),
      );
      await expect(failure).rejects.toBeInstanceOf(InvalidRelationConfigError);
    });
  });

  /**
   * The self-referential tuple, and the asymmetry it exposes.
   *
   * Upstream refuses `doc:1#blocked@doc:1#blocked` on the Write API
   * — "cannot write a tuple that is implicit" — and **accepts** the
   * same tuple supplied contextually, answering over it. Probed on
   * v1.18.2 with two controls: a different contextual tuple changes
   * the answer, and a contextual tuple the model does not admit is
   * refused, so the field is demonstrably honoured.
   *
   * The refusal therefore belongs to `addTuple` alone and not to
   * the validation contextual tuples share with it. That is a
   * deliberate asymmetry, pinned here so nobody "tidies" it into
   * the shared surface and starts refusing a tuple upstream takes.
   */
  describe("a tuple that says only what the model says", () => {
    let selfModelId: string;

    beforeAll(async () => {
      selfModelId = await fgaWriteModel(
        storeId,
        "./config-validation/model.dsl",
      );
      await fgaWriteTuples(
        storeId,
        "./config-validation/tuples.yaml",
        selfModelId,
        uuidMap,
      );

      await tsfgaClient.writeRelationConfig(
        config({
          objectType: "document",
          relation: "blocked",
          directlyAssignable: [
            { type: "user" },
            { type: "document", relation: "blocked" },
          ],
        }),
      );
      await tsfgaClient.writeRelationConfig(
        config({
          objectType: "document",
          relation: "member",
          directlyAssignable: [
            { type: "user" },
            { type: "document", relation: "member" },
          ],
        }),
      );
      await tsfgaClient.writeRelationConfig(
        config({
          objectType: "document",
          directlyAssignable: [{ type: "user" }],
          excludedBy: "blocked",
        }),
      );
      await tsfgaClient.addTuple({
        objectType: "document",
        objectId: uuid("doc1"),
        relation: "viewer",
        subjectType: "user",
        subjectId: uuid("alice"),
      });
      await tsfgaClient.addTuple({
        objectType: "document",
        objectId: uuid("doc1"),
        relation: "member",
        subjectType: "user",
        subjectId: uuid("alice"),
      });
    });

    const selfTuple = {
      objectType: "document",
      objectId: uuid("doc1"),
      relation: "blocked",
      subjectType: "document",
      subjectId: uuid("doc1"),
      subjectRelation: "blocked",
    };

    test("the write is refused by both", async () => {
      await expectWriteConformance(
        storeId,
        selfModelId,
        tsfgaClient,
        selfTuple,
        "refused",
      );
    });

    test("supplied contextually, both answer rather than refuse", async () => {
      // `member` is self-assignable exactly as `blocked` is, so the
      // contextual tuple is the same shape; alice's direct row
      // answers regardless, which is what makes this about
      // acceptance and not about the resolution below.
      await expectConformance(
        storeId,
        selfModelId,
        tsfgaClient,
        {
          objectType: "document",
          objectId: uuid("doc1"),
          relation: "member",
          subjectType: "user",
          subjectId: uuid("alice"),
          contextualTuples: [
            { ...selfTuple, relation: "member", subjectRelation: "member" },
          ],
        },
        true,
      );
    });

    test("what it resolves to is the documented recursive divergence", async () => {
      // Not a new divergence and not caused by the self-reference:
      // `blocked` is assignable to a userset of itself, which is
      // the recursive shape `packages/core/README.md` records.
      // Upstream's recursive resolver reaches a definitive false
      // with no cycle flag, so the exclusion grants; tsfga's cycle
      // guard truncates and a cycle on the subtract side denies.
      await expectPinnedDivergence(
        storeId,
        selfModelId,
        tsfgaClient,
        {
          objectType: "document",
          objectId: uuid("doc1"),
          relation: "viewer",
          subjectType: "user",
          subjectId: uuid("alice"),
          contextualTuples: [selfTuple],
        },
        { openfga: true, tsfga: false },
      );
    });
  });
});
