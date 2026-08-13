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
 * B1 userset corpus — usersets under set algebra.
 *
 * A port of upstream's own case matrix —
 * `tests/check/check_userset.go` at v1.18.2 — over the stages
 * listed below. Every `expected` is the `Expectation:` the Go
 * corpus states, so a shape both engines answer the same
 * *wrong* way still fails.
 *
 * Stages ported here:
 * - `usersets_userset_to_or_computed`
 * - `usersets_userset_to_or_computed_no_condition`
 * - `usersets_userset_to_butnot_computed`
 * - `usersets_userset_to_and_computed`
 * - `usersets_or_userset`
 * - `usersets_and_userset`
 * - `usersets_butnot_userset`
 * - `usersets_nested_or_userset`
 * - `usersets_nested_and_userset`
 *
 * Upstream's `ErrorCode: 2000` (a check whose condition
 * parameter the request never supplied) is transcribed as
 * `"refused"`: both engines decline to answer rather than
 * denying.
 *
 * Types and the condition carry a `_b1b` suffix so this
 * fixture cannot collide with another fixture's rows in the
 * shared Postgres and OpenFGA.
 */

const USER = "user_b1b";
const EMPLOYEE = "employee_b1b";
const DU = "directs_user_b1b";
const DE = "directs_employee_b1b";
const UU = "usersets_user_b1b";
const XCOND = "xcond_b1b";

/** Upstream's object and subject names, as UUIDs. */
const u = ids(
  [
    "usersets_userset_to_or_computed/utoc_1",
    "usersets_userset_to_or_computed/utoc_2",
    "usersets_userset_to_or_computed/utoc_3",
    "usersets_userset_to_or_computed/utoc_4",
    "usersets_userset_to_or_computed_no_condition/utoc_no_cond_1",
    "usersets_userset_to_or_computed_no_condition/utoc_no_cond_2",
    "usersets_userset_to_or_computed_no_condition/utoc_no_cond_3",
    "usersets_userset_to_or_computed_no_condition/(utoc_no_cond_3)",
    "usersets_userset_to_or_computed_no_condition/utoc_no_cond_4",
    "usersets_userset_to_or_computed_no_condition/(utoc_no_cond_4)",
    "usersets_userset_to_or_computed_no_condition/(utoc_no_cond_2)",
    "usersets_userset_to_or_computed_no_condition/utoc_no_cond_3_wildcard",
    "usersets_userset_to_or_computed_no_condition/utoc_no_cond_4_invalid_user",
    "usersets_userset_to_butnot_computed/utbc_1",
    "usersets_userset_to_butnot_computed/utbc_2",
    "usersets_userset_to_and_computed/utac_1",
    "usersets_userset_to_and_computed/utac_2",
    "usersets_or_userset/userset_or_1",
    "usersets_or_userset/userset_or_userset_valid",
    "usersets_or_userset/userset_or_2",
    "usersets_or_userset/uou_2",
    "usersets_or_userset/userset_or_3",
    "usersets_or_userset/uou_3",
    "usersets_or_userset/userset_or_4",
    "usersets_or_userset/uou_4",
    "usersets_or_userset/userset_or_userset_invalid",
    "usersets_and_userset/uau_1",
    "usersets_and_userset/uau_2",
    "usersets_and_userset/uau_3",
    "usersets_butnot_userset/bnu_1",
    "usersets_butnot_userset/bnu_2",
    "usersets_nested_or_userset/nou_1",
    "usersets_nested_or_userset/nou_2",
    "usersets_nested_or_userset/nou_3",
    "usersets_nested_or_userset/nou_4",
    "usersets_nested_or_userset/5",
    "usersets_nested_or_userset/nou_5",
    "usersets_nested_and_userset/nau_1",
    "usersets_nested_and_userset/nau_5",
  ],
  "d480",
);

// Written in dependency order: a tupleset relation's config
// exists before the tuple-to-userset that names it, so
// `writeRelationConfig`'s tupleset gates can see it.
const CONFIGS: RelationConfig[] = [
  cfg(DE, "direct", { directlyAssignable: [{ type: EMPLOYEE }] }),
  cfg(DE, "direct_cond", {
    directlyAssignable: [{ type: EMPLOYEE, condition: XCOND }],
  }),
  cfg(DE, "direct_wild", {
    directlyAssignable: [{ type: EMPLOYEE, wildcard: true }],
  }),
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
  cfg(DU, "direct_wild_cond", {
    directlyAssignable: [{ type: USER, wildcard: true, condition: XCOND }],
  }),
  cfg(DU, "computed_wild_cond", { computedUserset: "direct_wild_cond" }),
  cfg(DU, "direct", { directlyAssignable: [{ type: USER }] }),
  cfg(DU, "computed", { computedUserset: "direct" }),
  cfg(DU, "computed_computed", { computedUserset: "computed" }),
  cfg(DU, "butnot_computed", {
    computedUserset: "computed_wild_cond",
    excludedBy: "computed_computed",
  }),
  cfg(DU, "or_computed", {
    impliedBy: ["computed", "computed_cond", "direct_wild"],
  }),
  cfg(DU, "or_computed_no_cond", { impliedBy: ["computed", "direct_wild"] }),
  cfg(UU, "userset_to_computed_cond", {
    directlyAssignable: [
      { type: DU, relation: "computed_cond" },
      { type: DE, relation: "direct_cond" },
    ],
  }),
  cfg(UU, "userset_to_computed_wild", {
    directlyAssignable: [
      { type: DU, relation: "computed_wild" },
      { type: DE, relation: "direct_wild" },
    ],
  }),
  cfg(UU, "and_userset", {
    intersection: [
      { type: "computedUserset", relation: "userset_to_computed_cond" },
      { type: "computedUserset", relation: "userset_to_computed_wild" },
    ],
  }),
  cfg(UU, "userset_cond_to_computed_wild", {
    directlyAssignable: [
      { type: DU, relation: "computed_wild", condition: XCOND },
    ],
  }),
  cfg(UU, "userset_cond", {
    directlyAssignable: [{ type: DU, relation: "direct", condition: XCOND }],
  }),
  cfg(UU, "butnot_userset", {
    computedUserset: "userset_cond_to_computed_wild",
    excludedBy: "userset_cond",
  }),
  cfg(UU, "userset_to_and_computed", {
    directlyAssignable: [{ type: DU, relation: "and_computed" }],
  }),
  cfg(UU, "userset_to_or_computed", {
    directlyAssignable: [{ type: DU, relation: "or_computed" }],
  }),
  cfg(UU, "nested_and_userset", {
    intersection: [
      { type: "computedUserset", relation: "userset_to_and_computed" },
      { type: "computedUserset", relation: "userset_to_or_computed" },
    ],
  }),
  cfg(UU, "userset_to_butnot_computed", {
    directlyAssignable: [{ type: DU, relation: "butnot_computed" }],
  }),
  cfg(UU, "nested_or_userset", {
    impliedBy: ["userset_to_or_computed", "userset_to_butnot_computed"],
  }),
  cfg(UU, "userset", {
    directlyAssignable: [
      { type: DU, relation: "direct" },
      { type: DE, relation: "direct" },
    ],
  }),
  cfg(UU, "or_userset", { impliedBy: ["userset", "userset_to_computed_cond"] }),
  cfg(UU, "userset_to_or_computed_no_cond", {
    directlyAssignable: [{ type: DU, relation: "or_computed_no_cond" }],
  }),
];

