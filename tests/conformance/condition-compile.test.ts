import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { WriteAuthorizationModelRequest } from "@openfga/sdk";
import { TypeName } from "@openfga/sdk";
import {
  ConditionCompileError,
  createTsfga,
  type TsfgaClient,
  TsfgaError,
} from "@tsfga/core";
import type { DB } from "@tsfga/kysely";
import { KyselyTupleStore } from "@tsfga/kysely";
import type { Kysely } from "kysely";
import { expectModelWriteConformance } from "./helpers/conformance.ts";
import {
  beginTransaction,
  destroyDb,
  getDb,
  rollbackTransaction,
} from "./helpers/db.ts";
import { fgaCreateStore, fgaWriteModelOutcome } from "./helpers/openfga.ts";
import { ungatedConfig, ungatedTuple } from "./helpers/ungated.ts";

/**
 * A condition expression that does not compile is refused where it
 * is written.
 *
 * OpenFGA compiles every condition as part of validating the model
 * write, so an expression that cannot be parsed never reaches a
 * check. tsfga accepted it at three points — the definition write,
 * every tuple write beneath it, and every check until someone ran
 * one — and then surfaced cel-js's own `ParseError`, which is not
 * a `TsfgaError`, so callers could not catch it by the documented
 * class.
 *
 * **Written through the model, not the DSL.** The syntax
 * transformer rejects these expressions before they can reach the
 * server, so the OpenFGA side of each case is a hand-built
 * authorization model.
 */

/** Expressions cel-js and OpenFGA both refuse to compile. */
const UNPARSEABLE = ["x +", "x ==", "((x", "x = 1", ""];

/**
 * A model whose only condition carries `expression`.
 *
 * The condition is referenced from a type restriction so that a
 * model omitting it would not be silently well-formed.
 */
function modelWith(expression: string): WriteAuthorizationModelRequest {
  return {
    schema_version: "1.1",
    type_definitions: [
      { type: "user", relations: {}, metadata: { relations: {} } },
      {
        type: "doc",
        relations: { viewer: { this: {} } },
        metadata: {
          relations: {
            viewer: {
              directly_related_user_types: [
                { type: "user", condition: "gate" },
              ],
            },
          },
        },
      },
    ],
    conditions: {
      gate: {
        name: "gate",
        expression,
        parameters: { x: { type_name: TypeName.Int } },
      },
    },
  };
}

describe("Condition Compilation Conformance", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let store: KyselyTupleStore;
  let tsfgaClient: TsfgaClient;

  beforeAll(async () => {
    db = getDb();
    await beginTransaction(db);
    store = new KyselyTupleStore(db);
    tsfgaClient = createTsfga(store);
    storeId = await fgaCreateStore("condition-compile-conformance");
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  for (const [i, expression] of UNPARSEABLE.entries()) {
    test(`both refuse to define ${JSON.stringify(expression)}`, async () => {
      await expectModelWriteConformance(
        storeId,
        modelWith(expression),
        () =>
          tsfgaClient.writeConditionDefinition({
            name: `gate_${i}`,
            expression,
            parameters: { x: "int" },
          }),
        "refused",
      );
    });
  }

  test("a compiling expression is accepted by both", async () => {
    const expression = "x > 3";
    const [, openFgaOutcome] = await Promise.all([
      tsfgaClient.writeConditionDefinition({
        name: "gate_ok",
        expression,
        parameters: { x: "int" },
      }),
      fgaWriteModelOutcome(storeId, modelWith(expression)),
    ]);
    expect(openFgaOutcome).toBe("accepted");
  });

  /**
   * Once a pinned divergence, now agreement.
   *
   * OpenFGA compiles against the declared parameters and rejects an
   * undeclared reference. cel-js only parsed, so the call was stored
   * and failed at evaluation -- pinned here so that a cel-js release
   * which started checking references would show up as a failing
   * test rather than a silent change.
   *
   * It was not a cel-js release that closed it. `compileCondition`
   * now type-checks against the declared parameters on a clone that
   * registers them as variables, which is what upstream does, so
   * both engines refuse the write. The pin has become the
   * conformance assertion it existed to wait for.
   */
  test("an undeclared reference is refused by both", async () => {
    const expression = "not_a_function(x)";
    const [tsfgaOutcome, openFgaOutcome] = await Promise.all([
      tsfgaClient
        .writeConditionDefinition({
          name: "gate_undeclared",
          expression,
          parameters: { x: "int" },
        })
        .then(() => "accepted" as const)
        .catch((error: unknown) => {
          if (error instanceof TsfgaError) return "refused" as const;
          throw error;
        }),
      fgaWriteModelOutcome(storeId, modelWith(expression)).then((outcome) =>
        outcome === "accepted" ? "accepted" : "refused",
      ),
    ]);

    expect(openFgaOutcome).toBe("refused");
    expect(tsfgaOutcome).toBe("refused");
  });

  /**
   * The error class, on the path the public API can no longer
   * reach. After the write refuses, the only way into this state
   * is through the store — which is also the state a database
   * written by an older version is in.
   */
  test("a stored unparseable definition raises a TsfgaError", async () => {
    await store.upsertConditionDefinition({
      name: "gate_stored",
      expression: "x +",
      parameters: { x: "int" },
    });
    await store.upsertRelationConfig(
      ungatedConfig({
        objectType: "doc",
        relation: "viewer",
        directlyAssignable: [{ type: "user", condition: "gate_stored" }],
        impliedBy: null,
        computedUserset: null,
        tupleToUserset: null,
        excludedBy: null,
        intersection: null,
      }),
    );
    await store.insertTuple(
      ungatedTuple({
        objectType: "doc",
        objectId: "00000000-0000-4000-ce00-000000000001",
        relation: "viewer",
        subjectType: "user",
        subjectId: "00000000-0000-4000-ce00-000000000002",
        conditionName: "gate_stored",
        conditionContext: { x: 1 },
      }),
    );

    const failure = tsfgaClient.check({
      objectType: "doc",
      objectId: "00000000-0000-4000-ce00-000000000001",
      relation: "viewer",
      subjectType: "user",
      subjectId: "00000000-0000-4000-ce00-000000000002",
    });
    await expect(failure).rejects.toBeInstanceOf(ConditionCompileError);
    await expect(failure).rejects.toBeInstanceOf(TsfgaError);
  });
});
