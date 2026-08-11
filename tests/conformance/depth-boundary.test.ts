import { afterAll, beforeAll, describe, test } from "bun:test";
import { createTsfga, type TsfgaClient } from "@tsfga/core";
import type { DB } from "@tsfga/kysely";
import { KyselyTupleStore } from "@tsfga/kysely";
import type { Kysely } from "kysely";
import {
  expectConformance,
  expectPinnedDivergence,
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
 * Where each engine stops resolving, pinned.
 *
 * tsfga exhausts its budget one dispatch earlier than OpenFGA on
 * most shapes, because upstream resolves the *terminal* hop in
 * place rather than dispatching for it: its weight-2 resolvers
 * require the target node to have weight 1 to the user type, which
 * is true only of the last hop.
 *
 * The offset is **not uniform**, which is why no constant
 * correction is right and why the budget is left alone. Give the
 * leaf relation a second arm and it stops being weight 1, upstream
 * declines its own resolver and dispatches for the terminal hop
 * like tsfga always does — and the two agree. A uniform `+1` would
 * make tsfga answer at `n = L` on that shape, where upstream
 * returns `too_complex`: a granting divergence introduced by a
 * parity fix.
 *
 * Both rows are asserted, so this goes red if the gap widens *or*
 * closes. Measurements and the full five-shape sweep are in
 * `tmp/improve-perf-v0.5.0/evidence/depth-boundary.md`.
 */

const LIMIT = 25;

const uuidMap = new Map<string, string>();
for (let i = 0; i <= LIMIT + 1; i++) {
  uuidMap.set(
    `d${i}`,
    `00000000-0000-4000-d300-${String(i).padStart(12, "0")}`,
  );
}
uuidMap.set("alice", "00000000-0000-4000-d300-0000000000ff");
uuidMap.set("side", "00000000-0000-4000-d300-0000000000fe");

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

describe("Depth Boundary Conformance", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let modelId: string;
  let tsfgaClient: TsfgaClient;

  beforeAll(async () => {
    db = getDb();
    await beginTransaction(db);

    const store = new KyselyTupleStore(db);
    tsfgaClient = createTsfga(store);

    const relation = (
      name: string,
      directlyAssignable: Array<{ type: string; relation?: string }>,
      tupleToUserset: Array<{
        tupleset: string;
        computedUserset: string;
      }> | null,
    ) => ({
      objectType: "doc",
      relation: name,
      directlyAssignable,
      impliedBy: null,
      computedUserset: null,
      tupleToUserset,
      excludedBy: null,
      intersection: null,
    });

    await tsfgaClient.writeRelationConfig(
      relation("parent", [{ type: "doc" }], null),
    );
    await tsfgaClient.writeRelationConfig(
      relation("other", [{ type: "doc" }], null),
    );
    await tsfgaClient.writeRelationConfig(
      relation("m", [{ type: "user" }], null),
    );
    await tsfgaClient.writeRelationConfig(
      relation(
        "plain",
        [{ type: "user" }],
        [{ tupleset: "parent", computedUserset: "plain" }],
      ),
    );
    await tsfgaClient.writeRelationConfig(
      relation(
        "leafw2",
        [{ type: "user" }],
        [
          { tupleset: "other", computedUserset: "m" },
          { tupleset: "parent", computedUserset: "leafw2" },
        ],
      ),
    );

    // One chain, long enough for both boundary probes.
    const rows: Array<Parameters<TsfgaClient["addTuple"]>[0]> = [];
    for (let i = 0; i <= LIMIT; i++) {
      rows.push({
        objectType: "doc",
        objectId: uuid(`d${i}`),
        relation: "parent",
        subjectType: "doc",
        subjectId: uuid(`d${i + 1}`),
      });
    }
    for (const leaf of ["plain", "leafw2"] as const) {
      rows.push({
        objectType: "doc",
        objectId: uuid(`d${LIMIT}`),
        relation: leaf,
        subjectType: "user",
        subjectId: uuid("alice"),
      });
    }
    for (const row of rows) await tsfgaClient.addTuple(row);

    storeId = await fgaCreateStore("depth-boundary-conformance");
    modelId = await fgaWriteModel(storeId, "./depth-boundary/model.dsl");
    await fgaWriteTuplesRaw(
      storeId,
      modelId,
      rows.map((row) => ({
        user: row.subjectRelation
          ? `${row.subjectType}:${row.subjectId}#${row.subjectRelation}`
          : `${row.subjectType}:${row.subjectId}`,
        relation: row.relation,
        object: `${row.objectType}:${row.objectId}`,
      })),
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  const from = (start: number, relation: string) => ({
    objectType: "doc",
    objectId: uuid(`d${start}`),
    relation,
    subjectType: "user",
    subjectId: uuid("alice"),
  });

  /**
   * `LIMIT - 1` hops from `d1`: inside both budgets. Without this
   * the divergence below could be satisfied by tsfga failing at
   * every depth.
   */
  test("one hop inside both budgets, both answer", async () => {
    await expectConformance(
      storeId,
      modelId,
      tsfgaClient,
      from(1, "plain"),
      true,
    );
  });

  /**
   * `LIMIT` hops. Upstream resolves the terminal hop in place and
   * answers; tsfga dispatches for it and exhausts.
   */
  test("at the limit, upstream answers where tsfga exhausts", async () => {
    await expectPinnedDivergence(
      storeId,
      modelId,
      tsfgaClient,
      from(0, "plain"),
      {
        openfga: true,
        tsfga: "refused",
      },
    );
  });

  /**
   * The same depth on a leaf that is not weight 1. Upstream
   * declines its own resolver here, so it dispatches for the
   * terminal hop as tsfga does and the offset disappears.
   *
   * This is the row that makes a uniform correction wrong: a `+1`
   * would answer here, where upstream refuses.
   */
  test("a weight-2 leaf removes the offset, and both exhaust", async () => {
    await expectConformance(
      storeId,
      modelId,
      tsfgaClient,
      from(0, "leafw2"),
      "refused",
    );
  });

  test("a weight-2 leaf one hop shallower, both answer", async () => {
    await expectConformance(
      storeId,
      modelId,
      tsfgaClient,
      from(1, "leafw2"),
      true,
    );
  });
});
