import { afterAll, beforeAll, describe, test } from "bun:test";
import { createTsfga, type RelationConfig } from "@tsfga/core";
import type { DB } from "@tsfga/kysely";
import { KyselyTupleStore } from "@tsfga/kysely";
import type { Kysely } from "kysely";
import {
  expectConfigsMatchModel,
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
  type Corpus,
  cfg,
  ids,
  loadCorpus,
  runStages,
  type Stage,
} from "./matrix-corpus.ts";

/**
 * B1 corpus — usersets over tuple-to-usersets, and cycles.
 *
 * A port of upstream's own case matrix —
 * `tests/check/check_userset.go` at v1.18.2 — over the stages
 * listed below. Every `expected` is the `Expectation:` the Go
 * corpus states, so a shape both engines answer the same
 * *wrong* way still fails.
 *
 * Stages ported here:
 * - `ttu_direct_userset`
 * - `usersets_ttu_direct_cond_userset`
 * - `userset_ttu_or_direct_userset`
 * - `usersets_ttu_and_direct_userset`
 * - `usersets_tuple_cycle2`
 * - `usersets_tuple_cycle3`
 *
 * Upstream's `ErrorCode: 2000` (a check whose condition
 * parameter the request never supplied) is transcribed as
 * `"refused"`: both engines decline to answer rather than
 * denying.
 *
 * Types and the condition carry a `_b1f` suffix so this
 * fixture cannot collide with another fixture's rows in the
 * shared Postgres and OpenFGA.
 */

const USER = "user_b1f";
const EMPLOYEE = "employee_b1f";
const DU = "directs_user_b1f";
const DE = "directs_employee_b1f";
const UU = "usersets_user_b1f";
const TT = "ttus_b1f";
const C3 = "complexity3_b1f";
const XCOND = "xcond_b1f";

/** Upstream's object and subject names, as UUIDs. */
const u = ids(
  [
    "ttu_direct_userset/ttudu_1",
    "ttu_direct_userset/ttudu_2",
    "ttu_direct_userset/ttudu_3",
    "usersets_ttu_direct_cond_userset/ttdcu_1",
    "usersets_ttu_direct_cond_userset/ttdcu_2",
    "usersets_ttu_direct_cond_userset/ttdcu_5",
    "userset_ttu_or_direct_userset/ttuodu_1",
    "userset_ttu_or_direct_userset/ttuodu_2",
    "userset_ttu_or_direct_userset/ttuodu_3",
    "usersets_ttu_and_direct_userset/ttuadu_1",
    "usersets_ttu_and_direct_userset/ttuadu_2",
    "usersets_tuple_cycle2/utc2_1",
    "usersets_tuple_cycle2/utc2_4",
    "usersets_tuple_cycle2/utc2_3",
    "usersets_tuple_cycle3/utc3_1",
    "usersets_tuple_cycle3/utc3_4",
    "usersets_tuple_cycle3/utc3_2",
  ],
  "d480",
);

