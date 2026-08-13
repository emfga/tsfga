import { afterAll, beforeAll, describe, test } from "bun:test";
import type { TsfgaClient } from "@tsfga/core";
import type { DB } from "@tsfga/kysely";
import type { Kysely } from "kysely";
import {
  expectConfigsMatchModel,
  expectListObjectsConformance,
  type FixtureRecord,
} from "./helpers/conformance.ts";
import { MATRIX_HELPERS, MATRIX_MOVED } from "./listobjects-matrix/configs.ts";
import {
  assertionExpectation,
  assertionRequest,
  createCaseStore,
  INVALID_CONTEXT,
  type MatrixCase,
  removeCaseTuples,
  setupMatrix,
  teardownMatrix,
  VALID_CONTEXT,
  writeCaseTuples,
} from "./listobjects-matrix/harness.ts";

/**
 * OpenFGA's `tests/listobjects/matrix_directs.go`, ported verbatim.
 *
 * Every tuple, every request and every expected object set is
 * transcribed from upstream; only the type names carry this
 * fixture's `_b4` suffix and the ids are UUIDs. The expectations are
 * therefore upstream's own claim about what `listObjects` returns,
 * asserted against both engines at once.
 */

const D = "directs_b4";
const DE = "directs_employee_b4";
const U = "user_b4";
const E = "employee_b4";
const COND = "xcond_b4";

