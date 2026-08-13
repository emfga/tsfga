import { afterAll, beforeAll, describe, test } from "bun:test";
import {
  type ConditionParameterType,
  createTsfga,
  type TsfgaClient,
} from "@tsfga/core";
import type { DB } from "@tsfga/kysely";
import { KyselyTupleStore } from "@tsfga/kysely";
import type { Kysely } from "kysely";
import {
  type CheckOutcome,
  expectConfigsMatchModel,
  expectConformance,
  expectPinnedDivergence,
  type FixtureRecord,
  recordFixture,
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
  fgaWriteTuplesRaw,
} from "./helpers/openfga.ts";

/**
 * The unchecked-operator family, past the four cells
 * `packages/core/README.md` pins.
 *
 * The README says cel-go range-checks "every arithmetic and
 * conversion overload" and names four operators cel-js does not —
 * unary minus and division at int64's minimum, and duration `+`
 * and `-` past the int64 nanosecond range. The list is short by
 * two whole shapes:
 *
 * - **modulo.** `MinInt64 % -1` is the same trap as
 *   `MinInt64 / -1` — Go's `%` panics on it, so cel-go's
 *   `modInt64Checked` guards it explicitly — and it is not in the
 *   pinned set.
 * - **timestamp arithmetic.** cel-go keeps a timestamp inside CEL's
 *   year 1 to year 9999 window and errors when an addition or a
 *   subtraction leaves it, and it range-checks `timestamp -
 *   timestamp` against int64 nanoseconds. cel-js does none of the
 *   three. `cel-numeric.test.ts` has a `t + duration(…)` cell
 *   asserting the two agree, but its timestamp is in 2026 and the
 *   duration is 273 years, so the sum never leaves the window and
 *   the cell proves nothing about the boundary.
 *
 * Every cell below is the granting direction: upstream declines to
 * answer, tsfga returns `true`. Each is paired with a neighbour
 * one step inside the boundary that must keep agreeing.
 */

const uuidMap = new Map<string, string>([
  ["alice", "00000000-0000-4000-d510-000000000031"],
  ["doc", "00000000-0000-4000-d510-000000000032"],
]);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

const INT64_MIN = "-9223372036854775808";
const INT64_MIN_PLUS_1 = "-9223372036854775807";
const YEAR_ONE = "0001-01-01T00:00:00Z";
const YEAR_9999 = "9999-12-31T23:59:59Z";

/** One row per relation in `cel-operators/model.dsl`. */
const CELLS: ReadonlyArray<
  readonly [string, Record<string, ConditionParameterType>, string]
> = [
  ["mod_c5", { n: "int" }, "n % -1 == 0"],
  ["tsadd_c5", { t: "timestamp" }, "t + duration('2400000h') > t"],
  ["tsadd1_c5", { t: "timestamp" }, "t + duration('1h') > t"],
  ["tssubd_c5", { t: "timestamp" }, "t - duration('1h') < t"],
  [
    "tssubt_c5",
    { t: "timestamp" },
    "(t - timestamp('9999-12-31T23:59:59Z')) < duration('0s')",
  ],
  ["duradd_c5", { d: "duration" }, "(d + d) > d"],
];