// Written in dependency order: a tupleset relation's config
// exists before the tuple-to-userset that names it, so
// `writeRelationConfig`'s tupleset gates can see it.
const CONFIGS: RelationConfig[] = [
  cfg(TT, "userset_parent", { directlyAssignable: [{ type: UU }] }),
  cfg(DU, "tuple_cycle3", {
    directlyAssignable: [
      { type: USER },
      { type: C3, relation: "cycle_nested" },
    ],
  }),
  cfg(DU, "compute_tuple_cycle3", { computedUserset: "tuple_cycle3" }),
  cfg(UU, "tuple_cycle3", {
    directlyAssignable: [{ type: DU, relation: "compute_tuple_cycle3" }],
  }),
  cfg(TT, "tuple_cycle3", {
    tupleToUserset: [
      { tupleset: "userset_parent", computedUserset: "tuple_cycle3" },
    ],
  }),
  cfg(C3, "cycle_nested", {
    directlyAssignable: [{ type: TT, relation: "tuple_cycle3" }],
  }),
  cfg(DE, "direct", { directlyAssignable: [{ type: EMPLOYEE }] }),
  cfg(DU, "direct_cond", {
    directlyAssignable: [{ type: USER, condition: XCOND }],
  }),
  cfg(DU, "computed_cond", { computedUserset: "direct_cond" }),
  cfg(DU, "direct_wild", {
    directlyAssignable: [{ type: USER, wildcard: true }],
  }),
  cfg(DU, "computed_wild", { computedUserset: "direct_wild" }),
  cfg(DU, "and_computed", {
    intersection: [
      { type: "computedUserset", relation: "computed_cond" },
      { type: "computedUserset", relation: "computed_wild" },
    ],
  }),
  cfg(DU, "direct", { directlyAssignable: [{ type: USER }] }),
  cfg(DU, "computed", { computedUserset: "direct" }),
  cfg(DU, "or_computed", {
    impliedBy: ["computed", "computed_cond", "direct_wild"],
  }),
  cfg(TT, "direct_parent", { directlyAssignable: [{ type: DU }] }),
  cfg(TT, "tuple_cycle2", {
    tupleToUserset: [
      { tupleset: "direct_parent", computedUserset: "tuple_cycle2" },
    ],
  }),
  cfg(UU, "tuple_cycle2", {
    directlyAssignable: [{ type: TT, relation: "tuple_cycle2" }],
  }),
  cfg(DU, "tuple_cycle2", {
    directlyAssignable: [
      { type: USER },
      { type: UU, relation: "tuple_cycle2" },
      { type: EMPLOYEE },
    ],
  }),
  cfg(TT, "direct_cond_parent", {
    directlyAssignable: [{ type: DU, condition: XCOND }],
  }),
  cfg(TT, "and_comp_from_direct_parent", {
    tupleToUserset: [
      { tupleset: "direct_cond_parent", computedUserset: "and_computed" },
    ],
  }),
  cfg(TT, "mult_parent_types_cond", {
    directlyAssignable: [
      { type: DU, condition: XCOND },
      { type: DE, condition: XCOND },
    ],
  }),
  cfg(TT, "direct_cond_pa_direct_ch", {
    tupleToUserset: [
      { tupleset: "mult_parent_types_cond", computedUserset: "direct" },
    ],
  }),
  cfg(TT, "mult_parent_types", {
    directlyAssignable: [{ type: DU }, { type: DE }],
  }),
  cfg(TT, "direct_pa_direct_ch", {
    tupleToUserset: [
      { tupleset: "mult_parent_types", computedUserset: "direct" },
    ],
  }),
  cfg(TT, "or_comp_from_direct_parent", {
    tupleToUserset: [
      { tupleset: "direct_parent", computedUserset: "or_computed" },
    ],
  }),
  cfg(UU, "ttu_and_direct_userset", {
    directlyAssignable: [{ type: TT, relation: "and_comp_from_direct_parent" }],
  }),
  cfg(UU, "ttu_direct_cond_userset", {
    directlyAssignable: [{ type: TT, relation: "direct_cond_pa_direct_ch" }],
  }),
  cfg(UU, "ttu_direct_userset", {
    directlyAssignable: [{ type: TT, relation: "direct_pa_direct_ch" }],
  }),
  cfg(UU, "ttu_or_direct_userset", {
    directlyAssignable: [{ type: TT, relation: "or_comp_from_direct_parent" }],
  }),
];

