import { afterAll, beforeAll, describe, test } from "bun:test";
import {
  type ConditionParamTypeRef,
  TypeName,
  type WriteAuthorizationModelRequest,
} from "@openfga/sdk";
import { createTsfga, type TsfgaClient } from "@tsfga/core";
import type { DB } from "@tsfga/kysely";
import { KyselyTupleStore } from "@tsfga/kysely";
import type { Kysely } from "kysely";
import { expectPinnedModelWriteDivergence } from "./helpers/conformance.ts";
import {
  beginTransaction,
  destroyDb,
  getDb,
  rollbackTransaction,
} from "./helpers/db.ts";
import { fgaCreateStore } from "./helpers/openfga.ts";

/**
 * **Row RM: tsfga does not support `matches()`.**
 *
 * The single largest deliberate divergence between tsfga and
 * OpenFGA, and the only one whose direction is *refusing at the
 * model write*: upstream stores a condition calling `matches()`
 * and answers checks against it forever, and tsfga will not store
 * it at all.
 *
 * It is not a fourth refusal. `matches` is one entry removed from
 * each of `CEL_GO_MEMBER_CALLS` and `CEL_GO_GLOBAL_CALLS` — cel-go
 * declares both spellings — so the declaration allow-list that
 * already refuses `split` and `substring` refuses it too, by name,
 * at the earliest and loudest moment there is.
 *
 * **Why the whole feature rather than the bad patterns.** cel-go's
 * `matches` is RE2 and cel-js's is a JavaScript `RegExp`. A
 * write-time deny-list refusing what RE2 rejects was authorised
 * and then abandoned, because it closed one of three groups:
 * constructs RE2 *accepts* and JavaScript reads differently
 * (`[[:alnum:]]`, `\A`, `\Q`, `\s`) passed straight through it, a
 * pattern arriving through condition context could not be
 * inspected at all, and catastrophic backtracking was untouched by
 * it. `docs/cel-js/` carries the measurements.
 *
 * **`tsfgaCause` is asserted here and almost nowhere else.** Three
 * write-time gates all surface as `"refused"` — the allow-list,
 * the type check, and a parse failure — so a pin that fires for
 * the wrong one is indistinguishable from a pin that fires for the
 * right one, *and it would keep passing if `matches` were quietly
 * re-declared*. This is the cell where a wrong-reason pass would
 * hide the reintroduction of regex support, so it names the reason.
 */

/** A model whose only condition carries `expression`. */
function modelWith(
  expression: string,
  parameters: Record<string, ConditionParamTypeRef>,
): WriteAuthorizationModelRequest {
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
      gate: { name: "gate", expression, parameters },
    },
  };
}

const STRING = { type_name: TypeName.String };

describe("RM: matches() is refused at the model write", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let tsfgaClient: TsfgaClient;

  beforeAll(async () => {
    db = getDb();
    await beginTransaction(db);
    tsfgaClient = createTsfga(new KyselyTupleStore(db));
    storeId = await fgaCreateStore("cel-matches-conformance");
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  /**
   * The canonical cell, and the one `actions` lost its branch
   * rule to. The pattern is *tuple context data* there, which is
   * how a real environment protection rule is written and which no
   * write-time inspection could ever have reached.
   */
  test("RM: a pattern supplied as data", async () => {
    await expectPinnedModelWriteDivergence(
      storeId,
      modelWith("branch.matches(pattern)", {
        branch: STRING,
        pattern: STRING,
      }),
      () =>
        tsfgaClient.writeConditionDefinition({
          name: "rm_data_pattern",
          expression: "branch.matches(pattern)",
          parameters: { branch: "string", pattern: "string" },
        }),
      { openfga: "accepted", tsfga: "refused" },
      { tsfgaCause: "undeclared reference to 'matches'" },
    );
  });

  /**
   * A pattern every engine agrees about, refused anyway. The
   * refusal is on the *call*, not on the pattern — there is no
   * code in tsfga that reads a pattern, so a portable one is
   * refused exactly as an unportable one is.
   */
  test("RM: a wholly portable literal pattern", async () => {
    await expectPinnedModelWriteDivergence(
      storeId,
      modelWith('s.matches("^ward-[0-9]+$")', { s: STRING }),
      () =>
        tsfgaClient.writeConditionDefinition({
          name: "rm_portable_pattern",
          expression: 's.matches("^ward-[0-9]+$")',
          parameters: { s: "string" },
        }),
      { openfga: "accepted", tsfga: "refused" },
      { tsfgaCause: "undeclared reference to 'matches'" },
    );
  });

  /**
   * The refusal is not per-branch. cel-js short-circuits, so an
   * unreachable `matches()` would never evaluate — but the
   * allow-list runs over the whole parsed expression, so the
   * definition does not store whatever the surrounding logic does.
   * That is the point of refusing at the write: there is no
   * arrangement of operands that smuggles a pattern in.
   */
  test("RM: even behind a short-circuit that never reaches it", async () => {
    const expression = 'true || s.matches("^a+$")';
    await expectPinnedModelWriteDivergence(
      storeId,
      modelWith(expression, { s: STRING }),
      () =>
        tsfgaClient.writeConditionDefinition({
          name: "rm_short_circuit",
          expression,
          parameters: { s: "string" },
        }),
      { openfga: "accepted", tsfga: "refused" },
      { tsfgaCause: "undeclared reference to 'matches'" },
    );
  });

  /**
   * And inside a comprehension body, which is an `rcall` node
   * carrying its body in the argument list. The allow-list's walk
   * descends there on purpose; a walk that took only the receiver
   * would leave every macro body ungated, and this cell is what
   * says so.
   */
  test("RM: and inside a comprehension body", async () => {
    const expression = 'l.exists(x, x.matches("^a+$"))';
    await expectPinnedModelWriteDivergence(
      storeId,
      modelWith(expression, {
        l: {
          type_name: TypeName.List,
          generic_types: [{ type_name: TypeName.String }],
        },
      }),
      () =>
        tsfgaClient.writeConditionDefinition({
          name: "rm_comprehension",
          expression,
          parameters: { l: "list<string>" },
        }),
      { openfga: "accepted", tsfga: "refused" },
      { tsfgaCause: "undeclared reference to 'matches'" },
    );
  });

  /**
   * The global spelling, which cel-go declares beside the receiver
   * one. It was once a divergence of its own: it resolved upstream
   * and refused here, for a different reason — cel-js declares only
   * the receiver form. Both spellings are now one refusal, which is the simplification dropping the feature
   * bought.
   */
  test("RM: the global spelling too", async () => {
    const expression = "matches(s, p)";
    await expectPinnedModelWriteDivergence(
      storeId,
      modelWith(expression, { s: STRING, p: STRING }),
      () =>
        tsfgaClient.writeConditionDefinition({
          name: "rm_global_spelling",
          expression,
          parameters: { s: "string", p: "string" },
        }),
      { openfga: "accepted", tsfga: "refused" },
      { tsfgaCause: "undeclared reference to 'matches'" },
    );
  });
});
