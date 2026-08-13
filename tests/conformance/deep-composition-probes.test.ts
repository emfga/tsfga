import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type TsfgaClient, TsfgaError } from "@tsfga/core";
import type { DB } from "@tsfga/kysely";
import type { Kysely } from "kysely";
import { MATRIX_HELPERS, MATRIX_MOVED } from "./complexity-matrix/configs.ts";
import {
  type CheckAssertion,
  checkRequest,
  createCaseStore,
  INVALID_CONTEXT,
  type MatrixTuple,
  removeCaseTuples,
  setupMatrix,
  teardownMatrix,
  uuid,
  VALID_CONTEXT,
  writeCaseTuples,
} from "./complexity-matrix/harness.ts";
import {
  expectConfigsMatchModel,
  expectConformance,
  type FixtureRecord,
} from "./helpers/conformance.ts";
import { fgaListObjects, fgaWriteTuplesRaw } from "./helpers/openfga.ts";

/**
 * Three properties that only their own tests otherwise guard,
 * asked again at the bottom of a four-level composition:
 *
 * 1. `listObjects` classifies a condition error by **which read
 *    raised it** — a subject-naming read aborts, a scan read
 *    defers and raises only if nothing was granted. A deep
 *    composition is where that classification is most likely to be
 *    wrong, because the read that raises is several dispatches away
 *    from the scan that started the candidate.
 * 2. `check` / `listObjects` refuse an **undefined subject type**.
 * 3. An object id has to survive a four-level composition, two of
 *    them as the object half of a userset ref the next level
 *    compares by string, not just a single direct row.
 *
 * The model is `complexity-matrix/model.dsl` — OpenFGA's own listobjects
 * matrix, `_c1`-suffixed.
 */

const U = "user_c1";
const D = "directs_c1";
const S = "usersets_user_c1";
const C3 = "complexity3_c1";

/**
 * `listObjects` on both engines, reporting a refusal as an outcome.
 *
 * `expectListObjectsConformance` types `expected` as a string
 * array, so a shape where **both** engines decline to answer is not
 * expressible through it — and that is most of what this file asks.
 * Only a `TsfgaError` counts as a tsfga refusal, exactly as the
 * shared check helper insists.
 */
type Outcome = readonly string[] | "refused";

async function listObjectsOutcomes(
  storeId: string,
  authorizationModelId: string,
  client: TsfgaClient,
  params: {
    objectType: string;
    relation: string;
    subjectType: string;
    subjectId: string;
    subjectRelation?: string | null;
    context?: Record<string, unknown>;
  },
): Promise<{ tsfga: Outcome; openfga: Outcome }> {
  const [tsfga, openfga] = await Promise.all([
    client
      .listObjects(params)
      .then((objects): Outcome => [...objects].sort())
      .catch((error: unknown): Outcome => {
        if (error instanceof TsfgaError) return "refused";
        throw error;
      }),
    fgaListObjects(storeId, authorizationModelId, params)
      .then((objects): Outcome => [...objects].sort())
      .catch((): Outcome => "refused"),
  ]);
  return { tsfga, openfga };
}

function expectSame(
  outcomes: { tsfga: Outcome; openfga: Outcome },
  expected: Outcome,
): void {
  expect(outcomes.tsfga).toEqual(outcomes.openfga);
  expect(outcomes.tsfga).toEqual(expected);
}

/** `type:id` split in two. */
function splitRef(ref: string): [string, string] {
  const colon = ref.indexOf(":");
  return [ref.slice(0, colon), ref.slice(colon + 1)];
}

/** Ids, sorted, as `listObjects` reports them. */
function ids(...names: string[]): string[] {
  return names.map(uuid).sort();
}

const TUPLES: MatrixTuple[] = [
  // ce_1 — the condition sits on the tupleset read of the TTU,
  // one dispatch below the scan that produces the candidate.
  {
    object: `${C3}:ce_1`,
    relation: "userset_parent",
    user: `${S}:ce_1`,
    condition: "xcond_c1",
  },
  { object: `${S}:ce_1`, relation: "userset", user: `${D}:ce_1#direct_comb` },
  { object: `${D}:ce_1`, relation: "direct_comb", user: `${U}:ce_alice` },

  // ce_2 — the same shape with no condition anywhere.
  { object: `${C3}:ce_2`, relation: "userset_parent", user: `${S}:ce_2` },
  { object: `${S}:ce_2`, relation: "userset", user: `${D}:ce_2#direct_comb` },
  { object: `${D}:ce_2`, relation: "direct_comb", user: `${U}:ce_alice` },
  { object: `${D}:ce_2`, relation: "direct_comb", user: `${U}:ce_bob` },

  // ce_4 — the condition sits on the subject-naming leaf read,
  // three dispatches below the scan. `usersets_user_c1.userset`
  // admits no conditioned restriction, so the only two places the
  // matrix model lets a condition sit on this path are the tupleset
  // read above and this one — which is exactly the pair the
  // classification separates.
  { object: `${C3}:ce_4`, relation: "userset_parent", user: `${S}:ce_4` },
  { object: `${S}:ce_4`, relation: "userset", user: `${D}:ce_4#direct_comb` },
  {
    object: `${D}:ce_4`,
    relation: "direct_comb",
    user: `${U}:ce_alice`,
    condition: "xcond_c1",
  },

  // ce_5 — `ce_carol` exists in the store but no `complexity3_c1`
  // object reaches her, so upstream's reverse walk starts and then
  // stops, where tsfga's candidate scan still visits `ce_1` and
  // `ce_4`.
  { object: `${D}:ce_5`, relation: "direct_comb", user: `${U}:ce_carol` },
];