describe("CEL operator range-check conformance", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let modelId: string;
  let tsfgaClient: TsfgaClient;
  let fixture: FixtureRecord;

  beforeAll(async () => {
    db = getDb();
    await beginTransaction(db);

    tsfgaClient = createTsfga(new KyselyTupleStore(db));
    fixture = recordFixture(tsfgaClient);

    for (const [relation, parameters, expression] of CELLS) {
      await tsfgaClient.writeConditionDefinition({
        name: `${relation}_c`,
        expression,
        parameters,
      });
      await tsfgaClient.writeRelationConfig({
        objectType: "doc_c5",
        relation,
        directlyAssignable: [{ type: "user_c5", condition: `${relation}_c` }],
        impliedBy: null,
        computedUserset: null,
        tupleToUserset: null,
        excludedBy: null,
        intersection: null,
      });
      await tsfgaClient.addTuple({
        objectType: "doc_c5",
        objectId: uuid("doc"),
        relation,
        subjectType: "user_c5",
        subjectId: uuid("alice"),
        conditionName: `${relation}_c`,
      });
    }

    storeId = await fgaCreateStore("cel-operators");
    modelId = await fgaWriteModel(storeId, "./cel-operators/model.dsl");
    await fgaWriteTuplesRaw(
      storeId,
      modelId,
      CELLS.map(([relation]) => ({
        user: `user_c5:${uuid("alice")}`,
        relation,
        object: `doc_c5:${uuid("doc")}`,
        condition: { name: `${relation}_c` },
      })),
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  const check = (
    relation: string,
    context: Record<string, unknown>,
    expected: CheckOutcome,
  ) =>
    expectConformance(
      storeId,
      modelId,
      tsfgaClient,
      {
        objectType: "doc_c5",
        objectId: uuid("doc"),
        relation,
        subjectType: "user_c5",
        subjectId: uuid("alice"),
        context,
      },
      expected,
    );

  /** `check`, for the cells the two engines answer differently. */
  const checkPinned = (
    relation: string,
    context: Record<string, unknown>,
    expected: { openfga: CheckOutcome; tsfga: CheckOutcome },
  ) =>
    expectPinnedDivergence(
      storeId,
      modelId,
      tsfgaClient,
      {
        objectType: "doc_c5",
        objectId: uuid("doc"),
        relation,
        subjectType: "user_c5",
        subjectId: uuid("alice"),
        context,
      },
      expected,
    );

  /*
   * Every cell below is pinned in the **granting** direction:
   * cel-go range-checks the result of the operator and refuses,
   * cel-js does not and tsfga answers `true`.
   *
   * Not fixed, and the reason is structural rather than a matter
   * of effort: closing one needs the operator's own overload
   * replaced, and cel-js 8.0.0 refuses to register over any
   * built-in. A type-blind operator rewrite was considered and
   * rejected, because it moves CEL's comparison and
   * arithmetic semantics for every operand type into tsfga, where
   * they can drift silently. The lever is upstream: a `replace`
   * option on cel-js's `registerOperator`.
   *
   * Each keeps its in-range neighbour beside it, so the boundary
   * is asserted and not assumed — the pin says "past the bound the
   * engines differ", and the neighbour says "inside it they do
   * not".
   */

  describe("modulo at int64's minimum", () => {
    test("MinInt64 % -1 overflows", async () => {
      await checkPinned(
        "mod_c5",
        { n: INT64_MIN },
        {
          openfga: "refused",
          tsfga: true,
        },
      );
    });

    test("one above the minimum agrees", async () => {
      await check("mod_c5", { n: INT64_MIN_PLUS_1 }, true);
    });

    test("a small negative agrees", async () => {
      await check("mod_c5", { n: -5 }, true);
    });
  });

  describe("timestamp arithmetic leaving CEL's window", () => {
    test("adding past year 9999", async () => {
      await checkPinned(
        "tsadd_c5",
        { t: YEAR_9999 },
        { openfga: "refused", tsfga: true },
      );
    });

    test("adding one hour past year 9999", async () => {
      await checkPinned(
        "tsadd1_c5",
        { t: YEAR_9999 },
        { openfga: "refused", tsfga: true },
      );
    });

    test("subtracting one hour before year 1", async () => {
      await checkPinned(
        "tssubd_c5",
        { t: YEAR_ONE },
        { openfga: "refused", tsfga: true },
      );
    });

    test("a timestamp difference past int64 nanoseconds", async () => {
      await checkPinned(
        "tssubt_c5",
        { t: YEAR_ONE },
        { openfga: "refused", tsfga: true },
      );
    });

    test("an addition that stays inside the window agrees", async () => {
      await check("tsadd_c5", { t: "2026-01-01T00:00:00Z" }, true);
      await check("tsadd1_c5", { t: "2026-01-01T00:00:00Z" }, true);
    });

    test("a subtraction that stays inside the window agrees", async () => {
      await check("tssubd_c5", { t: "2026-01-01T00:00:00Z" }, true);
    });

    test("a difference inside int64 nanoseconds agrees", async () => {
      // Two centuries is about 6.3e18 nanoseconds, just inside
      // int64; three would not be.
      await check("tssubt_c5", { t: "9800-01-01T00:00:00Z" }, true);
    });
  });

  /**
   * The already-pinned duration cell, restated in this file's
   * shape so the neighbour sits beside it. `cel-numeric` owns
   * the pin itself.
   */
  describe("duration addition, the pinned shape and its neighbour", () => {
    test("doubling a duration past int64 nanoseconds", async () => {
      await checkPinned(
        "duradd_c5",
        { d: "2400000h" },
        { openfga: "refused", tsfga: true },
      );
    });

    test("doubling a duration inside the range agrees", async () => {
      await check("duradd_c5", { d: "1h" }, true);
    });
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./cel-operators/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
