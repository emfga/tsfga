import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { TypeName } from "@openfga/sdk";
import {
  type ConditionDefinition,
  createTsfga,
  type TsfgaClient,
  TsfgaError,
} from "@tsfga/core";
import type { DB } from "@tsfga/kysely";
import { KyselyTupleStore } from "@tsfga/kysely";
import type { Kysely } from "kysely";
import {
  expectConfigsMatchModel,
  expectConformance,
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
  fgaWriteModelOutcome,
  fgaWriteTuplesRaw,
} from "./helpers/openfga.ts";

/**
 * The name gate, on the two names it does not otherwise reach.
 *
 * `writeRelationConfig` gates a relation config's own `objectType`
 * and `relation` against the protobuf field patterns upstream applies
 * to a model write — `^[^:#@\s]{1,254}$` and `^[^:#@\s]{1,50}$`.
 * A model carries two more name fields under the *same* class and
 * the *same* 50-code-point bound, both reached through
 * `writeConditionDefinition`, which applies no name rule at all:
 *
 * - `Condition.name`, and
 * - each key of `Condition.parameters`.
 *
 * Measured on v1.18.2, `WriteAuthorizationModel` answers
 * `invalid Condition.Name: value does not match regex pattern
 * "^[^:#@\s]{1,50}$"` for the first and
 * `invalid Condition.Parameters[…]` for the second, which is how
 * the bound on a parameter name was found at all: the size suite
 * beside this one tried a 203-byte parameter and was refused.
 *
 * Every case is stated as a pair — the largest legal name beside
 * the smallest illegal one — so the bound is asserted rather than
 * assumed.
 */

const ALICE = "00000000-0000-4000-d4e2-000000000001";
const DOC = "00000000-0000-4000-d4e2-000000000002";

/** A condition name of exactly `n` code points. */
function name(n: number): string {
  return `c${"n".repeat(n - 1)}`;
}

describe("Condition Name Conformance", () => {
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
      name: "ok_c2n",
      expression: 's != "zzz"',
      parameters: { s: "string" },
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "doc_c2n",
      relation: "viewer",
      directlyAssignable: [{ type: "user_c2n", condition: "ok_c2n" }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.addTuple({
      objectType: "doc_c2n",
      objectId: DOC,
      relation: "viewer",
      subjectType: "user_c2n",
      subjectId: ALICE,
      conditionName: "ok_c2n",
      conditionContext: { s: "ok" },
    });

    storeId = await fgaCreateStore("model-name-fields-conformance");
    authorizationModelId = await fgaWriteModel(
      storeId,
      "./model-name-fields/model.dsl",
    );
    await fgaWriteTuplesRaw(storeId, authorizationModelId, [
      {
        user: `user_c2n:${ALICE}`,
        relation: "viewer",
        object: `doc_c2n:${DOC}`,
        condition: { name: "ok_c2n", context: { s: "ok" } },
      },
    ]);
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  /** Whether upstream stores a model carrying this condition. */
  async function upstreamAccepts(
    conditionName: string,
    parameter: string,
  ): Promise<"accepted" | "refused"> {
    const outcome = await fgaWriteModelOutcome(storeId, {
      schema_version: "1.1",
      type_definitions: [
        { type: "user_c2n", relations: {}, metadata: undefined },
        {
          type: "gate_c2n",
          relations: { viewer: { this: {} } },
          metadata: {
            relations: {
              viewer: {
                directly_related_user_types: [
                  { type: "user_c2n", condition: conditionName },
                ],
              },
            },
          },
        },
      ],
      conditions: {
        [conditionName]: {
          name: conditionName,
          expression: "true",
          parameters: { [parameter]: { type_name: TypeName.String } },
        },
      },
    });
    return outcome === "accepted" ? "accepted" : "refused";
  }

  /** Whether tsfga stores the same condition. */
  async function tsfgaAccepts(
    definition: ConditionDefinition,
  ): Promise<"accepted" | "refused"> {
    return tsfgaClient
      .writeConditionDefinition(definition)
      .then(() => "accepted" as const)
      .catch((error: unknown) => {
        if (error instanceof TsfgaError) return "refused" as const;
        throw error;
      });
  }

  async function expectBoth(
    conditionName: string,
    parameter: string,
    expected: "accepted" | "refused",
  ): Promise<void> {
    const [upstream, tsfga] = await Promise.all([
      upstreamAccepts(conditionName, parameter),
      tsfgaAccepts({
        name: conditionName,
        expression: "true",
        parameters: { [parameter]: "string" },
      }),
    ]);
    expect(tsfga).toBe(upstream);
    expect(tsfga).toBe(expected);
  }

  // --- the control, which both engines take ----------------------

  test("a 50-code-point condition name is stored by both", async () => {
    await expectBoth(name(50), "p", "accepted");
  });

  test("a 50-code-point parameter name is stored by both", async () => {
    await expectBoth("ok50_c2n", name(50), "accepted");
  });

  test("the fixture's own condition still answers", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "doc_c2n",
        objectId: DOC,
        relation: "viewer",
        subjectType: "user_c2n",
        subjectId: ALICE,
      },
      true,
    );
  });

  // --- the gate that is not there --------------------------------

  test("a 51-code-point condition name is stored", async () => {
    await expectBoth(name(51), "p", "refused");
  });

  test("a condition name holding a `#` is stored", async () => {
    await expectBoth("bad#name_c2n", "p", "refused");
  });

  test("a condition name holding a space is stored", async () => {
    await expectBoth("bad name_c2n", "p", "refused");
  });

  test("a condition name holding a `:` is stored", async () => {
    await expectBoth("bad:name_c2n", "p", "refused");
  });

  test("an empty condition name is stored", async () => {
    await expectBoth("", "p", "refused");
  });

  test("a 51-code-point parameter name is stored", async () => {
    await expectBoth("ok51_c2n", name(51), "refused");
  });

  test("a parameter name holding a `:` is stored", async () => {
    await expectBoth("okcolon_c2n", "bad:p", "refused");
  });

  test("the fixture's configs match its model", () => {
    expectConfigsMatchModel("./model-name-fields/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