/** A context `xcond_c1` cannot be evaluated against. */
const NO_PARAM = {};
const WRONG_KEY = { y: "1" };
const WRONG_TYPE = { x: 1 };

const CHECKS: CheckAssertion[] = [
  {
    name: "conditioned tupleset read, context true",
    object: `${C3}:ce_1`,
    relation: "ttu_userset",
    user: `${U}:ce_alice`,
    context: VALID_CONTEXT,
    expect: true,
  },
  {
    name: "conditioned tupleset read, context false",
    object: `${C3}:ce_1`,
    relation: "ttu_userset",
    user: `${U}:ce_alice`,
    context: INVALID_CONTEXT,
    expect: false,
  },
  {
    name: "conditioned leaf read, context true",
    object: `${C3}:ce_4`,
    relation: "ttu_userset",
    user: `${U}:ce_alice`,
    context: VALID_CONTEXT,
    expect: true,
  },
  {
    name: "conditioned leaf read, context false",
    object: `${C3}:ce_4`,
    relation: "ttu_userset",
    user: `${U}:ce_alice`,
    context: INVALID_CONTEXT,
    expect: false,
  },
  {
    name: "unconditioned path is unaffected by a missing parameter",
    object: `${C3}:ce_2`,
    relation: "ttu_userset",
    user: `${U}:ce_alice`,
    context: NO_PARAM,
    expect: true,
  },
];

