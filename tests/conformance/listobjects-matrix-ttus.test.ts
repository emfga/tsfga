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
 * OpenFGA's `tests/listobjects/matrix_ttus.go`, ported verbatim.
 *
 * The tuple-to-userset half of the matrix: recursive TTUs, a TTU
 * cycle of length two across two parent types, a three-way inline
 * intersection with an exclusion inside it, and a relation with two
 * TTU arms onto the same computed relation.
 */

const D = "directs_b4";
const DE = "directs_employee_b4";
const T = "ttus_b4";
const U = "user_b4";
const E = "employee_b4";
const COND = "xcond_b4";

const CASES: MatrixCase[] = [
  {
    name: "ttus_alg_combined",
    tuples: [
      // Satisfies the left side of `and_ttu`
      {
        object: `${D}:ttu_alg_1`,
        relation: "direct_mult_types",
        user: `${U}:ttu_anne`,
      },
      { object: `${D}:ttu_alg_1`, relation: "other_rel", user: `${U}:*` },
      {
        object: `${T}:ttu_alg_1`,
        relation: "mult_parent_types",
        user: `${D}:ttu_alg_1`,
      },
      {
        object: `${T}:ttu_alg_1`,
        relation: "direct_parent",
        user: `${D}:ttu_alg_1`,
      },
      // Satisfies the right side of the BUT NOT, behind a condition
      {
        object: `${D}:ttu_alg_2`,
        relation: "other_rel",
        user: `${U}:ttu_anne`,
      },
      { object: `${D}:ttu_alg_2`, relation: "direct", user: `${U}:ttu_anne` },
      {
        object: `${T}:ttu_alg_1`,
        relation: "mult_parent_types",
        user: `${D}:ttu_alg_2`,
        condition: COND,
      },
      // Satisfies "AND ttu_other_rel" for bob
      { object: `${D}:ttu_alg_b`, relation: "other_rel", user: `${U}:ttu_bob` },
      {
        object: `${T}:ttu_alg_2`,
        relation: "mult_parent_types",
        user: `${D}:ttu_alg_b`,
      },
      // Satisfies the alg_combined arm iff the condition holds
      { object: `${D}:ttu_alg_c`, relation: "other_rel", user: `${U}:ttu_bob` },
      {
        object: `${D}:ttu_alg_c`,
        relation: "direct_mult_types",
        user: `${U}:ttu_bob`,
      },
      {
        object: `${T}:ttu_alg_2`,
        relation: "mult_parent_types",
        user: `${D}:ttu_alg_c`,
        condition: COND,
      },
    ],
    assertions: [
      {
        user: `${U}:ttu_anne`,
        type: T,
        relation: "alg_combined",
        context: INVALID_CONTEXT,
        expect: [`${T}:ttu_alg_1`],
      },
      {
        user: `${U}:ttu_anne`,
        type: T,
        relation: "alg_combined",
        context: VALID_CONTEXT,
        expect: [],
      },
      {
        user: `${D}:ttu_alg_1`,
        type: T,
        relation: "mult_parent_types",
        expect: [`${T}:ttu_alg_1`],
      },
      {
        user: `${U}:ttu_bob`,
        type: T,
        relation: "alg_combined",
        context: VALID_CONTEXT,
        expect: [`${T}:ttu_alg_2`],
      },
      {
        user: `${U}:ttu_bob`,
        type: T,
        relation: "alg_combined",
        context: INVALID_CONTEXT,
        expect: [],
      },
    ],
  },
  {
    name: "ttus_recursive",
    tuples: [
      {
        object: `${T}:recursive_1`,
        relation: "ttu_recursive",
        user: `${U}:recursive_anne`,
      },
      {
        object: `${T}:recursive_2`,
        relation: "ttu_parent",
        user: `${T}:recursive_1`,
      },
      {
        object: `${T}:recursive_3`,
        relation: "ttu_parent",
        user: `${T}:recursive_2`,
      },
      // Connected twice; recursive_3 must come back once
      {
        object: `${T}:recursive_3`,
        relation: "ttu_recursive",
        user: `${U}:recursive_anne`,
      },
      {
        object: `${T}:recursive_2`,
        relation: "ttu_recursive_public",
        user: `${U}:*`,
      },
    ],
    assertions: [
      {
        user: `${T}:recursive_2`,
        type: T,
        relation: "ttu_parent",
        expect: [`${T}:recursive_3`],
      },
      {
        user: `${U}:public`,
        type: T,
        relation: "ttu_recursive_public",
        expect: [`${T}:recursive_2`, `${T}:recursive_3`],
      },
      {
        user: `${U}:recursive_anne`,
        type: T,
        relation: "ttu_recursive",
        expect: [`${T}:recursive_1`, `${T}:recursive_2`, `${T}:recursive_3`],
      },
    ],
  },
  {
    name: "ttus_recursive_alg_combined_w2",
    tuples: [
      // Direct; always returned
      {
        object: `${T}:recursive_w2_1`,
        relation: "ttu_recursive_alg_combined_w2",
        user: `${U}:w2_anne`,
      },
      // Satisfies ttu_recursive_alg_combined iff the condition holds
      {
        object: `${T}:recursive_w2_1c`,
        relation: "user_rel2",
        user: `${U}:w2_anne`,
        condition: COND,
      },
      {
        object: `${T}:recursive_w2_1c`,
        relation: "user_rel3",
        user: `${U}:w2_anne`,
      },
      {
        object: `${T}:recursive_w2_2`,
        relation: "ttu_parent",
        user: `${T}:recursive_w2_1c`,
      },
      {
        object: `${T}:recursive_w2_3`,
        relation: "ttu_parent",
        user: `${T}:recursive_w2_2`,
      },
      // Satisfies the rightmost AND iff the condition holds
      {
        object: `${T}:recursive_w2_a`,
        relation: "user_rel2",
        user: `${U}:w2_bob`,
        condition: COND,
      },
      {
        object: `${D}:recursive_w2_a`,
        relation: "direct",
        user: `${U}:w2_bob`,
      },
      {
        object: `${T}:recursive_w2_a`,
        relation: "direct_parent",
        user: `${D}:recursive_w2_a`,
      },
      // The same, through a conditioned wildcard
      {
        object: `${T}:recursive_w2_ab`,
        relation: "user_rel2",
        user: `${U}:w2_charlie`,
      },
      {
        object: `${T}:recursive_w2_ab`,
        relation: "user_rel3",
        user: `${U}:*`,
        condition: COND,
      },
      {
        object: `${T}:recursive_w2_abc`,
        relation: "ttu_parent",
        user: `${T}:recursive_w2_ab`,
      },
      {
        object: `${T}:recursive_w2_abcd`,
        relation: "ttu_parent",
        user: `${T}:recursive_w2_abc`,
      },
    ],
    assertions: [
      {
        user: `${U}:w2_anne`,
        type: T,
        relation: "ttu_recursive_alg_combined_w2",
        context: VALID_CONTEXT,
        expect: [
          `${T}:recursive_w2_1`,
          `${T}:recursive_w2_2`,
          `${T}:recursive_w2_3`,
        ],
      },
      {
        user: `${U}:w2_anne`,
        type: T,
        relation: "ttu_recursive_alg_combined_w2",
        context: INVALID_CONTEXT,
        expect: [`${T}:recursive_w2_1`],
      },
      {
        user: `${U}:w2_bob`,
        type: T,
        relation: "ttu_recursive_alg_combined_w2",
        context: INVALID_CONTEXT,
        expect: [],
      },
      {
        user: `${U}:w2_bob`,
        type: T,
        relation: "ttu_recursive_alg_combined_w2",
        context: VALID_CONTEXT,
        expect: [`${T}:recursive_w2_a`],
      },
      {
        user: `${U}:w2_charlie`,
        type: T,
        relation: "ttu_recursive_alg_combined_w2",
        context: VALID_CONTEXT,
        expect: [`${T}:recursive_w2_abc`, `${T}:recursive_w2_abcd`],
      },
      {
        user: `${U}:w2_charlie`,
        type: T,
        relation: "ttu_recursive_alg_combined_w2",
        context: INVALID_CONTEXT,
        expect: [],
      },
    ],
  },
  {
    name: "ttus_multiple_parent_exclusion_intersection",
    tuples: [
      { object: `${T}:ttu1`, relation: "alg_inline", user: `${U}:bob` },
      { object: `${T}:ttu3`, relation: "alg_inline", user: `${U}:bob` },
      { object: `${T}:ttu2`, relation: "alg_inline", user: `${U}:*` },
      { object: `${T}:ttu3`, relation: "alg_inline", user: `${U}:*` },
      { object: `${T}:ttu4`, relation: "alg_inline", user: `${U}:*` },

      { object: `${T}:ttu2`, relation: "user_rel1", user: `${U}:bob` },
      { object: `${T}:ttu3`, relation: "user_rel1", user: `${U}:bob` },
      { object: `${T}:ttu2`, relation: "user_rel1", user: `${U}:*` },
      { object: `${T}:ttu1`, relation: "user_rel1", user: `${U}:*` },

      { object: `${T}:ttu1`, relation: "direct_parent", user: `${D}:d1` },
      { object: `${T}:ttu2`, relation: "direct_parent", user: `${D}:d2` },
      { object: `${T}:ttu3`, relation: "direct_parent", user: `${D}:d3` },
      { object: `${T}:ttu4`, relation: "direct_parent", user: `${D}:d4` },

      { object: `${D}:d1`, relation: "direct", user: `${U}:bob` },
      { object: `${D}:d2`, relation: "direct", user: `${U}:bob` },
      { object: `${D}:d3`, relation: "direct", user: `${U}:bob` },
      { object: `${D}:d4`, relation: "direct", user: `${U}:bob` },

      { object: `${T}:ttu3`, relation: "mult_parent_types", user: `${D}:d3` },
      { object: `${T}:ttu4`, relation: "mult_parent_types", user: `${D}:d4` },
      {
        object: `${T}:ttu1`,
        relation: "mult_parent_types",
        user: `${DE}:mdd1`,
      },
      {
        object: `${T}:ttu2`,
        relation: "mult_parent_types",
        user: `${DE}:mdd2`,
      },

      { object: `${D}:d4`, relation: "other_rel", user: `${U}:bob` },
      { object: `${D}:d3`, relation: "other_rel", user: `${U}:*` },
    ],
    assertions: [
      {
        user: `${U}:bob`,
        type: T,
        relation: "alg_inline",
        context: VALID_CONTEXT,
        expect: [`${T}:ttu1`, `${T}:ttu2`],
      },
    ],
  },
  {
    name: "ttus_recursive_alg_combined_oneline",
    tuples: [
      // rel2 AND rel3 iff the condition holds
      {
        object: `${T}:oneline_public_1`,
        relation: "user_rel2",
        user: `${U}:oneline_anne`,
      },
      {
        object: `${T}:oneline_public_1`,
        relation: "user_rel3",
        user: `${U}:*`,
        condition: COND,
      },
      {
        object: `${T}:oneline_public_2`,
        relation: "ttu_parent",
        user: `${T}:oneline_public_1`,
      },
      // oneline_public_3 must not come back
      {
        object: `${T}:oneline_public_2`,
        relation: "ttu_parent",
        user: `${T}:oneline_public_3`,
      },
      // The same pair with the condition on the other relation
      {
        object: `${T}:oneline_public_1`,
        relation: "user_rel2",
        user: `${U}:oneline_bob`,
        condition: COND,
      },
      {
        object: `${T}:oneline_public_1`,
        relation: "user_rel3",
        user: `${U}:oneline_bob`,
      },
      // The user_rel1 arm of the OR
      {
        object: `${T}:oneline_rel1_1`,
        relation: "ttu_parent",
        user: `${T}:oneline_rel1_2`,
      },
      {
        object: `${T}:oneline_rel1_2`,
        relation: "ttu_parent",
        user: `${T}:oneline_rel1_3`,
      },
      {
        object: `${T}:oneline_rel1_3`,
        relation: "ttu_parent",
        user: `${T}:oneline_rel1_4`,
      },
      {
        object: `${T}:oneline_rel1_3`,
        relation: "user_rel1",
        user: `${U}:oneline_charlie`,
      },
      {
        object: `${T}:oneline_direct`,
        relation: "ttu_recursive_alg_combined_oneline",
        user: `${U}:oneline_direct`,
      },
    ],
    assertions: [
      {
        user: `${U}:oneline_anne`,
        type: T,
        relation: "ttu_recursive_alg_combined_oneline",
        context: VALID_CONTEXT,
        expect: [`${T}:oneline_public_1`, `${T}:oneline_public_2`],
      },
      {
        user: `${U}:oneline_anne`,
        type: T,
        relation: "ttu_recursive_alg_combined_oneline",
        context: INVALID_CONTEXT,
        expect: [],
      },
      {
        user: `${U}:oneline_bob`,
        type: T,
        relation: "ttu_recursive_alg_combined_oneline",
        context: VALID_CONTEXT,
        expect: [`${T}:oneline_public_1`, `${T}:oneline_public_2`],
      },
      {
        user: `${U}:oneline_bob`,
        type: T,
        relation: "ttu_recursive_alg_combined_oneline",
        context: INVALID_CONTEXT,
        expect: [],
      },
      {
        user: `${U}:oneline_charlie`,
        type: T,
        relation: "ttu_recursive_alg_combined_oneline",
        context: VALID_CONTEXT,
        expect: [
          `${T}:oneline_rel1_1`,
          `${T}:oneline_rel1_2`,
          `${T}:oneline_rel1_3`,
        ],
      },
      {
        user: `${U}:oneline_direct`,
        type: T,
        relation: "ttu_recursive_alg_combined_oneline",
        context: VALID_CONTEXT,
        expect: [`${T}:oneline_direct`],
      },
    ],
  },
  {
    name: "duplicate_ttu_parents",
    tuples: [
      {
        object: `${T}:duplicate_parent`,
        relation: "mult_parent_types",
        user: `${D}:duplicate_parent`,
      },
      {
        object: `${D}:duplicate_parent`,
        relation: "direct",
        user: `${U}:duplicate_parent_anne`,
      },
    ],
    assertions: [
      {
        user: `${U}:duplicate_parent_anne`,
        type: T,
        relation: "duplicate_ttu",
        expect: [`${T}:duplicate_parent`],
      },
    ],
  },
  {
    name: "ttus_tuple_cycle_len2_ttu",
    tuples: [
      {
        object: `${T}:cycle_1`,
        relation: "mult_parent_types",
        user: `${D}:cycle_1`,
      },
      {
        object: `${D}:cycle_1`,
        relation: "cycle_len2_parent",
        user: `${T}:cycle_2`,
      },
      {
        object: `${T}:cycle_2`,
        relation: "mult_parent_types",
        user: `${D}:cycle_2`,
      },
      {
        object: `${D}:cycle_2`,
        relation: "cycle_len2_parent",
        user: `${T}:cycle_3`,
      },
      {
        object: `${T}:cycle_3`,
        relation: "mult_parent_types",
        user: `${D}:cycle_3`,
        condition: COND,
      },
      {
        object: `${D}:cycle_3`,
        relation: "tuple_cycle_len2_ttu",
        user: `${U}:ttu_cycle_bob`,
      },
      {
        object: `${T}:cycle_3`,
        relation: "mult_parent_types",
        user: `${DE}:cycle_3`,
        condition: COND,
      },
      {
        object: `${DE}:cycle_3`,
        relation: "tuple_cycle_len2_ttu",
        user: `${U}:ttu_cycle_employee`,
      },
      // Attached unconditionally mid-chain; charlie must not reach
      // cycle_3.
      {
        object: `${D}:cycle_2`,
        relation: "tuple_cycle_len2_ttu",
        user: `${U}:ttu_charlie`,
      },
    ],
    assertions: [
      {
        user: `${U}:ttu_cycle_bob`,
        type: T,
        relation: "tuple_cycle_len2_ttu",
        context: VALID_CONTEXT,
        expect: [`${T}:cycle_1`, `${T}:cycle_2`, `${T}:cycle_3`],
      },
      {
        user: `${U}:ttu_cycle_bob`,
        type: T,
        relation: "tuple_cycle_len2_ttu",
        context: INVALID_CONTEXT,
        expect: [],
      },
      {
        user: `${U}:ttu_cycle_employee`,
        type: T,
        relation: "tuple_cycle_len2_ttu",
        context: VALID_CONTEXT,
        expect: [`${T}:cycle_1`, `${T}:cycle_2`, `${T}:cycle_3`],
      },
      {
        user: `${U}:ttu_cycle_employee`,
        type: T,
        relation: "tuple_cycle_len2_ttu",
        context: INVALID_CONTEXT,
        expect: [],
      },
      {
        // The conditioned rows sit on `cycle_3`, which charlie
        // cannot reach. Upstream never evaluates them; tsfga checks
        // every candidate and the error costs the whole answer.
        issue: "260",
        user: `${U}:ttu_charlie`,
        type: T,
        relation: "tuple_cycle_len2_ttu",
        expect: [`${T}:cycle_1`, `${T}:cycle_2`],
      },
    ],
  },
  {
    name: "ttus_recursive_combined_w3",
    tuples: [
      { object: `${T}:rc_2`, relation: "ttu_parent", user: `${T}:rc_1` },
      { object: `${T}:rc_3`, relation: "ttu_parent", user: `${T}:rc_2` },
      // anne alone reaches rc_1
      {
        object: `${T}:rc_1`,
        relation: "ttu_recursive_combined_w3",
        user: `${U}:rc_anne`,
      },
      // bob reaches rc_2 and its children, not rc_1
      { object: `${D}:rc_2`, relation: "direct", user: `${U}:rc_bob` },
      { object: `${T}:rc_2`, relation: "direct_parent", user: `${D}:rc_2` },
      // A fork: rc_2 has two ttu_parent chains
      { object: `${T}:rc_2`, relation: "ttu_parent", user: `${T}:rc_a` },
      { object: `${T}:rc_a`, relation: "ttu_parent", user: `${T}:rc_b` },
      {
        object: `${T}:rc_a`,
        relation: "ttu_recursive_combined_w3",
        user: `${E}:rc_a`,
      },
      {
        object: `${T}:rc_wild_parent`,
        relation: "ttu_recursive_combined_w3",
        user: `${U}:*`,
      },
      {
        object: `${T}:rc_wild_child`,
        relation: "ttu_parent",
        user: `${T}:rc_wild_parent`,
      },
    ],
    assertions: [
      {
        user: `${U}:rc_anne`,
        type: T,
        relation: "ttu_recursive_combined_w3",
        expect: [
          `${T}:rc_1`,
          `${T}:rc_2`,
          `${T}:rc_3`,
          `${T}:rc_wild_parent`,
          `${T}:rc_wild_child`,
        ],
      },
      {
        user: `${U}:rc_bob`,
        type: T,
        relation: "ttu_recursive_combined_w3",
        expect: [
          `${T}:rc_2`,
          `${T}:rc_3`,
          `${T}:rc_wild_parent`,
          `${T}:rc_wild_child`,
        ],
      },
      {
        user: `${E}:rc_a`,
        type: T,
        relation: "ttu_recursive_combined_w3",
        expect: [`${T}:rc_a`, `${T}:rc_2`, `${T}:rc_3`],
      },
      {
        user: `${U}:public`,
        type: T,
        relation: "ttu_recursive_combined_w3",
        expect: [`${T}:rc_wild_parent`, `${T}:rc_wild_child`],
      },
    ],
  },
];

describe("listObjects matrix — ttus", () => {
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
