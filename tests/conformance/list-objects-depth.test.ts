import { afterAll, beforeAll, describe, test } from "bun:test";
import { createTsfga, type TsfgaClient } from "@tsfga/core";
import { type DB, KyselyTupleStore } from "@tsfga/kysely";
import type { Kysely } from "kysely";
import {
  expectListObjectsConformance,
  expectPinnedListObjectsDivergence,
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
 * `listObjects` over chains at and past the resolve-node budget.
 *
 * `depth-boundary.test.ts` pins where a single `check` stops on
 * this shape. The question here is different: `listObjects`
 * answers with a *set*, and every object on the chain is a
 * candidate. Whether one candidate past the budget costs only
 * itself or costs the entire answer is a decision neither engine
 * documents, so it is asked directly.
 *
 * Two chains, on two types, so the answer is not confounded:
 * `doc_a4d` is one hop inside tsfga's budget and must agree
 * exactly, `deep_a4d` is one hop past it.
 */

const INSIDE = 24;
const OVER = 25;

const uuidMap = new Map<string, string>();
for (let i = 0; i <= OVER; i++) {
  uuidMap.set(
    `d${i}`,
    `00000000-0000-4000-d430-1${String(i).padStart(11, "0")}`,
  );
  uuidMap.set(
    `e${i}`,
    `00000000-0000-4000-d430-2${String(i).padStart(11, "0")}`,
  );
}
uuidMap.set("alice", "00000000-0000-4000-d430-1000000000ff");

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

describe("listObjects depth parity", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let modelId: string;
  let tsfgaClient: TsfgaClient;

  beforeAll(async () => {
    db = getDb();
    await beginTransaction(db);

    tsfgaClient = createTsfga(new KyselyTupleStore(db));

    for (const objectType of ["doc_a4d", "deep_a4d"]) {
      await tsfgaClient.writeRelationConfig({
        objectType,
        relation: "parent",
        directlyAssignable: [{ type: objectType }],
        impliedBy: null,
        computedUserset: null,
        tupleToUserset: null,
        excludedBy: null,
        intersection: null,
      });
      await tsfgaClient.writeRelationConfig({
        objectType,
        relation: "plain",
        directlyAssignable: [{ type: "user_a4d" }],
        impliedBy: null,
        computedUserset: null,
        tupleToUserset: [{ tupleset: "parent", computedUserset: "plain" }],
        excludedBy: null,
        intersection: null,
      });
    }

    const rows: Array<Parameters<TsfgaClient["addTuple"]>[0]> = [];
    const chain = (objectType: string, prefix: string, hops: number): void => {
      for (let i = 0; i < hops; i++) {
        rows.push({
          objectType,
          objectId: uuid(`${prefix}${i}`),
          relation: "parent",
          subjectType: objectType,
          subjectId: uuid(`${prefix}${i + 1}`),
        });
      }
      rows.push({
        objectType,
        objectId: uuid(`${prefix}${hops}`),
        relation: "plain",
        subjectType: "user_a4d",
        subjectId: uuid("alice"),
      });
    };
    chain("doc_a4d", "d", INSIDE);
    chain("deep_a4d", "e", OVER);

    for (const row of rows) await tsfgaClient.addTuple(row);

    storeId = await fgaCreateStore("list-objects-depth-conformance");
    modelId = await fgaWriteModel(storeId, "./list-objects-depth/model.dsl");
    await fgaWriteTuplesRaw(
      storeId,
      modelId,
      rows.map((row) => ({
        user: `${row.subjectType}:${row.subjectId}`,
        relation: row.relation,
        object: `${row.objectType}:${row.objectId}`,
      })),
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  /**
   * The control. Every object on this chain is reachable inside
   * both budgets, so an engine that refused `listObjects` on deep
   * chains outright cannot pass here.
   */
  test("a chain one hop inside the budget: every object, both engines", async () => {
    const expected: string[] = [];
    for (let i = 0; i <= INSIDE; i++) expected.push(uuid(`d${i}`));
    await expectListObjectsConformance(
      storeId,
      modelId,
      tsfgaClient,
      {
        objectType: "doc_a4d",
        relation: "plain",
        subjectType: "user_a4d",
        subjectId: uuid("alice"),
      },
      expected,
    );
  });

  /**
   * One hop further. Upstream's reverse expansion walks outward
   * from the subject and reports every object on the chain; tsfga
   * runs a `check` per candidate, and the single candidate that
   * exhausts the budget is dropped rather than costing the answer.
   * So the divergence is one object wide, not the whole set — the
   * pinned depth offset (`depth-boundary.test.ts`) read through a
   * result set instead of through a single cell.
   */
  test("a chain one hop past the budget", async () => {
    const openfga: string[] = [];
    for (let i = 0; i <= OVER; i++) openfga.push(uuid(`e${i}`));
    await expectPinnedListObjectsDivergence(
      storeId,
      modelId,
      tsfgaClient,
      {
        objectType: "deep_a4d",
        relation: "plain",
        subjectType: "user_a4d",
        subjectId: uuid("alice"),
      },
      // Every object but `e0`, the one whose distance from the
      // grant is the whole chain. The control above shows the
      // budget reaches exactly one hop less far than upstream's.
      { openfga, tsfga: openfga.slice(1) },
    );
  });
});
