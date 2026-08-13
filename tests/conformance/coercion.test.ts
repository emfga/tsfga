import { afterAll, beforeAll, describe, test } from "bun:test";
import {
  type AddTupleRequest,
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
  expectWriteConformance,
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
 * Coercion as a **read gate**: for each declared parameter type, a
 * value whose magnitude or shape upstream refuses as it reads the
 * context, asked of both engines.
 *
 * `cel-arithmetic.test.ts` enumerated the *arithmetic*
 * surface and found one cell in it that needs no arithmetic at all
 * — a `duration` context value past int64 nanoseconds. This file
 * asks that question of the whole conversion table
 * (`internal/condition/types/converters.go`, v1.18.2) rather than
 * of one type: `int`, `uint`, `double`, `bool`, `string`,
 * `duration`, `timestamp`, and the `list<T>` / `map<T>` containers
 * that run each element through the same converter.
 *
 * Two of the eight **used to** refuse values tsfga accepted, both
 * in the granting direction. Both are closed, and the tests below
 * now assert `"refused"` on both engines. They are kept, and kept
 * described, because a coercion gate that has been open once is
 * the kind that reopens quietly:
 *
 * - **`duration` had no magnitude check.** Upstream's
 *   `time.ParseDuration` overflows at ±2^63 nanoseconds and
 *   errors; tsfga validated the grammar with a regex and never the
 *   size, through the scalar, through a `list<duration>` element
 *   and through a `map<duration>` value alike. Closed by
 *   `durationExceedsInt64`, which sums the terms into a `BigInt`
 *   and refuses before the value reaches cel-js.
 * - **`timestamp` was parsed by `new Date`, which rolls a date
 *   over instead of refusing it.** `2026-02-30` became March 2 and
 *   `T24:00:00` became the next midnight, where Go's `time.Parse`
 *   reports "day out of range" and "hour out of range". Closed by
 *   `asTimestamp`, which now reads the RFC 3339 components itself
 *   and checks each against the calendar rather than trusting the
 *   normalisation.
 *
 * The other six agreed on everything probed, and the passing tests
 * below record that so the next enumeration does not re-derive it:
 * `double` refuses a string that overflows or underflows float64,
 * `int` refuses a fractional value and saturates past int64,
 * `uint` refuses a negative, `string` and `bool` refuse a value of
 * another JSON type, and a container refuses a value that is not
 * of its own shape.
 *
 * `any` is absent because the DSL cannot spell it — the
 * transformer rejects `a: any` and `a: map<any>` alike — so no
 * two-engine cell can be built for it through this harness.
 */

const uuidMap = new Map<string, string>([
  ["alice", "00000000-0000-4000-d530-000000000001"],
  ["doc", "00000000-0000-4000-d530-000000000002"],
]);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

/** Each write-gate case needs an object of its own. */
let nextObject = 0;
function objectId(): string {
  nextObject++;
  return `00000000-0000-4000-d530-1${String(nextObject).padStart(11, "0")}`;
}

/** 3.24e19 ns — past int64, so `time.ParseDuration` overflows. */
const DUR_OVER = "9000000h";
/** One nanosecond past int64, spelled as Go prints the maximum. */
const DUR_OVER_BY_ONE = "2562047h47m16.854775808s";
/** int64 nanoseconds exactly: the largest duration Go will read. */
const DUR_MAX = "2562047h47m16.854775807s";

/** One row per relation in `coercion/model.dsl`. */
const CELLS: ReadonlyArray<
  readonly [string, Record<string, ConditionParameterType>, string]
> = [
  ["durctx_d2", { d: "duration" }, "d > duration('0s')"],
  ["durlist_d2", { ds: "list<duration>" }, "ds[0] > duration('0s')"],
  ["durmap_d2", { dm: "map<duration>" }, "dm['a'] > duration('0s')"],
  ["dblctx_d2", { x: "double" }, "x > 0.0"],
  ["dbllist_d2", { xs: "list<double>" }, "xs[0] > 0.0"],
  ["intctx_d2", { n: "int" }, "n > 0"],
  ["uintctx_d2", { u: "uint" }, "u > 0u"],
  ["strctx_d2", { s: "string" }, "s == 'x'"],
  ["boolctx_d2", { b: "bool" }, "b"],
  ["tsctx_d2", { t: "timestamp" }, "t > timestamp('2020-01-01T00:00:00Z')"],
  [
    "tslist_d2",
    { ts: "list<timestamp>" },
    "ts[0] > timestamp('2020-01-01T00:00:00Z')",
  ],
];

describe("Context coercion conformance", () => {
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
        objectType: "doc_d2",
        relation,
        directlyAssignable: [{ type: "user_d2", condition: `${relation}_c` }],
        impliedBy: null,
        computedUserset: null,
        tupleToUserset: null,
        excludedBy: null,
        intersection: null,
      });
      await tsfgaClient.addTuple({
        objectType: "doc_d2",
        objectId: uuid("doc"),
        relation,
        subjectType: "user_d2",
        subjectId: uuid("alice"),
        conditionName: `${relation}_c`,
      });
    }

    storeId = await fgaCreateStore("coercion");
    modelId = await fgaWriteModel(storeId, "./coercion/model.dsl");
    await fgaWriteTuplesRaw(
      storeId,
      modelId,
      CELLS.map(([relation]) => ({
        user: `user_d2:${uuid("alice")}`,
        relation,
        object: `doc_d2:${uuid("doc")}`,
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
        objectType: "doc_d2",
        objectId: uuid("doc"),
        relation,
        subjectType: "user_d2",
        subjectId: uuid("alice"),
        context,
      },
      expected,
    );

  const write = (
    relation: string,
    conditionContext: Record<string, unknown>,
    expected: "accepted" | "refused",
  ) => {
    const tuple: AddTupleRequest = {
      objectType: "doc_d2",
      objectId: objectId(),
      relation,
      subjectType: "user_d2",
      subjectId: uuid("alice"),
      conditionName: `${relation}_c`,
      conditionContext,
    };
    return expectWriteConformance(
      storeId,
      modelId,
      tsfgaClient,
      tuple,
      expected,
    );
  };

  /**
   * `time.ParseDuration` builds nanoseconds in an int64 and
   * reports "invalid duration" the moment the accumulator
   * overflows, so a duration outside ±2^63 ns is refused as the
   * context is read — before any expression runs. tsfga's
   * `coerceContext` used to match Go's *grammar* with a regex and
   * hand whatever matched to cel-js, which does not bound it
   * either; `durationExceedsInt64` now sums the terms and refuses
   * at the same boundary Go's accumulator does.
   *
   * `d > duration('0s')` is as ordinary as a condition gets, and
   * the value is one a caller stores in a tuple to mean "forever",
   * which is why the closed gap keeps its whole enumeration.
   */
  describe("a duration's magnitude is checked, at Go's boundary", () => {
    test("a duration past int64 nanoseconds", async () => {
      await check("durctx_d2", { d: DUR_OVER }, "refused");
    });

    test("one nanosecond past the maximum", async () => {
      await check("durctx_d2", { d: DUR_OVER_BY_ONE }, "refused");
    });

    test("a negative duration past int64 nanoseconds", async () => {
      await check("durctx_d2", { d: `-${DUR_OVER}` }, "refused");
    });

    test("unit terms that overflow only when summed", async () => {
      // Each term is inside the range; Go overflows adding them.
      await check("durctx_d2", { d: "2400000h2400000h" }, "refused");
    });

    test("a nanosecond count past int64", async () => {
      await check("durctx_d2", { d: "9223372036854775808ns" }, "refused");
    });

    test("the same value as a list<duration> element", async () => {
      await check("durlist_d2", { ds: [DUR_OVER] }, "refused");
    });

    test("the same value as a map<duration> value", async () => {
      await check("durmap_d2", { dm: { a: DUR_OVER } }, "refused");
    });

    test("the write gate refuses it too, as upstream does", async () => {
      // The shape that used to grant end to end: upstream would
      // not store the tuple at all, tsfga stored it and then
      // answered `true` on it. Both refuse the write now.
      await write("durctx_d2", { d: DUR_OVER }, "refused");
    });

    test("the largest duration Go reads agrees", async () => {
      await check("durctx_d2", { d: DUR_MAX }, true);
    });

    test("an ordinary duration agrees, in a list and a map", async () => {
      await check("durlist_d2", { ds: ["1h"] }, true);
      await check("durmap_d2", { dm: { a: "1h" } }, true);
    });

    test("a duration term Go's grammar refuses is refused by both", async () => {
      // `1h-1h` is not a sum; Go's grammar has no infix minus.
      await check("durctx_d2", { d: "1h-1h" }, "refused");
      // Nor an exponent — the mantissa grammar is digits and a dot.
      await check("durctx_d2", { d: "0.5e3h" }, "refused");
    });

    test("an ordinary duration is stored by both", async () => {
      await write("durctx_d2", { d: "1h" }, "accepted");
    });
  });

  /**
   * Go's `time.Parse` validates each field of an RFC 3339 string
   * against the calendar — "day out of range", "hour out of range"
   * — and refuses. `new Date` normalises instead: February 30
   * becomes March 2, and `T24:00:00` becomes the next midnight.
   * tsfga's `RFC3339` regex checks only the *shape* (two digits, a
   * colon), and `asTimestamp` used to hand the rest to `new Date`,
   * so both rolled-over spellings passed the gate and evaluated.
   *
   * That was granting, and reachable from ordinary data: a caller
   * assembling `2026-02-${lastDay}` or an off-by-one on a midnight
   * boundary produces exactly these strings, and upstream declined
   * to answer where tsfga answered `true`. Closed by giving
   * `asTimestamp` its own component parser, which reads year,
   * month, day, hour, minute and second out of the match and
   * checks each against the calendar before building the `Date`.
   */
  describe("a timestamp is validated, not normalised", () => {
    test("a day past the end of the month", async () => {
      await check("tsctx_d2", { t: "2026-02-30T00:00:00Z" }, "refused");
    });

    test("February 29 in a common year", async () => {
      await check("tsctx_d2", { t: "2026-02-29T00:00:00Z" }, "refused");
    });

    test("the 31st of a thirty-day month", async () => {
      await check("tsctx_d2", { t: "2026-04-31T00:00:00Z" }, "refused");
    });

    test("hour 24", async () => {
      await check("tsctx_d2", { t: "2026-01-01T24:00:00Z" }, "refused");
    });

    test("the same value as a list<timestamp> element", async () => {
      await check("tslist_d2", { ts: ["2026-02-30T00:00:00Z"] }, "refused");
    });

    test("the write gate refuses it too, as upstream does", async () => {
      await write("tsctx_d2", { t: "2026-02-30T00:00:00Z" }, "refused");
    });

    test("hour 24 on the write gate", async () => {
      await write("tsctx_d2", { t: "2026-01-01T24:00:00Z" }, "refused");
    });

    test("February 29 in a leap year agrees", async () => {
      await check("tsctx_d2", { t: "2024-02-29T00:00:00Z" }, true);
    });

    test("a day number no month has is refused by both", async () => {
      // `new Date` refuses 32 outright, so this half already agrees.
      await check("tsctx_d2", { t: "2026-01-32T00:00:00Z" }, "refused");
      await check("tsctx_d2", { t: "2026-13-01T00:00:00Z" }, "refused");
      await check("tsctx_d2", { t: "2026-01-00T00:00:00Z" }, "refused");
      await check("tsctx_d2", { t: "2026-00-01T00:00:00Z" }, "refused");
    });

    test("a minute or second past its range is refused by both", async () => {
      await check("tsctx_d2", { t: "2026-01-01T00:60:00Z" }, "refused");
      await check("tsctx_d2", { t: "2016-12-31T23:59:60Z" }, "refused");
      await check("tsctx_d2", { t: "2026-01-01T24:00:01Z" }, "refused");
    });

    test("an ordinary timestamp is stored by both", async () => {
      await write("tsctx_d2", { t: "2026-01-01T00:00:00Z" }, "accepted");
    });
  });

  /**
   * The other direction of the same predicate, and the reason the
   * fix is a calendar parser rather than a tighter regex: Go
   * accepts a zone offset whose minute field is 60, and `new Date`
   * does not. tsfga refuses a value upstream answers on —
   * fail-closed, and narrow.
   */
  describe("a zone offset upstream reads and tsfga does not", () => {
    test("an offset with minute 60", async () => {
      await check("tsctx_d2", { t: "2026-01-01T00:00:00+00:60" }, true);
    });

    test("an offset at the edge of the day agrees", async () => {
      await check("tsctx_d2", { t: "2026-01-01T00:00:00+23:59" }, true);
      await check("tsctx_d2", { t: "2026-01-01T00:00:00-00:00" }, true);
    });

    test("an offset with hour 99 is refused by both", async () => {
      await check("tsctx_d2", { t: "2026-01-01T00:00:00+99:00" }, "refused");
    });
  });

  /**
   * The rest of the conversion table, where nothing was found.
   * Recorded rather than dropped: the value of an enumeration is
   * that the cells which agree are written down beside the ones
   * that do not.
   */
  describe("the rest of the conversion table agrees", () => {
    test("a double past float64 is refused by both", async () => {
      await check("dblctx_d2", { x: "1e400" }, "refused");
    });

    test("a double under float64's smallest is refused by both", async () => {
      await check("dblctx_d2", { x: "1e-400" }, "refused");
    });

    test("`Inf` is read as a double by both", async () => {
      await check("dblctx_d2", { x: "Inf" }, true);
    });

    test("`NaN` is refused as a double by both", async () => {
      await check("dblctx_d2", { x: "NaN" }, "refused");
    });

    test("an out-of-range list<double> element is refused by both", async () => {
      await check("dbllist_d2", { xs: ["1e400"] }, "refused");
    });

    test("an ordinary list<double> element agrees", async () => {
      await check("dbllist_d2", { xs: [1.5] }, true);
    });

    test("a fractional int is refused by both", async () => {
      await check("intctx_d2", { n: 1.5 }, "refused");
      await check("intctx_d2", { n: "1.5" }, "refused");
    });

    test("an int past int64 saturates the same way on both", async () => {
      await check("intctx_d2", { n: "9223372036854775808" }, true);
    });

    test("an exponent form is read as an int by both", async () => {
      await check("intctx_d2", { n: "1e3" }, true);
    });

    test("an int given a bool or a list is refused by both", async () => {
      await check("intctx_d2", { n: true }, "refused");
      await check("intctx_d2", { n: [1] }, "refused");
    });

    test("a negative uint is refused by both", async () => {
      await check("uintctx_d2", { u: -1 }, "refused");
    });

    test("a fractional uint is refused by both", async () => {
      await check("uintctx_d2", { u: 1.5 }, "refused");
    });

    test("a uint past int64 saturates the same way on both", async () => {
      await check("uintctx_d2", { u: "18446744073709551615" }, true);
    });

    test("a string given a number or null is refused by both", async () => {
      await check("strctx_d2", { s: 5 }, "refused");
      await check("strctx_d2", { s: null }, "refused");
    });

    test("a bool given a string or a number is refused by both", async () => {
      await check("boolctx_d2", { b: "true" }, "refused");
      await check("boolctx_d2", { b: 1 }, "refused");
    });

    test("a container given the wrong shape is refused by both", async () => {
      await check("durlist_d2", { ds: "1h" }, "refused");
      await check("durmap_d2", { dm: ["1h"] }, "refused");
    });
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./coercion/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
