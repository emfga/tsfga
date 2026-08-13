import { afterAll, beforeAll, describe, test } from "bun:test";
import { createTsfga, type TsfgaClient } from "@tsfga/core";
import type { DB } from "@tsfga/kysely";
import { KyselyTupleStore } from "@tsfga/kysely";
import type { Kysely } from "kysely";
import { expectConformance } from "./helpers/conformance.ts";
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
 * The three `uint` cells that used to be a divergence.
 *
 * A `uint` parameter used to reach CEL as a `bigint`, which is
 * CEL's `int`, so a type test and a bare `u`-suffixed literal
 * could not agree with upstream and the arithmetic was bounded by
 * int64 rather than uint64. cel-js does have a `uint` — its
 * `UnsignedInt`, reachable through `uint()` — and the coercion now
 * carries one, which closed all four cells at once: these two and
 * the two matching rows in `cel-numeric.test.ts`.
 *
 * The one thing the carrier costs is `int(n)` on a `uint`, for
 * which cel-js has no overload and tsfga supplies none — see
 * `docs/cel-js/` for the gap and why it is not repaired here.
 *
 * The file keeps its name and its cells so the history stays
 * legible: these are the exact three requests the pin used to
 * cover.
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

const CONDITIONS = [
  ["typed", "typed_c", "type(n) == uint"],
  ["suffixed", "suffixed_c", "n + 1u == 8u"],
  ["converted", "converted_c", "uint(n) + 1u == 8u"],
] as const;

describe("uint Divergence", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let modelId: string;
  let tsfgaClient: TsfgaClient;

  beforeAll(async () => {
    db = getDb();
    await beginTransaction(db);

    const store = new KyselyTupleStore(db);
    tsfgaClient = createTsfga(store);

    for (const [relation, condition, expression] of CONDITIONS) {
      await tsfgaClient.writeConditionDefinition({
        name: condition,
        expression,
        parameters: { n: "uint" },
      });
      await tsfgaClient.writeRelationConfig({
        objectType: "doc",
        relation,
        directlyAssignable: [{ type: "user", condition }],
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
        conditionName: condition,
      });
    }

    storeId = await fgaCreateStore("uint-divergence-conformance");
    modelId = await fgaWriteModel(storeId, "./uint-divergence/model.dsl");
    await fgaWriteTuplesRaw(
      storeId,
      modelId,
      CONDITIONS.map(([relation, condition]) => ({
        user: `user:${uuid("alice")}`,
        relation,
        object: `doc:${uuid("doc")}`,
        condition: { name: condition },
      })),
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  const request = (relation: string) => ({
    objectType: "doc",
    objectId: uuid("doc"),
    relation,
    subjectType: "user",
    subjectId: uuid("alice"),
    context: { n: "7" },
  });

  test("the value's CEL type is uint", async () => {
    await expectConformance(
      storeId,
      modelId,
      tsfgaClient,
      request("typed"),
      true,
    );
  });

  test("a bare u-suffixed literal finds its overload", async () => {
    await expectConformance(
      storeId,
      modelId,
      tsfgaClient,
      request("suffixed"),
      true,
    );
  });

  /**
   * The cell that already agreed under the old carrier, and the
   * reason the divergence was narrow rather than "uint is broken".
   */
  test("an explicit uint() conversion agrees", async () => {
    await expectConformance(
      storeId,
      modelId,
      tsfgaClient,
      request("converted"),
      true,
    );
  });
});
