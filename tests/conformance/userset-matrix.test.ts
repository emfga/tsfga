import { afterAll, beforeAll, describe, test } from "bun:test";
import { createTsfga, type RelationConfig } from "@tsfga/core";
import type { DB } from "@tsfga/kysely";
import { KyselyTupleStore } from "@tsfga/kysely";
import type { Kysely } from "kysely";
import {
  expectConfigsMatchModel,
  expectPinnedDivergence,
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
 * B1 userset corpus — the direct userset arms.
 *
 * A port of upstream's own case matrix —
 * `tests/check/check_userset.go` at v1.18.2 — over the stages
 * listed below. Every `expected` is the `Expectation:` the Go
 * corpus states, so a shape both engines answer the same
 * *wrong* way still fails.
 *
 * Stages ported here:
 * - `usersets_userset`
 * - `usersets_userset_alg`
 * - `usersets_userset_to_computed`
 * - `usersets_userset_to_computed_wild`
 * - `usersets_userset_to_computed_wild_cond`
 * - `usersets_userset_cond`
 * - `usersets_userset_cond_to_computed`
 * - `usersets_userset_cond_to_computed_cond`
 * - `usersets_userset_cond_to_computed_wild`
 * - `usersets_userset_cond_to_computed_wild_cond`
 * - `usersets_userset_direct_and_direct_wild`
 *
 * Upstream's `ErrorCode: 2000` (a check whose condition
 * parameter the request never supplied) is transcribed as
 * `"refused"`: both engines decline to answer rather than
 * denying.
 *
 * Types and the condition carry a `_b1a` suffix so this
 * fixture cannot collide with another fixture's rows in the
 * shared Postgres and OpenFGA.
 */

const USER = "user_b1a";
const EMPLOYEE = "employee_b1a";
const DU = "directs_user_b1a";
const DE = "directs_employee_b1a";
const UU = "usersets_user_b1a";
const TT = "ttus_b1a";
const XCOND = "xcond_b1a";

/** Upstream's object and subject names, as UUIDs. */
const u = ids(
  [
    "usersets_userset/userset_1",
    "usersets_userset/userset_valid",
    "usersets_userset/userset_invalid",
    "usersets_userset/userset_2",
    "usersets_userset_alg/userset_1_alg",
    "usersets_userset_alg/alg_valid",
    "usersets_userset_alg/alg_excluded_1",
    "usersets_userset_alg/alg_excluded_2",
    "usersets_userset_to_computed/utc_1",
    "usersets_userset_to_computed/utc_valid",
    "usersets_userset_to_computed/utc_invalid",
    "usersets_userset_to_computed/utc_2",
    "usersets_userset_to_computed_wild/utcw_1",
    "usersets_userset_to_computed_wild/utcw_valid",
    "usersets_userset_to_computed_wild/utcw_invalid",
    "usersets_userset_to_computed_wild/utcw_2",
    "usersets_userset_to_computed_wild_cond/utcwd_1",
    "usersets_userset_to_computed_wild_cond/utcwd_2",
    "usersets_userset_to_computed_wild_cond/utwcd_1",
    "usersets_userset_to_computed_wild_cond/utwcd_2",
    "usersets_userset_cond/uuc_1",
    "usersets_userset_cond/uuc_2",
    "usersets_userset_cond_to_computed/uuctc_1",
    "usersets_userset_cond_to_computed/uuctc_2",
    "usersets_userset_cond_to_computed_cond/uuctcc_1",
    "usersets_userset_cond_to_computed_cond/uuctcc_2",
    "usersets_userset_cond_to_computed_wild/uuctcw_1",
    "usersets_userset_cond_to_computed_wild/uuctcw_2",
    "usersets_userset_cond_to_computed_wild_cond/uuctcwc_1",
    "usersets_userset_cond_to_computed_wild_cond/uuctcwc_2",
    "usersets_userset_direct_and_direct_wild/uuudadw_1",
    "usersets_userset_direct_and_direct_wild/uuudadw_2",
    "usersets_userset_direct_and_direct_wild/uuudadw_2a",
    "usersets_userset_direct_and_direct_wild/uuudadw_3",
    "usersets_userset_direct_and_direct_wild/uuudadw_3a",
    "usersets_userset_direct_and_direct_wild/uuudadw_wildcard",
  ],
  "d480",
);