const STAGES: Stage[] = [
  {
    name: "usersets_userset_to_or_computed",
    tuples: [
      {
        objectType: DU,
        objectId: u("usersets_userset_to_or_computed/utoc_1"),
        relation: "direct",
        subjectType: USER,
        subjectId: u("usersets_userset_to_or_computed/utoc_1"),
      },
      {
        objectType: DU,
        objectId: u("usersets_userset_to_or_computed/utoc_2"),
        relation: "direct_wild",
        subjectType: USER,
        subjectId: "*",
      },
      {
        objectType: DU,
        objectId: u("usersets_userset_to_or_computed/utoc_3"),
        relation: "direct_cond",
        subjectType: USER,
        subjectId: u("usersets_userset_to_or_computed/utoc_3"),
        conditionName: XCOND,
      },
      {
        objectType: UU,
        objectId: u("usersets_userset_to_or_computed/utoc_1"),
        relation: "userset_to_or_computed",
        subjectType: DU,
        subjectId: u("usersets_userset_to_or_computed/utoc_1"),
        subjectRelation: "or_computed",
      },
      {
        objectType: UU,
        objectId: u("usersets_userset_to_or_computed/utoc_2"),
        relation: "userset_to_or_computed",
        subjectType: DU,
        subjectId: u("usersets_userset_to_or_computed/utoc_2"),
        subjectRelation: "or_computed",
      },
      {
        objectType: UU,
        objectId: u("usersets_userset_to_or_computed/utoc_3"),
        relation: "userset_to_or_computed",
        subjectType: DU,
        subjectId: u("usersets_userset_to_or_computed/utoc_3"),
        subjectRelation: "or_computed",
      },
    ],
    cases: [
      {
        name: "usersets_userset_to_or_computed/valid_user",
        objectType: UU,
        objectId: u("usersets_userset_to_or_computed/utoc_1"),
        relation: "userset_to_or_computed",
        subjectType: USER,
        subjectId: u("usersets_userset_to_or_computed/utoc_1"),
        expected: true,
      },
      {
        name: "usersets_userset_to_or_computed/valid_wildcard",
        objectType: UU,
        objectId: u("usersets_userset_to_or_computed/utoc_2"),
        relation: "userset_to_or_computed",
        subjectType: USER,
        subjectId: u("usersets_userset_to_or_computed/utoc_2"),
        expected: true,
      },
      {
        name: "usersets_userset_to_or_computed/valid_user_cond",
        objectType: UU,
        objectId: u("usersets_userset_to_or_computed/utoc_3"),
        relation: "userset_to_or_computed",
        subjectType: USER,
        subjectId: u("usersets_userset_to_or_computed/utoc_3"),
        context: { x: "1" },
        expected: true,
      },
      {
        name: "usersets_userset_to_or_computed/valid_user_invalid_cond",
        objectType: UU,
        objectId: u("usersets_userset_to_or_computed/utoc_3"),
        relation: "userset_to_or_computed",
        subjectType: USER,
        subjectId: u("usersets_userset_to_or_computed/utoc_3"),
        context: { x: "2" },
        expected: false,
      },
      {
        name: "usersets_userset_to_or_computed/invalid_user",
        objectType: UU,
        objectId: u("usersets_userset_to_or_computed/utoc_1"),
        relation: "userset_to_or_computed",
        subjectType: USER,
        subjectId: u("usersets_userset_to_or_computed/utoc_2"),
        expected: false,
      },
      {
        name: "usersets_userset_to_or_computed/invalid_user_cond",
        objectType: UU,
        objectId: u("usersets_userset_to_or_computed/utoc_3"),
        relation: "userset_to_or_computed",
        subjectType: USER,
        subjectId: u("usersets_userset_to_or_computed/utoc_4"),
        context: { x: "1" },
        expected: false,
      },
      {
        name: "usersets_userset_to_or_computed/no_condition",
        objectType: UU,
        objectId: u("usersets_userset_to_or_computed/utoc_3"),
        relation: "userset_to_or_computed",
        subjectType: USER,
        subjectId: u("usersets_userset_to_or_computed/utoc_3"),
        expected: "refused",
      },
      {
        name: "usersets_userset_to_or_computed/invalid_object",
        objectType: UU,
        objectId: u("usersets_userset_to_or_computed/utoc_3"),
        relation: "userset_to_or_computed",
        subjectType: USER,
        subjectId: u("usersets_userset_to_or_computed/utoc_1"),
        expected: false,
      },
    ],
  },
  {
    name: "usersets_userset_to_or_computed_no_condition",
    tuples: [
      {
        objectType: DU,
        objectId: u(
          "usersets_userset_to_or_computed_no_condition/utoc_no_cond_1",
        ),
        relation: "direct",
        subjectType: USER,
        subjectId: u(
          "usersets_userset_to_or_computed_no_condition/utoc_no_cond_1",
        ),
      },
      {
        objectType: DU,
        objectId: u(
          "usersets_userset_to_or_computed_no_condition/utoc_no_cond_2",
        ),
        relation: "direct_wild",
        subjectType: USER,
        subjectId: "*",
      },
      {
        objectType: DU,
        objectId: u(
          "usersets_userset_to_or_computed_no_condition/utoc_no_cond_3",
        ),
        relation: "direct",
        subjectType: USER,
        subjectId: u(
          "usersets_userset_to_or_computed_no_condition/(utoc_no_cond_3)",
        ),
      },
      {
        objectType: DU,
        objectId: u(
          "usersets_userset_to_or_computed_no_condition/utoc_no_cond_3",
        ),
        relation: "direct_wild",
        subjectType: USER,
        subjectId: "*",
      },
      {
        objectType: DU,
        objectId: u(
          "usersets_userset_to_or_computed_no_condition/utoc_no_cond_3",
        ),
        relation: "direct",
        subjectType: USER,
        subjectId: u(
          "usersets_userset_to_or_computed_no_condition/utoc_no_cond_3",
        ),
      },
      {
        objectType: DU,
        objectId: u(
          "usersets_userset_to_or_computed_no_condition/utoc_no_cond_4",
        ),
        relation: "direct",
        subjectType: USER,
        subjectId: u(
          "usersets_userset_to_or_computed_no_condition/(utoc_no_cond_4)",
        ),
      },
      {
        objectType: DU,
        objectId: u(
          "usersets_userset_to_or_computed_no_condition/utoc_no_cond_4",
        ),
        relation: "direct",
        subjectType: USER,
        subjectId: u(
          "usersets_userset_to_or_computed_no_condition/utoc_no_cond_4",
        ),
      },
      {
        objectType: UU,
        objectId: u(
          "usersets_userset_to_or_computed_no_condition/utoc_no_cond_1",
        ),
        relation: "userset_to_or_computed_no_cond",
        subjectType: DU,
        subjectId: u(
          "usersets_userset_to_or_computed_no_condition/utoc_no_cond_1",
        ),
        subjectRelation: "or_computed_no_cond",
      },
      {
        objectType: UU,
        objectId: u(
          "usersets_userset_to_or_computed_no_condition/utoc_no_cond_2",
        ),
        relation: "userset_to_or_computed_no_cond",
        subjectType: DU,
        subjectId: u(
          "usersets_userset_to_or_computed_no_condition/utoc_no_cond_2",
        ),
        subjectRelation: "or_computed_no_cond",
      },
      {
        objectType: UU,
        objectId: u(
          "usersets_userset_to_or_computed_no_condition/utoc_no_cond_3",
        ),
        relation: "userset_to_or_computed_no_cond",
        subjectType: DU,
        subjectId: u(
          "usersets_userset_to_or_computed_no_condition/utoc_no_cond_3",
        ),
        subjectRelation: "or_computed_no_cond",
      },
      {
        objectType: UU,
        objectId: u(
          "usersets_userset_to_or_computed_no_condition/utoc_no_cond_4",
        ),
        relation: "userset_to_or_computed_no_cond",
        subjectType: DU,
        subjectId: u(
          "usersets_userset_to_or_computed_no_condition/utoc_no_cond_4",
        ),
        subjectRelation: "or_computed_no_cond",
      },
    ],
    cases: [
      {
        name: "usersets_userset_to_or_computed_no_condition/valid_user",
        objectType: UU,
        objectId: u(
          "usersets_userset_to_or_computed_no_condition/utoc_no_cond_1",
        ),
        relation: "userset_to_or_computed_no_cond",
        subjectType: USER,
        subjectId: u(
          "usersets_userset_to_or_computed_no_condition/utoc_no_cond_1",
        ),
        expected: true,
      },
      {
        name: "usersets_userset_to_or_computed_no_condition/valid_wildcard",
        objectType: UU,
        objectId: u(
          "usersets_userset_to_or_computed_no_condition/utoc_no_cond_2",
        ),
        relation: "userset_to_or_computed_no_cond",
        subjectType: USER,
        subjectId: u(
          "usersets_userset_to_or_computed_no_condition/utoc_no_cond_2",
        ),
        expected: true,
      },
      {
        name: "usersets_userset_to_or_computed_no_condition/valid_wildcard_before_wildcard",
        objectType: UU,
        objectId: u(
          "usersets_userset_to_or_computed_no_condition/utoc_no_cond_2",
        ),
        relation: "userset_to_or_computed_no_cond",
        subjectType: USER,
        subjectId: u(
          "usersets_userset_to_or_computed_no_condition/(utoc_no_cond_2)",
        ),
        expected: true,
      },
      {
        name: "usersets_userset_to_or_computed_no_condition/invalid_user",
        objectType: UU,
        objectId: u(
          "usersets_userset_to_or_computed_no_condition/utoc_no_cond_1",
        ),
        relation: "userset_to_or_computed_no_cond",
        subjectType: USER,
        subjectId: u(
          "usersets_userset_to_or_computed_no_condition/utoc_no_cond_2",
        ),
        expected: false,
      },
      {
        name: "usersets_userset_to_or_computed_no_condition/valid_user_3_before_wildcard",
        objectType: UU,
        objectId: u(
          "usersets_userset_to_or_computed_no_condition/utoc_no_cond_3",
        ),
        relation: "userset_to_or_computed_no_cond",
        subjectType: USER,
        subjectId: u(
          "usersets_userset_to_or_computed_no_condition/(utoc_no_cond_3)",
        ),
        expected: true,
      },
      {
        name: "usersets_userset_to_or_computed_no_condition/valid_user_3_wildcard",
        objectType: UU,
        objectId: u(
          "usersets_userset_to_or_computed_no_condition/utoc_no_cond_3",
        ),
        relation: "userset_to_or_computed_no_cond",
        subjectType: USER,
        subjectId: u(
          "usersets_userset_to_or_computed_no_condition/utoc_no_cond_3_wildcard",
        ),
        expected: true,
      },
      {
        name: "usersets_userset_to_or_computed_no_condition/valid_user_3_after_wildcard",
        objectType: UU,
        objectId: u(
          "usersets_userset_to_or_computed_no_condition/utoc_no_cond_3",
        ),
        relation: "userset_to_or_computed_no_cond",
        subjectType: USER,
        subjectId: u(
          "usersets_userset_to_or_computed_no_condition/utoc_no_cond_3",
        ),
        expected: true,
      },
      {
        name: "usersets_userset_to_or_computed_no_condition/valid_user_4_before_wildcard",
        objectType: UU,
        objectId: u(
          "usersets_userset_to_or_computed_no_condition/utoc_no_cond_4",
        ),
        relation: "userset_to_or_computed_no_cond",
        subjectType: USER,
        subjectId: u(
          "usersets_userset_to_or_computed_no_condition/(utoc_no_cond_4)",
        ),
        expected: true,
      },
      {
        name: "usersets_userset_to_or_computed_no_condition/valid_user_4_invalid_user",
        objectType: UU,
        objectId: u(
          "usersets_userset_to_or_computed_no_condition/utoc_no_cond_4",
        ),
        relation: "userset_to_or_computed_no_cond",
        subjectType: USER,
        subjectId: u(
          "usersets_userset_to_or_computed_no_condition/utoc_no_cond_4_invalid_user",
        ),
        expected: false,
      },
      {
        name: "usersets_userset_to_or_computed_no_condition/valid_user_4_after_wildcard",
        objectType: UU,
        objectId: u(
          "usersets_userset_to_or_computed_no_condition/utoc_no_cond_4",
        ),
        relation: "userset_to_or_computed_no_cond",
        subjectType: USER,
        subjectId: u(
          "usersets_userset_to_or_computed_no_condition/utoc_no_cond_4",
        ),
        expected: true,
      },
    ],
  },
  {
    name: "usersets_userset_to_butnot_computed",
    tuples: [
      {
        objectType: DU,
        objectId: u("usersets_userset_to_butnot_computed/utbc_1"),
        relation: "direct_wild_cond",
        subjectType: USER,
        subjectId: "*",
        conditionName: XCOND,
      },
      {
        objectType: DU,
        objectId: u("usersets_userset_to_butnot_computed/utbc_1"),
        relation: "direct",
        subjectType: USER,
        subjectId: u("usersets_userset_to_butnot_computed/utbc_2"),
      },
      {
        objectType: UU,
        objectId: u("usersets_userset_to_butnot_computed/utbc_1"),
        relation: "userset_to_butnot_computed",
        subjectType: DU,
        subjectId: u("usersets_userset_to_butnot_computed/utbc_1"),
        subjectRelation: "butnot_computed",
      },
    ],
    cases: [
      {
        name: "usersets_userset_to_butnot_computed/valid_user",
        objectType: UU,
        objectId: u("usersets_userset_to_butnot_computed/utbc_1"),
        relation: "userset_to_butnot_computed",
        subjectType: USER,
        subjectId: u("usersets_userset_to_butnot_computed/utbc_1"),
        context: { x: "1" },
        expected: true,
      },
      {
        name: "usersets_userset_to_butnot_computed/valid_user_invalid_cond",
        objectType: UU,
        objectId: u("usersets_userset_to_butnot_computed/utbc_1"),
        relation: "userset_to_butnot_computed",
        subjectType: USER,
        subjectId: u("usersets_userset_to_butnot_computed/utbc_1"),
        context: { x: "2" },
        expected: false,
      },
      {
        name: "usersets_userset_to_butnot_computed/no_condition",
        objectType: UU,
        objectId: u("usersets_userset_to_butnot_computed/utbc_1"),
        relation: "userset_to_butnot_computed",
        subjectType: USER,
        subjectId: u("usersets_userset_to_butnot_computed/utbc_1"),
        expected: "refused",
      },
      {
        name: "usersets_userset_to_butnot_computed/but_not_case",
        objectType: UU,
        objectId: u("usersets_userset_to_butnot_computed/utbc_1"),
        relation: "userset_to_butnot_computed",
        subjectType: USER,
        subjectId: u("usersets_userset_to_butnot_computed/utbc_2"),
        context: { x: "1" },
        expected: false,
      },
      {
        name: "usersets_userset_to_butnot_computed/invalid_object",
        objectType: UU,
        objectId: u("usersets_userset_to_butnot_computed/utbc_2"),
        relation: "userset_to_butnot_computed",
        subjectType: USER,
        subjectId: u("usersets_userset_to_butnot_computed/utbc_2"),
        context: { x: "1" },
        expected: false,
      },
    ],
  },
  {
    name: "usersets_userset_to_and_computed",
    tuples: [
      {
        objectType: DU,
        objectId: u("usersets_userset_to_and_computed/utac_1"),
        relation: "direct_cond",
        subjectType: USER,
        subjectId: u("usersets_userset_to_and_computed/utac_1"),
        conditionName: XCOND,
      },
      {
        objectType: DU,
        objectId: u("usersets_userset_to_and_computed/utac_1"),
        relation: "direct_wild",
        subjectType: USER,
        subjectId: "*",
      },
      {
        objectType: UU,
        objectId: u("usersets_userset_to_and_computed/utac_1"),
        relation: "userset_to_and_computed",
        subjectType: DU,
        subjectId: u("usersets_userset_to_and_computed/utac_1"),
        subjectRelation: "and_computed",
      },
    ],
    cases: [
      {
        name: "usersets_userset_to_and_computed/valid_user",
        objectType: UU,
        objectId: u("usersets_userset_to_and_computed/utac_1"),
        relation: "userset_to_and_computed",
        subjectType: USER,
        subjectId: u("usersets_userset_to_and_computed/utac_1"),
        context: { x: "1" },
        expected: true,
      },
      {
        name: "usersets_userset_to_and_computed/valid_user_invalid_cond",
        objectType: UU,
        objectId: u("usersets_userset_to_and_computed/utac_1"),
        relation: "userset_to_and_computed",
        subjectType: USER,
        subjectId: u("usersets_userset_to_and_computed/utac_1"),
        context: { x: "2" },
        expected: false,
      },
      {
        name: "usersets_userset_to_and_computed/no_condition",
        objectType: UU,
        objectId: u("usersets_userset_to_and_computed/utac_1"),
        relation: "userset_to_and_computed",
        subjectType: USER,
        subjectId: u("usersets_userset_to_and_computed/utac_1"),
        expected: "refused",
      },
      {
        name: "usersets_userset_to_and_computed/invalid_user",
        objectType: UU,
        objectId: u("usersets_userset_to_and_computed/utac_1"),
        relation: "userset_to_and_computed",
        subjectType: USER,
        subjectId: u("usersets_userset_to_and_computed/utac_2"),
        context: { x: "1" },
        expected: false,
      },
      {
        name: "usersets_userset_to_and_computed/invalid_object",
        objectType: UU,
        objectId: u("usersets_userset_to_and_computed/utac_2"),
        relation: "userset_to_and_computed",
        subjectType: USER,
        subjectId: u("usersets_userset_to_and_computed/utac_2"),
        context: { x: "1" },
        expected: false,
      },
    ],
  },
  {
    name: "usersets_or_userset",
    tuples: [
      {
        objectType: DU,
        objectId: u("usersets_or_userset/userset_or_1"),
        relation: "direct",
        subjectType: USER,
        subjectId: u("usersets_or_userset/userset_or_userset_valid"),
      },
      {
        objectType: DU,
        objectId: u("usersets_or_userset/userset_or_2"),
        relation: "direct_cond",
        subjectType: USER,
        subjectId: u("usersets_or_userset/uou_2"),
        conditionName: XCOND,
      },
      {
        objectType: DE,
        objectId: u("usersets_or_userset/userset_or_3"),
        relation: "direct",
        subjectType: EMPLOYEE,
        subjectId: u("usersets_or_userset/uou_3"),
      },
      {
        objectType: DE,
        objectId: u("usersets_or_userset/userset_or_4"),
        relation: "direct_cond",
        subjectType: EMPLOYEE,
        subjectId: u("usersets_or_userset/uou_4"),
        conditionName: XCOND,
      },
      {
        objectType: UU,
        objectId: u("usersets_or_userset/userset_or_1"),
        relation: "userset",
        subjectType: DU,
        subjectId: u("usersets_or_userset/userset_or_1"),
        subjectRelation: "direct",
      },
      {
        objectType: UU,
        objectId: u("usersets_or_userset/userset_or_2"),
        relation: "userset_to_computed_cond",
        subjectType: DU,
        subjectId: u("usersets_or_userset/userset_or_2"),
        subjectRelation: "computed_cond",
      },
      {
        objectType: UU,
        objectId: u("usersets_or_userset/userset_or_3"),
        relation: "userset",
        subjectType: DE,
        subjectId: u("usersets_or_userset/userset_or_3"),
        subjectRelation: "direct",
      },
      {
        objectType: UU,
        objectId: u("usersets_or_userset/userset_or_4"),
        relation: "userset_to_computed_cond",
        subjectType: DE,
        subjectId: u("usersets_or_userset/userset_or_4"),
        subjectRelation: "direct_cond",
      },
    ],
    cases: [
      {
        name: "usersets_or_userset/valid_userset_directs-user",
        objectType: UU,
        objectId: u("usersets_or_userset/userset_or_1"),
        relation: "or_userset",
        subjectType: USER,
        subjectId: u("usersets_or_userset/userset_or_userset_valid"),
        expected: true,
      },
      {
        name: "usersets_or_userset/valid_userset_directs-user_cond",
        objectType: UU,
        objectId: u("usersets_or_userset/userset_or_2"),
        relation: "or_userset",
        subjectType: USER,
        subjectId: u("usersets_or_userset/uou_2"),
        context: { x: "1" },
        expected: true,
      },
      {
        name: "usersets_or_userset/valid_userset_directs-employee",
        objectType: UU,
        objectId: u("usersets_or_userset/userset_or_3"),
        relation: "or_userset",
        subjectType: EMPLOYEE,
        subjectId: u("usersets_or_userset/uou_3"),
        expected: true,
      },
      {
        name: "usersets_or_userset/valid_userset_directs-employee_cond",
        objectType: UU,
        objectId: u("usersets_or_userset/userset_or_4"),
        relation: "or_userset",
        subjectType: EMPLOYEE,
        subjectId: u("usersets_or_userset/uou_4"),
        context: { x: "1" },
        expected: true,
      },
      {
        name: "usersets_or_userset/valid_userset_directs-user_cond_invalid_cond",
        objectType: UU,
        objectId: u("usersets_or_userset/userset_or_2"),
        relation: "or_userset",
        subjectType: USER,
        subjectId: u("usersets_or_userset/uou_2"),
        context: { x: "2" },
        expected: false,
      },
      {
        name: "usersets_or_userset/valid_userset_directs-employee_cond_invalid_cond",
        objectType: UU,
        objectId: u("usersets_or_userset/userset_or_4"),
        relation: "or_userset",
        subjectType: EMPLOYEE,
        subjectId: u("usersets_or_userset/uou_4"),
        context: { x: "2" },
        expected: false,
      },
      {
        name: "usersets_or_userset/valid_userset_directs-user_cond_no_cond",
        objectType: UU,
        objectId: u("usersets_or_userset/userset_or_2"),
        relation: "or_userset",
        subjectType: USER,
        subjectId: u("usersets_or_userset/uou_2"),
        expected: "refused",
      },
      {
        name: "usersets_or_userset/valid_userset_directs-employee_cond_ino_cond",
        objectType: UU,
        objectId: u("usersets_or_userset/userset_or_4"),
        relation: "or_userset",
        subjectType: EMPLOYEE,
        subjectId: u("usersets_or_userset/uou_4"),
        expected: "refused",
      },
      {
        name: "usersets_or_userset/invalid_userset",
        objectType: UU,
        objectId: u("usersets_or_userset/userset_or_1"),
        relation: "or_userset",
        subjectType: USER,
        subjectId: u("usersets_or_userset/userset_or_userset_invalid"),
        expected: false,
      },
      {
        name: "usersets_or_userset/invalid_object",
        objectType: UU,
        objectId: u("usersets_or_userset/userset_or_2"),
        relation: "or_userset",
        subjectType: USER,
        subjectId: u("usersets_or_userset/userset_or_userset_invalid"),
        expected: false,
      },
    ],
  },
  {
    name: "usersets_and_userset",
    tuples: [
      {
        objectType: DU,
        objectId: u("usersets_and_userset/uau_1"),
        relation: "direct_cond",
        subjectType: USER,
        subjectId: u("usersets_and_userset/uau_1"),
        conditionName: XCOND,
      },
      {
        objectType: DU,
        objectId: u("usersets_and_userset/uau_1"),
        relation: "direct_wild",
        subjectType: USER,
        subjectId: "*",
      },
      {
        objectType: UU,
        objectId: u("usersets_and_userset/uau_1"),
        relation: "userset_to_computed_cond",
        subjectType: DU,
        subjectId: u("usersets_and_userset/uau_1"),
        subjectRelation: "computed_cond",
      },
      {
        objectType: UU,
        objectId: u("usersets_and_userset/uau_1"),
        relation: "userset_to_computed_wild",
        subjectType: DU,
        subjectId: u("usersets_and_userset/uau_1"),
        subjectRelation: "computed_wild",
      },
      {
        objectType: DE,
        objectId: u("usersets_and_userset/uau_1"),
        relation: "direct_cond",
        subjectType: EMPLOYEE,
        subjectId: u("usersets_and_userset/uau_1"),
        conditionName: XCOND,
      },
      {
        objectType: DE,
        objectId: u("usersets_and_userset/uau_1"),
        relation: "direct_wild",
        subjectType: EMPLOYEE,
        subjectId: "*",
      },
      {
        objectType: UU,
        objectId: u("usersets_and_userset/uau_2"),
        relation: "userset_to_computed_cond",
        subjectType: DE,
        subjectId: u("usersets_and_userset/uau_1"),
        subjectRelation: "direct_cond",
      },
      {
        objectType: UU,
        objectId: u("usersets_and_userset/uau_2"),
        relation: "userset_to_computed_wild",
        subjectType: DE,
        subjectId: u("usersets_and_userset/uau_1"),
        subjectRelation: "direct_wild",
      },
    ],
    cases: [
      {
        name: "usersets_and_userset/valid_user",
        objectType: UU,
        objectId: u("usersets_and_userset/uau_1"),
        relation: "and_userset",
        subjectType: USER,
        subjectId: u("usersets_and_userset/uau_1"),
        context: { x: "1" },
        expected: true,
      },
      {
        name: "usersets_and_userset/valid_user_invalid_cond",
        objectType: UU,
        objectId: u("usersets_and_userset/uau_1"),
        relation: "and_userset",
        subjectType: USER,
        subjectId: u("usersets_and_userset/uau_1"),
        context: { x: "2" },
        expected: false,
      },
      {
        name: "usersets_and_userset/invalid_user",
        objectType: UU,
        objectId: u("usersets_and_userset/uau_1"),
        relation: "and_userset",
        subjectType: USER,
        subjectId: u("usersets_and_userset/uau_2"),
        context: { x: "1" },
        expected: false,
      },
      {
        name: "usersets_and_userset/no_condition",
        objectType: UU,
        objectId: u("usersets_and_userset/uau_1"),
        relation: "and_userset",
        subjectType: USER,
        subjectId: u("usersets_and_userset/uau_1"),
        expected: "refused",
      },
      {
        name: "usersets_and_userset/invalid_object",
        objectType: UU,
        objectId: u("usersets_and_userset/uau_3"),
        relation: "and_userset",
        subjectType: USER,
        subjectId: u("usersets_and_userset/uau_1"),
        context: { x: "1" },
        expected: false,
      },
      {
        name: "usersets_and_userset/valid_employee",
        objectType: UU,
        objectId: u("usersets_and_userset/uau_2"),
        relation: "and_userset",
        subjectType: EMPLOYEE,
        subjectId: u("usersets_and_userset/uau_1"),
        context: { x: "1" },
        expected: true,
      },
      {
        name: "usersets_and_userset/valid_employee_invalid_cond",
        objectType: UU,
        objectId: u("usersets_and_userset/uau_2"),
        relation: "and_userset",
        subjectType: EMPLOYEE,
        subjectId: u("usersets_and_userset/uau_1"),
        context: { x: "2" },
        expected: false,
      },
      {
        name: "usersets_and_userset/invalid_employee",
        objectType: UU,
        objectId: u("usersets_and_userset/uau_2"),
        relation: "and_userset",
        subjectType: EMPLOYEE,
        subjectId: u("usersets_and_userset/uau_2"),
        context: { x: "1" },
        expected: false,
      },
    ],
  },
  {
    name: "usersets_butnot_userset",
    tuples: [
      {
        objectType: DU,
        objectId: u("usersets_butnot_userset/bnu_1"),
        relation: "direct_wild",
        subjectType: USER,
        subjectId: "*",
      },
      {
        objectType: DU,
        objectId: u("usersets_butnot_userset/bnu_1"),
        relation: "direct",
        subjectType: USER,
        subjectId: u("usersets_butnot_userset/bnu_2"),
      },
      {
        objectType: UU,
        objectId: u("usersets_butnot_userset/bnu_1"),
        relation: "userset_cond",
        subjectType: DU,
        subjectId: u("usersets_butnot_userset/bnu_1"),
        subjectRelation: "direct",
        conditionName: XCOND,
      },
      {
        objectType: UU,
        objectId: u("usersets_butnot_userset/bnu_1"),
        relation: "userset_cond_to_computed_wild",
        subjectType: DU,
        subjectId: u("usersets_butnot_userset/bnu_1"),
        subjectRelation: "computed_wild",
        conditionName: XCOND,
      },
    ],
    cases: [
      {
        name: "usersets_butnot_userset/valid_user",
        objectType: UU,
        objectId: u("usersets_butnot_userset/bnu_1"),
        relation: "butnot_userset",
        subjectType: USER,
        subjectId: u("usersets_butnot_userset/bnu_1"),
        context: { x: "1" },
        expected: true,
      },
      {
        name: "usersets_butnot_userset/valid_user_invalid_cond",
        objectType: UU,
        objectId: u("usersets_butnot_userset/bnu_1"),
        relation: "butnot_userset",
        subjectType: USER,
        subjectId: u("usersets_butnot_userset/bnu_1"),
        context: { x: "2" },
        expected: false,
      },
      {
        name: "usersets_butnot_userset/invalid_user",
        objectType: UU,
        objectId: u("usersets_butnot_userset/bnu_1"),
        relation: "butnot_userset",
        subjectType: USER,
        subjectId: u("usersets_butnot_userset/bnu_2"),
        context: { x: "1" },
        expected: false,
      },
      {
        name: "usersets_butnot_userset/invalid_object",
        objectType: UU,
        objectId: u("usersets_butnot_userset/bnu_2"),
        relation: "butnot_userset",
        subjectType: USER,
        subjectId: u("usersets_butnot_userset/bnu_1"),
        context: { x: "1" },
        expected: false,
      },
      {
        name: "usersets_butnot_userset/no_condition",
        objectType: UU,
        objectId: u("usersets_butnot_userset/bnu_1"),
        relation: "butnot_userset",
        subjectType: USER,
        subjectId: u("usersets_butnot_userset/bnu_1"),
        expected: "refused",
      },
    ],
  },
  {
    name: "usersets_nested_or_userset",
    tuples: [
      {
        objectType: DU,
        objectId: u("usersets_nested_or_userset/nou_1"),
        relation: "direct",
        subjectType: USER,
        subjectId: u("usersets_nested_or_userset/nou_1"),
      },
      {
        objectType: DU,
        objectId: u("usersets_nested_or_userset/nou_2"),
        relation: "direct_cond",
        subjectType: USER,
        subjectId: u("usersets_nested_or_userset/nou_2"),
        conditionName: XCOND,
      },
      {
        objectType: DU,
        objectId: u("usersets_nested_or_userset/nou_3"),
        relation: "direct_wild",
        subjectType: USER,
        subjectId: "*",
      },
      {
        objectType: UU,
        objectId: u("usersets_nested_or_userset/nou_1"),
        relation: "userset_to_or_computed",
        subjectType: DU,
        subjectId: u("usersets_nested_or_userset/nou_1"),
        subjectRelation: "or_computed",
      },
      {
        objectType: UU,
        objectId: u("usersets_nested_or_userset/nou_2"),
        relation: "userset_to_or_computed",
        subjectType: DU,
        subjectId: u("usersets_nested_or_userset/nou_2"),
        subjectRelation: "or_computed",
      },
      {
        objectType: UU,
        objectId: u("usersets_nested_or_userset/nou_3"),
        relation: "userset_to_or_computed",
        subjectType: DU,
        subjectId: u("usersets_nested_or_userset/nou_3"),
        subjectRelation: "or_computed",
      },
      {
        objectType: DU,
        objectId: u("usersets_nested_or_userset/nou_4"),
        relation: "direct_wild_cond",
        subjectType: USER,
        subjectId: "*",
        conditionName: XCOND,
      },
      {
        objectType: DU,
        objectId: u("usersets_nested_or_userset/nou_4"),
        relation: "direct",
        subjectType: USER,
        subjectId: u("usersets_nested_or_userset/5"),
      },
      {
        objectType: UU,
        objectId: u("usersets_nested_or_userset/nou_4"),
        relation: "userset_to_butnot_computed",
        subjectType: DU,
        subjectId: u("usersets_nested_or_userset/nou_4"),
        subjectRelation: "butnot_computed",
      },
    ],
    cases: [
      {
        name: "usersets_nested_or_userset/valid_user_direct",
        objectType: UU,
        objectId: u("usersets_nested_or_userset/nou_1"),
        relation: "nested_or_userset",
        subjectType: USER,
        subjectId: u("usersets_nested_or_userset/nou_1"),
        expected: true,
      },
      {
        name: "usersets_nested_or_userset/valid_user_direct_cond",
        objectType: UU,
        objectId: u("usersets_nested_or_userset/nou_2"),
        relation: "nested_or_userset",
        subjectType: USER,
        subjectId: u("usersets_nested_or_userset/nou_2"),
        context: { x: "1" },
        expected: true,
      },
      {
        name: "usersets_nested_or_userset/valid_user_direct_cond_invalid_cond",
        objectType: UU,
        objectId: u("usersets_nested_or_userset/nou_2"),
        relation: "nested_or_userset",
        subjectType: USER,
        subjectId: u("usersets_nested_or_userset/nou_2"),
        context: { x: "2" },
        expected: false,
      },
      {
        name: "usersets_nested_or_userset/valid_user_direct_wild",
        objectType: UU,
        objectId: u("usersets_nested_or_userset/nou_3"),
        relation: "nested_or_userset",
        subjectType: USER,
        subjectId: u("usersets_nested_or_userset/nou_3"),
        expected: true,
      },
      {
        name: "usersets_nested_or_userset/invalid_user_direct_cond",
        objectType: UU,
        objectId: u("usersets_nested_or_userset/nou_2"),
        relation: "nested_or_userset",
        subjectType: USER,
        subjectId: u("usersets_nested_or_userset/nou_1"),
        context: { x: "1" },
        expected: false,
      },
      {
        name: "usersets_nested_or_userset/user_direct_cond_no_condition",
        objectType: UU,
        objectId: u("usersets_nested_or_userset/nou_2"),
        relation: "nested_or_userset",
        subjectType: USER,
        subjectId: u("usersets_nested_or_userset/nou_2"),
        expected: "refused",
      },
      {
        name: "usersets_nested_or_userset/valid_user_butnot_computed",
        objectType: UU,
        objectId: u("usersets_nested_or_userset/nou_4"),
        relation: "nested_or_userset",
        subjectType: USER,
        subjectId: u("usersets_nested_or_userset/nou_4"),
        context: { x: "1" },
        expected: true,
      },
      {
        name: "usersets_nested_or_userset/valid_user_butnot_computed_invalid_cond",
        objectType: UU,
        objectId: u("usersets_nested_or_userset/nou_4"),
        relation: "nested_or_userset",
        subjectType: USER,
        subjectId: u("usersets_nested_or_userset/nou_4"),
        context: { x: "2" },
        expected: false,
      },
      {
        name: "usersets_nested_or_userset/invalid_user_butnot_computed",
        objectType: UU,
        objectId: u("usersets_nested_or_userset/nou_4"),
        relation: "nested_or_userset",
        subjectType: USER,
        subjectId: u("usersets_nested_or_userset/nou_5"),
        context: { x: "1" },
        expected: true,
      },
      {
        name: "usersets_nested_or_userset/butnot_computed_no_condition",
        objectType: UU,
        objectId: u("usersets_nested_or_userset/nou_4"),
        relation: "nested_or_userset",
        subjectType: USER,
        subjectId: u("usersets_nested_or_userset/nou_4"),
        expected: "refused",
      },
    ],
  },
  {
    name: "usersets_nested_and_userset",
    tuples: [
      {
        objectType: DU,
        objectId: u("usersets_nested_and_userset/nau_1"),
        relation: "direct_cond",
        subjectType: USER,
        subjectId: u("usersets_nested_and_userset/nau_1"),
        conditionName: XCOND,
      },
      {
        objectType: DU,
        objectId: u("usersets_nested_and_userset/nau_1"),
        relation: "direct_wild",
        subjectType: USER,
        subjectId: "*",
      },
      {
        objectType: UU,
        objectId: u("usersets_nested_and_userset/nau_1"),
        relation: "userset_to_and_computed",
        subjectType: DU,
        subjectId: u("usersets_nested_and_userset/nau_1"),
        subjectRelation: "and_computed",
      },
      {
        objectType: UU,
        objectId: u("usersets_nested_and_userset/nau_1"),
        relation: "userset_to_or_computed",
        subjectType: DU,
        subjectId: u("usersets_nested_and_userset/nau_1"),
        subjectRelation: "or_computed",
      },
    ],
    cases: [
      {
        name: "usersets_nested_and_userset/valid_user",
        objectType: UU,
        objectId: u("usersets_nested_and_userset/nau_1"),
        relation: "nested_and_userset",
        subjectType: USER,
        subjectId: u("usersets_nested_and_userset/nau_1"),
        context: { x: "1" },
        expected: true,
      },
      {
        name: "usersets_nested_and_userset/valid_user_invalid_cond",
        objectType: UU,
        objectId: u("usersets_nested_and_userset/nau_1"),
        relation: "nested_and_userset",
        subjectType: USER,
        subjectId: u("usersets_nested_and_userset/nau_1"),
        context: { x: "2" },
        expected: false,
      },
      {
        name: "usersets_nested_and_userset/invalid_user",
        objectType: UU,
        objectId: u("usersets_nested_and_userset/nau_1"),
        relation: "nested_and_userset",
        subjectType: USER,
        subjectId: u("usersets_nested_and_userset/nau_5"),
        context: { x: "1" },
        expected: false,
      },
      {
        name: "usersets_nested_and_userset/no_condition",
        objectType: UU,
        objectId: u("usersets_nested_and_userset/nau_1"),
        relation: "nested_and_userset",
        subjectType: USER,
        subjectId: u("usersets_nested_and_userset/nau_1"),
        expected: "refused",
      },
    ],
  },
];

describe("B1 userset corpus — usersets under set algebra", () => {
  let db: Kysely<DB>;
  let corpus: Corpus;
  let fixture: FixtureRecord;

  beforeAll(async () => {
    db = getDb();
    await beginTransaction(db);

    const tsfgaClient = createTsfga(new KyselyTupleStore(db));
    fixture = recordFixture(tsfgaClient);
    corpus = await loadCorpus(tsfgaClient, {
      slug: "userset-algebra",
      modelPath: "./userset-algebra/model.dsl",
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
    expectConfigsMatchModel("./userset-algebra/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