describe("c1: round-2 behaviour under a four-level composition", () => {
  let db: Kysely<DB>;
  let tsfgaClient: TsfgaClient;
  let fixture: FixtureRecord;
  let storeId: string;
  let authorizationModelId: string;

  beforeAll(async () => {
    ({ db, tsfgaClient, fixture } = await setupMatrix());
    ({ storeId, authorizationModelId } = await createCaseStore("probes"));
    await writeCaseTuples(tsfgaClient, storeId, authorizationModelId, TUPLES);
  });

  afterAll(async () => {
    await removeCaseTuples(tsfgaClient, TUPLES);
    await teardownMatrix(db);
  });

  describe("checks along the composition", () => {
    for (const [index, probe] of CHECKS.entries()) {
      test(`#${index} ${probe.name}`, async () => {
        await expectConformance(
          storeId,
          authorizationModelId,
          tsfgaClient,
          checkRequest(probe),
          probe.expect,
        );
      });
    }
  });

  describe("listObjects with a usable context", () => {
    test("every path fires", async () => {
      expectSame(
        await listObjectsOutcomes(storeId, authorizationModelId, tsfgaClient, {
          objectType: C3,
          relation: "ttu_userset",
          subjectType: U,
          subjectId: uuid("ce_alice"),
          context: VALID_CONTEXT,
        }),
        ids("ce_1", "ce_2", "ce_4"),
      );
    });

    test("only the unconditioned path fires", async () => {
      expectSame(
        await listObjectsOutcomes(storeId, authorizationModelId, tsfgaClient, {
          objectType: C3,
          relation: "ttu_userset",
          subjectType: U,
          subjectId: uuid("ce_alice"),
          context: INVALID_CONTEXT,
        }),
        ids("ce_2"),
      );
    });

    test("a subject only the unconditioned path grants", async () => {
      expectSame(
        await listObjectsOutcomes(storeId, authorizationModelId, tsfgaClient, {
          objectType: C3,
          relation: "ttu_userset",
          subjectType: U,
          subjectId: uuid("ce_bob"),
          context: VALID_CONTEXT,
        }),
        ids("ce_2"),
      );
    });
  });

  describe("listObjects with a context the condition cannot use", () => {
    for (const [name, context] of [
      ["no parameter at all", NO_PARAM],
      ["a parameter under the wrong key", WRONG_KEY],
      ["a parameter of the wrong declared type", WRONG_TYPE],
    ] as const) {
      test(`${name}: some object is still granted`, async () => {
        // `ce_alice` is reachable, so upstream's reverse walk
        // arrives at `ce_1` and `ce_4` and cannot evaluate their
        // conditions. Both engines decline — the agreement that
        // makes the `ce_carol` case below a real divergence rather
        // than a difference of taste about errors.
        expectSame(
          await listObjectsOutcomes(
            storeId,
            authorizationModelId,
            tsfgaClient,
            {
              objectType: C3,
              relation: "ttu_userset",
              subjectType: U,
              subjectId: uuid("ce_alice"),
              context,
            },
          ),
          "refused",
        );
      });

      test(`${name}: nothing is granted`, async () => {
        // `ce_carol` reaches nothing at all — but the scan still
        // visits `ce_1` and `ce_4`, whose conditions cannot be
        // evaluated. Whether
        // the answer is `[ce_2]` or a refusal is exactly what the
        // classification decides.
        expectSame(
          await listObjectsOutcomes(
            storeId,
            authorizationModelId,
            tsfgaClient,
            {
              objectType: C3,
              relation: "ttu_userset",
              subjectType: U,
              subjectId: uuid("ce_carol"),
              context,
            },
          ),
          [],
        );
      });
    }
  });

  describe("an undefined subject type", () => {
    test("check refuses", async () => {
      await expectConformance(
        storeId,
        authorizationModelId,
        tsfgaClient,
        {
          objectType: C3,
          objectId: uuid("ce_1"),
          relation: "ttu_userset",
          subjectType: "no_such_type_c1",
          subjectId: uuid("ce_alice"),
        },
        "refused",
      );
    });

    test("listObjects refuses", async () => {
      expectSame(
        await listObjectsOutcomes(storeId, authorizationModelId, tsfgaClient, {
          objectType: C3,
          relation: "ttu_userset",
          subjectType: "no_such_type_c1",
          subjectId: uuid("ce_alice"),
        }),
        "refused",
      );
    });

    test("an undefined subject relation refuses", async () => {
      await expectConformance(
        storeId,
        authorizationModelId,
        tsfgaClient,
        {
          objectType: C3,
          objectId: uuid("ce_1"),
          relation: "ttu_userset",
          subjectType: S,
          subjectId: uuid("ce_1"),
          subjectRelation: "no_such_relation",
        },
        "refused",
      );
    });
  });

  /**
   * An id carried unchanged through four dispatches, two of them
   * as the *object* half of a userset ref the next level compares
   * by string.
   *
   * This block used to run on non-UUID ids, because migration
   * `007` had made `object_id` a `text` column. That premise is
   * retired: the column is `uuid` again and the store declares a
   * canonical-UUID id domain, so a non-UUID id is refused at the
   * request boundary and the block would be asserting the
   * refusal rather than the composition.
   *
   * The composition coverage is what it was for, and it survives:
   * three distinct ids, each written at three levels and each
   * required to reach only itself.
   */
  describe("an object id through the whole composition", () => {
    const TEXT_IDS = [
      "00000000-0000-4000-c1e0-000000000001",
      "00000000-0000-4000-c1e0-000000000002",
      "00000000-0000-4000-c1e0-000000000003",
    ];
    /** A neighbour of each, never written. */
    const other = (id: string): string => `${id.slice(0, -1)}9`;

    beforeAll(async () => {
      const rows: { object: string; relation: string; user: string }[] = [];
      for (const id of TEXT_IDS) {
        rows.push(
          {
            object: `${C3}:${id}`,
            relation: "userset_parent",
            user: `${S}:${id}`,
          },
          {
            object: `${S}:${id}`,
            relation: "userset",
            user: `${D}:${id}#direct_comb`,
          },
          { object: `${D}:${id}`, relation: "direct_comb", user: `${U}:${id}` },
        );
      }
      for (const row of rows) {
        const [objectType, objectId] = splitRef(row.object);
        const [subjectType, rest] = splitRef(row.user);
        const hash = rest.indexOf("#");
        await tsfgaClient.addTuple({
          objectType,
          objectId,
          relation: row.relation,
          subjectType,
          subjectId: hash >= 0 ? rest.slice(0, hash) : rest,
          subjectRelation: hash >= 0 ? rest.slice(hash + 1) : null,
        });
      }
      await fgaWriteTuplesRaw(storeId, authorizationModelId, rows);
    });

    for (const id of TEXT_IDS) {
      test(`check reaches ${id} through four dispatches`, async () => {
        await expectConformance(
          storeId,
          authorizationModelId,
          tsfgaClient,
          {
            objectType: C3,
            objectId: id,
            relation: "ttu_userset",
            subjectType: U,
            subjectId: id,
          },
          true,
        );
      });

      test(`check denies a neighbouring id at ${id}`, async () => {
        await expectConformance(
          storeId,
          authorizationModelId,
          tsfgaClient,
          {
            objectType: C3,
            objectId: id,
            relation: "ttu_userset",
            subjectType: U,
            subjectId: other(id),
          },
          false,
        );
      });

      test(`listObjects reports ${id} and only it`, async () => {
        expectSame(
          await listObjectsOutcomes(
            storeId,
            authorizationModelId,
            tsfgaClient,
            {
              objectType: C3,
              relation: "ttu_userset",
              subjectType: U,
              subjectId: id,
              context: VALID_CONTEXT,
            },
          ),
          [id],
        );
      });
    }
  });

  test("configs match the model", () => {
    expectConfigsMatchModel("./complexity-matrix/model.dsl", fixture, {
      coverage: "complete",
      tsfgaOnlyHelpers: MATRIX_HELPERS,
      moved: MATRIX_MOVED,
    });
  });
});
