import { afterAll, beforeAll, describe, test } from "bun:test";
import type { TsfgaClient } from "@tsfga/core";
import type { DB } from "@tsfga/kysely";
import type { Kysely } from "kysely";
import { MATRIX_HELPERS, MATRIX_MOVED } from "./complexity-matrix/configs.ts";
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
} from "./complexity-matrix/harness.ts";
import {
  expectConfigsMatchModel,
  expectListObjectsConformance,
  type FixtureRecord,
} from "./helpers/conformance.ts";

/**
 * The three `listobjects` matrix cases `listobjects-matrix-usersets`
 * leaves on the table:
 * `usersets_user_userset_intersect_mixed`,
 * `usersets_user_userset_exclude_mixed` and
 * `usersets_tuple_cycle_len3`
 * (`tests/listobjects/matrix_usersets.go`, v1.18.2).
 *
 * They are the only part of the upstream ListObjects matrix that
 * stacks **three rewrite kinds**: a `complexity3` TTU whose
 * computed relation is itself an intersection-over-a-userset, and
 * a `complexity3` userset whose referenced relation is that same
 * intersection. `tuple_cycle_len3` closes a cycle across three
 * object types rather than two.
 *
 * Every tuple, request and expected object set is upstream's,
 * transcribed. Type names carry the `_c1` suffix and nothing else
 * moved.
 */

const U = "user_c1";
const E = "employee_c1";
const D = "directs_c1";
const DE = "directs_employee_c1";
const S = "usersets_user_c1";
const C3 = "complexity3_c1";

/** Upstream's stems, kept verbatim. */
const IM = "userset_intersect_mixed";
const EM = "userset_exclude_mixed";
const L3 = "usersets_tuple_cycle_len3";
const AC = "alg_combined_computed";
const COND = "xcond_c1";

