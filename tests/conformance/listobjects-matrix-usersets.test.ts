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
 * OpenFGA's `tests/listobjects/matrix_usersets.go`, ported for the
 * cases whose relations the trimmed model carries.
 *
 * The `complexity3` / `complexity4` cases and the `tuple_cycle_len3`
 * family are not ported — they need two more types and a dozen more
 * relations, and nothing they exercise is unreachable from the ones
 * here. Everything ported is transcribed verbatim: tuples, requests
 * and expected object sets.
 *
 * Several requests name a **userset subject** (`type:id#relation`),
 * which `listObjects` accepts. Upstream asserts them throughout,
 * so they are the ones to watch.
 */

const D = "directs_b4";
const DE = "directs_employee_b4";
const S = "usersets_user_b4";
const U = "user_b4";
const E = "employee_b4";
const COND = "xcond_b4";

/** Upstream's longest object-name stem, kept verbatim. */
const W3 = "userset_recursive_combined_w3";
const OL = "userset_recursive_alg_combined_oneline";

const CASES: MatrixCase[] = [
  {
    name: "usersets_user_alg_combined",
    tuples: [
      {
        object: `${S}:user_alg_1`,
        relation: "userset_alg_combined",
        user: `${D}:user_alg_1#alg_combined`,
      },
      {
        object: `${S}:user_alg_2`,
        relation: "userset_alg_combined",
        user: `${D}:user_alg_2#alg_combined`,
      },
      {
        object: `${S}:user_alg_3`,
        relation: "userset_alg_combined",
        user: `${DE}:user_alg_1#alg_combined`,
      },
      {
        object: `${S}:user_alg_4`,
        relation: "userset_alg_combined",
        user: `${DE}:user_alg_2#alg_combined`,
      },
      // Satisfies directs#alg_combined
      {
        object: `${D}:user_alg_1`,
        relation: "direct_mult_types",
        user: `${U}:user_alg_1`,
      },
      {
        object: `${D}:user_alg_1`,
        relation: "other_rel",
        user: `${U}:user_alg_1`,
      },
      // Does not
      {
        object: `${D}:user_alg_2`,
        relation: "other_rel",
        user: `${U}:user_alg_1`,
      },
      // Satisfies directs-employee#alg_combined
      {
        object: `${DE}:user_alg_1`,
        relation: "direct",
        user: `${E}:user_alg_1`,
      },
      {
        object: `${DE}:user_alg_1`,
        relation: "direct_wild",
        user: `${E}:*`,
      },
      // Does not
      {
        object: `${DE}:user_alg_2`,
        relation: "other_rel",
        user: `${E}:user_alg_1`,
      },
    ],
    assertions: [
      {
        user: `${D}:user_alg_1#alg_combined`,
        type: S,
        relation: "userset_alg_combined",
        expect: [`${S}:user_alg_1`],
      },
      {
        user: `${U}:user_alg_1`,
        type: S,
        relation: "userset_alg_combined",
        expect: [`${S}:user_alg_1`],
      },
      {
        user: `${E}:user_alg_1`,
        type: S,
        relation: "userset_alg_combined",
        expect: [`${S}:user_alg_3`],
      },
    ],
  },
  {
    name: "usersets_user_alg_combined_oneline",
    tuples: [
      {
        object: `${S}:oneline_1`,
        relation: "userset_alg_combined_oneline",
        user: `${D}:oneline_1#alg_combined_oneline`,
      },
      {
        object: `${S}:oneline_2`,
        relation: "userset_alg_combined_oneline",
        user: `${D}:oneline_2#alg_combined_oneline`,
      },
      {
        object: `${S}:oneline_3`,
        relation: "userset_alg_combined_oneline",
        user: `${DE}:oneline_1#alg_combined_oneline`,
      },
      {
        object: `${S}:oneline_4`,
        relation: "userset_alg_combined_oneline",
        user: `${DE}:oneline_2#alg_combined_oneline`,
      },
      { object: `${D}:oneline_1`, relation: "direct", user: `${U}:oneline_1` },
      {
        object: `${D}:oneline_1`,
        relation: "other_rel",
        user: `${U}:oneline_1`,
      },
      {
        object: `${D}:oneline_2`,
        relation: "other_rel",
        user: `${U}:oneline_1`,
      },
      { object: `${DE}:oneline_1`, relation: "direct", user: `${E}:oneline_1` },
      {
        object: `${DE}:oneline_2`,
        relation: "other_rel",
        user: `${E}:oneline_1`,
      },
    ],
    assertions: [
      // A userset subject naming a relation the object does *not*
      // satisfy still reaches the object that names the userset.
      {
        user: `${D}:oneline_2#alg_combined_oneline`,
        type: S,
        relation: "userset_alg_combined_oneline",
        expect: [`${S}:oneline_2`],
      },
      {
        user: `${D}:oneline_1#alg_combined_oneline`,
        type: S,
        relation: "userset_alg_combined_oneline",
        expect: [`${S}:oneline_1`],
      },
      {
        user: `${U}:oneline_1`,
        type: S,
        relation: "userset_alg_combined_oneline",
        expect: [`${S}:oneline_1`],
      },
      {
        user: `${E}:oneline_1`,
        type: S,
        relation: "userset_alg_combined_oneline",
        expect: [`${S}:oneline_3`],
      },
    ],
  },
  {
    name: "usersets_user_userset_recursive",
    tuples: [
      {
        object: `${S}:recursive_level_1`,
        relation: "userset_recursive",
        user: `${U}:recursive_1`,
      },
      {
        object: `${S}:recursive_level_2`,
        relation: "userset_recursive",
        user: `${S}:recursive_level_1#userset_recursive`,
      },
      {
        object: `${S}:recursive_level_3`,
        relation: "userset_recursive",
        user: `${S}:recursive_level_2#userset_recursive`,
      },
      {
        object: `${S}:recursive_level_4`,
        relation: "userset_recursive",
        user: `${S}:recursive_level_3#userset_recursive`,
      },
      // Another user, halfway along the chain
      {
        object: `${S}:recursive_level_3`,
        relation: "userset_recursive",
        user: `${U}:recursive_2`,
      },
      // A second branch, tied into the first
      {
        object: `${S}:branch_2_level_1`,
        relation: "userset_recursive",
        user: `${U}:other_branch`,
      },
      {
        object: `${S}:branch_2_level_2`,
        relation: "userset_recursive",
        user: `${S}:branch_2_level_1#userset_recursive`,
      },
      {
        object: `${S}:recursive_level_3`,
        relation: "userset_recursive",
        user: `${S}:branch_2_level_2#userset_recursive`,
      },
      // A branch that closes into a cycle
      {
        object: `${S}:branch_with_cycle_1`,
        relation: "userset_recursive",
        user: `${U}:cycle_1_user`,
      },
      {
        object: `${S}:branch_with_cycle_2`,
        relation: "userset_recursive",
        user: `${S}:branch_with_cycle_1#userset_recursive`,
      },
      {
        object: `${S}:branch_with_cycle_3`,
        relation: "userset_recursive",
        user: `${S}:branch_with_cycle_2#userset_recursive`,
      },
      {
        object: `${S}:branch_with_cycle_4`,
        relation: "userset_recursive",
        user: `${S}:branch_with_cycle_3#userset_recursive`,
      },
      {
        object: `${S}:branch_with_cycle_2`,
        relation: "userset_recursive",
        user: `${S}:branch_with_cycle_4#userset_recursive`,
      },
    ],
    assertions: [
      {
        user: `${S}:recursive_level_3#userset_recursive`,
        type: S,
        relation: "userset_recursive",
        expect: [`${S}:recursive_level_3`, `${S}:recursive_level_4`],
      },
      {
        user: `${U}:recursive_1`,
        type: S,
        relation: "userset_recursive",
        expect: [
          `${S}:recursive_level_1`,
          `${S}:recursive_level_2`,
          `${S}:recursive_level_3`,
          `${S}:recursive_level_4`,
        ],
      },
      {
        user: `${U}:recursive_2`,
        type: S,
        relation: "userset_recursive",
        expect: [`${S}:recursive_level_3`, `${S}:recursive_level_4`],
      },
      {
        user: `${U}:other_branch`,
        type: S,
        relation: "userset_recursive",
        expect: [
          `${S}:branch_2_level_1`,
          `${S}:branch_2_level_2`,
          `${S}:recursive_level_3`,
          `${S}:recursive_level_4`,
        ],
      },
      {
        user: `${U}:cycle_1_user`,
        type: S,
        relation: "userset_recursive",
        expect: [
          `${S}:branch_with_cycle_1`,
          `${S}:branch_with_cycle_2`,
          `${S}:branch_with_cycle_3`,
          `${S}:branch_with_cycle_4`,
        ],
      },
    ],
  },
  {
    name: "userset_recursive_public",
    tuples: [
      {
        object: `${S}:recursive_public_level_1`,
        relation: "userset_recursive_public",
        user: `${U}:*`,
      },
      {
        object: `${S}:recursive_public_level_2`,
        relation: "userset_recursive_public",
        user: `${S}:recursive_public_level_1#userset_recursive_public`,
      },
      {
        object: `${S}:recursive_public_level_3`,
        relation: "userset_recursive_public",
        user: `${S}:recursive_public_level_2#userset_recursive_public`,
      },
      {
        object: `${S}:recursive_public_level_4`,
        relation: "userset_recursive_public",
        user: `${S}:recursive_public_level_3#userset_recursive_public`,
      },
      {
        object: `${S}:recursive_public_level_3`,
        relation: "userset_recursive_public",
        user: `${U}:*`,
      },
      {
        object: `${S}:recursive_public_branch_level_1`,
        relation: "userset_recursive_public",
        user: `${U}:*`,
      },
      {
        object: `${S}:recursive_public_branch_level_2`,
        relation: "userset_recursive_public",
        user: `${S}:recursive_public_branch_level_1#userset_recursive_public`,
      },
      {
        object: `${S}:recursive_public_branch_level_3`,
        relation: "userset_recursive_public",
        user: `${S}:recursive_public_branch_level_2#userset_recursive_public`,
      },
      {
        object: `${S}:recursive_public_branch_level_4`,
        relation: "userset_recursive_public",
        user: `${S}:recursive_public_branch_level_3#userset_recursive_public`,
      },
      {
        object: `${S}:recursive_public_branch_level_2`,
        relation: "userset_recursive_public",
        user: `${U}:*`,
      },
    ],
    assertions: [
      {
        user: `${S}:recursive_public_level_3#userset_recursive_public`,
        type: S,
        relation: "userset_recursive_public",
        expect: [
          `${S}:recursive_public_level_3`,
          `${S}:recursive_public_level_4`,
        ],
      },
      {
        user: `${U}:public`,
        type: S,
        relation: "userset_recursive_public",
        expect: [
          `${S}:recursive_public_level_1`,
          `${S}:recursive_public_level_2`,
          `${S}:recursive_public_level_3`,
          `${S}:recursive_public_level_4`,
          `${S}:recursive_public_branch_level_1`,
          `${S}:recursive_public_branch_level_2`,
          `${S}:recursive_public_branch_level_3`,
          `${S}:recursive_public_branch_level_4`,
        ],
      },
    ],
  },
  {
    name: "userset_recursive_combined_w3",
    tuples: [
      {
        object: `${S}:${W3}_direct`,
        relation: W3,
        user: `${U}:${W3}_direct`,
      },
      { object: `${S}:${W3}_public`, relation: W3, user: `${U}:*` },
      {
        object: `${S}:${W3}_direct_recursive_1`,
        relation: W3,
        user: `${S}:${W3}_direct#${W3}`,
      },
      {
        object: `${S}:${W3}_direct_recursive_2`,
        relation: W3,
        user: `${S}:${W3}_direct_recursive_1#${W3}`,
      },
      {
        object: `${S}:${W3}_public_recursive_1`,
        relation: W3,
        user: `${S}:${W3}_public#${W3}`,
      },
      {
        object: `${S}:${W3}_public_recursive_2`,
        relation: W3,
        user: `${S}:${W3}_public_recursive_1#${W3}`,
      },
      {
        object: `${S}:${W3}_userset_entry`,
        relation: "userset",
        user: `${D}:${W3}_userset#direct_comb`,
      },
      {
        object: `${S}:${W3}_userset`,
        relation: W3,
        user: `${S}:${W3}_userset_entry#userset`,
      },
      {
        object: `${D}:${W3}_userset`,
        relation: "direct_comb",
        user: `${U}:${W3}_userset_direct`,
      },
      {
        object: `${D}:${W3}_userset`,
        relation: "direct_comb",
        user: `${U}:${W3}_userset_direct_cond`,
        condition: COND,
      },
      {
        object: `${S}:${W3}_userset_recursive_1`,
        relation: W3,
        user: `${S}:${W3}_userset#${W3}`,
      },
      {
        object: `${S}:${W3}_employee_direct`,
        relation: W3,
        user: `${E}:${W3}_employee_direct`,
      },
      {
        object: `${S}:${W3}_employee_direct_recursive_1`,
        relation: W3,
        user: `${S}:${W3}_employee_direct#${W3}`,
      },
      {
        object: `${S}:${W3}_userset_employee_entry`,
        relation: "userset",
        user: `${DE}:${W3}_userset_employee#direct`,
      },
      {
        object: `${S}:${W3}_userset_employee`,
        relation: W3,
        user: `${S}:${W3}_userset_employee_entry#userset`,
      },
      {
        object: `${S}:${W3}_userset_employee_recursive_1`,
        relation: W3,
        user: `${S}:${W3}_userset_employee#${W3}`,
      },
      {
        object: `${DE}:${W3}_userset_employee`,
        relation: "direct",
        user: `${E}:*`,
      },
      {
        object: `${S}:${W3}_userset_employee_entry_cond`,
        relation: "userset",
        user: `${DE}:${W3}_userset_employee_cond#direct`,
      },
      {
        object: `${S}:${W3}_userset_employee_cond`,
        relation: W3,
        user: `${S}:${W3}_userset_employee_entry_cond#userset`,
      },
      {
        object: `${S}:${W3}_userset_employee_cond_recursive_1`,
        relation: W3,
        user: `${S}:${W3}_userset_employee_cond#${W3}`,
      },
      {
        object: `${DE}:${W3}_userset_employee_cond`,
        relation: "direct",
        user: `${E}:*`,
        condition: COND,
      },
    ],
    assertions: [
      {
        user: `${U}:${W3}_direct`,
        type: S,
        relation: W3,
        expect: [
          `${S}:${W3}_direct`,
          `${S}:${W3}_public`,
          `${S}:${W3}_direct_recursive_1`,
          `${S}:${W3}_direct_recursive_2`,
          `${S}:${W3}_public_recursive_1`,
          `${S}:${W3}_public_recursive_2`,
        ],
      },
      {
        user: `${U}:public`,
        type: S,
        relation: W3,
        expect: [
          `${S}:${W3}_public`,
          `${S}:${W3}_public_recursive_1`,
          `${S}:${W3}_public_recursive_2`,
        ],
      },
      {
        user: `${S}:${W3}_userset_entry#userset`,
        type: S,
        relation: W3,
        expect: [`${S}:${W3}_userset`, `${S}:${W3}_userset_recursive_1`],
      },
      {
        user: `${U}:${W3}_userset_direct`,
        type: S,
        relation: W3,
        expect: [
          `${S}:${W3}_public`,
          `${S}:${W3}_public_recursive_1`,
          `${S}:${W3}_public_recursive_2`,
          `${S}:${W3}_userset`,
          `${S}:${W3}_userset_recursive_1`,
        ],
      },
      {
        user: `${U}:${W3}_userset_direct_cond`,
        type: S,
        relation: W3,
        context: VALID_CONTEXT,
        expect: [
          `${S}:${W3}_public`,
          `${S}:${W3}_public_recursive_1`,
          `${S}:${W3}_public_recursive_2`,
          `${S}:${W3}_userset`,
          `${S}:${W3}_userset_recursive_1`,
        ],
      },
      {
        user: `${U}:${W3}_userset_direct_cond`,
        type: S,
        relation: W3,
        context: INVALID_CONTEXT,
        expect: [
          `${S}:${W3}_public`,
          `${S}:${W3}_public_recursive_1`,
          `${S}:${W3}_public_recursive_2`,
        ],
      },
      {
        user: `${E}:public`,
        type: S,
        relation: W3,
        context: VALID_CONTEXT,
        expect: [
          `${S}:${W3}_userset_employee`,
          `${S}:${W3}_userset_employee_recursive_1`,
          `${S}:${W3}_userset_employee_cond`,
          `${S}:${W3}_userset_employee_cond_recursive_1`,
        ],
      },
      {
        user: `${E}:public`,
        type: S,
        relation: W3,
        context: INVALID_CONTEXT,
        expect: [
          `${S}:${W3}_userset_employee`,
          `${S}:${W3}_userset_employee_recursive_1`,
        ],
      },
      {
        user: `${E}:${W3}_employee_direct`,
        type: S,
        relation: W3,
        context: VALID_CONTEXT,
        expect: [
          `${S}:${W3}_userset_employee`,
          `${S}:${W3}_userset_employee_recursive_1`,
          `${S}:${W3}_userset_employee_cond`,
          `${S}:${W3}_userset_employee_cond_recursive_1`,
          `${S}:${W3}_employee_direct`,
          `${S}:${W3}_employee_direct_recursive_1`,
        ],
      },
    ],
  },
  {
    name: "userset_recursive_alg_combined_oneline",
    tuples: [
      // rel2 or rel3, never both: no match
      {
        object: `${S}:${OL}_rel2_only`,
        relation: "user_rel2",
        user: `${U}:${OL}_rel2_only`,
      },
      {
        object: `${S}:${OL}_rel3_only`,
        relation: "user_rel3",
        user: `${U}:${OL}_rel3_only`,
      },
      // rel2 and rel3
      {
        object: `${S}:${OL}_rel2_rel3`,
        relation: "user_rel2",
        user: `${U}:${OL}_rel2_rel3`,
      },
      {
        object: `${S}:${OL}_rel2_rel3`,
        relation: "user_rel3",
        user: `${U}:${OL}_rel2_rel3`,
      },
      {
        object: `${S}:${OL}_rel2_rel3_recursive_1`,
        relation: OL,
        user: `${S}:${OL}_rel2_rel3#${OL}`,
      },
      // Attached in the middle of the recursion
      {
        object: `${S}:${OL}_rel2_rel3_recursive_1`,
        relation: OL,
        user: `${U}:${OL}_rel2_rel3_recursive_1`,
      },
      {
        object: `${S}:${OL}_rel1_only`,
        relation: "user_rel1",
        user: `${U}:${OL}_rel1_only`,
      },
      {
        object: `${S}:${OL}_rel1_only_recursive_1`,
        relation: OL,
        user: `${S}:${OL}_rel1_only#${OL}`,
      },
      {
        object: `${S}:${OL}_direct`,
        relation: OL,
        user: `${U}:${OL}_direct`,
      },
      {
        object: `${S}:${OL}_direct_recursive_1`,
        relation: OL,
        user: `${S}:${OL}_direct#${OL}`,
      },
      {
        object: `${S}:${OL}_rel2_rel3_cond`,
        relation: "user_rel2",
        user: `${U}:${OL}_rel2_rel3_cond`,
        condition: COND,
      },
      {
        object: `${S}:${OL}_rel2_rel3_cond`,
        relation: "user_rel3",
        user: `${U}:*`,
        condition: COND,
      },
      {
        object: `${S}:${OL}_rel2_rel3_cond_recursive_1`,
        relation: OL,
        user: `${S}:${OL}_rel2_rel3_cond#${OL}`,
      },
      {
        object: `${S}:${OL}_rel2_nocond_rel3_cond`,
        relation: "user_rel2",
        user: `${U}:${OL}_rel2_nocond_rel3_cond`,
      },
      {
        object: `${S}:${OL}_rel2_nocond_rel3_cond`,
        relation: "user_rel3",
        user: `${U}:*`,
        condition: COND,
      },
    ],
    assertions: [
      {
        user: `${U}:${OL}_rel2_only`,
        type: S,
        relation: OL,
        context: INVALID_CONTEXT,
        expect: [],
      },
      {
        user: `${U}:${OL}_rel3_only`,
        type: S,
        relation: OL,
        context: INVALID_CONTEXT,
        expect: [],
      },
      {
        user: `${U}:${OL}_rel2_rel3`,
        type: S,
        relation: OL,
        context: INVALID_CONTEXT,
        expect: [`${S}:${OL}_rel2_rel3`, `${S}:${OL}_rel2_rel3_recursive_1`],
      },
      {
        user: `${U}:${OL}_rel2_rel3_recursive_1`,
        type: S,
        relation: OL,
        context: INVALID_CONTEXT,
        expect: [`${S}:${OL}_rel2_rel3_recursive_1`],
      },
      {
        user: `${U}:${OL}_rel1_only`,
        type: S,
        relation: OL,
        context: INVALID_CONTEXT,
        expect: [`${S}:${OL}_rel1_only`, `${S}:${OL}_rel1_only_recursive_1`],
      },
      {
        user: `${U}:${OL}_direct`,
        type: S,
        relation: OL,
        context: INVALID_CONTEXT,
        expect: [`${S}:${OL}_direct`, `${S}:${OL}_direct_recursive_1`],
      },
      {
        user: `${U}:${OL}_rel2_rel3_cond`,
        type: S,
        relation: OL,
        context: VALID_CONTEXT,
        expect: [
          `${S}:${OL}_rel2_rel3_cond`,
          `${S}:${OL}_rel2_rel3_cond_recursive_1`,
        ],
      },
      {
        user: `${U}:${OL}_rel2_rel3_cond`,
        type: S,
        relation: OL,
        context: INVALID_CONTEXT,
        expect: [],
      },
      {
        user: `${U}:${OL}_rel2_nocond_rel3_cond`,
        type: S,
        relation: OL,
        context: VALID_CONTEXT,
        expect: [`${S}:${OL}_rel2_nocond_rel3_cond`],
      },
      {
        user: `${U}:${OL}_rel2_nocond_rel3_cond`,
        type: S,
        relation: OL,
        context: INVALID_CONTEXT,
        expect: [],
      },
    ],
  },
  {
    name: "usersets_tuple_cycle_len2_userset",
    tuples: [
      {
        object: `${S}:len2_1`,
        relation: "tuple_cycle_len2_userset",
        user: `${D}:len2_1#tuple_cycle_len2_userset`,
      },
      {
        object: `${D}:len2_1`,
        relation: "tuple_cycle_len2_userset",
        user: `${S}:len2_2#tuple_cycle_len2_userset`,
      },
      {
        object: `${S}:len2_2`,
        relation: "tuple_cycle_len2_userset",
        user: `${U}:len2_anne`,
      },
      {
        object: `${D}:len2_2`,
        relation: "tuple_cycle_len2_userset",
        user: `${S}:len2_1#tuple_cycle_len2_userset`,
      },
      {
        object: `${S}:len2_2`,
        relation: "tuple_cycle_len2_userset",
        user: `${DE}:len2_1#tuple_cycle_len2_userset`,
        condition: COND,
      },
      {
        object: `${DE}:len2_1`,
        relation: "tuple_cycle_len2_userset",
        user: `${E}:len2_bob`,
      },
    ],
    assertions: [
      {
        user: `${U}:len2_anne`,
        type: S,
        relation: "tuple_cycle_len2_userset",
        expect: [`${S}:len2_1`, `${S}:len2_2`],
      },
      {
        user: `${U}:len2_anne`,
        type: D,
        relation: "tuple_cycle_len2_userset",
        expect: [`${D}:len2_1`, `${D}:len2_2`],
      },
      {
        user: `${E}:len2_bob`,
        type: D,
        relation: "tuple_cycle_len2_userset",
        context: VALID_CONTEXT,
        expect: [`${D}:len2_1`, `${D}:len2_2`],
      },
      {
        user: `${E}:len2_bob`,
        type: D,
        relation: "tuple_cycle_len2_userset",
        context: INVALID_CONTEXT,
        expect: [],
      },
      {
        user: `${E}:len2_bob`,
        type: S,
        relation: "tuple_cycle_len2_userset",
        context: VALID_CONTEXT,
        expect: [`${S}:len2_1`, `${S}:len2_2`],
      },
      {
        user: `${DE}:len2_1#tuple_cycle_len2_userset`,
        type: S,
        relation: "tuple_cycle_len2_userset",
        context: VALID_CONTEXT,
        expect: [`${S}:len2_1`, `${S}:len2_2`],
      },
      {
        user: `${DE}:len2_1#tuple_cycle_len2_userset`,
        type: D,
        relation: "tuple_cycle_len2_userset",
        context: VALID_CONTEXT,
        expect: [`${D}:len2_1`, `${D}:len2_2`],
      },
    ],
  },
];

describe("listObjects matrix — usersets", () => {
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
