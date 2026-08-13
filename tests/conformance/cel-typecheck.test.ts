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
import {
  beginTransaction,
  destroyDb,
  getDb,
  rollbackTransaction,
} from "./helpers/db.ts";
import { fgaCreateStore, fgaWriteModelOutcome } from "./helpers/openfga.ts";

/**
 * Expressions OpenFGA refuses to put in a model at all, and what
 * tsfga does with them instead.
 *
 * OpenFGA compiles every condition against its declared parameters
 * while it validates `WriteAuthorizationModel`, so an expression
 * that names a function the environment does not declare, or that
 * does not type-check, never reaches a check: the model is
 * rejected. tsfga's `writeConditionDefinition` parses and does not
 * type-check — a gap `packages/core/README.md` states and
 * `condition-compile.test.ts` pins for `not_a_function(x)`.
 *
 * What that pin does *not* say is what happens next. For
 * `not_a_function(x)` the answer is comfortable: cel-js fails to
 * resolve the call and the check refuses, so both engines end up
 * declining. For the two families below it is not. Both compile,
 * both evaluate, and both **answer** — and several answer `true`.
 * A tsfga-backed service therefore grants access on a model
 * OpenFGA would not have accepted, with nothing anywhere reporting
 * a problem.
 *
 * The tests assert the parity that ought to hold: an expression no
 * valid OpenFGA model can carry should be refused where it is
 * written. They fail today.
 *
 * **Written through the model rather than the DSL** where the
 * transformer would object; where it would not, the DSL text is
 * transformed here so the expression reaching the server is
 * exactly the one tsfga was given.
 */

const uuidMap = new Map<string, string>([
  ["alice", "00000000-0000-4000-d510-000000000021"],
  ["doc", "00000000-0000-4000-d510-000000000022"],
]);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

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
};

/** A one-condition model carrying `expression`, as JSON. */
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

type user_c5

type doc_c5
  relations
    define ${name}: [user_c5 with ${name}_c]

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
  readonly context: Record<string, unknown>;
  /** What tsfga answers today, for the record. */
  readonly tsfgaAnswers: boolean | "refused";
}

/**
 * cel-js ships the equivalent of cel-go's `ext.Strings()` and
 * `ext.Bindings()` libraries in its base environment. OpenFGA
 * enables neither.
 */
const EXTENSIONS: readonly Cell[] = [
  {
    name: "x_split",
    parameters: { s: "string" },
    expression: "s.split(',').size() == 2",
    context: { s: "a,b" },
    tsfgaAnswers: "refused",
  },
  {
    name: "x_substring",
    parameters: { s: "string" },
    expression: "s.substring(0, 1) == 'a'",
    context: { s: "abc" },
    tsfgaAnswers: "refused",
  },
  {
    name: "x_trim",
    parameters: { s: "string" },
    expression: "s.trim() == 'a'",
    context: { s: " a " },
    tsfgaAnswers: "refused",
  },
  {
    name: "x_indexof",
    parameters: { s: "string" },
    expression: "s.indexOf('b') == 1",
    context: { s: "abc" },
    tsfgaAnswers: "refused",
  },
  {
    name: "x_lastindexof",
    parameters: { s: "string" },
    expression: "s.lastIndexOf('a') == 2",
    context: { s: "aba" },
    tsfgaAnswers: "refused",
  },
  {
    name: "x_lowerascii",
    parameters: { s: "string" },
    expression: "s.lowerAscii() == 'ab'",
    context: { s: "AB" },
    tsfgaAnswers: "refused",
  },
  {
    name: "x_upperascii",
    parameters: { s: "string" },
    expression: "s.upperAscii() == 'AB'",
    context: { s: "ab" },
    tsfgaAnswers: "refused",
  },
  {
    name: "x_join",
    parameters: { l: "list<string>" },
    expression: "l.join(',') == 'a,b'",
    context: { l: ["a", "b"] },
    tsfgaAnswers: "refused",
  },
  {
    name: "x_bind",
    parameters: { n: "int" },
    expression: "cel.bind(x, n + 1, x > 1)",
    context: { n: 1 },
    tsfgaAnswers: "refused",
  },
];

/**
 * Expressions that parse and do not type-check. Every one of these
 * *answers* in tsfga rather than refusing, and four of them answer
 * `true`.
 */
