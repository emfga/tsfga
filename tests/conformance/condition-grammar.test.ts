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
 * Which context values a condition parameter can be read from —
 * the grammar, not the semantics.
 *
 * **Every relation here is `[user] but not blocked`**, and that is
 * the point rather than a flourish. On a plain relation these
 * divergences read as "one engine answers, the other refuses",
 * which sounds like a robustness difference. Under an exclusion
 * they invert: a value upstream refuses to read at all coerces
 * cleanly here, the exclusion does not fire, and access is
 * *granted*. `n = '0x10'` against `double` was exactly that.
 *
 * The parameter types are read through Go's parser upstream, not
 * JavaScript's, and the two agree on almost none of the boundary:
 *
 * - every numeric type goes through
 *   `big.ParseFloat(value, 10, 64, 0)`, so the prefixed literal
 *   forms and surrounding whitespace `Number()` accepts are
 *   refused, the exponent forms `BigInt()` rejects are accepted,
 *   and a decimal that cannot be a `float64` exactly is an error
 *   rather than the nearest one;
 * - `Inf` is a number and `Infinity` is not;
 * - a bare `0` is a duration and `00` is not;
 * - the RFC 3339 designators are uppercase, and the fractional
 *   digits are unbounded;
 * - `list` and `map` carry an element type, and it is enforced.
 *
 * Both directions are here. A cell OpenFGA refuses is a grant
 * waiting to happen; a cell it answers and tsfga refused is an
 * outage.
 */

const uuidMap = new Map<string, string>([
  ["alice", "00000000-0000-4000-d000-000000000001"],
  ["doc", "00000000-0000-4000-d000-000000000010"],
]);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

/**
 * One row per relation in `condition-grammar/model.dsl`: the
 * relation's name, the parameter type its condition declares, and
 * the expression. The fixture writes both sides from this.
 */
const CELLS: ReadonlyArray<readonly [string, ConditionParameterType, string]> =
  [
    ["int_exp", "int", "n == 1000"],
    ["int_point", "int", "n == 4"],
    ["uint_sat", "uint", "n == 9223372036854775807u"],
    ["dbl_hex", "double", "n == 16.0"],
    ["dbl_pad", "double", "n == 1.5"],
    ["dbl_prec", "double", "n == 1.0"],
    ["dbl_inexact", "double", "n > 0.0"],
    ["dbl_inf", "double", "n > 1.0"],
    ["dbl_ninf", "double", "n < 1.0"],
    ["dur_zero", "duration", "n == duration('0s')"],
    ["dur_neg_zero", "duration", "n == duration('0s')"],
    ["ts_lower", "timestamp", "n == timestamp('2026-01-01T00:00:00Z')"],
    ["ts_lower_zone", "timestamp", "n == timestamp('2026-01-01T00:00:00Z')"],
    ["ts_frac", "timestamp", "n > timestamp('2026-01-01T00:00:00Z')"],
    ["list_string", "list<string>", "'a' in n"],
    ["map_string", "map<string>", "n['a'] == 'x'"],
    ["list_int_bad", "list<int>", "1 in n"],
    ["list_int", "list<int>", "n[0] + 1 == 2"],
    ["map_int", "map<int>", "n['a'] + 1 == 2"],
    ["ok_int", "int", "n == 42"],
    ["ok_double", "double", "n == 1.5"],
    ["ok_duration", "duration", "n == duration('0s')"],
    ["ok_timestamp", "timestamp", "n > timestamp('2026-01-01T00:00:00Z')"],
    ["ok_list", "list<string>", "'a' in n"],
  ];

