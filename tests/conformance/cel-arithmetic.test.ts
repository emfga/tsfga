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
 * The rest of the arithmetic surface — the operator × operand-type
 * combinations the pinned set did not name.
 *
 * `cel-numeric.test.ts` pins four cells (unary `-` and `/` at
 * int64's minimum, duration `+` and `-` past the int64 nanosecond
 * range) and `cel-operators.test.ts` pins six more (`%` at
 * int64's minimum, and timestamp `+`/`-` leaving CEL's year 1 to
 * year 9999 window). Both sets were assembled from the cells
 * somebody happened to name, which is why the second one exists at
 * all. This file enumerates the surface instead: every checked
 * overload cel-go carries — int and uint `+ - * / %` and unary `-`,
 * duration `+ -`, timestamp `+ -` and `timestamp - timestamp`, and
 * the `int`/`uint`/`double`/`duration`/`timestamp` conversions —
 * measured against the container in both the in-range and the
 * out-of-range direction, so what agrees is written down beside
 * what does not.
 *
 * Three things it found that neither pinned set covers:
 *
 * 1. **A `duration` context value is not range-checked at all.**
 *    `d > duration('0s')` with `d = '9000000h'` has no arithmetic
 *    in it: upstream refuses the value as it reads it, tsfga takes
 *    it and answers. This is the one cell in the family that does
 *    not need the *expression* to overflow, so the argument that
 *    the residue is unreachable from ordinary data does not cover
 *    it. `timestamp` and `int` are checked; `duration` is not.
 * 2. **`duration(string)` is a named call and is unchecked too.**
 *    Same value, arriving through the conversion rather than
 *    through coercion.
 * 3. **`duration + timestamp` is missing from cel-js**, in the
 *    spelling where the left operand is a `duration(…)` literal.
 *    That one diverges the other way: upstream answers and tsfga
 *    refuses.
 *
 * Everything else in the surface agrees, including every cell that
 * looks like it should not: `/ 0` and `% 0` on both integer types,
 * `uint` underflow and overflow, IEEE division by zero and
 * overflow on doubles, and the `int`/`uint`/`timestamp` conversions
 * at their bounds. The unchecked residue is the *duration and
 * timestamp* corner plus the three int64-minimum operators — not a
 * general absence of range checking.
 */

const uuidMap = new Map<string, string>([
  ["alice", "00000000-0000-4000-d520-000000000001"],
  ["doc", "00000000-0000-4000-d520-000000000002"],
]);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

/** Past int64 nanoseconds; 2400000h is the largest round hour inside. */
const DUR_OVER = "9000000h";
const DUR_MAX = "2400000h";
const YEAR_ONE = "0001-01-01T00:00:00Z";
const YEAR_9999 = "9999-12-31T23:59:59Z";
const INT64_MIN = "-9223372036854775808";

/** One row per relation in `cel-arithmetic/model.dsl`. */
const CELLS: ReadonlyArray<
  readonly [string, Record<string, ConditionParameterType>, string]
> = [
  ["durctx_c5b", { d: "duration" }, "d > duration('0s')"],
  ["durofs_c5b", { s: "string" }, "duration(s) > duration('0s')"],
  ["durdiff_c5b", { a: "duration", b: "duration" }, "(a - b) > duration('0s')"],
  ["durts_c5b", { t: "timestamp", d: "duration" }, "d + t > t"],
  ["durtslit_c5b", { t: "timestamp" }, "duration('1h') + t > t"],
  [
    "tsdiff_c5b",
    { a: "timestamp", b: "timestamp" },
    "(a - b) < duration('0s')",
  ],
  ["tssubdc_c5b", { t: "timestamp", d: "duration" }, "t - d < t"],
  [
    "grace_c5b",
    { t: "timestamp" },
    "t + duration('24h') > timestamp('2026-01-01T00:00:00Z')",
  ],
  ["tsctx_c5b", { t: "timestamp" }, "t > timestamp('2020-01-01T00:00:00Z')"],
  ["intctx_c5b", { n: "int" }, "n > 0"],
  ["idiv0_c5b", { n: "int" }, "n / 0 > 0"],
  ["imod0_c5b", { n: "int" }, "n % 0 == 0"],
  ["isub_c5b", { n: "int" }, "n - 9223372036854775807 < 0"],
  ["udiv0_c5b", { n: "uint" }, "n / 0u > 0u"],
  ["umod0_c5b", { n: "uint" }, "n % 0u == 0u"],
  ["umul_c5b", { n: "uint" }, "n * n > 0u"],
  ["ddiv0_c5b", { x: "double" }, "x / 0.0 > 0.0"],
  ["dmul_c5b", { x: "double" }, "x * x > 0.0"],
];

