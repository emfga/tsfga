import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { WriteAuthorizationModelRequest } from "@openfga/sdk";
import { transformer } from "@openfga/syntax-transformer";
import { createTsfga, type TsfgaClient, TsfgaError } from "@tsfga/core";
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
 * The name gate on `writeConditionDefinition`, which reuses the
 * relation-name predicate: the character class `[^:#@\s]` and a
 * bound of 50 code points.
 *
 * This file attacks it from the over-refusal side. A name upstream
 * stores and tsfga refuses is an outage on a model that is
 * perfectly valid — and the bound in particular is a transcription
 * from upstream, so it is measured here rather than trusted.
 *
 * The model is built through the DSL transformer and then renamed
 * in the JSON, so the name reaching the server is exactly the one
 * tsfga is given and the DSL's own lexer never gets a vote.
 */

const BASE_DSL = `model
  schema 1.1

type user_d1n

type doc_d1n
  relations
    define viewer: [user_d1n with placeholder]

condition placeholder(p: int) {
  p > 0
}
`;

function modelWithNames(
  conditionName: string,
  parameterName: string,
): WriteAuthorizationModelRequest {
  const model = transformer.transformDSLToJSONObject(BASE_DSL);
  const json = JSON.parse(JSON.stringify(model));
  const conditions = json.conditions ?? {};
  const placeholder = conditions.placeholder;
  delete conditions.placeholder;
  placeholder.name = conditionName;
  placeholder.parameters = { [parameterName]: { type_name: "TYPE_NAME_INT" } };
  placeholder.expression = `${parameterName} > 0`;
  conditions[conditionName] = placeholder;
  json.conditions = conditions;
  for (const typeDef of json.type_definitions ?? []) {
    const metadata = typeDef.metadata?.relations?.viewer;
    for (const ref of metadata?.directly_related_user_types ?? []) {
      if (ref.condition === "placeholder") ref.condition = conditionName;
    }
  }
  return json;
}

describe("condition name gate: over-refusal sweep", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let tsfgaClient: TsfgaClient;

  beforeAll(async () => {
    db = getDb();
    await beginTransaction(db);
    tsfgaClient = createTsfga(new KyselyTupleStore(db));
    storeId = await fgaCreateStore("condition-names");
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  async function tsfgaWrite(
    conditionName: string,
    parameterName: string,
  ): Promise<"accepted" | "refused"> {
    try {
      await tsfgaClient.writeConditionDefinition({
        name: conditionName,
        expression: `${parameterName} > 0`,
        parameters: { [parameterName]: "int" },
      });
      return "accepted";
    } catch (error) {
      if (error instanceof TsfgaError) return "refused";
      throw error;
    }
  }

  async function upstreamWrite(
    conditionName: string,
    parameterName: string,
  ): Promise<"accepted" | "refused"> {
    const outcome = await fgaWriteModelOutcome(
      storeId,
      modelWithNames(conditionName, parameterName),
    );
    return outcome === "accepted" ? "accepted" : "refused";
  }

  const agree = async (conditionName: string, parameterName = "p") => {
    const [tsfga, upstream] = await Promise.all([
      tsfgaWrite(conditionName, parameterName),
      upstreamWrite(conditionName, parameterName),
    ]);
    expect(tsfga).toBe(upstream);
  };

  test("an ordinary name", async () => {
    await agree("weekday_only_d1n");
  });

  test("a name with a dot and a dash", async () => {
    await agree("d1n.weekday-only");
  });

  test("a name of non-ASCII letters", async () => {
    await agree("d1n_horário");
  });

  test("a name of exactly 50 code points", async () => {
    await agree(`d1n${"a".repeat(47)}`);
  });

  test("a name of 51 code points", async () => {
    await agree(`d1n${"b".repeat(48)}`);
  });

  test("a name of 100 code points", async () => {
    await agree(`d1n${"c".repeat(97)}`);
  });

  test("a name of 254 code points", async () => {
    await agree(`d1n${"d".repeat(251)}`);
  });

  test("a parameter name of exactly 50 code points", async () => {
    await agree("d1n_p50", `p${"a".repeat(49)}`);
  });

  test("a parameter name of 51 code points", async () => {
    await agree("d1n_p51", `p${"b".repeat(50)}`);
  });

  test("a parameter name with a dollar sign", async () => {
    await agree("d1n_pdollar", "p_x");
  });
});