const STAGES: Stage[] = [
  {
    name: "ttu_direct_userset",
    tuples: [
      {
        objectType: DU,
        objectId: u("ttu_direct_userset/ttudu_1"),
        relation: "direct",
        subjectType: USER,
        subjectId: u("ttu_direct_userset/ttudu_1"),
      },
      {
        objectType: TT,
        objectId: u("ttu_direct_userset/ttudu_1"),
        relation: "mult_parent_types",
        subjectType: DU,
        subjectId: u("ttu_direct_userset/ttudu_1"),
      },
      {
        objectType: UU,
        objectId: u("ttu_direct_userset/ttudu_1"),
        relation: "ttu_direct_userset",
        subjectType: TT,
        subjectId: u("ttu_direct_userset/ttudu_1"),
        subjectRelation: "direct_pa_direct_ch",
      },
      {
        objectType: DE,
        objectId: u("ttu_direct_userset/ttudu_1"),
        relation: "direct",
        subjectType: EMPLOYEE,
        subjectId: u("ttu_direct_userset/ttudu_1"),
      },
      {
        objectType: TT,
        objectId: u("ttu_direct_userset/ttudu_2"),
        relation: "mult_parent_types",
        subjectType: DE,
        subjectId: u("ttu_direct_userset/ttudu_1"),
      },
      {
        objectType: UU,
        objectId: u("ttu_direct_userset/ttudu_2"),
        relation: "ttu_direct_userset",
        subjectType: TT,
        subjectId: u("ttu_direct_userset/ttudu_2"),
        subjectRelation: "direct_pa_direct_ch",
      },
    ],
    cases: [
      {
        name: "ttu_direct_userset/valid_user",
        objectType: UU,
        objectId: u("ttu_direct_userset/ttudu_1"),
        relation: "ttu_direct_userset",
        subjectType: USER,
        subjectId: u("ttu_direct_userset/ttudu_1"),
        expected: true,
      },
      {
        name: "ttu_direct_userset/invalid_user",
        objectType: UU,
        objectId: u("ttu_direct_userset/ttudu_1"),
        relation: "ttu_direct_userset",
        subjectType: USER,
        subjectId: u("ttu_direct_userset/ttudu_2"),
        expected: false,
      },
      {
        name: "ttu_direct_userset/valid_employee",
        objectType: UU,
        objectId: u("ttu_direct_userset/ttudu_2"),
        relation: "ttu_direct_userset",
        subjectType: EMPLOYEE,
        subjectId: u("ttu_direct_userset/ttudu_1"),
        expected: true,
      },
      {
        name: "ttu_direct_userset/invalid_employee",
        objectType: UU,
        objectId: u("ttu_direct_userset/ttudu_2"),
        relation: "ttu_direct_userset",
        subjectType: EMPLOYEE,
        subjectId: u("ttu_direct_userset/ttudu_2"),
        expected: false,
      },
      {
        name: "ttu_direct_userset/invalid_object",
        objectType: UU,
        objectId: u("ttu_direct_userset/ttudu_3"),
        relation: "ttu_direct_userset",
        subjectType: USER,
        subjectId: u("ttu_direct_userset/ttudu_1"),
        expected: false,
      },
    ],
  },
  {
    name: "usersets_ttu_direct_cond_userset",
    tuples: [
      {
        objectType: DU,
        objectId: u("usersets_ttu_direct_cond_userset/ttdcu_1"),
        relation: "direct",
        subjectType: USER,
        subjectId: u("usersets_ttu_direct_cond_userset/ttdcu_1"),
      },
      {
        objectType: TT,
        objectId: u("usersets_ttu_direct_cond_userset/ttdcu_1"),
        relation: "mult_parent_types_cond",
        subjectType: DU,
        subjectId: u("usersets_ttu_direct_cond_userset/ttdcu_1"),
        conditionName: XCOND,
      },
      {
        objectType: DE,
        objectId: u("usersets_ttu_direct_cond_userset/ttdcu_2"),
        relation: "direct",
        subjectType: EMPLOYEE,
        subjectId: u("usersets_ttu_direct_cond_userset/ttdcu_2"),
      },
      {
        objectType: TT,
        objectId: u("usersets_ttu_direct_cond_userset/ttdcu_2"),
        relation: "mult_parent_types_cond",
        subjectType: DE,
        subjectId: u("usersets_ttu_direct_cond_userset/ttdcu_2"),
        conditionName: XCOND,
      },
      {
        objectType: UU,
        objectId: u("usersets_ttu_direct_cond_userset/ttdcu_1"),
        relation: "ttu_direct_cond_userset",
        subjectType: TT,
        subjectId: u("usersets_ttu_direct_cond_userset/ttdcu_1"),
        subjectRelation: "direct_cond_pa_direct_ch",
      },
      {
        objectType: UU,
        objectId: u("usersets_ttu_direct_cond_userset/ttdcu_2"),
        relation: "ttu_direct_cond_userset",
        subjectType: TT,
        subjectId: u("usersets_ttu_direct_cond_userset/ttdcu_2"),
        subjectRelation: "direct_cond_pa_direct_ch",
      },
    ],
    cases: [
      {
        name: "usersets_ttu_direct_cond_userset/valid_user",
        objectType: UU,
        objectId: u("usersets_ttu_direct_cond_userset/ttdcu_1"),
        relation: "ttu_direct_cond_userset",
        subjectType: USER,
        subjectId: u("usersets_ttu_direct_cond_userset/ttdcu_1"),
        context: { x: "1" },
        expected: true,
      },
      {
        name: "usersets_ttu_direct_cond_userset/valid_user#2",
        objectType: UU,
        objectId: u("usersets_ttu_direct_cond_userset/ttdcu_2"),
        relation: "ttu_direct_cond_userset",
        subjectType: EMPLOYEE,
        subjectId: u("usersets_ttu_direct_cond_userset/ttdcu_2"),
        context: { x: "1" },
        expected: true,
      },
      {
        name: "usersets_ttu_direct_cond_userset/valid_user_invalid_cond",
        objectType: UU,
        objectId: u("usersets_ttu_direct_cond_userset/ttdcu_1"),
        relation: "ttu_direct_cond_userset",
        subjectType: USER,
        subjectId: u("usersets_ttu_direct_cond_userset/ttdcu_1"),
        context: { x: "2" },
        expected: false,
      },
      {
        name: "usersets_ttu_direct_cond_userset/valid_employee_invalid_cond",
        objectType: UU,
        objectId: u("usersets_ttu_direct_cond_userset/ttdcu_2"),
        relation: "ttu_direct_cond_userset",
        subjectType: EMPLOYEE,
        subjectId: u("usersets_ttu_direct_cond_userset/ttdcu_1"),
        context: { x: "2" },
        expected: false,
      },
      {
        name: "usersets_ttu_direct_cond_userset/invalid_user",
        objectType: UU,
        objectId: u("usersets_ttu_direct_cond_userset/ttdcu_1"),
        relation: "ttu_direct_cond_userset",
        subjectType: USER,
        subjectId: u("usersets_ttu_direct_cond_userset/ttdcu_5"),
        context: { x: "1" },
        expected: false,
      },
      {
        name: "usersets_ttu_direct_cond_userset/no_condition",
        objectType: UU,
        objectId: u("usersets_ttu_direct_cond_userset/ttdcu_1"),
        relation: "ttu_direct_cond_userset",
        subjectType: USER,
        subjectId: u("usersets_ttu_direct_cond_userset/ttdcu_1"),
        expected: "refused",
      },
      {
        name: "usersets_ttu_direct_cond_userset/invalid_object",
        objectType: UU,
        objectId: u("usersets_ttu_direct_cond_userset/ttdcu_2"),
        relation: "ttu_direct_cond_userset",
        subjectType: USER,
        subjectId: u("usersets_ttu_direct_cond_userset/ttdcu_1"),
        context: { x: "1" },
        expected: false,
      },
    ],
  },
  {
    name: "userset_ttu_or_direct_userset",
    tuples: [
      {
        objectType: DU,
        objectId: u("userset_ttu_or_direct_userset/ttuodu_1"),
        relation: "direct",
        subjectType: USER,
        subjectId: u("userset_ttu_or_direct_userset/ttuodu_1"),
      },
      {
        objectType: DU,
        objectId: u("userset_ttu_or_direct_userset/ttuodu_2"),
        relation: "direct_wild",
        subjectType: USER,
        subjectId: "*",
      },
      {
        objectType: DU,
        objectId: u("userset_ttu_or_direct_userset/ttuodu_3"),
        relation: "direct_cond",
        subjectType: USER,
        subjectId: u("userset_ttu_or_direct_userset/ttuodu_3"),
        conditionName: XCOND,
      },
      {
        objectType: TT,
        objectId: u("userset_ttu_or_direct_userset/ttuodu_1"),
        relation: "direct_parent",
        subjectType: DU,
        subjectId: u("userset_ttu_or_direct_userset/ttuodu_1"),
      },
      {
        objectType: TT,
        objectId: u("userset_ttu_or_direct_userset/ttuodu_2"),
        relation: "direct_parent",
        subjectType: DU,
        subjectId: u("userset_ttu_or_direct_userset/ttuodu_2"),
      },
      {
        objectType: TT,
        objectId: u("userset_ttu_or_direct_userset/ttuodu_3"),
        relation: "direct_parent",
        subjectType: DU,
        subjectId: u("userset_ttu_or_direct_userset/ttuodu_3"),
      },
      {
        objectType: UU,
        objectId: u("userset_ttu_or_direct_userset/ttuodu_1"),
        relation: "ttu_or_direct_userset",
        subjectType: TT,
        subjectId: u("userset_ttu_or_direct_userset/ttuodu_1"),
        subjectRelation: "or_comp_from_direct_parent",
      },
      {
        objectType: UU,
        objectId: u("userset_ttu_or_direct_userset/ttuodu_2"),
        relation: "ttu_or_direct_userset",
        subjectType: TT,
        subjectId: u("userset_ttu_or_direct_userset/ttuodu_2"),
        subjectRelation: "or_comp_from_direct_parent",
      },
      {
        objectType: UU,
        objectId: u("userset_ttu_or_direct_userset/ttuodu_3"),
        relation: "ttu_or_direct_userset",
        subjectType: TT,
        subjectId: u("userset_ttu_or_direct_userset/ttuodu_3"),
        subjectRelation: "or_comp_from_direct_parent",
      },
    ],
    cases: [
      {
        name: "userset_ttu_or_direct_userset/valid_user_direct",
        objectType: UU,
        objectId: u("userset_ttu_or_direct_userset/ttuodu_1"),
        relation: "ttu_or_direct_userset",
        subjectType: USER,
        subjectId: u("userset_ttu_or_direct_userset/ttuodu_1"),
        expected: true,
      },
      {
        name: "userset_ttu_or_direct_userset/valid_user_direct_wild",
        objectType: UU,
        objectId: u("userset_ttu_or_direct_userset/ttuodu_2"),
        relation: "ttu_or_direct_userset",
        subjectType: USER,
        subjectId: u("userset_ttu_or_direct_userset/ttuodu_2"),
        expected: true,
      },
      {
        name: "userset_ttu_or_direct_userset/valid_user_direct_cond",
        objectType: UU,
        objectId: u("userset_ttu_or_direct_userset/ttuodu_3"),
        relation: "ttu_or_direct_userset",
        subjectType: USER,
        subjectId: u("userset_ttu_or_direct_userset/ttuodu_3"),
        context: { x: "1" },
        expected: true,
      },
      {
        name: "userset_ttu_or_direct_userset/valid_user_direct_cond_invalid_cond",
        objectType: UU,
        objectId: u("userset_ttu_or_direct_userset/ttuodu_3"),
        relation: "ttu_or_direct_userset",
        subjectType: USER,
        subjectId: u("userset_ttu_or_direct_userset/ttuodu_3"),
        context: { x: "2" },
        expected: false,
      },
      {
        name: "userset_ttu_or_direct_userset/invalid_user_direct",
        objectType: UU,
        objectId: u("userset_ttu_or_direct_userset/ttuodu_1"),
        relation: "ttu_or_direct_userset",
        subjectType: USER,
        subjectId: u("userset_ttu_or_direct_userset/ttuodu_2"),
        expected: false,
      },
      {
        name: "userset_ttu_or_direct_userset/invalid_user_direct_cond",
        objectType: UU,
        objectId: u("userset_ttu_or_direct_userset/ttuodu_3"),
        relation: "ttu_or_direct_userset",
        subjectType: USER,
        subjectId: u("userset_ttu_or_direct_userset/ttuodu_1"),
        context: { x: "1" },
        expected: false,
      },
      {
        name: "userset_ttu_or_direct_userset/user_direct_cond_no_condition",
        objectType: UU,
        objectId: u("userset_ttu_or_direct_userset/ttuodu_3"),
        relation: "ttu_or_direct_userset",
        subjectType: USER,
        subjectId: u("userset_ttu_or_direct_userset/ttuodu_3"),
        expected: "refused",
      },
    ],
  },
  {
    name: "usersets_ttu_and_direct_userset",
    tuples: [
      {
        objectType: DU,
        objectId: u("usersets_ttu_and_direct_userset/ttuadu_1"),
        relation: "direct_cond",
        subjectType: USER,
        subjectId: u("usersets_ttu_and_direct_userset/ttuadu_1"),
        conditionName: XCOND,
      },
      {
        objectType: DU,
        objectId: u("usersets_ttu_and_direct_userset/ttuadu_1"),
        relation: "direct_wild",
        subjectType: USER,
        subjectId: "*",
      },
      {
        objectType: TT,
        objectId: u("usersets_ttu_and_direct_userset/ttuadu_1"),
        relation: "direct_cond_parent",
        subjectType: DU,
        subjectId: u("usersets_ttu_and_direct_userset/ttuadu_1"),
        conditionName: XCOND,
      },
      {
        objectType: UU,
        objectId: u("usersets_ttu_and_direct_userset/ttuadu_1"),
        relation: "ttu_and_direct_userset",
        subjectType: TT,
        subjectId: u("usersets_ttu_and_direct_userset/ttuadu_1"),
        subjectRelation: "and_comp_from_direct_parent",
      },
    ],
    cases: [
      {
        name: "usersets_ttu_and_direct_userset/valid_user",
        objectType: UU,
        objectId: u("usersets_ttu_and_direct_userset/ttuadu_1"),
        relation: "ttu_and_direct_userset",
        subjectType: USER,
        subjectId: u("usersets_ttu_and_direct_userset/ttuadu_1"),
        context: { x: "1" },
        expected: true,
      },
      {
        name: "usersets_ttu_and_direct_userset/valid_user_invalid_cond",
        objectType: UU,
        objectId: u("usersets_ttu_and_direct_userset/ttuadu_1"),
        relation: "ttu_and_direct_userset",
        subjectType: USER,
        subjectId: u("usersets_ttu_and_direct_userset/ttuadu_1"),
        context: { x: "2" },
        expected: false,
      },
      {
        name: "usersets_ttu_and_direct_userset/no_condition",
        objectType: UU,
        objectId: u("usersets_ttu_and_direct_userset/ttuadu_1"),
        relation: "ttu_and_direct_userset",
        subjectType: USER,
        subjectId: u("usersets_ttu_and_direct_userset/ttuadu_1"),
        expected: "refused",
      },
      {
        name: "usersets_ttu_and_direct_userset/invalid_user",
        objectType: UU,
        objectId: u("usersets_ttu_and_direct_userset/ttuadu_1"),
        relation: "ttu_and_direct_userset",
        subjectType: USER,
        subjectId: u("usersets_ttu_and_direct_userset/ttuadu_2"),
        context: { x: "1" },
        expected: false,
      },
      {
        name: "usersets_ttu_and_direct_userset/invalid_object",
        objectType: UU,
        objectId: u("usersets_ttu_and_direct_userset/ttuadu_2"),
        relation: "ttu_and_direct_userset",
        subjectType: USER,
        subjectId: u("usersets_ttu_and_direct_userset/ttuadu_2"),
        context: { x: "1" },
        expected: false,
      },
    ],
  },
  {
    name: "usersets_tuple_cycle2",
    tuples: [
      {
        objectType: DU,
        objectId: u("usersets_tuple_cycle2/utc2_1"),
        relation: "tuple_cycle2",
        subjectType: USER,
        subjectId: u("usersets_tuple_cycle2/utc2_1"),
      },
      {
        objectType: TT,
        objectId: u("usersets_tuple_cycle2/utc2_1"),
        relation: "direct_parent",
        subjectType: DU,
        subjectId: u("usersets_tuple_cycle2/utc2_1"),
      },
      {
        objectType: UU,
        objectId: u("usersets_tuple_cycle2/utc2_1"),
        relation: "tuple_cycle2",
        subjectType: TT,
        subjectId: u("usersets_tuple_cycle2/utc2_1"),
        subjectRelation: "tuple_cycle2",
      },
      {
        objectType: DU,
        objectId: u("usersets_tuple_cycle2/utc2_1"),
        relation: "tuple_cycle2",
        subjectType: UU,
        subjectId: u("usersets_tuple_cycle2/utc2_1"),
        subjectRelation: "tuple_cycle2",
      },
      {
        objectType: DU,
        objectId: u("usersets_tuple_cycle2/utc2_4"),
        relation: "tuple_cycle2",
        subjectType: UU,
        subjectId: u("usersets_tuple_cycle2/utc2_4"),
        subjectRelation: "tuple_cycle2",
      },
      {
        objectType: TT,
        objectId: u("usersets_tuple_cycle2/utc2_4"),
        relation: "direct_parent",
        subjectType: DU,
        subjectId: u("usersets_tuple_cycle2/utc2_4"),
      },
      {
        objectType: UU,
        objectId: u("usersets_tuple_cycle2/utc2_4"),
        relation: "tuple_cycle2",
        subjectType: TT,
        subjectId: u("usersets_tuple_cycle2/utc2_4"),
        subjectRelation: "tuple_cycle2",
      },
    ],
    cases: [
      {
        name: "usersets_tuple_cycle2/valid_user",
        objectType: UU,
        objectId: u("usersets_tuple_cycle2/utc2_1"),
        relation: "tuple_cycle2",
        subjectType: USER,
        subjectId: u("usersets_tuple_cycle2/utc2_1"),
        expected: true,
      },
      {
        name: "usersets_tuple_cycle2/cycle",
        objectType: UU,
        objectId: u("usersets_tuple_cycle2/utc2_4"),
        relation: "tuple_cycle2",
        subjectType: USER,
        subjectId: u("usersets_tuple_cycle2/utc2_1"),
        expected: false,
      },
      {
        name: "usersets_tuple_cycle2/invalid_user",
        objectType: UU,
        objectId: u("usersets_tuple_cycle2/utc2_1"),
        relation: "tuple_cycle2",
        subjectType: USER,
        subjectId: u("usersets_tuple_cycle2/utc2_3"),
        expected: false,
      },
    ],
  },
  {
    name: "usersets_tuple_cycle3",
    tuples: [
      {
        objectType: TT,
        objectId: u("usersets_tuple_cycle3/utc3_1"),
        relation: "userset_parent",
        subjectType: UU,
        subjectId: u("usersets_tuple_cycle3/utc3_1"),
      },
      {
        objectType: C3,
        objectId: u("usersets_tuple_cycle3/utc3_1"),
        relation: "cycle_nested",
        subjectType: TT,
        subjectId: u("usersets_tuple_cycle3/utc3_1"),
        subjectRelation: "tuple_cycle3",
      },
      {
        objectType: DU,
        objectId: u("usersets_tuple_cycle3/utc3_1"),
        relation: "tuple_cycle3",
        subjectType: USER,
        subjectId: u("usersets_tuple_cycle3/utc3_1"),
      },
      {
        objectType: DU,
        objectId: u("usersets_tuple_cycle3/utc3_1"),
        relation: "tuple_cycle3",
        subjectType: C3,
        subjectId: u("usersets_tuple_cycle3/utc3_1"),
        subjectRelation: "cycle_nested",
      },
      {
        objectType: UU,
        objectId: u("usersets_tuple_cycle3/utc3_1"),
        relation: "tuple_cycle3",
        subjectType: DU,
        subjectId: u("usersets_tuple_cycle3/utc3_1"),
        subjectRelation: "compute_tuple_cycle3",
      },
      {
        objectType: TT,
        objectId: u("usersets_tuple_cycle3/utc3_4"),
        relation: "userset_parent",
        subjectType: UU,
        subjectId: u("usersets_tuple_cycle3/utc3_4"),
      },
      {
        objectType: C3,
        objectId: u("usersets_tuple_cycle3/utc3_4"),
        relation: "cycle_nested",
        subjectType: TT,
        subjectId: u("usersets_tuple_cycle3/utc3_4"),
        subjectRelation: "tuple_cycle3",
      },
      {
        objectType: DU,
        objectId: u("usersets_tuple_cycle3/utc3_4"),
        relation: "tuple_cycle3",
        subjectType: C3,
        subjectId: u("usersets_tuple_cycle3/utc3_4"),
        subjectRelation: "cycle_nested",
      },
      {
        objectType: UU,
        objectId: u("usersets_tuple_cycle3/utc3_4"),
        relation: "tuple_cycle3",
        subjectType: DU,
        subjectId: u("usersets_tuple_cycle3/utc3_4"),
        subjectRelation: "compute_tuple_cycle3",
      },
    ],
    cases: [
      {
        name: "usersets_tuple_cycle3/valid_user",
        objectType: UU,
        objectId: u("usersets_tuple_cycle3/utc3_1"),
        relation: "tuple_cycle3",
        subjectType: USER,
        subjectId: u("usersets_tuple_cycle3/utc3_1"),
        expected: true,
      },
      {
        name: "usersets_tuple_cycle3/cycle",
        objectType: UU,
        objectId: u("usersets_tuple_cycle3/utc3_4"),
        relation: "tuple_cycle3",
        subjectType: USER,
        subjectId: u("usersets_tuple_cycle3/utc3_1"),
        expected: false,
      },
      {
        name: "usersets_tuple_cycle3/invalid_user",
        objectType: UU,
        objectId: u("usersets_tuple_cycle3/utc3_1"),
        relation: "tuple_cycle3",
        subjectType: USER,
        subjectId: u("usersets_tuple_cycle3/utc3_2"),
        expected: false,
      },
    ],
  },
];

describe("B1 corpus — usersets over tuple-to-usersets, and cycles", () => {
  let db: Kysely<DB>;
  let corpus: Corpus;
  let fixture: FixtureRecord;

  beforeAll(async () => {
    db = getDb();
    await beginTransaction(db);

    const tsfgaClient = createTsfga(new KyselyTupleStore(db));
    fixture = recordFixture(tsfgaClient);
    corpus = await loadCorpus(tsfgaClient, {
      slug: "ttu-userset-subject",
      modelPath: "./ttu-userset-subject/model.dsl",
      conditions: [
        {
          name: XCOND,
          expression: "x == '1'",
          parameters: { x: "string" },
        },
      ],
      configs: CONFIGS,
      stages: STAGES,
    });
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  runStages(STAGES, () => corpus);

  test("the configs say what the model says", () => {
    expectConfigsMatchModel("./ttu-userset-subject/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