// Written in dependency order: a tupleset relation's config
// exists before the tuple-to-userset that names it, so
// `writeRelationConfig`'s tupleset gates can see it.
const CONFIGS: RelationConfig[] = [
  cfg(DE, "direct", { directlyAssignable: [{ type: EMPLOYEE }] }),
  cfg(DE, "computed", { computedUserset: "direct" }),
  cfg(DE, "computed_computed", { computedUserset: "computed" }),
  cfg(DE, "computed_computed_computed", {
    computedUserset: "computed_computed",
  }),
  cfg(DE, "or_computed", {
    impliedBy: ["computed_computed_computed", "direct"],
  }),
  cfg(DE, "and_computed", {
    intersection: [
      { type: "computedUserset", relation: "or_computed" },
      { type: "computedUserset", relation: "direct" },
    ],
  }),
  cfg(DE, "direct_2", { directlyAssignable: [{ type: EMPLOYEE }] }),
  cfg(DE, "butnot_computed", {
    computedUserset: "and_computed",
    excludedBy: "direct_2",
  }),
  cfg(DE, "direct_cond", {
    directlyAssignable: [{ type: EMPLOYEE, condition: XCOND }],
  }),
  cfg(DE, "alg_combined", {
    intersection: [
      { type: "computedUserset", relation: "butnot_computed" },
      { type: "computedUserset", relation: "direct_cond" },
    ],
  }),
  cfg(DE, "direct_wild", {
    directlyAssignable: [{ type: EMPLOYEE, wildcard: true }],
  }),
  cfg(DE, "direct_wild_cond", {
    directlyAssignable: [{ type: EMPLOYEE, wildcard: true, condition: XCOND }],
  }),
  cfg(DU, "direct_cond", {
    directlyAssignable: [{ type: USER, condition: XCOND }],
  }),
  cfg(DU, "computed_cond", { computedUserset: "direct_cond" }),
  cfg(DU, "direct", { directlyAssignable: [{ type: USER }] }),
  cfg(DU, "computed", { computedUserset: "direct" }),
  cfg(DU, "computed_computed", { computedUserset: "computed" }),
  cfg(DU, "butnot_computed_cond", {
    computedUserset: "computed_cond",
    excludedBy: "computed_computed",
  }),
  cfg(DU, "direct_and_direct_cond", {
    directlyAssignable: [
      { type: USER },
      { type: USER, condition: XCOND },
      { type: EMPLOYEE },
    ],
  }),
  cfg(DU, "alg_combined", {
    computedUserset: "butnot_computed_cond",
    excludedBy: "direct_and_direct_cond",
  }),
  cfg(DU, "direct_wild", {
    directlyAssignable: [{ type: USER, wildcard: true }],
  }),
  cfg(DU, "computed_wild", { computedUserset: "direct_wild" }),
  cfg(DU, "direct_wild_cond", {
    directlyAssignable: [{ type: USER, wildcard: true, condition: XCOND }],
  }),
  cfg(DU, "computed_wild_cond", { computedUserset: "direct_wild_cond" }),
  cfg(DU, "direct_and_direct_wild", {
    directlyAssignable: [
      { type: USER },
      { type: USER, wildcard: true },
      { type: EMPLOYEE, wildcard: true },
    ],
  }),
  cfg(UU, "userset", {
    directlyAssignable: [
      { type: DU, relation: "direct" },
      { type: DE, relation: "direct" },
    ],
  }),
  cfg(UU, "userset_alg", {
    directlyAssignable: [
      { type: DU, relation: "alg_combined" },
      { type: DE, relation: "alg_combined" },
    ],
  }),
  cfg(UU, "userset_cond", {
    directlyAssignable: [{ type: DU, relation: "direct", condition: XCOND }],
  }),
  cfg(UU, "userset_cond_to_computed", {
    directlyAssignable: [{ type: DU, relation: "computed", condition: XCOND }],
  }),
  cfg(UU, "userset_cond_to_computed_cond", {
    directlyAssignable: [
      { type: DU, relation: "computed_cond", condition: XCOND },
    ],
  }),
  cfg(UU, "userset_cond_to_computed_wild", {
    directlyAssignable: [
      { type: DU, relation: "computed_wild", condition: XCOND },
    ],
  }),
  cfg(UU, "userset_cond_to_computed_wild_cond", {
    directlyAssignable: [
      { type: DU, relation: "computed_wild_cond", condition: XCOND },
    ],
  }),
  cfg(UU, "userset_direct_and_direct_wild", {
    directlyAssignable: [{ type: DU, relation: "direct_and_direct_wild" }],
  }),
  cfg(UU, "userset_to_computed", {
    directlyAssignable: [
      { type: DU, relation: "computed" },
      { type: DE, relation: "computed" },
    ],
  }),
  cfg(UU, "userset_to_computed_wild", {
    directlyAssignable: [
      { type: DU, relation: "computed_wild" },
      { type: DE, relation: "direct_wild" },
    ],
  }),
  cfg(UU, "userset_to_computed_wild_cond", {
    directlyAssignable: [
      { type: DU, relation: "direct_wild_cond" },
      { type: DE, relation: "direct_wild_cond" },
    ],
  }),
];

