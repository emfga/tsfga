import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { WriteAuthorizationModelRequest } from "@openfga/sdk";
import { transformer } from "@openfga/syntax-transformer";
import {
  type ConditionParameterType,
  createTsfga,
  type TsfgaClient,
  TsfgaError,
} from "@tsfga/core";
import type { DB } from "@tsfga/kysely";
import { KyselyTupleStore } from "@tsfga/kysely";
import type { Kysely } from "kysely";
import { expectPinnedModelWriteDivergence } from "./helpers/conformance.ts";
import {
  beginTransaction,
  destroyDb,
  getDb,
  rollbackTransaction,
} from "./helpers/db.ts";
import { fgaCreateStore, fgaWriteModelOutcome } from "./helpers/openfga.ts";

/**
 * The other side of the declaration gate and the write-time type
 * check: expressions **upstream accepts**.
 *
 * A gate written to refuse what cel-go never declared is only
 * correct if cel-js's checker agrees with cel-go's about the
 * declarations they *share*. Where it is stricter, a model OpenFGA
 * stores cannot be written here at all — which is an outage, and
 * one no amount of check-path testing would find, because the
 * write never lands.
 *
 * Same shape as `cel-typecheck.test.ts`, run the other way
 * round: upstream must accept, and tsfga must too.
 */

const DSL_TYPE_NAMES: Readonly<Record<string, string>> = {
  string: "string",
  int: "int",
  uint: "uint",
  bool: "bool",
  double: "double",
  duration: "duration",
  timestamp: "timestamp",
  "list<string>": "list<string>",
  "list<int>": "list<int>",
  "map<int>": "map<int>",
  "map<string>": "map<string>",
};

function modelWith(
  name: string,
  parameters: Record<string, ConditionParameterType>,
  expression: string,
): WriteAuthorizationModelRequest {
  const declared = Object.entries(parameters)
    .map(([key, type]) => {
      const spelled = DSL_TYPE_NAMES[type];
      if (spelled === undefined) throw new Error(`no DSL spelling for ${type}`);
      return `${key}: ${spelled}`;
    })
    .join(", ");
  const dsl = `model
  schema 1.1

type user_d1

type doc_d1
  relations
    define ${name}: [user_d1 with ${name}_c]

condition ${name}_c(${declared}) {
  ${expression}
}
`;
  return transformer.transformDSLToJSONObject(dsl);
}

interface Cell {
  readonly name: string;
  readonly parameters: Record<string, ConditionParameterType>;
  readonly expression: string;
}

/**
 * Expressions a real model carries. Macros, comprehensions, `dyn`,
 * and one use of every parameter type tsfga declares.
 */
const LEGITIMATE: readonly Cell[] = [
  { name: "g01", parameters: { s: "string" }, expression: "s.size() > 0" },
  {
    name: "g02",
    parameters: { l: "list<string>" },
    expression: "l.exists(x, x == 'a')",
  },
  {
    name: "g03",
    parameters: { l: "list<int>" },
    expression: "l.all(x, x > 0)",
  },
  {
    name: "g04",
    parameters: { l: "list<int>" },
    expression: "l.filter(x, x > 1).size() > 0",
  },
  {
    name: "g05",
    parameters: { l: "list<int>" },
    expression: "l.map(x, x + 1).exists(y, y > 2)",
  },
  {
    name: "g06",
    parameters: { l: "list<int>" },
    expression: "l.all(x, l.exists(y, y >= x))",
  },
  {
    name: "g07",
    parameters: { m: "map<int>" },
    expression: "m.all(k, m[k] > 0)",
  },
  { name: "g08", parameters: { m: "map<int>" }, expression: "has(m.a)" },
  {
    name: "g09",
    parameters: { a: "string", b: "string" },
    expression: "dyn(a) == dyn(b)",
  },
  { name: "g10", parameters: { u: "uint" }, expression: "u > 0u" },
  { name: "g11", parameters: { d: "double" }, expression: "d > 1.5" },
  { name: "g12", parameters: { b: "bool" }, expression: "b && !b" },
  {
    name: "g13",
    parameters: { t: "timestamp" },
    expression: "t.getDayOfWeek('UTC') > 1",
  },
  {
    name: "g14",
    parameters: { du: "duration" },
    expression: "du.getSeconds() > 1",
  },
  {
    name: "g15",
    parameters: { t: "timestamp", du: "duration" },
    expression: "t + du > t",
  },
  {
    name: "g16",
    parameters: { t1: "timestamp", t2: "timestamp" },
    expression: "t2 - t1 > duration('1h')",
  },
  {
    name: "g17",
    parameters: { s: "string", l: "list<string>" },
    expression: "!(s in l)",
  },
  {
    name: "g18",
    parameters: { i: "int" },
    expression: "timestamp(i) > timestamp(0)",
  },
  {
    name: "g19",
    parameters: { s: "string" },
    expression: "bytes(s).size() > 0",
  },
  { name: "g20", parameters: { s: "string" }, expression: "type(s) == string" },
  // The five overloads cel-go declares and cel-js does not. Each
  // is a model upstream stores, so each must stay *writable* here
  // — the check that reads it is what refuses (ledger rows R1–R5,
  // pinned in `cel-stdlib` and `cel-numeric`).
  //
  // They are here because `typeVerdict` gives no verdict on a call
  // cel-js cannot resolve. Without that narrowing every one of
  // them is a write-time refusal, which is strictly worse than a
  // check-time one and more refusing than bare cel-js, the dialect
  // tsfga retreats to. This block is what holds that line.
  { name: "g21", parameters: { n: "uint" }, expression: "int(n) == 7" },
  { name: "g22", parameters: { d: "duration" }, expression: "int(d) > 0" },
  { name: "g23", parameters: { t: "timestamp" }, expression: "int(t) > 0" },
  {
    name: "g24",
    parameters: { d: "duration" },
    expression: "string(d) == '3600s'",
  },
  {
    name: "g25",
    parameters: { t: "timestamp" },
    expression: "string(t) == 'x'",
  },
];

