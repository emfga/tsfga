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
 * The two `uint` cells cel-js cannot express.
 *
 * cel-js has no `uint`. An `int` and a `uint` parameter both reach
 * CEL as a `bigint`, which is CEL's `int`, so a type test and a
 * bare `u`-suffixed literal cannot agree with upstream.
 * `Environment.registerType` makes a real `uint` reachable in
 * principle, so this is a judgement about cost rather than a
 * limit -- which is exactly why it needs pinning: a judgement can
 * be revisited, and an unpinned divergence silently becomes two.
 *
 * `packages/core/README.md` documents these under "Known
 * divergence: uint" and claims they are pinned. This is that pin.
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

  test("type(n) == uint is true upstream and false here", async () => {
    await expectPinnedDivergence(
      storeId,
      modelId,
      tsfgaClient,
      request("typed"),
      {
        openfga: true,
        tsfga: false,
      },
    );
  });

  test("a bare u-suffixed literal finds no overload here", async () => {
    await expectPinnedDivergence(
      storeId,
      modelId,
      tsfgaClient,
      request("suffixed"),
      { openfga: true, tsfga: "refused" },
    );
  });

  /**
   * The control, and the reason the divergence is narrow rather
   * than "uint is broken": an explicit conversion agrees.
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