const STAGES: Stage[] = [
  {
    name: "usersets_userset",
    tuples: [
      {
        objectType: DU,
        objectId: u("usersets_userset/userset_1"),
        relation: "direct",
        subjectType: USER,
        subjectId: u("usersets_userset/userset_valid"),
      },
      {
        objectType: DE,
        objectId: u("usersets_userset/userset_1"),
        relation: "direct",
        subjectType: EMPLOYEE,
        subjectId: u("usersets_userset/userset_valid"),
      },
      {
        objectType: UU,
        objectId: u("usersets_userset/userset_1"),
        relation: "userset",
        subjectType: DU,
        subjectId: u("usersets_userset/userset_1"),
        subjectRelation: "direct",
      },
      {
        objectType: UU,
        objectId: u("usersets_userset/userset_1"),
        relation: "userset",
        subjectType: DE,
        subjectId: u("usersets_userset/userset_1"),
        subjectRelation: "direct",
      },
    ],
    cases: [
      {
        name: "usersets_userset/user_valid",
        objectType: UU,
        objectId: u("usersets_userset/userset_1"),
        relation: "userset",
        subjectType: USER,
        subjectId: u("usersets_userset/userset_valid"),
        expected: true,
      },
      {
        name: "usersets_userset/employee_valid",
        objectType: UU,
        objectId: u("usersets_userset/userset_1"),
        relation: "userset",
        subjectType: EMPLOYEE,
        subjectId: u("usersets_userset/userset_valid"),
        expected: true,
      },
      {
        name: "usersets_userset/user_invalid",
        objectType: UU,
        objectId: u("usersets_userset/userset_1"),
        relation: "userset",
        subjectType: USER,
        subjectId: u("usersets_userset/userset_invalid"),
        expected: false,
      },
      {
        name: "usersets_userset/employee_invalid",
        objectType: UU,
        objectId: u("usersets_userset/userset_1"),
        relation: "userset",
        subjectType: EMPLOYEE,
        subjectId: u("usersets_userset/userset_invalid"),
        expected: false,
      },
      {
        name: "usersets_userset/invalid_object",
        objectType: UU,
        objectId: u("usersets_userset/userset_2"),
        relation: "userset",
        subjectType: USER,
        subjectId: u("usersets_userset/userset_invalid"),
        expected: false,
      },
    ],
  },
  {
    name: "usersets_userset_alg",
    tuples: [
      {
        objectType: UU,
        objectId: u("usersets_userset_alg/userset_1_alg"),
        relation: "userset_alg",
        subjectType: DU,
        subjectId: u("usersets_userset_alg/userset_1_alg"),
        subjectRelation: "alg_combined",
      },
      {
        objectType: DU,
        objectId: u("usersets_userset_alg/userset_1_alg"),
        relation: "direct_cond",
        subjectType: USER,
        subjectId: u("usersets_userset_alg/alg_valid"),
        conditionName: XCOND,
      },
      {
        objectType: DU,
        objectId: u("usersets_userset_alg/userset_1_alg"),
        relation: "direct_cond",
        subjectType: USER,
        subjectId: u("usersets_userset_alg/alg_excluded_1"),
        conditionName: XCOND,
      },
      {
        objectType: DU,
        objectId: u("usersets_userset_alg/userset_1_alg"),
        relation: "direct",
        subjectType: USER,
        subjectId: u("usersets_userset_alg/alg_excluded_1"),
      },
      {
        objectType: DU,
        objectId: u("usersets_userset_alg/userset_1_alg"),
        relation: "direct_cond",
        subjectType: USER,
        subjectId: u("usersets_userset_alg/alg_excluded_2"),
        conditionName: XCOND,
      },
      {
        objectType: DU,
        objectId: u("usersets_userset_alg/userset_1_alg"),
        relation: "direct_and_direct_cond",
        subjectType: USER,
        subjectId: u("usersets_userset_alg/alg_excluded_2"),
        conditionName: XCOND,
      },
      {
        objectType: UU,
        objectId: u("usersets_userset_alg/userset_1_alg"),
        relation: "userset_alg",
        subjectType: DE,
        subjectId: u("usersets_userset_alg/userset_1_alg"),
        subjectRelation: "alg_combined",
      },
      {
        objectType: DE,
        objectId: u("usersets_userset_alg/userset_1_alg"),
        relation: "direct",
        subjectType: EMPLOYEE,
        subjectId: u("usersets_userset_alg/alg_valid"),
      },
      {
        objectType: DE,
        objectId: u("usersets_userset_alg/userset_1_alg"),
        relation: "direct_cond",
        subjectType: EMPLOYEE,
        subjectId: u("usersets_userset_alg/alg_valid"),
        conditionName: XCOND,
      },
      {
        objectType: DE,
        objectId: u("usersets_userset_alg/userset_1_alg"),
        relation: "direct",
        subjectType: EMPLOYEE,
        subjectId: u("usersets_userset_alg/alg_excluded_1"),
      },
      {
        objectType: DE,
        objectId: u("usersets_userset_alg/userset_1_alg"),
        relation: "direct_cond",
        subjectType: EMPLOYEE,
        subjectId: u("usersets_userset_alg/alg_excluded_1"),
        conditionName: XCOND,
      },
      {
        objectType: DE,
        objectId: u("usersets_userset_alg/userset_1_alg"),
        relation: "direct_2",
        subjectType: EMPLOYEE,
        subjectId: u("usersets_userset_alg/alg_excluded_1"),
      },
    ],
    cases: [
      {
        name: "usersets_userset_alg/user_valid",
        objectType: UU,
        objectId: u("usersets_userset_alg/userset_1_alg"),
        relation: "userset_alg",
        subjectType: USER,
        subjectId: u("usersets_userset_alg/alg_valid"),
        context: { x: "1" },
        expected: true,
      },
      {
        name: "usersets_userset_alg/employee_valid",
        objectType: UU,
        objectId: u("usersets_userset_alg/userset_1_alg"),
        relation: "userset_alg",
        subjectType: EMPLOYEE,
        subjectId: u("usersets_userset_alg/alg_valid"),
        context: { x: "1" },
        expected: true,
      },
      {
        name: "usersets_userset_alg/user_excluded_1",
        objectType: UU,
        objectId: u("usersets_userset_alg/userset_1_alg"),
        relation: "userset_alg",
        subjectType: USER,
        subjectId: u("usersets_userset_alg/alg_excluded_1"),
        context: { x: "1" },
        expected: false,
      },
      {
        name: "usersets_userset_alg/user_excluded_2",
        objectType: UU,
        objectId: u("usersets_userset_alg/userset_1_alg"),
        relation: "userset_alg",
        subjectType: USER,
        subjectId: u("usersets_userset_alg/alg_excluded_2"),
        context: { x: "1" },
        expected: false,
      },
      {
        name: "usersets_userset_alg/employee_excluded_1",
        objectType: UU,
        objectId: u("usersets_userset_alg/userset_1_alg"),
        relation: "userset_alg",
        subjectType: EMPLOYEE,
        subjectId: u("usersets_userset_alg/alg_excluded_1"),
        context: { x: "1" },
        expected: false,
      },
    ],
  },
  {
    name: "usersets_userset_to_computed",
    tuples: [
      {
        objectType: DU,
        objectId: u("usersets_userset_to_computed/utc_1"),
        relation: "direct",
        subjectType: USER,
        subjectId: u("usersets_userset_to_computed/utc_valid"),
      },
      {
        objectType: DE,
        objectId: u("usersets_userset_to_computed/utc_1"),
        relation: "direct",
        subjectType: EMPLOYEE,
        subjectId: u("usersets_userset_to_computed/utc_valid"),
      },
      {
        objectType: UU,
        objectId: u("usersets_userset_to_computed/utc_1"),
        relation: "userset_to_computed",
        subjectType: DU,
        subjectId: u("usersets_userset_to_computed/utc_1"),
        subjectRelation: "computed",
      },
      {
        objectType: UU,
        objectId: u("usersets_userset_to_computed/utc_1"),
        relation: "userset_to_computed",
        subjectType: DE,
        subjectId: u("usersets_userset_to_computed/utc_1"),
        subjectRelation: "computed",
      },
    ],
    cases: [
      {
        name: "usersets_userset_to_computed/valid_user",
        objectType: UU,
        objectId: u("usersets_userset_to_computed/utc_1"),
        relation: "userset_to_computed",
        subjectType: USER,
        subjectId: u("usersets_userset_to_computed/utc_valid"),
        expected: true,
      },
      {
        name: "usersets_userset_to_computed/valid_employee",
        objectType: UU,
        objectId: u("usersets_userset_to_computed/utc_1"),
        relation: "userset_to_computed",
        subjectType: EMPLOYEE,
        subjectId: u("usersets_userset_to_computed/utc_valid"),
        expected: true,
      },
      {
        name: "usersets_userset_to_computed/invalid_user",
        objectType: UU,
        objectId: u("usersets_userset_to_computed/utc_1"),
        relation: "userset_to_computed",
        subjectType: USER,
        subjectId: u("usersets_userset_to_computed/utc_invalid"),
        expected: false,
      },
      {
        name: "usersets_userset_to_computed/invalid_employee",
        objectType: UU,
        objectId: u("usersets_userset_to_computed/utc_1"),
        relation: "userset_to_computed",
        subjectType: EMPLOYEE,
        subjectId: u("usersets_userset_to_computed/utc_invalid"),
        expected: false,
      },
      {
        name: "usersets_userset_to_computed/invalid_object",
        objectType: UU,
        objectId: u("usersets_userset_to_computed/utc_2"),
        relation: "userset_to_computed",
        subjectType: USER,
        subjectId: u("usersets_userset_to_computed/utc_valid"),
        expected: false,
      },
    ],
  },
  {
    name: "usersets_userset_to_computed_wild",
    tuples: [
      {
        objectType: DU,
        objectId: u("usersets_userset_to_computed_wild/utcw_1"),
        relation: "direct_wild",
        subjectType: USER,
        subjectId: "*",
      },
      {
        objectType: DE,
        objectId: u("usersets_userset_to_computed_wild/utcw_1"),
        relation: "direct_wild",
        subjectType: EMPLOYEE,
        subjectId: "*",
      },
      {
        objectType: UU,
        objectId: u("usersets_userset_to_computed_wild/utcw_1"),
        relation: "userset_to_computed_wild",
        subjectType: DU,
        subjectId: u("usersets_userset_to_computed_wild/utcw_1"),
        subjectRelation: "computed_wild",
      },
      {
        objectType: UU,
        objectId: u("usersets_userset_to_computed_wild/utcw_1"),
        relation: "userset_to_computed_wild",
        subjectType: DE,
        subjectId: u("usersets_userset_to_computed_wild/utcw_1"),
        subjectRelation: "direct_wild",
      },
    ],
    cases: [
      {
        name: "usersets_userset_to_computed_wild/valid_user",
        objectType: UU,
        objectId: u("usersets_userset_to_computed_wild/utcw_1"),
        relation: "userset_to_computed_wild",
        subjectType: USER,
        subjectId: u("usersets_userset_to_computed_wild/utcw_valid"),
        expected: true,
      },
      {
        name: "usersets_userset_to_computed_wild/valid_employee",
        objectType: UU,
        objectId: u("usersets_userset_to_computed_wild/utcw_1"),
        relation: "userset_to_computed_wild",
        subjectType: EMPLOYEE,
        subjectId: u("usersets_userset_to_computed_wild/utcw_valid"),
        expected: true,
      },
      // `usersets_userset_to_computed_wild/invalid_user_type` is
      // not here. It is the one case in this corpus tsfga does not
      // answer, and it is pinned as a divergence at the bottom of
      // this file rather than transcribed.
      {
        name: "usersets_userset_to_computed_wild/invalid_object",
        objectType: UU,
        objectId: u("usersets_userset_to_computed_wild/utcw_2"),
        relation: "userset_to_computed_wild",
        subjectType: USER,
        subjectId: u("usersets_userset_to_computed_wild/utcw_valid"),
        expected: false,
      },
    ],
  },
  {
    name: "usersets_userset_to_computed_wild_cond",
    tuples: [
      {
        objectType: DU,
        objectId: u("usersets_userset_to_computed_wild_cond/utcwd_1"),
        relation: "direct_wild_cond",
        subjectType: USER,
        subjectId: "*",
        conditionName: XCOND,
      },
      {
        objectType: DE,
        objectId: u("usersets_userset_to_computed_wild_cond/utcwd_2"),
        relation: "direct_wild_cond",
        subjectType: EMPLOYEE,
        subjectId: "*",
        conditionName: XCOND,
      },
      {
        objectType: UU,
        objectId: u("usersets_userset_to_computed_wild_cond/utcwd_1"),
        relation: "userset_to_computed_wild_cond",
        subjectType: DU,
        subjectId: u("usersets_userset_to_computed_wild_cond/utcwd_1"),
        subjectRelation: "direct_wild_cond",
      },
      {
        objectType: UU,
        objectId: u("usersets_userset_to_computed_wild_cond/utcwd_2"),
        relation: "userset_to_computed_wild_cond",
        subjectType: DE,
        subjectId: u("usersets_userset_to_computed_wild_cond/utcwd_2"),
        subjectRelation: "direct_wild_cond",
      },
    ],
    cases: [
      {
        name: "usersets_userset_to_computed_wild_cond/valid_user",
        objectType: UU,
        objectId: u("usersets_userset_to_computed_wild_cond/utcwd_1"),
        relation: "userset_to_computed_wild_cond",
        subjectType: USER,
        subjectId: u("usersets_userset_to_computed_wild_cond/utwcd_1"),
        context: { x: "1" },
        expected: true,
      },
      {
        name: "usersets_userset_to_computed_wild_cond/valid_employee",
        objectType: UU,
        objectId: u("usersets_userset_to_computed_wild_cond/utcwd_2"),
        relation: "userset_to_computed_wild_cond",
        subjectType: EMPLOYEE,
        subjectId: u("usersets_userset_to_computed_wild_cond/utwcd_2"),
        context: { x: "1" },
        expected: true,
      },
      {
        name: "usersets_userset_to_computed_wild_cond/valid_user_invalid_cond",
        objectType: UU,
        objectId: u("usersets_userset_to_computed_wild_cond/utcwd_1"),
        relation: "userset_to_computed_wild_cond",
        subjectType: USER,
        subjectId: u("usersets_userset_to_computed_wild_cond/utwcd_1"),
        context: { x: "2" },
        expected: false,
      },
      {
        name: "usersets_userset_to_computed_wild_cond/valid_employee_invalid_cond",
        objectType: UU,
        objectId: u("usersets_userset_to_computed_wild_cond/utcwd_2"),
        relation: "userset_to_computed_wild_cond",
        subjectType: EMPLOYEE,
        subjectId: u("usersets_userset_to_computed_wild_cond/utwcd_2"),
        context: { x: "2" },
        expected: false,
      },
      {
        name: "usersets_userset_to_computed_wild_cond/user_no_cond",
        objectType: UU,
        objectId: u("usersets_userset_to_computed_wild_cond/utcwd_1"),
        relation: "userset_to_computed_wild_cond",
        subjectType: USER,
        subjectId: u("usersets_userset_to_computed_wild_cond/utwcd_1"),
        expected: "refused",
      },
      {
        name: "usersets_userset_to_computed_wild_cond/employee_no_cond",
        objectType: UU,
        objectId: u("usersets_userset_to_computed_wild_cond/utcwd_2"),
        relation: "userset_to_computed_wild_cond",
        subjectType: EMPLOYEE,
        subjectId: u("usersets_userset_to_computed_wild_cond/utwcd_2"),
        expected: "refused",
      },
    ],
  },
  {
    name: "usersets_userset_cond",
    tuples: [
      {
        objectType: DU,
        objectId: u("usersets_userset_cond/uuc_1"),
        relation: "direct",
        subjectType: USER,
        subjectId: u("usersets_userset_cond/uuc_1"),
      },
      {
        objectType: UU,
        objectId: u("usersets_userset_cond/uuc_1"),
        relation: "userset_cond",
        subjectType: DU,
        subjectId: u("usersets_userset_cond/uuc_1"),
        subjectRelation: "direct",
        conditionName: XCOND,
      },
    ],
    cases: [
      {
        name: "usersets_userset_cond/valid_user",
        objectType: UU,
        objectId: u("usersets_userset_cond/uuc_1"),
        relation: "userset_cond",
        subjectType: USER,
        subjectId: u("usersets_userset_cond/uuc_1"),
        context: { x: "1" },
        expected: true,
      },
      {
        name: "usersets_userset_cond/valid_user_invalid_cond",
        objectType: UU,
        objectId: u("usersets_userset_cond/uuc_1"),
        relation: "userset_cond",
        subjectType: USER,
        subjectId: u("usersets_userset_cond/uuc_1"),
        context: { x: "2" },
        expected: false,
      },
      {
        name: "usersets_userset_cond/invalid_user",
        objectType: UU,
        objectId: u("usersets_userset_cond/uuc_1"),
        relation: "userset_cond",
        subjectType: USER,
        subjectId: u("usersets_userset_cond/uuc_2"),
        context: { x: "1" },
        expected: false,
      },
      {
        name: "usersets_userset_cond/invalid_object",
        objectType: UU,
        objectId: u("usersets_userset_cond/uuc_2"),
        relation: "userset_cond",
        subjectType: USER,
        subjectId: u("usersets_userset_cond/uuc_1"),
        context: { x: "1" },
        expected: false,
      },
      {
        name: "usersets_userset_cond/no_cond",
        objectType: UU,
        objectId: u("usersets_userset_cond/uuc_1"),
        relation: "userset_cond",
        subjectType: USER,
        subjectId: u("usersets_userset_cond/uuc_1"),
        expected: "refused",
      },
    ],
  },
  {
    name: "usersets_userset_cond_to_computed",
    tuples: [
      {
        objectType: DU,
        objectId: u("usersets_userset_cond_to_computed/uuctc_1"),
        relation: "direct",
        subjectType: USER,
        subjectId: u("usersets_userset_cond_to_computed/uuctc_1"),
      },
      {
        objectType: UU,
        objectId: u("usersets_userset_cond_to_computed/uuctc_1"),
        relation: "userset_cond_to_computed",
        subjectType: DU,
        subjectId: u("usersets_userset_cond_to_computed/uuctc_1"),
        subjectRelation: "computed",
        conditionName: XCOND,
      },
    ],
    cases: [
      {
        name: "usersets_userset_cond_to_computed/valid_user",
        objectType: UU,
        objectId: u("usersets_userset_cond_to_computed/uuctc_1"),
        relation: "userset_cond_to_computed",
        subjectType: USER,
        subjectId: u("usersets_userset_cond_to_computed/uuctc_1"),
        context: { x: "1" },
        expected: true,
      },
      {
        name: "usersets_userset_cond_to_computed/valid_user_invalid_cond",
        objectType: UU,
        objectId: u("usersets_userset_cond_to_computed/uuctc_1"),
        relation: "userset_cond_to_computed",
        subjectType: USER,
        subjectId: u("usersets_userset_cond_to_computed/uuctc_1"),
        context: { x: "2" },
        expected: false,
      },
      {
        name: "usersets_userset_cond_to_computed/invalid_user",
        objectType: UU,
        objectId: u("usersets_userset_cond_to_computed/uuctc_1"),
        relation: "userset_cond_to_computed",
        subjectType: USER,
        subjectId: u("usersets_userset_cond_to_computed/uuctc_2"),
        context: { x: "1" },
        expected: false,
      },
      {
        name: "usersets_userset_cond_to_computed/invalid_object",
        objectType: UU,
        objectId: u("usersets_userset_cond_to_computed/uuctc_2"),
        relation: "userset_cond_to_computed",
        subjectType: USER,
        subjectId: u("usersets_userset_cond_to_computed/uuctc_1"),
        context: { x: "1" },
        expected: false,
      },
      {
        name: "usersets_userset_cond_to_computed/no_cond",
        objectType: UU,
        objectId: u("usersets_userset_cond_to_computed/uuctc_1"),
        relation: "userset_cond_to_computed",
        subjectType: USER,
        subjectId: u("usersets_userset_cond_to_computed/uuctc_1"),
        expected: "refused",
      },
    ],
  },
  {
    name: "usersets_userset_cond_to_computed_cond",
    tuples: [
      {
        objectType: DU,
        objectId: u("usersets_userset_cond_to_computed_cond/uuctcc_1"),
        relation: "direct_cond",
        subjectType: USER,
        subjectId: u("usersets_userset_cond_to_computed_cond/uuctcc_1"),
        conditionName: XCOND,
      },
      {
        objectType: UU,
        objectId: u("usersets_userset_cond_to_computed_cond/uuctcc_1"),
        relation: "userset_cond_to_computed_cond",
        subjectType: DU,
        subjectId: u("usersets_userset_cond_to_computed_cond/uuctcc_1"),
        subjectRelation: "computed_cond",
        conditionName: XCOND,
      },
    ],
    cases: [
      {
        name: "usersets_userset_cond_to_computed_cond/valid_user",
        objectType: UU,
        objectId: u("usersets_userset_cond_to_computed_cond/uuctcc_1"),
        relation: "userset_cond_to_computed_cond",
        subjectType: USER,
        subjectId: u("usersets_userset_cond_to_computed_cond/uuctcc_1"),
        context: { x: "1" },
        expected: true,
      },
      {
        name: "usersets_userset_cond_to_computed_cond/valid_user_invalid_cond",
        objectType: UU,
        objectId: u("usersets_userset_cond_to_computed_cond/uuctcc_1"),
        relation: "userset_cond_to_computed_cond",
        subjectType: USER,
        subjectId: u("usersets_userset_cond_to_computed_cond/uuctcc_1"),
        context: { x: "2" },
        expected: false,
      },
      {
        name: "usersets_userset_cond_to_computed_cond/invalid_user",
        objectType: UU,
        objectId: u("usersets_userset_cond_to_computed_cond/uuctcc_1"),
        relation: "userset_cond_to_computed_cond",
        subjectType: USER,
        subjectId: u("usersets_userset_cond_to_computed_cond/uuctcc_2"),
        context: { x: "1" },
        expected: false,
      },
      {
        name: "usersets_userset_cond_to_computed_cond/invalid_object",
        objectType: UU,
        objectId: u("usersets_userset_cond_to_computed_cond/uuctcc_2"),
        relation: "userset_cond_to_computed_cond",
        subjectType: USER,
        subjectId: u("usersets_userset_cond_to_computed_cond/uuctcc_1"),
        context: { x: "1" },
        expected: false,
      },
      {
        name: "usersets_userset_cond_to_computed_cond/no_cond",
        objectType: UU,
        objectId: u("usersets_userset_cond_to_computed_cond/uuctcc_1"),
        relation: "userset_cond_to_computed_cond",
        subjectType: USER,
        subjectId: u("usersets_userset_cond_to_computed_cond/uuctcc_1"),
        expected: "refused",
      },
    ],
  },
  {
    name: "usersets_userset_cond_to_computed_wild",
    tuples: [
      {
        objectType: DU,
        objectId: u("usersets_userset_cond_to_computed_wild/uuctcw_1"),
        relation: "direct_wild",
        subjectType: USER,
        subjectId: "*",
      },
      {
        objectType: UU,
        objectId: u("usersets_userset_cond_to_computed_wild/uuctcw_1"),
        relation: "userset_cond_to_computed_wild",
        subjectType: DU,
        subjectId: u("usersets_userset_cond_to_computed_wild/uuctcw_1"),
        subjectRelation: "computed_wild",
        conditionName: XCOND,
      },
    ],
    cases: [
      {
        name: "usersets_userset_cond_to_computed_wild/valid_user",
        objectType: UU,
        objectId: u("usersets_userset_cond_to_computed_wild/uuctcw_1"),
        relation: "userset_cond_to_computed_wild",
        subjectType: USER,
        subjectId: u("usersets_userset_cond_to_computed_wild/uuctcw_1"),
        context: { x: "1" },
        expected: true,
      },
      {
        name: "usersets_userset_cond_to_computed_wild/valid_user_invalid_cond",
        objectType: UU,
        objectId: u("usersets_userset_cond_to_computed_wild/uuctcw_1"),
        relation: "userset_cond_to_computed_wild",
        subjectType: USER,
        subjectId: u("usersets_userset_cond_to_computed_wild/uuctcw_1"),
        context: { x: "2" },
        expected: false,
      },
      {
        name: "usersets_userset_cond_to_computed_wild/invalid_object",
        objectType: UU,
        objectId: u("usersets_userset_cond_to_computed_wild/uuctcw_2"),
        relation: "userset_cond_to_computed_wild",
        subjectType: USER,
        subjectId: u("usersets_userset_cond_to_computed_wild/uuctcw_1"),
        context: { x: "1" },
        expected: false,
      },
    ],
  },
  {
    name: "usersets_userset_cond_to_computed_wild_cond",
    tuples: [
      {
        objectType: DU,
        objectId: u("usersets_userset_cond_to_computed_wild_cond/uuctcwc_1"),
        relation: "direct_wild_cond",
        subjectType: USER,
        subjectId: "*",
        conditionName: XCOND,
      },
      {
        objectType: UU,
        objectId: u("usersets_userset_cond_to_computed_wild_cond/uuctcwc_1"),
        relation: "userset_cond_to_computed_wild_cond",
        subjectType: DU,
        subjectId: u("usersets_userset_cond_to_computed_wild_cond/uuctcwc_1"),
        subjectRelation: "computed_wild_cond",
        conditionName: XCOND,
      },
    ],
    cases: [
      {
        name: "usersets_userset_cond_to_computed_wild_cond/valid_user",
        objectType: UU,
        objectId: u("usersets_userset_cond_to_computed_wild_cond/uuctcwc_1"),
        relation: "userset_cond_to_computed_wild_cond",
        subjectType: USER,
        subjectId: u("usersets_userset_cond_to_computed_wild_cond/uuctcwc_1"),
        context: { x: "1" },
        expected: true,
      },
      {
        name: "usersets_userset_cond_to_computed_wild_cond/valid_user_invalid_cond",
        objectType: UU,
        objectId: u("usersets_userset_cond_to_computed_wild_cond/uuctcwc_1"),
        relation: "userset_cond_to_computed_wild_cond",
        subjectType: USER,
        subjectId: u("usersets_userset_cond_to_computed_wild_cond/uuctcwc_1"),
        context: { x: "2" },
        expected: false,
      },
      {
        name: "usersets_userset_cond_to_computed_wild_cond/invalid_object",
        objectType: UU,
        objectId: u("usersets_userset_cond_to_computed_wild_cond/uuctcwc_2"),
        relation: "userset_cond_to_computed_wild_cond",
        subjectType: USER,
        subjectId: u("usersets_userset_cond_to_computed_wild_cond/uuctcwc_1"),
        context: { x: "1" },
        expected: false,
      },
      {
        name: "usersets_userset_cond_to_computed_wild_cond/no_cond",
        objectType: UU,
        objectId: u("usersets_userset_cond_to_computed_wild_cond/uuctcwc_1"),
        relation: "userset_cond_to_computed_wild_cond",
        subjectType: USER,
        subjectId: u("usersets_userset_cond_to_computed_wild_cond/uuctcwc_1"),
        expected: "refused",
      },
    ],
  },
  {
    name: "usersets_userset_direct_and_direct_wild",
    tuples: [
      {
        objectType: DU,
        objectId: u("usersets_userset_direct_and_direct_wild/uuudadw_1"),
        relation: "direct_and_direct_wild",
        subjectType: USER,
        subjectId: u("usersets_userset_direct_and_direct_wild/uuudadw_1"),
      },
      {
        objectType: UU,
        objectId: u("usersets_userset_direct_and_direct_wild/uuudadw_1"),
        relation: "userset_direct_and_direct_wild",
        subjectType: DU,
        subjectId: u("usersets_userset_direct_and_direct_wild/uuudadw_1"),
        subjectRelation: "direct_and_direct_wild",
      },
      {
        objectType: DU,
        objectId: u("usersets_userset_direct_and_direct_wild/uuudadw_2"),
        relation: "direct_and_direct_wild",
        subjectType: USER,
        subjectId: u("usersets_userset_direct_and_direct_wild/uuudadw_2"),
      },
      {
        objectType: DU,
        objectId: u("usersets_userset_direct_and_direct_wild/uuudadw_2"),
        relation: "direct_and_direct_wild",
        subjectType: USER,
        subjectId: "*",
      },
      {
        objectType: DU,
        objectId: u("usersets_userset_direct_and_direct_wild/uuudadw_2a"),
        relation: "direct_and_direct_wild",
        subjectType: USER,
        subjectId: "*",
      },
      {
        objectType: DU,
        objectId: u("usersets_userset_direct_and_direct_wild/uuudadw_3"),
        relation: "direct_and_direct_wild",
        subjectType: USER,
        subjectId: u("usersets_userset_direct_and_direct_wild/uuudadw_3"),
      },
      {
        objectType: DU,
        objectId: u("usersets_userset_direct_and_direct_wild/uuudadw_3"),
        relation: "direct_and_direct_wild",
        subjectType: USER,
        subjectId: "*",
      },
      {
        objectType: DU,
        objectId: u("usersets_userset_direct_and_direct_wild/uuudadw_3a"),
        relation: "direct_and_direct_wild",
        subjectType: USER,
        subjectId: u("usersets_userset_direct_and_direct_wild/uuudadw_3"),
      },
      {
        objectType: UU,
        objectId: u("usersets_userset_direct_and_direct_wild/uuudadw_2"),
        relation: "userset_direct_and_direct_wild",
        subjectType: DU,
        subjectId: u("usersets_userset_direct_and_direct_wild/uuudadw_2"),
        subjectRelation: "direct_and_direct_wild",
      },
      {
        objectType: UU,
        objectId: u("usersets_userset_direct_and_direct_wild/uuudadw_2a"),
        relation: "userset_direct_and_direct_wild",
        subjectType: DU,
        subjectId: u("usersets_userset_direct_and_direct_wild/uuudadw_2a"),
        subjectRelation: "direct_and_direct_wild",
      },
      {
        objectType: UU,
        objectId: u("usersets_userset_direct_and_direct_wild/uuudadw_3"),
        relation: "userset_direct_and_direct_wild",
        subjectType: DU,
        subjectId: u("usersets_userset_direct_and_direct_wild/uuudadw_3"),
        subjectRelation: "direct_and_direct_wild",
      },
      {
        objectType: UU,
        objectId: u("usersets_userset_direct_and_direct_wild/uuudadw_3a"),
        relation: "userset_direct_and_direct_wild",
        subjectType: DU,
        subjectId: u("usersets_userset_direct_and_direct_wild/uuudadw_3a"),
        subjectRelation: "direct_and_direct_wild",
      },
    ],
    cases: [
      {
        name: "usersets_userset_direct_and_direct_wild/valid_user",
        objectType: UU,
        objectId: u("usersets_userset_direct_and_direct_wild/uuudadw_1"),
        relation: "userset_direct_and_direct_wild",
        subjectType: USER,
        subjectId: u("usersets_userset_direct_and_direct_wild/uuudadw_1"),
        expected: true,
      },
      {
        name: "usersets_userset_direct_and_direct_wild/valid_user_with_wildcard",
        objectType: UU,
        objectId: u("usersets_userset_direct_and_direct_wild/uuudadw_2"),
        relation: "userset_direct_and_direct_wild",
        subjectType: USER,
        subjectId: u("usersets_userset_direct_and_direct_wild/uuudadw_2"),
        expected: true,
      },
      {
        name: "usersets_userset_direct_and_direct_wild/wildcard_user_with_wildcard",
        objectType: UU,
        objectId: u("usersets_userset_direct_and_direct_wild/uuudadw_2"),
        relation: "userset_direct_and_direct_wild",
        subjectType: USER,
        subjectId: u(
          "usersets_userset_direct_and_direct_wild/uuudadw_wildcard",
        ),
        expected: true,
      },
      {
        name: "usersets_userset_direct_and_direct_wild/same_user_different_group",
        objectType: UU,
        objectId: u("usersets_userset_direct_and_direct_wild/uuudadw_2a"),
        relation: "userset_direct_and_direct_wild",
        subjectType: USER,
        subjectId: u("usersets_userset_direct_and_direct_wild/uuudadw_2"),
        expected: true,
      },
      {
        name: "usersets_userset_direct_and_direct_wild/wildcard_non_wildcard_group",
        objectType: UU,
        objectId: u("usersets_userset_direct_and_direct_wild/uuudadw_2a"),
        relation: "userset_direct_and_direct_wild",
        subjectType: USER,
        subjectId: u(
          "usersets_userset_direct_and_direct_wild/uuudadw_wildcard",
        ),
        expected: true,
      },
      {
        name: "usersets_userset_direct_and_direct_wild/order_3_valid_user_with_wildcard",
        objectType: UU,
        objectId: u("usersets_userset_direct_and_direct_wild/uuudadw_3"),
        relation: "userset_direct_and_direct_wild",
        subjectType: USER,
        subjectId: u("usersets_userset_direct_and_direct_wild/uuudadw_2"),
        expected: true,
      },
      {
        name: "usersets_userset_direct_and_direct_wild/order_3_wildcard_user_with_wildcard",
        objectType: UU,
        objectId: u("usersets_userset_direct_and_direct_wild/uuudadw_3"),
        relation: "userset_direct_and_direct_wild",
        subjectType: USER,
        subjectId: u(
          "usersets_userset_direct_and_direct_wild/uuudadw_wildcard",
        ),
        expected: true,
      },
      {
        name: "usersets_userset_direct_and_direct_wild/order_3_same_user_different_group",
        objectType: UU,
        objectId: u("usersets_userset_direct_and_direct_wild/uuudadw_3a"),
        relation: "userset_direct_and_direct_wild",
        subjectType: USER,
        subjectId: u("usersets_userset_direct_and_direct_wild/uuudadw_3"),
        expected: true,
      },
      {
        name: "usersets_userset_direct_and_direct_wild/order_3_wildcard_non_wildcard_group",
        objectType: UU,
        objectId: u("usersets_userset_direct_and_direct_wild/uuudadw_3a"),
        relation: "userset_direct_and_direct_wild",
        subjectType: USER,
        subjectId: u(
          "usersets_userset_direct_and_direct_wild/uuudadw_wildcard",
        ),
        expected: false,
      },
    ],
  },
];