const CASES: MatrixCase[] = [
  {
    name: "directs_direct_assignment",
    tuples: [
      { object: `${D}:direct_1_1`, relation: "direct", user: `${U}:direct_1` },
      { object: `${D}:direct_1_2`, relation: "direct", user: `${U}:direct_1` },
    ],
    assertions: [
      {
        user: `${U}:direct_1`,
        type: D,
        relation: "direct",
        expect: [`${D}:direct_1_1`, `${D}:direct_1_2`],
      },
      {
        user: `${U}:direct_no_such_user`,
        type: D,
        relation: "direct",
        expect: [],
      },
    ],
  },
  {
    name: "directs_one_terminal_type_wildcard_and_conditions",
    tuples: [
      {
        object: `${D}:wildcard_and_condition_1`,
        relation: "direct_comb",
        user: `${U}:direct_comb_1`,
      },
      {
        object: `${D}:wildcard_and_condition_2`,
        relation: "direct_comb",
        user: `${U}:*`,
      },
      {
        object: `${D}:wildcard_and_condition_3`,
        relation: "direct_comb",
        user: `${U}:direct_comb_1`,
        condition: COND,
      },
      {
        object: `${D}:wildcard_and_condition_4`,
        relation: "direct_comb",
        user: `${U}:*`,
        condition: COND,
      },
    ],
    assertions: [
      {
        user: `${U}:direct_comb_1`,
        type: D,
        relation: "direct_comb",
        context: VALID_CONTEXT,
        expect: [
          `${D}:wildcard_and_condition_1`,
          `${D}:wildcard_and_condition_2`,
          `${D}:wildcard_and_condition_3`,
          `${D}:wildcard_and_condition_4`,
        ],
      },
      {
        user: `${U}:direct_comb_1`,
        type: D,
        relation: "direct_comb",
        context: INVALID_CONTEXT,
        expect: [
          `${D}:wildcard_and_condition_1`,
          `${D}:wildcard_and_condition_2`,
        ],
      },
    ],
  },
  {
    name: "directs_multiple_terminal_types",
    tuples: [
      {
        object: `${D}:mult_types_1`,
        relation: "direct_mult_types",
        user: `${E}:mult_types_1`,
      },
      {
        object: `${D}:mult_types_2`,
        relation: "direct_mult_types",
        user: `${E}:*`,
      },
      {
        object: `${D}:mult_types_3`,
        relation: "direct_mult_types",
        user: `${U}:mult_types_1`,
      },
      {
        object: `${D}:mult_types_4`,
        relation: "direct_mult_types",
        user: `${U}:*`,
      },
    ],
    assertions: [
      {
        user: `${U}:mult_types_1`,
        type: D,
        relation: "direct_mult_types",
        expect: [`${D}:mult_types_3`, `${D}:mult_types_4`],
      },
      {
        user: `${E}:mult_types_1`,
        type: D,
        relation: "direct_mult_types",
        expect: [`${D}:mult_types_1`, `${D}:mult_types_2`],
      },
    ],
  },
  {
    name: "directs_algebraic_expression_multiple_terminal_types",
    tuples: [
      // Both returned if valid condition context, otherwise neither
      {
        object: `${D}:alg_expr_1`,
        relation: "direct",
        user: `${U}:alg_expr_1`,
      },
      {
        object: `${D}:alg_expr_1`,
        relation: "other_rel",
        user: `${U}:*`,
        condition: COND,
      },
      {
        object: `${D}:alg_expr_2`,
        relation: "direct_mult_types",
        user: `${U}:alg_expr_1`,
      },
      {
        object: `${D}:alg_expr_2`,
        relation: "other_rel",
        user: `${U}:*`,
        condition: COND,
      },
      // returned for this employee
      {
        object: `${D}:alg_expr_2`,
        relation: "direct_mult_types",
        user: `${E}:*`,
      },
      {
        object: `${D}:alg_expr_2`,
        relation: "other_rel",
        user: `${E}:alg_expr_1`,
      },
      // Access to both of these with the condition, neither without
      {
        object: `${D}:alg_expr_3`,
        relation: "direct_comb",
        user: `${U}:*`,
      },
      {
        object: `${D}:alg_expr_3`,
        relation: "other_rel",
        user: `${U}:alg_expr_1`,
        condition: COND,
      },
      {
        object: `${D}:alg_expr_4`,
        relation: "direct_comb",
        user: `${U}:*`,
        condition: COND,
      },
      { object: `${D}:alg_expr_4`, relation: "other_rel", user: `${U}:*` },
    ],
    assertions: [
      {
        user: `${U}:alg_expr_1`,
        type: D,
        relation: "and_computed_mult_types",
        context: VALID_CONTEXT,
        expect: [
          `${D}:alg_expr_1`,
          `${D}:alg_expr_2`,
          `${D}:alg_expr_3`,
          `${D}:alg_expr_4`,
        ],
      },
      {
        user: `${U}:alg_expr_1`,
        type: D,
        relation: "and_computed_mult_types",
        context: INVALID_CONTEXT,
        expect: [],
      },
      {
        user: `${E}:alg_expr_1`,
        type: D,
        relation: "and_computed_mult_types",
        expect: [`${D}:alg_expr_2`],
      },
    ],
  },
  {
    name: "directs_nested_algebraic_expressions",
    tuples: [
      // Excluded by "but not computed_3_times" on the path
      {
        object: `${D}:nested_alg_1`,
        relation: "direct",
        user: `${U}:nested_alg_1`,
      },
      {
        object: `${D}:nested_alg_1`,
        relation: "other_rel",
        user: `${U}:nested_alg_1`,
      },
      // Excluded by "but not computed_comb" on the path
      { object: `${D}:nested_alg_2`, relation: "direct_comb", user: `${U}:*` },
      {
        object: `${D}:nested_alg_2`,
        relation: "other_rel",
        user: `${U}:*`,
        condition: COND,
      },
      // Returned for both types
      {
        object: `${D}:nested_alg_3`,
        relation: "direct_mult_types",
        user: `${U}:nested_alg_1`,
      },
      {
        object: `${D}:nested_alg_3`,
        relation: "direct_mult_types",
        user: `${E}:*`,
      },
      {
        object: `${D}:nested_alg_3`,
        relation: "other_rel",
        user: `${U}:*`,
        condition: COND,
      },
      {
        object: `${D}:nested_alg_3`,
        relation: "other_rel",
        user: `${E}:nested_alg_1`,
      },
      // Excluded for lack of other_rel
      {
        object: `${D}:nested_alg_4`,
        relation: "direct",
        user: `${U}:nested_alg_1`,
      },
    ],
    assertions: [
      {
        user: `${U}:nested_alg_1`,
        type: D,
        relation: "alg_combined",
        context: VALID_CONTEXT,
        expect: [`${D}:nested_alg_3`],
      },
      {
        user: `${E}:nested_alg_1`,
        type: D,
        relation: "alg_combined",
        expect: [`${D}:nested_alg_3`],
      },
    ],
  },
  {
    name: "directs_alg_combined_oneline",
    tuples: [
      // Excluded: only the left side of the AND
      {
        object: `${D}:alg_combined_oneline_1`,
        relation: "direct",
        user: `${U}:alg_combined_oneline_1`,
      },
      // Both sides of the AND for this user
      {
        object: `${D}:alg_combined_oneline_2`,
        relation: "direct_mult_types",
        user: `${U}:alg_combined_oneline_1`,
      },
      {
        object: `${D}:alg_combined_oneline_2`,
        relation: "direct_comb",
        user: `${U}:alg_combined_oneline_1`,
      },
      {
        object: `${D}:alg_combined_oneline_2`,
        relation: "other_rel",
        user: `${U}:alg_combined_oneline_1`,
      },
      // Excluded for this employee: both on one side of the AND
      {
        object: `${D}:alg_combined_oneline_2`,
        relation: "other_rel",
        user: `${E}:alg_combined_oneline_1`,
      },
      {
        object: `${D}:alg_combined_oneline_2`,
        relation: "direct_mult_types",
        user: `${E}:alg_combined_oneline_1`,
      },
    ],
    assertions: [
      {
        user: `${U}:alg_combined_oneline_1`,
        type: D,
        relation: "alg_combined_oneline",
        context: VALID_CONTEXT,
        expect: [`${D}:alg_combined_oneline_2`],
      },
      {
        user: `${E}:alg_combined_oneline_1`,
        type: D,
        relation: "alg_combined_oneline",
        expect: [],
      },
    ],
  },
  {
    name: "directs_employee_alg_combined_oneline",
    tuples: [
      { object: `${DE}:oneline_1`, relation: "direct", user: `${E}:oneline_1` },
      {
        object: `${DE}:oneline_2`,
        relation: "direct",
        user: `${E}:oneline_1`,
        condition: COND,
      },
      {
        object: `${DE}:oneline_3`,
        relation: "other_rel",
        user: `${E}:oneline_1`,
      },
      {
        object: `${DE}:oneline_4`,
        relation: "direct_wild",
        user: `${E}:*`,
      },
    ],
    assertions: [
      {
        user: `${E}:oneline_1`,
        type: DE,
        relation: "alg_combined_oneline",
        context: VALID_CONTEXT,
        expect: [`${DE}:oneline_1`, `${DE}:oneline_2`],
      },
      {
        user: `${E}:oneline_1`,
        type: DE,
        relation: "alg_combined_oneline",
        context: INVALID_CONTEXT,
        expect: [`${DE}:oneline_1`],
      },
    ],
  },
  {
    name: "directs_employee_alg_combined",
    tuples: [
      // Excluded by "but not other_rel"
      {
        object: `${DE}:alg_combined_1`,
        relation: "other_rel",
        user: `${E}:alg_combined_1`,
      },
      {
        object: `${DE}:alg_combined_1`,
        relation: "direct_wild",
        user: `${E}:*`,
      },
      // Returned iff the condition holds
      {
        object: `${DE}:alg_combined_2`,
        relation: "direct",
        user: `${E}:alg_combined_1`,
        condition: COND,
      },
      {
        object: `${DE}:alg_combined_2`,
        relation: "direct_wild",
        user: `${E}:*`,
      },
      // Excluded for lack of direct_wild
      {
        object: `${DE}:alg_combined_3`,
        relation: "direct",
        user: `${E}:alg_combined_1`,
      },
    ],
    assertions: [
      {
        user: `${E}:alg_combined_1`,
        type: DE,
        relation: "alg_combined",
        context: VALID_CONTEXT,
        expect: [`${DE}:alg_combined_2`],
      },
      {
        user: `${E}:alg_combined_1`,
        type: DE,
        relation: "alg_combined",
        context: INVALID_CONTEXT,
        expect: [],
      },
    ],
  },
];