describe("CEL arithmetic surface conformance", () => {
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
        objectType: "doc_c5b",
        relation,
        directlyAssignable: [{ type: "user_c5b", condition: `${relation}_c` }],
        impliedBy: null,
        computedUserset: null,
        tupleToUserset: null,
        excludedBy: null,
        intersection: null,
      });
      await tsfgaClient.addTuple({
        objectType: "doc_c5b",
        objectId: uuid("doc"),
        relation,
        subjectType: "user_c5b",
        subjectId: uuid("alice"),
        conditionName: `${relation}_c`,
      });
    }

    storeId = await fgaCreateStore("cel-arithmetic");
    modelId = await fgaWriteModel(storeId, "./cel-arithmetic/model.dsl");
    await fgaWriteTuplesRaw(
      storeId,
      modelId,
      CELLS.map(([relation]) => ({
        user: `user_c5b:${uuid("alice")}`,
        relation,
        object: `doc_c5b:${uuid("doc")}`,
        condition: { name: `${relation}_c` },
      })),
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  const request = (relation: string, context: Record<string, unknown>) => ({
    objectType: "doc_c5b",
    objectId: uuid("doc"),
    relation,
    subjectType: "user_c5b",
    subjectId: uuid("alice"),
    context,
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
      request(relation, context),
      expected,
    );

  const pinned = (
    relation: string,
    context: Record<string, unknown>,
    expected: { openfga: CheckOutcome; tsfga: CheckOutcome },
  ) =>
    expectPinnedDivergence(
      storeId,
      modelId,
      tsfgaClient,
      request(relation, context),
      expected,
    );

  /**
   * The cell that was *not* covered by the "only an overflowing
   * expression reaches it" argument — and, because it was not, the
   * one that got fixed rather than documented.
   *
   * `coerceContext` range-checks `int` and `uint` (saturating, as
   * upstream's `big.ParseFloat` grammar does) and refuses a
   * `timestamp` outside CEL's window — the two controls below say
   * so. It did **not** bound a `duration`: `9000000h` is 3.24e19
   * nanoseconds, past int64, and tsfga carried it into the
   * expression while upstream refused to read it. No operator was
   * involved, which is what made it reachable from a stored tuple
   * context written by whoever can write tuples, and what put it
   * outside the argument that justified pinning the rest.
   *
   * It was once recorded here as part of the arithmetic family; it
   * is a coercion-time refusal of its own, and both engines refuse.
   */
  describe("a duration is range-checked as it is read", () => {
    test("a duration context value past int64 nanoseconds is refused", async () => {
      await check("durctx_c5b", { d: DUR_OVER }, "refused");
    });

    test("the largest duration inside the range agrees", async () => {
      await check("durctx_c5b", { d: DUR_MAX }, true);
    });

    test("a timestamp outside CEL's window is refused by both", async () => {
      await check("tsctx_c5b", { t: "10000-01-01T00:00:00Z" }, "refused");
    });

    test("the last timestamp inside the window agrees", async () => {
      await check("tsctx_c5b", { t: YEAR_9999 }, true);
    });

    test("an int past int64 saturates the same way on both", async () => {
      await check("intctx_c5b", { n: "99999999999999999999" }, true);
    });

    test("int64's minimum reads the same way on both", async () => {
      await check("intctx_c5b", { n: INT64_MIN }, false);
    });
  });

  /**
   * `duration(string)` is a *named call*, which is the shape
   * `conditions.ts` can already replace — `int()` and `double()`
   * are renamed onto range-checked implementations of tsfga's own
   * for exactly this reason. This cell is therefore closable
   * without touching an operator, and is pinned rather than fixed
   * only because it is not this package's file to change.
   */
  describe("duration(string) is not range-checked either", () => {
    test("a duration string past int64 nanoseconds", async () => {
      await pinned(
        "durofs_c5b",
        { s: DUR_OVER },
        { openfga: "refused", tsfga: true },
      );
    });

    test("a duration string inside the range agrees", async () => {
      await check("durofs_c5b", { s: "1h" }, true);
    });
  });

  /**
   * The duration and timestamp operators, in the spellings where
   * **both** operands come from the context rather than from a
   * literal in the expression. The pinned cells elsewhere all put
   * the extreme value in the expression; these put it in the data,
   * which is where it comes from in practice.
   */
  describe("duration and timestamp operators over context values", () => {
    test("a duration difference past int64 nanoseconds", async () => {
      await pinned(
        "durdiff_c5b",
        { a: DUR_MAX, b: `-${DUR_MAX}` },
        { openfga: "refused", tsfga: true },
      );
    });

    test("a duration difference inside the range agrees", async () => {
      await check("durdiff_c5b", { a: "2h", b: "1h" }, true);
    });

    test("a timestamp difference past int64 nanoseconds", async () => {
      await pinned(
        "tsdiff_c5b",
        { a: YEAR_ONE, b: YEAR_9999 },
        { openfga: "refused", tsfga: true },
      );
    });

    test("a timestamp difference inside the range agrees", async () => {
      await check(
        "tsdiff_c5b",
        { a: "2026-01-01T00:00:00Z", b: "2027-01-01T00:00:00Z" },
        true,
      );
    });

    test("subtracting a context duration before year 1", async () => {
      await pinned(
        "tssubdc_c5b",
        { t: YEAR_ONE, d: "1h" },
        { openfga: "refused", tsfga: true },
      );
    });

    test("subtracting a context duration inside the window agrees", async () => {
      await check("tssubdc_c5b", { t: "2026-01-01T00:00:00Z", d: "1h" }, true);
    });

    test("a context duration added past year 9999", async () => {
      await pinned(
        "durts_c5b",
        { t: YEAR_9999, d: "1h" },
        { openfga: "refused", tsfga: true },
      );
    });

    test("a context duration added inside the window agrees", async () => {
      await check("durts_c5b", { t: "2026-01-01T00:00:00Z", d: "1h" }, true);
    });
  });

  /**
   * The reachability control, and the reason the timestamp rows
   * are the uncomfortable half of this family.
   *
   * There is nothing adversarial in
   * `t + duration('24h') > timestamp(…)` — it is a grace period —
   * and nothing unusual about `9999-12-31T23:59:59Z` as the
   * "never expires" sentinel a caller stores in a tuple's
   * condition context. Put together, upstream declines to answer
   * and tsfga grants. Every other cell in the family needs an
   * expression written to overflow; this one needs an ordinary
   * expression and an ordinary sentinel.
   */
  describe("an ordinary expression over a sentinel timestamp", () => {
    test("a grace period on a never-expires sentinel", async () => {
      await pinned(
        "grace_c5b",
        { t: YEAR_9999 },
        { openfga: "refused", tsfga: true },
      );
    });

    test("a grace period on an ordinary expiry agrees", async () => {
      await check("grace_c5b", { t: "2027-06-01T00:00:00Z" }, true);
    });
  });

  /**
   * The one cell in the family that diverges the other way.
   *
   * cel-js has no `duration + timestamp` overload for the result
   * of a `duration(…)` call, so tsfga raises where upstream
   * answers. Fail-closed, and narrow: the same sum with the
   * duration coming from the context resolves (`durts_c5b`,
   * above), and so does the commuted `timestamp + duration` that
   * every other cell here uses.
   */
  describe("duration(literal) + timestamp has no overload", () => {
    test("upstream answers and tsfga refuses", async () => {
      await pinned(
        "durtslit_c5b",
        { t: "2026-01-01T00:00:00Z" },
        { openfga: true, tsfga: "refused" },
      );
    });

    test("past the window both refuse, for different reasons", async () => {
      await check("durtslit_c5b", { t: YEAR_9999 }, "refused");
    });
  });

  /**
   * What the surface does **not** contain. Every one of these is a
   * checked overload in cel-go, and cel-js refuses each the same
   * way — so the divergence is confined to the cells above rather
   * than being "cel-js does not range-check arithmetic".
   */
  describe("the rest of the checked surface agrees", () => {
    test("integer division by zero is refused by both", async () => {
      await check("idiv0_c5b", { n: 1 }, "refused");
    });

    test("integer modulo by zero is refused by both", async () => {
      await check("imod0_c5b", { n: 1 }, "refused");
    });

    test("an int difference past int64 is refused by both", async () => {
      await check("isub_c5b", { n: INT64_MIN }, "refused");
    });

    test("an int difference inside int64 agrees", async () => {
      await check("isub_c5b", { n: 0 }, true);
    });

    test("unsigned division by zero is refused by both", async () => {
      await check("udiv0_c5b", { n: 1 }, "refused");
    });

    test("unsigned modulo by zero is refused by both", async () => {
      await check("umod0_c5b", { n: 1 }, "refused");
    });

    test("a uint product past uint64 is refused by both", async () => {
      await check("umul_c5b", { n: 10000000000 }, "refused");
    });

    test("a uint product inside uint64 agrees", async () => {
      await check("umul_c5b", { n: 2 }, true);
    });

    test("double division by zero is infinite on both", async () => {
      await check("ddiv0_c5b", { x: 1.5 }, true);
    });

    test("a double product past float64 is infinite on both", async () => {
      await check("dmul_c5b", { x: 1e200 }, true);
    });
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./cel-arithmetic/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
