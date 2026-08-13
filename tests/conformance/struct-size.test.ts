import { afterAll, beforeAll, describe, test } from "bun:test";
import {
  type AddTupleRequest,
  createTsfga,
  type TsfgaClient,
} from "@tsfga/core";
import type { DB } from "@tsfga/kysely";
import { KyselyTupleStore } from "@tsfga/kysely";
import type { Kysely } from "kysely";
import {
  expectConfigsMatchModel,
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
  fgaWriteOutcome,
} from "./helpers/openfga.ts";

/**
 * The condition-context size limit, at its boundary, for context
 * shapes that are not one flat string.
 *
 * The measure is a hand-rolled `proto.Size` of the
 * `google.protobuf.Struct` the context becomes, rather than
 * `JSON.stringify().length`, and it was calibrated on
 * `{"s": "<n bytes>"}` alone. That one
 * shape exercises a single-byte varint, a one-byte key and a
 * string value. Everything else the measure has to get right —
 * nested structs, lists, empty containers, non-ASCII keys, the
 * two-byte varint a length past 127 needs, and the per-entry
 * framing that dominates a context of many small entries — is
 * untested by it.
 *
 * Each test **bisects the container** for the exact largest
 * padding upstream accepts, and then asserts that tsfga accepts
 * the same padding and refuses one more. So the boundary is never
 * hard-coded and never derived from tsfga's own arithmetic:
 * `proto.Size` in v1.18.2 is the only authority
 * (`pkg/server/commands/write.go:159`).
 */

const ALICE = "00000000-0000-4000-d4e1-000000000001";

let nextObject = 0;
function objectId(): string {
  nextObject++;
  return `00000000-0000-4000-d4e1-3${String(nextObject).padStart(11, "0")}`;
}

/** A context shape with one knob, monotone in it. */
interface Shape {
  /** The largest knob value worth trying. */
  hi: number;
  build: (n: number) => Record<string, unknown>;
}

const LONG_KEY = `k${"y".repeat(202)}`;

const SHAPES: Record<string, Shape> = {
  // The calibration shape, restated so a regression in it is
  // visible beside the shapes it was generalised to.
  flat: { hi: 40_000, build: (n) => ({ s: "x".repeat(n) }) },

  // A key of 203 bytes, nested where the 50-code-point bound on a
  // *parameter* name does not reach: its own length needs a
  // two-byte varint, and so does the entry that carries it.
  longKey: {
    hi: 40_000,
    build: (n) => ({ m: { [LONG_KEY]: "x".repeat(n) } }),
  },

  // Three-byte UTF-8 in the value, so a measure counting UTF-16
  // units rather than bytes is off by a third.
  unicode: { hi: 20_000, build: (n) => ({ u: "\u5b57".repeat(n) }) },

  // Astral code points: two UTF-16 units and four UTF-8 bytes
  // each, so `String.length` and the byte count disagree the
  // other way.
  astral: { hi: 12_000, build: (n) => ({ v: "\u{1F642}".repeat(n) }) },

  // A `struct_value`, so the nested `Struct`'s own tag and length
  // prefix have to be counted on top of its entries.
  nestedMap: {
    hi: 40_000,
    build: (n) => ({ m: { inner: "x".repeat(n) } }),
  },

  // A `list_value` of strings: each element carries a tag and a
  // length of its own inside the list.
  listValue: {
    hi: 40_000,
    build: (n) => ({ l: ["x".repeat(n), "a", "b"] }),
  },

  // Many entries inside a nested struct, so the per-entry framing
  // is nearly the whole measure and the values contribute two
  // bytes each.
  manyInner: {
    hi: 6_000,
    build: (n) => {
      const inner: Record<string, string> = {};
      for (let index = 0; index < n; index++) inner[`k${index}`] = "";
      return { m: inner };
    },
  },

  // The same, with `bool_value` rather than an empty string.
  manyBools: {
    hi: 6_000,
    build: (n) => {
      const inner: Record<string, boolean> = {};
      for (let index = 0; index < n; index++) {
        inner[`k${index}`] = index % 2 === 0;
      }
      return { mb: inner };
    },
  },

  // The containers that carry nothing, beside the scalars whose
  // sizes are fixed: a `Value` holding an empty struct, an empty
  // list, a bool, an integral number and a fractional one.
  fixedScalars: {
    hi: 40_000,
    build: (n) => ({
      m: {},
      l: [],
      b: true,
      d: 1.5,
      i: 7,
      s: "x".repeat(n),
    }),
  },
};

describe("Condition Context Size Conformance", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let authorizationModelId: string;
  let tsfgaClient: TsfgaClient;
  let fixture: FixtureRecord;

  beforeAll(async () => {
    db = getDb();
    await beginTransaction(db);

    const store = new KyselyTupleStore(db);
    tsfgaClient = createTsfga(store);
    fixture = recordFixture(tsfgaClient);

    await tsfgaClient.writeConditionDefinition({
      name: "any_c2s",
      expression: 's != "zzz"',
      parameters: {
        s: "string",
        u: "string",
        v: "string",
        m: "map<string>",
        mb: "map<bool>",
        l: "list<string>",
        b: "bool",
        d: "double",
        i: "int",
      },
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "doc_c2s",
      relation: "viewer",
      directlyAssignable: [{ type: "user_c2s", condition: "any_c2s" }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });

    storeId = await fgaCreateStore("struct-size-conformance");
    authorizationModelId = await fgaWriteModel(
      storeId,
      "./struct-size/model.dsl",
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  function tuple(context: Record<string, unknown>): AddTupleRequest {
    return {
      objectType: "doc_c2s",
      objectId: objectId(),
      relation: "viewer",
      subjectType: "user_c2s",
      subjectId: ALICE,
      conditionName: "any_c2s",
      conditionContext: context,
    };
  }

  /** Whether upstream accepts this context at all. */
  async function upstreamAccepts(
    context: Record<string, unknown>,
  ): Promise<boolean> {
    const outcome = await fgaWriteOutcome(
      storeId,
      authorizationModelId,
      tuple(context),
    );
    return outcome === "accepted";
  }

  /**
   * The largest knob value upstream accepts, found by bisection
   * against the running container.
   */
  async function upstreamBoundary(shape: Shape): Promise<number> {
    let low = 0;
    let high = shape.hi;
    if (await upstreamAccepts(shape.build(high))) {
      throw new Error("shape never reaches the limit; raise its `hi`");
    }
    if (!(await upstreamAccepts(shape.build(low)))) {
      throw new Error("shape is over the limit at its smallest");
    }
    while (high - low > 1) {
      const mid = Math.floor((low + high) / 2);
      if (await upstreamAccepts(shape.build(mid))) low = mid;
      else high = mid;
    }
    return low;
  }

  for (const [name, shape] of Object.entries(SHAPES)) {
    test(`the ${name} context flips at the same size on both engines`, async () => {
      const boundary = await upstreamBoundary(shape);
      await expectWriteConformance(
        storeId,
        authorizationModelId,
        tsfgaClient,
        tuple(shape.build(boundary)),
        "accepted",
      );
      await expectWriteConformance(
        storeId,
        authorizationModelId,
        tsfgaClient,
        tuple(shape.build(boundary + 1)),
        "refused",
      );
    }, 120_000);
  }

  test("the fixture's configs match its model", () => {
    expectConfigsMatchModel("./struct-size/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
