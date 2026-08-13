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
 * The CEL standard library, overload by overload, against what
 * `@marcbachmann/cel-js` provides.
 *
 * OpenFGA's environment is cel-go's base environment plus the
 * `ipaddress` library and nothing else
 * (`internal/condition/condition.go`), so cel-go's
 * `common/stdlib/standard.go` is the exact list a condition may
 * name. `int(timestamp)`, `int(duration)`, `int(uint)` and
 * `string(timestamp)` have no cel-js counterpart, and all four are
 * reachable from a model OpenFGA accepts.
 *
 * Every cell here is in the outage direction — upstream answers
 * and tsfga refuses — which makes them the safe kind of
 * divergence, but a condition that stops answering revokes access
 * as surely as one that answers `false`.
 *
 * **The four gaps used to be two.** `conditions.ts` supplied the
 * missing overloads itself, through a replacement `int()` and a
 * `string(duration)` / `string(timestamp)` pair registered on the
 * evaluating environment. Those are gone with the rest of the
 * compatibility layer, so what were agreement cells are now pinned
 * divergences — ledger rows R1 through R5. The write still
 * succeeds on both sides; only the check parts company.
 *
 * **This file used to carry the two `matches` spellings as well**,
 * including the global `matches(s, p)`, which resolved upstream
 * and refused here. tsfga no longer supports
 * regular expressions at all, so neither spelling compiles and
 * the distinction between them has nothing left to describe. Those
 * cells are preserved verbatim in `docs/cel-js/retired/` as
 * material for a future cel-js fork; what survives here is the
 * part of the standard library that was never about patterns.
 */

const uuidMap = new Map<string, string>([
  ["alice", "00000000-0000-4000-d510-000000000011"],
  ["doc", "00000000-0000-4000-d510-000000000012"],
]);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

/** One row per relation in `cel-stdlib/model.dsl`. */
const CELLS: ReadonlyArray<
  readonly [string, Record<string, ConditionParameterType>, string]
> = [
  ["it_c5", { t: "timestamp" }, "int(t) == 1767225600"],
  ["id_c5", { d: "duration" }, "int(d) == 3600000000000"],
  ["is_c5", { s: "string" }, "int(s) == 7"],
  ["iu_c5", { n: "uint" }, "int(n) == 7"],
  ["st_c5", { t: "timestamp" }, "string(t) == '2026-01-01T00:00:00Z'"],
  ["ti_c5", { n: "int" }, "timestamp(n) == timestamp('1970-01-01T00:00:01Z')"],
  ["ty_c5", { n: "int" }, "type(n) == int"],
  ["by_c5", { s: "string" }, "size(bytes(s)) == 3"],
  ["bo_c5", { s: "string" }, "bool(s)"],
  ["sz_c5", { s: "string" }, "s.size() == 3"],
];

describe("CEL standard library conformance", () => {
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

    storeId = await fgaCreateStore("cel-stdlib");
    modelId = await fgaWriteModel(storeId, "./cel-stdlib/model.dsl");
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

  const pin = (relation: string, context: Record<string, unknown>) =>
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
      { openfga: true, tsfga: "refused" },
    );

  /**
   * `int()` has six overloads upstream — int, double, string,
   * uint, **duration** and **timestamp**. cel-js ships three, so
   * three of the six have no implementation to reach.
   *
   * `int(duration)` is nanoseconds and `int(timestamp)` is epoch
   * seconds, which is how a condition spells "how long" or "when"
   * as a number — the arithmetic a business-hours or expiry rule
   * is written in. `int(uint)` is the one a `uint` parameter runs
   * into first, because the carrier that makes `type(n) == uint`
   * true is what leaves the `int` overload unmatched.
   *
   * Measured against v1.18.2: upstream answers `true` for all
   * three and tsfga raises `ConditionEvaluationError`.
   */
  describe("int() of a timestamp, a duration or a uint", () => {
    test("int(timestamp) is epoch seconds upstream", async () => {
      await pin("it_c5", { t: "2026-01-01T00:00:00Z" });
    });

    test("int(duration) is nanoseconds upstream", async () => {
      await pin("id_c5", { d: "1h" });
    });

    test("int(string) still agrees", async () => {
      await check("is_c5", { s: "7" }, true);
    });

    test("int(uint) has no cel-js overload", async () => {
      await pin("iu_c5", { n: 7 });
    });
  });

  /**
   * The rest of the library, probed and found to agree. Recorded
   * so a later round does not re-sweep them, and so a fix for the
   * two gaps above cannot quietly break a neighbour.
   */
  describe("the rest of the standard library agrees", () => {
    // Ledger row R5. `string(timestamp)` and `string(duration)`
    // were registered here rather than supplied by cel-js, so the
    // agreement they used to record was tsfga's own formatting
    // agreeing with Go's, not the two libraries agreeing.
    test("string(timestamp) has no cel-js overload", async () => {
      await pin("st_c5", { t: "2026-01-01T00:00:00Z" });
    });

    test("timestamp(int) is epoch seconds on both", async () => {
      await check("ti_c5", { n: 1 }, true);
    });

    test("type()", async () => {
      await check("ty_c5", { n: 1 }, true);
    });

    test("bytes(string) and size(bytes)", async () => {
      await check("by_c5", { s: "abc" }, true);
    });

    test("bool(string)", async () => {
      await check("bo_c5", { s: "true" }, true);
    });

    test("the receiver spelling of size()", async () => {
      await check("sz_c5", { s: "abc" }, true);
    });
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./cel-stdlib/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