const UNTYPED: readonly Cell[] = [
  {
    name: "y_neq_str",
    parameters: { n: "int" },
    expression: "n != 'a'",
    context: { n: 1 },
    tsfgaAnswers: "refused",
  },
  {
    name: "y_eq_double",
    parameters: { n: "int" },
    expression: "n == 1.0",
    context: { n: 1 },
    tsfgaAnswers: "refused",
  },
  {
    name: "y_eq_uint",
    parameters: { n: "int" },
    expression: "n == 1u",
    context: { n: 1 },
    tsfgaAnswers: "refused",
  },
  {
    name: "y_undeclared_or",
    parameters: { n: "int" },
    expression: "n > 0 || other > 0",
    context: { n: 1 },
    tsfgaAnswers: "refused",
  },
  {
    name: "y_eq_str",
    parameters: { n: "int" },
    expression: "n == 'a'",
    context: { n: 1 },
    tsfgaAnswers: "refused",
  },
  {
    name: "y_in_mixed",
    parameters: { n: "int" },
    expression: "n in ['a']",
    context: { n: 1 },
    tsfgaAnswers: "refused",
  },
  {
    name: "y_nonbool",
    parameters: { n: "int" },
    expression: "n",
    context: { n: 1 },
    tsfgaAnswers: "refused",
  },
];

/** A cell whose expression both engines are happy with. */
const CONTROL: Cell = {
  name: "z_ok",
  parameters: { n: "int" },
  expression: "n > 0",
  context: { n: 1 },
  tsfgaAnswers: "refused",
};

describe("CEL type-check conformance", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let tsfgaClient: TsfgaClient;

  beforeAll(async () => {
    db = getDb();
    await beginTransaction(db);
    tsfgaClient = createTsfga(new KyselyTupleStore(db));
    storeId = await fgaCreateStore("cel-typecheck");
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  /** Whether tsfga takes the definition, and what it then answers. */
  async function tsfgaOutcome(
    cell: Cell,
  ): Promise<{ write: "accepted" | "refused"; answer: boolean | "refused" }> {
    try {
      await tsfgaClient.writeConditionDefinition({
        name: `${cell.name}_c`,
        expression: cell.expression,
        parameters: cell.parameters,
      });
    } catch (error) {
      if (error instanceof TsfgaError)
        return { write: "refused", answer: "refused" };
      throw error;
    }
    await tsfgaClient.writeRelationConfig({
      objectType: "doc_c5",
      relation: cell.name,
      directlyAssignable: [{ type: "user_c5", condition: `${cell.name}_c` }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.addTuple({
      objectType: "doc_c5",
      objectId: uuid("doc"),
      relation: cell.name,
      subjectType: "user_c5",
      subjectId: uuid("alice"),
      conditionName: `${cell.name}_c`,
    });
    try {
      const answer = await tsfgaClient.check({
        objectType: "doc_c5",
        objectId: uuid("doc"),
        relation: cell.name,
        subjectType: "user_c5",
        subjectId: uuid("alice"),
        context: cell.context,
      });
      return { write: "accepted", answer };
    } catch (error) {
      if (error instanceof TsfgaError)
        return { write: "accepted", answer: "refused" };
      throw error;
    }
  }

  async function upstreamOutcome(cell: Cell): Promise<"accepted" | "refused"> {
    const outcome = await fgaWriteModelOutcome(
      storeId,
      modelWith(cell.name, cell.parameters, cell.expression),
    );
    return outcome === "accepted" ? "accepted" : "refused";
  }

  /**
   * The control: an expression both engines accept, so a fix that
   * refused everything would not pass this file.
   */
  test("an expression that type-checks is accepted by both", async () => {
    const [tsfga, upstream] = await Promise.all([
      tsfgaOutcome(CONTROL),
      upstreamOutcome(CONTROL),
    ]);
    expect(upstream).toBe("accepted");
    expect(tsfga.write).toBe("accepted");
    expect(tsfga.answer).toBe(true);
  });

  describe("cel-js ships extension libraries OpenFGA does not enable", () => {
    for (const cell of EXTENSIONS) {
      test(`${cell.expression}`, async () => {
        const [tsfga, upstream] = await Promise.all([
          tsfgaOutcome(cell),
          upstreamOutcome(cell),
        ]);
        // Upstream will not carry this expression in any model, so
        // the reachable behaviour is a grant tsfga produced alone.
        expect(upstream).toBe("refused");
        expect(tsfga.answer).toBe(cell.tsfgaAnswers);
        expect(tsfga.write).toBe(upstream);
      });
    }
  });

  describe("an untyped expression answers rather than refusing", () => {
    for (const cell of UNTYPED) {
      test(`${cell.expression}`, async () => {
        const [tsfga, upstream] = await Promise.all([
          tsfgaOutcome(cell),
          upstreamOutcome(cell),
        ]);
        expect(upstream).toBe("refused");
        expect(tsfga.answer).toBe(cell.tsfgaAnswers);
        expect(tsfga.write).toBe(upstream);
      });
    }
  });
});