const CASES: MatrixCase[] = [
  {
    name: "usersets_user_userset_intersect_mixed",
    tuples: [
      // Direct user assignment intersecting the union's single arm.
      { object: `${S}:${IM}_1`, relation: IM, user: `${U}:${IM}_1` },
      { object: `${S}:${IM}_1`, relation: "user_rel1", user: `${U}:${IM}_1` },
      {
        object: `${C3}:${IM}_1`,
        relation: "userset_parent",
        user: `${S}:${IM}_1`,
      },
      {
        object: `${C3}:${IM}_1`,
        relation: "userset_userset_intersect_mixed",
        user: `${S}:${IM}_1#${IM}`,
      },

      // Direct user assignment intersecting the union's `and` arm.
      { object: `${S}:${IM}_2`, relation: IM, user: `${U}:${IM}_2` },
      { object: `${S}:${IM}_2`, relation: "user_rel2", user: `${U}:${IM}_2` },
      { object: `${S}:${IM}_2`, relation: "user_rel3", user: `${U}:${IM}_2` },
      {
        object: `${C3}:${IM}_2`,
        relation: "userset_parent",
        user: `${S}:${IM}_2`,
      },
      {
        object: `${C3}:${IM}_2`,
        relation: "userset_userset_intersect_mixed",
        user: `${S}:${IM}_2#${IM}`,
      },

      // Missing assignment: no object.
      { object: `${S}:${IM}_3`, relation: "user_rel1", user: `${U}:${IM}_3` },
      {
        object: `${C3}:${IM}_3`,
        relation: "userset_parent",
        user: `${S}:${IM}_3`,
      },
      {
        object: `${C3}:${IM}_3`,
        relation: "userset_userset_intersect_mixed",
        user: `${S}:${IM}_3#${IM}`,
      },

      { object: `${S}:${IM}_4`, relation: "user_rel2", user: `${U}:${IM}_4` },
      { object: `${S}:${IM}_4`, relation: "user_rel3", user: `${U}:${IM}_4` },
      {
        object: `${C3}:${IM}_4`,
        relation: "userset_parent",
        user: `${S}:${IM}_4`,
      },
      {
        object: `${C3}:${IM}_4`,
        relation: "userset_userset_intersect_mixed",
        user: `${S}:${IM}_4#${IM}`,
      },

      { object: `${S}:${IM}_5`, relation: IM, user: `${U}:${IM}_5` },
      {
        object: `${C3}:${IM}_5`,
        relation: "userset_parent",
        user: `${S}:${IM}_5`,
      },
      {
        object: `${C3}:${IM}_5`,
        relation: "userset_userset_intersect_mixed",
        user: `${S}:${IM}_5#${IM}`,
      },

      // Matching through the `directs#alg_combined_oneline` route.
      { object: `${D}:${IM}_6`, relation: "direct", user: `${U}:${IM}_6` },
      { object: `${D}:${IM}_6`, relation: "other_rel", user: `${U}:${IM}_6` },
      {
        object: `${S}:${IM}_6`,
        relation: IM,
        user: `${D}:${IM}_6#alg_combined_oneline`,
      },
      { object: `${S}:${IM}_6`, relation: "user_rel1", user: `${U}:${IM}_6` },
      {
        object: `${C3}:${IM}_6`,
        relation: "userset_parent",
        user: `${S}:${IM}_6`,
      },
      {
        object: `${C3}:${IM}_6`,
        relation: "userset_userset_intersect_mixed",
        user: `${S}:${IM}_6#${IM}`,
      },

      // Same route, missing `other_rel`.
      { object: `${D}:${IM}_7`, relation: "direct", user: `${U}:${IM}_7` },
      {
        object: `${S}:${IM}_7`,
        relation: IM,
        user: `${D}:${IM}_7#alg_combined_oneline`,
      },
      { object: `${S}:${IM}_7`, relation: "user_rel1", user: `${U}:${IM}_7` },
      {
        object: `${C3}:${IM}_7`,
        relation: "userset_parent",
        user: `${S}:${IM}_7`,
      },
      {
        object: `${C3}:${IM}_7`,
        relation: "userset_userset_intersect_mixed",
        user: `${S}:${IM}_7#${IM}`,
      },

      // Wildcard on the intersection's left operand.
      { object: `${S}:${IM}_8`, relation: IM, user: `${U}:*` },
      { object: `${S}:${IM}_8`, relation: "user_rel1", user: `${U}:${IM}_8` },
      {
        object: `${C3}:${IM}_8`,
        relation: "userset_parent",
        user: `${S}:${IM}_8`,
      },
      {
        object: `${C3}:${IM}_8`,
        relation: "userset_userset_intersect_mixed",
        user: `${S}:${IM}_8#${IM}`,
      },

      // Wildcard on the right.
      { object: `${S}:${IM}_9`, relation: IM, user: `${U}:${IM}_9` },
      { object: `${S}:${IM}_9`, relation: "user_rel1", user: `${U}:*` },
      {
        object: `${C3}:${IM}_9`,
        relation: "userset_parent",
        user: `${S}:${IM}_9`,
      },
      {
        object: `${C3}:${IM}_9`,
        relation: "userset_userset_intersect_mixed",
        user: `${S}:${IM}_9#${IM}`,
      },

      // Wildcard reached through the `directs` route.
      { object: `${D}:${IM}_10`, relation: "direct", user: `${U}:${IM}_10` },
      { object: `${D}:${IM}_10`, relation: "other_rel", user: `${U}:*` },
      {
        object: `${S}:${IM}_10`,
        relation: IM,
        user: `${D}:${IM}_10#alg_combined_oneline`,
      },
      { object: `${S}:${IM}_10`, relation: "user_rel1", user: `${U}:${IM}_10` },
      {
        object: `${C3}:${IM}_10`,
        relation: "userset_parent",
        user: `${S}:${IM}_10`,
      },
      {
        object: `${C3}:${IM}_10`,
        relation: "userset_userset_intersect_mixed",
        user: `${S}:${IM}_10#${IM}`,
      },
    ],
    assertions: [
      { user: `${U}:${IM}_1`, type: S, relation: IM, expect: [`${S}:${IM}_1`] },
      {
        user: `${U}:${IM}_1`,
        type: C3,
        relation: "ttu_userset_intersect_mixed",
        expect: [`${C3}:${IM}_1`],
      },
      {
        user: `${U}:${IM}_1`,
        type: C3,
        relation: "userset_userset_intersect_mixed",
        expect: [`${C3}:${IM}_1`],
      },
      { user: `${U}:${IM}_2`, type: S, relation: IM, expect: [`${S}:${IM}_2`] },
      {
        user: `${U}:${IM}_2`,
        type: C3,
        relation: "ttu_userset_intersect_mixed",
        expect: [`${C3}:${IM}_2`],
      },
      {
        user: `${U}:${IM}_2`,
        type: C3,
        relation: "userset_userset_intersect_mixed",
        expect: [`${C3}:${IM}_2`],
      },
      { user: `${U}:${IM}_3`, type: S, relation: IM, expect: [] },
      {
        user: `${U}:${IM}_3`,
        type: C3,
        relation: "ttu_userset_intersect_mixed",
        expect: [],
      },
      {
        user: `${U}:${IM}_3`,
        type: C3,
        relation: "userset_userset_intersect_mixed",
        expect: [],
      },
      { user: `${U}:${IM}_4`, type: S, relation: IM, expect: [] },
      {
        user: `${U}:${IM}_4`,
        type: C3,
        relation: "ttu_userset_intersect_mixed",
        expect: [],
      },
      {
        user: `${U}:${IM}_4`,
        type: C3,
        relation: "userset_userset_intersect_mixed",
        expect: [],
      },
      { user: `${U}:${IM}_5`, type: S, relation: IM, expect: [] },
      {
        user: `${U}:${IM}_5`,
        type: C3,
        relation: "ttu_userset_intersect_mixed",
        expect: [],
      },
      {
        user: `${U}:${IM}_5`,
        type: C3,
        relation: "userset_userset_intersect_mixed",
        expect: [],
      },
      { user: `${U}:${IM}_6`, type: S, relation: IM, expect: [`${S}:${IM}_6`] },
      {
        user: `${U}:${IM}_6`,
        type: C3,
        relation: "ttu_userset_intersect_mixed",
        expect: [`${C3}:${IM}_6`],
      },
      {
        user: `${U}:${IM}_6`,
        type: C3,
        relation: "userset_userset_intersect_mixed",
        expect: [`${C3}:${IM}_6`],
      },
      { user: `${U}:${IM}_7`, type: S, relation: IM, expect: [] },
      {
        user: `${U}:${IM}_7`,
        type: C3,
        relation: "ttu_userset_intersect_mixed",
        expect: [],
      },
      {
        user: `${U}:${IM}_7`,
        type: C3,
        relation: "userset_userset_intersect_mixed",
        expect: [],
      },
      { user: `${U}:${IM}_8`, type: S, relation: IM, expect: [`${S}:${IM}_8`] },
      {
        user: `${U}:${IM}_8`,
        type: C3,
        relation: "ttu_userset_intersect_mixed",
        expect: [`${C3}:${IM}_8`],
      },
      {
        user: `${U}:${IM}_8`,
        type: C3,
        relation: "userset_userset_intersect_mixed",
        expect: [`${C3}:${IM}_8`],
      },
      { user: `${U}:${IM}_9`, type: S, relation: IM, expect: [`${S}:${IM}_9`] },
      {
        user: `${U}:${IM}_9`,
        type: C3,
        relation: "ttu_userset_intersect_mixed",
        expect: [`${C3}:${IM}_9`],
      },
      {
        user: `${U}:${IM}_9`,
        type: C3,
        relation: "userset_userset_intersect_mixed",
        expect: [`${C3}:${IM}_9`],
      },
      {
        user: `${U}:${IM}_10`,
        type: S,
        relation: IM,
        expect: [`${S}:${IM}_10`],
      },
      {
        user: `${U}:${IM}_10`,
        type: C3,
        relation: "ttu_userset_intersect_mixed",
        expect: [`${C3}:${IM}_10`],
      },
      {
        user: `${U}:${IM}_10`,
        type: C3,
        relation: "userset_userset_intersect_mixed",
        expect: [`${C3}:${IM}_10`],
      },
    ],
  },
  {
    name: "usersets_user_userset_exclude_mixed",
    tuples: [
      // Direct assignment with no corresponding exclude assignment.
      { object: `${S}:${EM}_1`, relation: EM, user: `${U}:${EM}_1` },
      {
        object: `${C3}:${EM}_1`,
        relation: "userset_parent",
        user: `${S}:${EM}_1`,
      },
      {
        object: `${C3}:${EM}_1`,
        relation: "userset_userset_exclude_mixed",
        user: `${S}:${EM}_1#${EM}`,
      },

      // Direct assignment with a corresponding exclude assignment.
      { object: `${S}:${EM}_2`, relation: EM, user: `${U}:${EM}_2` },
      { object: `${S}:${EM}_2`, relation: IM, user: `${U}:${EM}_2` },
      { object: `${S}:${EM}_2`, relation: "user_rel1", user: `${U}:${EM}_2` },
      {
        object: `${C3}:${EM}_2`,
        relation: "userset_parent",
        user: `${S}:${EM}_2`,
      },
      {
        object: `${C3}:${EM}_2`,
        relation: "userset_userset_exclude_mixed",
        user: `${S}:${EM}_2#${EM}`,
      },

      // The exclude assignment does not fully hold.
      { object: `${S}:${EM}_3`, relation: EM, user: `${U}:${EM}_3` },
      { object: `${S}:${EM}_3`, relation: "user_rel1", user: `${U}:${EM}_3` },
      {
        object: `${C3}:${EM}_3`,
        relation: "userset_parent",
        user: `${S}:${EM}_3`,
      },
      {
        object: `${C3}:${EM}_3`,
        relation: "userset_userset_exclude_mixed",
        user: `${S}:${EM}_3#${EM}`,
      },

      { object: `${S}:${EM}_4`, relation: EM, user: `${U}:${EM}_4` },
      { object: `${S}:${EM}_4`, relation: IM, user: `${U}:${EM}_4` },
      {
        object: `${C3}:${EM}_4`,
        relation: "userset_parent",
        user: `${S}:${EM}_4`,
      },
      {
        object: `${C3}:${EM}_4`,
        relation: "userset_userset_exclude_mixed",
        user: `${S}:${EM}_4#${EM}`,
      },

      // Through `directs#alg_combined_oneline`.
      { object: `${S}:${EM}_5`, relation: EM, user: `${U}:${EM}_5` },
      { object: `${D}:${EM}_5`, relation: "direct", user: `${U}:${EM}_5` },
      { object: `${D}:${EM}_5`, relation: "other_rel", user: `${U}:${EM}_5` },
      {
        object: `${S}:${EM}_5`,
        relation: IM,
        user: `${D}:${EM}_5#alg_combined_oneline`,
      },
      { object: `${S}:${EM}_5`, relation: "user_rel1", user: `${U}:${EM}_5` },
      {
        object: `${C3}:${EM}_5`,
        relation: "userset_parent",
        user: `${S}:${EM}_5`,
      },
      {
        object: `${C3}:${EM}_5`,
        relation: "userset_userset_exclude_mixed",
        user: `${S}:${EM}_5#${EM}`,
      },

      { object: `${S}:${EM}_6`, relation: EM, user: `${U}:${EM}_6` },
      { object: `${D}:${EM}_6`, relation: "direct", user: `${U}:${EM}_6` },
      {
        object: `${S}:${EM}_6`,
        relation: IM,
        user: `${D}:${EM}_6#alg_combined_oneline`,
      },
      { object: `${S}:${EM}_6`, relation: "user_rel1", user: `${U}:${EM}_6` },
      {
        object: `${C3}:${EM}_6`,
        relation: "userset_parent",
        user: `${S}:${EM}_6`,
      },
      {
        object: `${C3}:${EM}_6`,
        relation: "userset_userset_exclude_mixed",
        user: `${S}:${EM}_6#${EM}`,
      },

      { object: `${S}:${EM}_7`, relation: EM, user: `${U}:${EM}_7` },
      { object: `${D}:${EM}_7`, relation: "direct", user: `${U}:${EM}_7` },
      { object: `${D}:${EM}_7`, relation: "other_rel", user: `${U}:*` },
      {
        object: `${S}:${EM}_7`,
        relation: IM,
        user: `${D}:${EM}_7#alg_combined_oneline`,
      },
      { object: `${S}:${EM}_7`, relation: "user_rel1", user: `${U}:${EM}_7` },
      {
        object: `${C3}:${EM}_7`,
        relation: "userset_parent",
        user: `${S}:${EM}_7`,
      },
      {
        object: `${C3}:${EM}_7`,
        relation: "userset_userset_exclude_mixed",
        user: `${S}:${EM}_7#${EM}`,
      },
    ],
    assertions: [
      { user: `${U}:${EM}_1`, type: S, relation: EM, expect: [`${S}:${EM}_1`] },
      {
        user: `${U}:${EM}_1`,
        type: C3,
        relation: "ttu_userset_exclude_mixed",
        expect: [`${C3}:${EM}_1`],
      },
      {
        user: `${U}:${EM}_1`,
        type: C3,
        relation: "userset_userset_exclude_mixed",
        expect: [`${C3}:${EM}_1`],
      },
      { user: `${U}:${EM}_2`, type: S, relation: EM, expect: [] },
      {
        user: `${U}:${EM}_2`,
        type: C3,
        relation: "ttu_userset_exclude_mixed",
        expect: [],
      },
      {
        user: `${U}:${EM}_2`,
        type: C3,
        relation: "userset_userset_exclude_mixed",
        expect: [],
      },
      { user: `${U}:${EM}_3`, type: S, relation: EM, expect: [`${S}:${EM}_3`] },
      {
        user: `${U}:${EM}_3`,
        type: C3,
        relation: "ttu_userset_exclude_mixed",
        expect: [`${C3}:${EM}_3`],
      },
      {
        user: `${U}:${EM}_3`,
        type: C3,
        relation: "userset_userset_exclude_mixed",
        expect: [`${C3}:${EM}_3`],
      },
      { user: `${U}:${EM}_4`, type: S, relation: EM, expect: [`${S}:${EM}_4`] },
      {
        user: `${U}:${EM}_4`,
        type: C3,
        relation: "ttu_userset_exclude_mixed",
        expect: [`${C3}:${EM}_4`],
      },
      {
        user: `${U}:${EM}_4`,
        type: C3,
        relation: "userset_userset_exclude_mixed",
        expect: [`${C3}:${EM}_4`],
      },
      { user: `${U}:${EM}_5`, type: S, relation: EM, expect: [] },
      {
        user: `${U}:${EM}_5`,
        type: C3,
        relation: "ttu_userset_exclude_mixed",
        expect: [],
      },
      {
        user: `${U}:${EM}_5`,
        type: C3,
        relation: "userset_userset_exclude_mixed",
        expect: [],
      },
      { user: `${U}:${EM}_6`, type: S, relation: EM, expect: [`${S}:${EM}_6`] },
      {
        user: `${U}:${EM}_6`,
        type: C3,
        relation: "ttu_userset_exclude_mixed",
        expect: [`${C3}:${EM}_6`],
      },
      {
        user: `${U}:${EM}_6`,
        type: C3,
        relation: "userset_userset_exclude_mixed",
        expect: [`${C3}:${EM}_6`],
      },
      { user: `${U}:${EM}_7`, type: S, relation: EM, expect: [] },
      {
        user: `${U}:${EM}_7`,
        type: C3,
        relation: "ttu_userset_exclude_mixed",
        expect: [],
      },
      {
        user: `${U}:${EM}_7`,
        type: C3,
        relation: "userset_userset_exclude_mixed",
        expect: [],
      },
    ],
  },
  {
    name: "usersets_tuple_cycle_len3",
    tuples: [
      // The non-cycle chain: complexity3 → directs → usersets-user,
      // then back into complexity3 through `userset_parent`.
      {
        object: `${D}:${L3}_1`,
        relation: "tuple_cycle_len3",
        user: `${C3}:${L3}_1#tuple_cycle_len3`,
      },
      {
        object: `${S}:${L3}_1`,
        relation: "tuple_cycle_len3",
        user: `${D}:${L3}_1#tuple_cycle_len3`,
      },
      {
        object: `${C3}:${L3}_2`,
        relation: "userset_parent",
        user: `${S}:${L3}_1`,
      },
      {
        object: `${D}:${L3}_2`,
        relation: "tuple_cycle_len3",
        user: `${C3}:${L3}_2#tuple_cycle_len3`,
      },
      {
        object: `${S}:${L3}_2`,
        relation: "tuple_cycle_len3",
        user: `${D}:${L3}_2#tuple_cycle_len3`,
      },
      {
        object: `${C3}:${L3}_3`,
        relation: "userset_parent",
        user: `${S}:${L3}_2`,
      },
      {
        object: `${D}:${L3}_3`,
        relation: "tuple_cycle_len3",
        user: `${C3}:${L3}_3#tuple_cycle_len3`,
      },
      {
        object: `${S}:${L3}_3`,
        relation: "tuple_cycle_len3",
        user: `${D}:${L3}_3#tuple_cycle_len3`,
      },

      {
        object: `${C3}:${L3}_1`,
        relation: "tuple_cycle_len3",
        user: `${U}:${L3}_1_complex3_assign`,
      },
      {
        object: `${D}:${L3}_1`,
        relation: "tuple_cycle_len3",
        user: `${U}:${L3}_1_direct_assign`,
      },
      {
        object: `${C3}:${L3}_2`,
        relation: "tuple_cycle_len3",
        user: `${U}:${L3}_2_complex3_assign`,
      },
      {
        object: `${D}:${L3}_2`,
        relation: "tuple_cycle_len3",
        user: `${U}:${L3}_2_direct_assign`,
      },
      {
        object: `${C3}:${L3}_3`,
        relation: "tuple_cycle_len3",
        user: `${U}:${L3}_3_complex3_assign`,
      },
      {
        object: `${D}:${L3}_3`,
        relation: "tuple_cycle_len3",
        user: `${U}:${L3}_3_direct_assign`,
      },

      // The closed cycle.
      {
        object: `${D}:${L3}_cycle`,
        relation: "tuple_cycle_len3",
        user: `${C3}:${L3}_cycle#tuple_cycle_len3`,
      },
      {
        object: `${S}:${L3}_cycle`,
        relation: "tuple_cycle_len3",
        user: `${D}:${L3}_cycle#tuple_cycle_len3`,
      },
      {
        object: `${C3}:${L3}_cycle`,
        relation: "userset_parent",
        user: `${S}:${L3}_cycle`,
      },
      {
        object: `${D}:${L3}_cycle`,
        relation: "tuple_cycle_len3",
        user: `${C3}:${L3}_cycle_1#tuple_cycle_len3`,
      },
      {
        object: `${S}:${L3}_cycle_1`,
        relation: "tuple_cycle_len3",
        user: `${D}:${L3}_cycle_1#tuple_cycle_len3`,
      },
      {
        object: `${C3}:${L3}_cycle_1`,
        relation: "userset_parent",
        user: `${S}:${L3}_cycle_1`,
      },
      {
        object: `${D}:${L3}_cycle_1`,
        relation: "tuple_cycle_len3",
        user: `${C3}:${L3}_cycle_1#tuple_cycle_len3`,
      },
      {
        object: `${C3}:${L3}_cycle_1`,
        relation: "tuple_cycle_len3",
        user: `${U}:${L3}_cycle`,
      },

      // Several paths reaching the same object.
      {
        object: `${D}:${L3}_multiple_1`,
        relation: "tuple_cycle_len3",
        user: `${C3}:${L3}_multiple_1#tuple_cycle_len3`,
      },
      {
        object: `${DE}:${L3}_multiple_1`,
        relation: "tuple_cycle_len3",
        user: `${C3}:${L3}_multiple_1#tuple_cycle_len3`,
      },
      {
        object: `${S}:${L3}_multiple_1`,
        relation: "tuple_cycle_len3",
        user: `${D}:${L3}_multiple_1#tuple_cycle_len3`,
      },
      {
        object: `${S}:${L3}_multiple_1`,
        relation: "tuple_cycle_len3",
        user: `${DE}:${L3}_multiple_1#tuple_cycle_len3`,
      },
      {
        object: `${C3}:${L3}_multiple_2`,
        relation: "userset_parent",
        user: `${S}:${L3}_multiple_1`,
      },
      {
        object: `${D}:${L3}_multiple_2`,
        relation: "tuple_cycle_len3",
        user: `${C3}:${L3}_multiple_2#tuple_cycle_len3`,
      },
      {
        object: `${DE}:${L3}_multiple_2`,
        relation: "tuple_cycle_len3",
        user: `${C3}:${L3}_multiple_2#tuple_cycle_len3`,
      },
      {
        object: `${S}:${L3}_multiple_2`,
        relation: "tuple_cycle_len3",
        user: `${D}:${L3}_multiple_2#tuple_cycle_len3`,
      },
      {
        object: `${S}:${L3}_multiple_2`,
        relation: "tuple_cycle_len3",
        user: `${DE}:${L3}_multiple_2#tuple_cycle_len3`,
      },
      {
        object: `${C3}:${L3}_multiple_3`,
        relation: "userset_parent",
        user: `${S}:${L3}_multiple_2`,
      },
      {
        object: `${D}:${L3}_multiple_3`,
        relation: "tuple_cycle_len3",
        user: `${C3}:${L3}_multiple_3#tuple_cycle_len3`,
      },
      {
        object: `${DE}:${L3}_multiple_3`,
        relation: "tuple_cycle_len3",
        user: `${C3}:${L3}_multiple_3#tuple_cycle_len3`,
      },
      {
        object: `${S}:${L3}_multiple_3`,
        relation: "tuple_cycle_len3",
        user: `${D}:${L3}_multiple_3#tuple_cycle_len3`,
      },
      {
        object: `${S}:${L3}_multiple_3`,
        relation: "tuple_cycle_len3",
        user: `${DE}:${L3}_multiple_3#tuple_cycle_len3`,
      },
      {
        object: `${D}:${L3}_multiple_1`,
        relation: "tuple_cycle_len3",
        user: `${E}:${L3}_multiple_1_direct_assign`,
      },
      {
        object: `${DE}:${L3}_multiple_1`,
        relation: "tuple_cycle_len3",
        user: `${E}:${L3}_multiple_1_direct_assign`,
      },
      {
        object: `${DE}:${L3}_multiple_1`,
        relation: "tuple_cycle_len3",
        user: `${E}:${L3}_multiple_1_employee_only`,
      },
    ],
    assertions: [
      {
        user: `${U}:${L3}_1_complex3_assign`,
        type: S,
        relation: "tuple_cycle_len3",
        context: VALID_CONTEXT,
        expect: [`${S}:${L3}_1`, `${S}:${L3}_2`, `${S}:${L3}_3`],
      },
      {
        user: `${U}:${L3}_1_direct_assign`,
        type: S,
        relation: "tuple_cycle_len3",
        context: VALID_CONTEXT,
        expect: [`${S}:${L3}_1`, `${S}:${L3}_2`, `${S}:${L3}_3`],
      },
      {
        user: `${U}:${L3}_2_complex3_assign`,
        type: S,
        relation: "tuple_cycle_len3",
        context: VALID_CONTEXT,
        expect: [`${S}:${L3}_2`, `${S}:${L3}_3`],
      },
      {
        user: `${U}:${L3}_2_direct_assign`,
        type: S,
        relation: "tuple_cycle_len3",
        context: VALID_CONTEXT,
        expect: [`${S}:${L3}_2`, `${S}:${L3}_3`],
      },
      {
        user: `${U}:${L3}_3_complex3_assign`,
        type: S,
        relation: "tuple_cycle_len3",
        context: VALID_CONTEXT,
        expect: [`${S}:${L3}_3`],
      },
      {
        user: `${U}:${L3}_3_direct_assign`,
        type: S,
        relation: "tuple_cycle_len3",
        context: VALID_CONTEXT,
        expect: [`${S}:${L3}_3`],
      },
      {
        user: `${U}:${L3}_cycle`,
        type: S,
        relation: "tuple_cycle_len3",
        context: VALID_CONTEXT,
        expect: [`${S}:${L3}_cycle`, `${S}:${L3}_cycle_1`],
      },
      {
        user: `${E}:${L3}_multiple_1_direct_assign`,
        type: S,
        relation: "tuple_cycle_len3",
        context: VALID_CONTEXT,
        expect: [
          `${S}:${L3}_multiple_1`,
          `${S}:${L3}_multiple_2`,
          `${S}:${L3}_multiple_3`,
        ],
      },
      {
        user: `${E}:${L3}_multiple_1_employee_only`,
        type: S,
        relation: "tuple_cycle_len3",
        context: VALID_CONTEXT,
        expect: [
          `${S}:${L3}_multiple_1`,
          `${S}:${L3}_multiple_2`,
          `${S}:${L3}_multiple_3`,
        ],
      },
    ],
  },
  {
    // Upstream's `alg_combined_computed`, the fourth case the
    // `listobjects-matrix` port leaves out. It reads
    // `(userset or userset_alg_combined) and userset_combined_cond
    //  but not userset_alg_combined_oneline`
    // through a computed userset, so a single object exercises a
    // union, an intersection, an exclusion and a userset leaf at
    // once.
    name: "alg_combined_computed",
    tuples: [
      // The subject is in both `userset` and `userset_combined_cond`
      // through one `directs` object.
      {
        object: `${S}:${AC}_only`,
        relation: "userset",
        user: `${D}:${AC}_only#direct_comb`,
      },
      {
        object: `${S}:${AC}_only`,
        relation: "userset_combined_cond",
        user: `${D}:${AC}_only#computed_mult_types`,
        condition: COND,
      },
      {
        object: `${D}:${AC}_only`,
        relation: "direct_comb",
        user: `${U}:${AC}_only`,
      },
      {
        object: `${D}:${AC}_only`,
        relation: "direct_mult_types",
        user: `${U}:${AC}_only`,
      },

      // The same, through two different `directs` objects.
      {
        object: `${S}:${AC}_only_1`,
        relation: "userset",
        user: `${D}:${AC}_only_1a#direct_comb`,
      },
      {
        object: `${S}:${AC}_only_1`,
        relation: "userset_combined_cond",
        user: `${D}:${AC}_only_1b#computed_mult_types`,
        condition: COND,
      },
      {
        object: `${D}:${AC}_only_1a`,
        relation: "direct_comb",
        user: `${U}:${AC}_only_1`,
      },
      {
        object: `${D}:${AC}_only_1b`,
        relation: "direct_mult_types",
        user: `${U}:${AC}_only_1`,
      },

      // `userset_alg_combined` instead, which fails because
      // `direct_comb` is on the subtracted side.
      {
        object: `${S}:${AC}_alg_combined`,
        relation: "userset_alg_combined",
        user: `${D}:${AC}_alg_combined#alg_combined`,
      },
      {
        object: `${S}:${AC}_alg_combined`,
        relation: "userset_combined_cond",
        user: `${D}:${AC}_alg_combined#computed_mult_types`,
        condition: COND,
      },
      {
        object: `${D}:${AC}_alg_combined`,
        relation: "direct_comb",
        user: `${U}:${AC}_alg_combined`,
      },
      {
        object: `${D}:${AC}_alg_combined`,
        relation: "other_rel",
        user: `${U}:${AC}_alg_combined`,
      },
      {
        object: `${D}:${AC}_alg_combined`,
        relation: "direct_mult_types",
        user: `${U}:${AC}_alg_combined`,
      },
      // The same object, a subject for whom `alg_combined` holds.
      {
        object: `${D}:${AC}_alg_combined`,
        relation: "direct_mult_types",
        user: `${U}:${AC}_alg_combined_direct_mult_types`,
      },
      {
        object: `${D}:${AC}_alg_combined`,
        relation: "other_rel",
        user: `${U}:${AC}_alg_combined_direct_mult_types`,
      },
      // And one for whom `direct` puts it back on the subtracted side.
      {
        object: `${D}:${AC}_alg_combined`,
        relation: "direct",
        user: `${U}:${AC}_alg_combined_direct`,
      },
      {
        object: `${D}:${AC}_alg_combined`,
        relation: "other_rel",
        user: `${U}:${AC}_alg_combined_direct`,
      },
      {
        object: `${D}:${AC}_alg_combined`,
        relation: "direct_mult_types",
        user: `${U}:${AC}_alg_combined_direct`,
      },
      // Missing `other_rel`, so the inner intersection fails.
      {
        object: `${D}:${AC}_alg_combined`,
        relation: "direct_mult_types",
        user: `${U}:${AC}_alg_combined_missing_other_rel`,
      },

      // `userset_alg_combined_oneline` holds at the top, which
      // subtracts the whole thing away.
      {
        object: `${S}:${AC}_only_2`,
        relation: "userset",
        user: `${D}:${AC}_only_2a#direct_comb`,
      },
      {
        object: `${S}:${AC}_only_2`,
        relation: "userset_combined_cond",
        user: `${D}:${AC}_only_2b#computed_mult_types`,
        condition: COND,
      },
      {
        object: `${S}:${AC}_only_2`,
        relation: "userset_alg_combined_oneline",
        user: `${D}:${AC}_only_2c#alg_combined_oneline`,
      },
      {
        object: `${D}:${AC}_only_2a`,
        relation: "direct_comb",
        user: `${U}:${AC}_only_2`,
      },
      {
        object: `${D}:${AC}_only_2b`,
        relation: "direct_mult_types",
        user: `${U}:${AC}_only_2`,
      },
      {
        object: `${D}:${AC}_only_2c`,
        relation: "direct",
        user: `${U}:${AC}_only_2`,
      },
      {
        object: `${D}:${AC}_only_2c`,
        relation: "other_rel",
        user: `${U}:${AC}_only_2`,
      },

      // `userset_combined_cond` missing entirely.
      {
        object: `${S}:${AC}_missing_combined`,
        relation: "userset",
        user: `${D}:${AC}_missing_combined#direct_comb`,
      },
      {
        object: `${D}:${AC}_missing_combined`,
        relation: "direct_comb",
        user: `${U}:${AC}_missing_combined`,
      },
    ],
    assertions: [
      {
        user: `${U}:${AC}_only`,
        type: S,
        relation: "alg_combined_computed",
        context: VALID_CONTEXT,
        expect: [`${S}:${AC}_only`],
      },
      {
        user: `${U}:${AC}_only`,
        type: S,
        relation: "alg_combined_computed",
        context: INVALID_CONTEXT,
        expect: [],
      },
      {
        user: `${U}:${AC}_only_1`,
        type: S,
        relation: "alg_combined_computed",
        context: VALID_CONTEXT,
        expect: [`${S}:${AC}_only_1`],
      },
      {
        user: `${U}:${AC}_only_1`,
        type: S,
        relation: "alg_combined_computed",
        context: INVALID_CONTEXT,
        expect: [],
      },
      {
        user: `${U}:${AC}_alg_combined`,
        type: S,
        relation: "alg_combined_computed",
        context: VALID_CONTEXT,
        expect: [],
      },
      {
        user: `${U}:${AC}_alg_combined_direct_mult_types`,
        type: S,
        relation: "alg_combined_computed",
        context: VALID_CONTEXT,
        expect: [`${S}:${AC}_alg_combined`],
      },
      {
        user: `${U}:${AC}_alg_combined_direct`,
        type: S,
        relation: "alg_combined_computed",
        context: VALID_CONTEXT,
        expect: [],
      },
      {
        user: `${U}:${AC}_alg_combined_missing_other_rel`,
        type: S,
        relation: "alg_combined_computed",
        context: VALID_CONTEXT,
        expect: [],
      },
      {
        user: `${U}:${AC}_only_2`,
        type: S,
        relation: "alg_combined_computed",
        context: VALID_CONTEXT,
        expect: [],
      },
      {
        user: `${U}:${AC}_missing_combined`,
        type: S,
        relation: "alg_combined_computed",
        context: VALID_CONTEXT,
        expect: [],
      },
    ],
  },
];

describe("c1: listObjects matrix — complexity3 and tuple_cycle_len3", () => {
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

      for (const [index, assertion] of (testCase.assertions ?? []).entries()) {
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
    expectConfigsMatchModel("./complexity-matrix/model.dsl", fixture, {
      coverage: "complete",
      tsfgaOnlyHelpers: MATRIX_HELPERS,
      moved: MATRIX_MOVED,
    });
  });
});