/**
 * Where cel-js's checker is stricter than cel-go's on a
 * declaration both environments have.
 */
const SUSPECTED: readonly Cell[] = [
  { name: "h02", parameters: { s: "string" }, expression: "s != null" },
  { name: "h03", parameters: { s: "string" }, expression: "s == null" },
];

/**
 * Ledger mechanism M7: a call **both** engines declare, applied to
 * an argument type **neither** overloads.
 *
 * This is the cost of the narrowing that makes `int(duration)` and
 * its four siblings writable. `typeVerdict` cannot tell "cel-go
 * declares this overload and cel-js does not" from "neither
 * declares it" — cel-js reports both as `found no matching
 * overload for …` — so suppressing the first family suppresses the
 * second with it. Upstream refuses the *model*; tsfga stores the
 * definition and refuses at the check that reads it.
 *
 * Write-moment only, narrow, and author-controlled: the author has
 * named a conversion that cannot apply to the parameter they
 * declared, and nothing downstream can grant on it. It is pinned
 * rather than closed because closing it needs a per-overload
 * transcription of cel-go's declaration table, which is the shape
 * `CLAUDE.md` bans.
 *
 * `duration(int)` was measured because an existing `SUSPECTED`
 * cell moved here; `size()` on a `bool` because a `cache` cell
 * did. Both were agreement cells before the narrowing.
 */
const UNOVERLOADED: readonly Cell[] = [
  { name: "m01", parameters: { b: "bool" }, expression: "int(b) > 0" },
  {
    name: "m02",
    parameters: { i: "int" },
    expression: "duration(i) > duration('1s')",
  },
  { name: "m03", parameters: { b: "bool" }, expression: "b.size() > 0" },
];

describe("CEL write gate: over-refusal sweep", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let tsfgaClient: TsfgaClient;

  beforeAll(async () => {
    db = getDb();
    await beginTransaction(db);
    tsfgaClient = createTsfga(new KyselyTupleStore(db));
    storeId = await fgaCreateStore("cel-gate");
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  async function tsfgaWrite(cell: Cell): Promise<"accepted" | "refused"> {
    try {
      await tsfgaClient.writeConditionDefinition({
        name: `${cell.name}_c`,
        expression: cell.expression,
        parameters: cell.parameters,
      });
      return "accepted";
    } catch (error) {
      if (error instanceof TsfgaError) return "refused";
      throw error;
    }
  }

  async function upstreamWrite(cell: Cell): Promise<"accepted" | "refused"> {
    const outcome = await fgaWriteModelOutcome(
      storeId,
      modelWith(cell.name, cell.parameters, cell.expression),
    );
    return outcome === "accepted" ? "accepted" : "refused";
  }

  describe("expressions upstream stores are still writable here", () => {
    for (const cell of LEGITIMATE) {
      test(`${cell.expression}`, async () => {
        const [tsfga, upstream] = await Promise.all([
          tsfgaWrite(cell),
          upstreamWrite(cell),
        ]);
        expect(upstream).toBe("accepted");
        expect(tsfga).toBe(upstream);
      });
    }
  });

  describe("cells where cel-js may be stricter than cel-go", () => {
    for (const cell of SUSPECTED) {
      test(`${cell.expression}`, async () => {
        const [tsfga, upstream] = await Promise.all([
          tsfgaWrite(cell),
          upstreamWrite(cell),
        ]);
        expect(tsfga).toBe(upstream);
      });
    }
  });

  describe("M7: a conversion neither engine overloads", () => {
    for (const cell of UNOVERLOADED) {
      test(`${cell.expression}`, async () => {
        await expectPinnedModelWriteDivergence(
          storeId,
          modelWith(cell.name, cell.parameters, cell.expression),
          () =>
            tsfgaClient.writeConditionDefinition({
              name: `${cell.name}_c`,
              expression: cell.expression,
              parameters: cell.parameters,
            }),
          { openfga: "refused", tsfga: "accepted" },
        );
      });
    }
  });
});