describe("listObjects matrix — directs", () => {
  let db: Kysely<DB>;
  let tsfgaClient: TsfgaClient;
  let fixture: FixtureRecord;

  beforeAll(async () => {
    ({ db, tsfgaClient, fixture } = await setupMatrix());
  });

  afterAll(async () => {
    await teardownMatrix(db);
  });

  for (const testCase of CASES) {
    describe(testCase.name, () => {
      let storeId: string;
      let authorizationModelId: string;

      beforeAll(async () => {
        ({ storeId, authorizationModelId } = await createCaseStore(
          testCase.name,
        ));
        await writeCaseTuples(
          tsfgaClient,
          storeId,
          authorizationModelId,
          testCase.tuples,
        );
      });

      afterAll(async () => {
        await removeCaseTuples(tsfgaClient, testCase.tuples);
      });

      for (const [index, assertion] of testCase.assertions.entries()) {
        const label =
          (assertion.issue ? `GAP-${assertion.issue}: ` : "") +
          `#${index} ${assertion.user} ` +
          `${assertion.relation} ${assertion.type}` +
          (assertion.context ? ` x=${String(assertion.context.x)}` : "");
        test(label, async () => {
          await expectListObjectsConformance(
            storeId,
            authorizationModelId,
            tsfgaClient,
            assertionRequest(assertion),
            assertionExpectation(assertion),
          );
        });
      }
    });
  }

  test("configs match the model", () => {
    expectConfigsMatchModel("./listobjects-matrix/model.dsl", fixture, {
      coverage: "complete",
      tsfgaOnlyHelpers: MATRIX_HELPERS,
      moved: MATRIX_MOVED,
    });
  });
});