describe("B1 userset corpus — the direct userset arms", () => {
  let db: Kysely<DB>;
  let corpus: Corpus;
  let fixture: FixtureRecord;

  beforeAll(async () => {
    db = getDb();
    await beginTransaction(db);

    const tsfgaClient = createTsfga(new KyselyTupleStore(db));
    fixture = recordFixture(tsfgaClient);
    corpus = await loadCorpus(tsfgaClient, {
      slug: "userset-matrix",
      modelPath: "./userset-matrix/model.dsl",
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

  /**
   * Upstream's `usersets_userset_to_computed_wild/invalid_user_type`,
   * transcribed as a **pinned divergence** instead of as a case.
   *
   * The subject's type is `ttus_b1a`, which the model declares
   * (`userset-matrix/model.dsl:47`) with no relations, and which
   * no other type's restriction names. Upstream reads the model
   * document, sees the type definition, and answers `false`. tsfga
   * stores a model as relation configs and nothing else, so a type
   * with no config of its own and no restriction naming it leaves
   * **no record in the store at all** — `hasTypeDefinition` cannot
   * see it, and the subject-type gate refuses a check upstream
   * answers.
   *
   * This cell comes from upstream's own corpus, so pinning it is a
   * knowing divergence from an upstream expectation rather than a
   * tsfga preference. It is kept because both directions of the
   * trade deny rather than grant, and the shape it costs — a model
   * declaring a type nothing else in it references, checked as a
   * subject — is far rarer than the shape it buys: a misspelled or
   * since-removed subject type answering a plain `false` that is
   * indistinguishable from a real denial.
   *
   * It closes when tsfga records a model as a document rather than
   * as per-relation configs, which is where `listDefinedTypes()`
   * will sit. Round-3 work; until then this test is the one place
   * the residual is visible.
   */
  test("ISSUE-261: a declared type no restriction names is refused", async () => {
    const store = corpus.stores.get("usersets_userset_to_computed_wild");
    if (!store) throw new Error("No store for the stage");
    await expectPinnedDivergence(
      store.storeId,
      store.authorizationModelId,
      corpus.tsfgaClient,
      {
        objectType: UU,
        objectId: u("usersets_userset_to_computed_wild/utcw_1"),
        relation: "userset_to_computed_wild",
        subjectType: TT,
        subjectId: u("usersets_userset_to_computed_wild/utcw_invalid"),
      },
      { openfga: false, tsfga: "refused" },
    );
  });

  test("the configs say what the model says", () => {
    expectConfigsMatchModel("./userset-matrix/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