describe("Condition Grammar Conformance", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let modelId: string;
  let tsfgaClient: TsfgaClient;
  let fixture: FixtureRecord;

  beforeAll(async () => {
    db = getDb();
    await beginTransaction(db);

    const store = new KyselyTupleStore(db);
    tsfgaClient = createTsfga(store);
    fixture = recordFixture(tsfgaClient);

    for (const [relation, parameter, expression] of CELLS) {
      await tsfgaClient.writeConditionDefinition({
        name: `${relation}_c`,
        expression,
        parameters: { n: parameter },
      });
      await tsfgaClient.writeRelationConfig({
        objectType: "doc",
        relation: `blocked_${relation}`,
        directlyAssignable: [{ type: "user", condition: `${relation}_c` }],
        impliedBy: null,
        computedUserset: null,
        tupleToUserset: null,
        excludedBy: null,
        intersection: null,
      });
      await tsfgaClient.writeRelationConfig({
        objectType: "doc",
        relation,
        directlyAssignable: [{ type: "user" }],
        impliedBy: null,
        computedUserset: null,
        tupleToUserset: null,
        excludedBy: `blocked_${relation}`,
        intersection: null,
      });
      await tsfgaClient.addTuple({
        objectType: "doc",
        objectId: uuid("doc"),
        relation,
        subjectType: "user",
        subjectId: uuid("alice"),
      });
      await tsfgaClient.addTuple({
        objectType: "doc",
        objectId: uuid("doc"),
        relation: `blocked_${relation}`,
        subjectType: "user",
        subjectId: uuid("alice"),
        conditionName: `${relation}_c`,
      });
    }

    storeId = await fgaCreateStore("condition-grammar-conformance");
    modelId = await fgaWriteModel(storeId, "./condition-grammar/model.dsl");
    await fgaWriteTuplesRaw(
      storeId,
      modelId,
      CELLS.flatMap(([relation]) => [
        {
          user: `user:${uuid("alice")}`,
          relation,
          object: `doc:${uuid("doc")}`,
        },
        {
          user: `user:${uuid("alice")}`,
          relation: `blocked_${relation}`,
          object: `doc:${uuid("doc")}`,
          condition: { name: `${relation}_c` },
        },
      ]),
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  /**
   * `false` means the value was read and the condition held, so
   * the exclusion fired. `true` means it was read and did not.
   * `"refused"` means neither engine would read it.
   */
  const check = (relation: string, n: unknown, expected: CheckOutcome) =>
    expectConformance(
      storeId,
      modelId,
      tsfgaClient,
      {
        objectType: "doc",
        objectId: uuid("doc"),
        relation,
        subjectType: "user",
        subjectId: uuid("alice"),
        context: { n },
      },
      expected,
    );

  describe("the numeric grammar is Go's, not JavaScript's", () => {
    test("an int reads an exponent", async () => {
      // A grammar of bare digits refused this; upstream parses
      // every numeric type as a float and then asks whether it is
      // an integer, so `1e3` is one.
      await check("int_exp", "1e3", false);
    });

    test("an int reads a zero fraction", async () => {
      await check("int_point", "4.0", false);
    });

    test("a uint past int64 saturates to int64's ceiling", async () => {
      // Not uint64's: upstream converts every numeric string
      // through the same `bigFloat.Int64()` and only then rejects
      // a negative result.
      await check("uint_sat", "99999999999999999999999", false);
    });

    for (const [relation, value] of [
      ["dbl_hex", "0x10"],
      ["dbl_pad", " 1.5 "],
    ] as const) {
      test(`a double refuses ${JSON.stringify(value)}`, async () => {
        // The granting shape. tsfga read the value, the condition
        // was met or unmet on a number upstream never accepted,
        // and the exclusion answered on it.
        await check(relation, value, "refused");
      });
    }

    for (const [relation, value] of [
      ["dbl_prec", "1.0000000000000000001"],
      ["dbl_inexact", "0.1"],
    ] as const) {
      test(`a double refuses the inexact ${JSON.stringify(value)}`, async () => {
        // Upstream parses at 64-bit precision and refuses when the
        // conversion to a float64 loses anything, so a decimal
        // with no finite binary form is an error rather than the
        // nearest double.
        await check(relation, value, "refused");
      });
    }

    test("a double reads Inf", async () => {
      await check("dbl_inf", "Inf", false);
    });

    test("a double reads -Inf", async () => {
      await check("dbl_ninf", "-Inf", false);
    });

    test("a double still refuses Infinity", async () => {
      // The control on the infinity spellings: `big.Float.Parse`
      // takes `Inf` and `inf` and nothing longer.
      await check("dbl_inf", "Infinity", "refused");
    });
  });

  describe("duration and timestamp spellings", () => {
    test("a bare zero is a duration", async () => {
      await check("dur_zero", "0", false);
    });

    test("so is a signed bare zero", async () => {
      await check("dur_neg_zero", "-0", false);
    });

    test("but a bare one is not", async () => {
      await check("dur_zero", "1", "refused");
    });

    test("a lowercase timestamp designator is refused", async () => {
      await check("ts_lower", "2026-01-01t00:00:00z", "refused");
    });

    test("so is a lowercase zone alone", async () => {
      await check("ts_lower_zone", "2026-01-01T00:00:00z", "refused");
    });

    test("twelve fractional digits are read", async () => {
      // cel-js's own `timestamp()` refuses any spelling past 30
      // characters, which ten digits reaches. Upstream keeps
      // nanoseconds and discards the rest.
      await check("ts_frac", "2026-01-01T00:00:00.123456789012Z", false);
    });
  });

  describe("a container's element type is enforced", () => {
    test("a list<string> refuses a number element", async () => {
      await check("list_string", [1], "refused");
    });

    test("a map<string> refuses a number value", async () => {
      await check("map_string", { a: 1 }, "refused");
    });

    test("a list<int> refuses a non-numeric element", async () => {
      await check("list_int_bad", ["x"], "refused");
    });

    test("a list<int> element is an int, so arithmetic resolves", async () => {
      // The element-level half of the integer representation: a
      // list of JS numbers reaches CEL as doubles, and `n[0] + 1`
      // finds no overload.
      await check("list_int", [1], false);
    });

    test("a map<int> value is an int too", async () => {
      await check("map_int", { a: 1 }, false);
    });

    test("a list<int> parses its numeric strings", async () => {
      await check("list_int", ["1"], false);
    });
  });

  /**
   * Controls. Tightening a grammar passes trivially by refusing
   * everything, so each family also has a cell that must still be
   * read — and one that must still *grant*, since every assertion
   * above is a refusal or an exclusion.
   */
  describe("what already worked still works", () => {
    test("an int reads a plain decimal string", async () => {
      await check("ok_int", "42", false);
    });

    test("and grants when the condition does not hold", async () => {
      // The one cell where the answer is `true`: without it the
      // suite would pass against an implementation that excluded
      // on everything it managed to read.
      await check("ok_int", "7", true);
    });

    test("a double reads a plain decimal string", async () => {
      await check("ok_double", "1.5", false);
    });

    test("a duration reads a unit", async () => {
      await check("ok_duration", "0s", false);
    });

    test("a timestamp reads nine fractional digits", async () => {
      await check("ok_timestamp", "2026-01-01T00:00:00.123456789Z", false);
    });

    test("a list<string> reads a string element", async () => {
      await check("ok_list", ["a"], false);
    });

    test("an ill-typed value is still refused by both", async () => {
      await check("ok_int", "abc", "refused");
    });
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./condition-grammar/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
