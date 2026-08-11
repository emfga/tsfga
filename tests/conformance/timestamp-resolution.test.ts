import { afterAll, beforeAll, describe, test } from "bun:test";
import { createTsfga, type TsfgaClient } from "@tsfga/core";
import type { DB } from "@tsfga/kysely";
import { KyselyTupleStore } from "@tsfga/kysely";
import type { Kysely } from "kysely";
import {
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
 * What a CEL timestamp can still say once tsfga has read it.
 *
 * Go's `time.Time` is nanosecond-resolution and cel-js maps a CEL
 * timestamp onto a JS `Date`, which is millisecond. Everything
 * finer is discarded — on the context value *and* on the
 * `timestamp('…')` literal the expression compares it against —
 * and neither engine errors, so the two answer different booleans.
 * Two of the four cells are in the granting direction: under an
 * equality predicate a truncated value compares *equal* here and
 * unequal upstream.
 *
 * The resolution is not reachable through `@marcbachmann/cel-js`
 * 8.0.0. `Environment.registerType` will take a nanosecond carrier,
 * but the built-in constructor cannot be displaced —
 * `registerFunction("timestamp(string): …")` throws *"overlaps with
 * existing overload 'timestamp(string): google.protobuf.Timestamp'"*
 * — and the standard library cannot be declined, so the literal
 * side truncates whatever the context side carries. The ~30
 * timestamp accessors and the duration arithmetic are defined over
 * `Date` as well, so a carrier that did work would have to
 * re-implement all of them or trade four cells for a wider
 * fail-closed surface. Documented in `packages/core/README.md`
 * instead, and pinned here on both sides so a cel-js release that
 * changes the resolution is a failing test rather than a silent
 * change of answer.
 */

const uuidMap = new Map<string, string>([
  ["alice", "00000000-0000-4000-cf00-000000000001"],
  ["doc", "00000000-0000-4000-cf00-000000000010"],
]);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

const AT_SECOND = "2026-01-01T00:00:00Z";

const CONDITIONS = [
  { name: "eq_nano_c", expression: `n == timestamp('${AT_SECOND}')` },
  { name: "eq_micro_c", expression: `n == timestamp('${AT_SECOND}')` },
  { name: "gt_half_ms_c", expression: `n > timestamp('${AT_SECOND}')` },
  {
    name: "gt_nano_c",
    expression: "n > timestamp('2026-01-01T00:00:00.000000000Z')",
  },
  { name: "ctl_ms_c", expression: `n > timestamp('${AT_SECOND}')` },
  { name: "ctl_exact_c", expression: `n == timestamp('${AT_SECOND}')` },
] as const;

describe("Timestamp Resolution Conformance", () => {
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

    for (const condition of CONDITIONS) {
      await tsfgaClient.writeConditionDefinition({
        name: condition.name,
        expression: condition.expression,
        parameters: { n: "timestamp" },
      });
      const relation = condition.name.replace(/_c$/, "");
      await tsfgaClient.writeRelationConfig({
        objectType: "doc",
        relation,
        directlyAssignable: [{ type: "user", condition: condition.name }],
        impliedBy: null,
        computedUserset: null,
        tupleToUserset: null,
        excludedBy: null,
        intersection: null,
      });
      await tsfgaClient.addTuple({
        objectType: "doc",
        objectId: uuid("doc"),
        relation,
        subjectType: "user",
        subjectId: uuid("alice"),
        conditionName: condition.name,
      });
    }

    storeId = await fgaCreateStore("timestamp-resolution-conformance");
    modelId = await fgaWriteModel(storeId, "./timestamp-resolution/model.dsl");
    await fgaWriteTuplesRaw(
      storeId,
      modelId,
      CONDITIONS.map((condition) => ({
        user: `user:${uuid("alice")}`,
        relation: condition.name.replace(/_c$/, ""),
        object: `doc:${uuid("doc")}`,
        condition: { name: condition.name },
      })),
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  const request = (relation: string, n: string) => ({
    objectType: "doc",
    objectId: uuid("doc"),
    relation,
    subjectType: "user",
    subjectId: uuid("alice"),
    context: { n },
  });

  const pin = (
    relation: string,
    n: string,
    expected: { openfga: boolean; tsfga: boolean },
  ) =>
    expectPinnedDivergence(
      storeId,
      modelId,
      tsfgaClient,
      request(relation, n),
      expected,
    );

  describe("sub-millisecond precision is discarded", () => {
    test("a nanosecond past the second compares equal to it", async () => {
      // Granting: tsfga reads the condition as met.
      await pin("eq_nano", "2026-01-01T00:00:00.000000001Z", {
        openfga: false,
        tsfga: true,
      });
    });

    test("a microsecond past the second compares equal to it", async () => {
      // Granting.
      await pin("eq_micro", "2026-01-01T00:00:00.000001Z", {
        openfga: false,
        tsfga: true,
      });
    });

    test("half a millisecond past the second is not past it", async () => {
      await pin("gt_half_ms", "2026-01-01T00:00:00.0005Z", {
        openfga: true,
        tsfga: false,
      });
    });

    test("half a microsecond past a nanosecond bound is not past it", async () => {
      await pin("gt_nano", "2026-01-01T00:00:00.000000500Z", {
        openfga: true,
        tsfga: false,
      });
    });
  });

  /**
   * The boundary. Everything at millisecond resolution or coarser
   * agrees, which is what makes the divergence narrow enough to
   * document rather than a reason to distrust every timestamp
   * condition.
   */
  describe("millisecond resolution and coarser agrees", () => {
    test("two milliseconds past the second is past it", async () => {
      await expectConformance(
        storeId,
        modelId,
        tsfgaClient,
        request("ctl_ms", "2026-01-01T00:00:00.002Z"),
        true,
      );
    });

    test("the second itself compares equal", async () => {
      await expectConformance(
        storeId,
        modelId,
        tsfgaClient,
        request("ctl_exact", AT_SECOND),
        true,
      );
    });
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./timestamp-resolution/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
