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
 * B1 userset corpus — recursive usersets and wildcards.
 *
 * A port of upstream's own case matrix —
 * `tests/check/check_userset.go` at v1.18.2 — over the stages
 * listed below. Every `expected` is the `Expectation:` the Go
 * corpus states, so a shape both engines answer the same
 * *wrong* way still fails.
 *
 * Stages ported here:
 * - `usersets_userset_recursive`
 * - `usersets_userset_recursive_alg`
 * - `usersets_userset_recursive_public`
 * - `usersets_userset_recursive_public_alg`
 * - `usersets_userset_recursive_public_only`
 * - `usersets_userset_recursive_public_only_alg`
 * - `usersets_userset_recursive_public_cond`
 * - `userset_recursive_mixed_direct_assignment_mixed_direct_assignment`
 * - `userset_mix_public`
 * - `or_userset_mix_public`
 *
 * Upstream's `ErrorCode: 2000` (a check whose condition
 * parameter the request never supplied) is transcribed as
 * `"refused"`: both engines decline to answer rather than
 * denying.
 *
 * Types and the condition carry a `_b1c` suffix so this
 * fixture cannot collide with another fixture's rows in the
 * shared Postgres and OpenFGA.
 */

const USER = "user_b1c";
const EMPLOYEE = "employee_b1c";
const DU = "directs_user_b1c";
const DE = "directs_employee_b1c";
const UU = "usersets_user_b1c";
const XCOND = "xcond_b1c";

/** Upstream's object and subject names, as UUIDs. */
const u = ids(
  [
    "usersets_userset_recursive/userset_recursive_1",
    "usersets_userset_recursive/userset_recursive_user_1",
    "usersets_userset_recursive/userset_recursive_2",
    "usersets_userset_recursive/userset_recursive_multi_level",
    "usersets_userset_recursive/userset_recursive_multi_level_1",
    "usersets_userset_recursive/userset_recursive_multi_level_2",
    "usersets_userset_recursive/userset_recursive_multi_level_3",
    "usersets_userset_recursive/userset_recursive_multi_level_4",
    "usersets_userset_recursive/userset_recursive_user_multi_level",
    "usersets_userset_recursive/userset_recursive_invalid_object",
    "usersets_userset_recursive/userset_recursive_user_invalid_object",
    "usersets_userset_recursive/userset_1",
    "usersets_userset_recursive/userset_3",
    "usersets_userset_recursive/userset_recursive_user_invalid_user",
    "usersets_userset_recursive_alg/userset_recursive_alg_1",
    "usersets_userset_recursive_alg/userset_recursive_alg_user_1",
    "usersets_userset_recursive_alg/userset_recursive_alg_user_2",
    "usersets_userset_recursive_alg/userset_recursive_alg_2",
    "usersets_userset_recursive_alg/userset_recursive_alg_multi_level",
    "usersets_userset_recursive_alg/userset_recursive_alg_multi_level_1",
    "usersets_userset_recursive_alg/userset_recursive_alg_multi_level_2",
    "usersets_userset_recursive_alg/userset_recursive_alg_multi_level_3",
    "usersets_userset_recursive_alg/userset_recursive_alg_multi_level_4",
    "usersets_userset_recursive_alg/userset_recursive_alg_user_multi_level",
    "usersets_userset_recursive_alg/userset_recursive_alg_invalid_object",
    "usersets_userset_recursive_alg/userset_recursive_alg_user_invalid_object",
    "usersets_userset_recursive_alg/userset_1_alg",
    "usersets_userset_recursive_alg/userset_3",
    "usersets_userset_recursive_alg/userset_recursive_alg_user_invalid_user",
    "usersets_userset_recursive_alg/userset_1",
    "usersets_userset_recursive_public/userset_recursive_public_1",
    "usersets_userset_recursive_public/userset_recursive_public_user_1",
    "usersets_userset_recursive_public/userset_recursive_public_2",
    "usersets_userset_recursive_public/userset_recursive_public_multi_level",
    "usersets_userset_recursive_public/userset_recursive_public_multi_level_1",
    "usersets_userset_recursive_public/userset_recursive_public_multi_level_2",
    "usersets_userset_recursive_public/userset_recursive_public_multi_level_3",
    "usersets_userset_recursive_public/userset_recursive_public_multi_level_4",
    "usersets_userset_recursive_public/userset_recursive_user_public_multi_level",
    "usersets_userset_recursive_public/userset_recursive_public_invalid_object",
    "usersets_userset_recursive_public/userset_recursive_user_public_invalid_object",
    "usersets_userset_recursive_public/userset_recursive_public_public_multi_level",
    "usersets_userset_recursive_public/userset_recursive_public_public_multi_level_1",
    "usersets_userset_recursive_public/userset_recursive_public_public_multi_level_2",
    "usersets_userset_recursive_public/userset_recursive_public_public_multi_level_3",
    "usersets_userset_recursive_public/userset_recursive_public_public_multi_level_4",
    "usersets_userset_recursive_public/userset_1",
    "usersets_userset_recursive_public/userset_3",
    "usersets_userset_recursive_public/userset_recursive_user_public_invalid_user",
    "usersets_userset_recursive_public/any",
    "usersets_userset_recursive_public_alg/userset_recursive_public_alg_1",
    "usersets_userset_recursive_public_alg/userset_recursive_public_alg_user_1",
    "usersets_userset_recursive_public_alg/userset_recursive_public_alg_2",
    "usersets_userset_recursive_public_alg/userset_recursive_public_alg_multi_level",
    "usersets_userset_recursive_public_alg/userset_recursive_public_alg_multi_level_1",
    "usersets_userset_recursive_public_alg/userset_recursive_public_alg_multi_level_2",
    "usersets_userset_recursive_public_alg/userset_recursive_public_alg_multi_level_3",
    "usersets_userset_recursive_public_alg/userset_recursive_public_alg_multi_level_4",
    "usersets_userset_recursive_public_alg/userset_recursive_user_public_multi_level",
    "usersets_userset_recursive_public_alg/userset_recursive_public_alg_invalid_object",
    "usersets_userset_recursive_public_alg/userset_recursive_user_public_invalid_object",
    "usersets_userset_recursive_public_alg/userset_recursive_public_alg_public_multi_level",
    "usersets_userset_recursive_public_alg/userset_recursive_public_alg_public_multi_level_1",
    "usersets_userset_recursive_public_alg/userset_recursive_public_alg_public_multi_level_2",
    "usersets_userset_recursive_public_alg/userset_recursive_public_alg_public_multi_level_3",
    "usersets_userset_recursive_public_alg/userset_recursive_public_alg_public_multi_level_4",
    "usersets_userset_recursive_public_alg/userset_recursive_public_alg_user_2",
    "usersets_userset_recursive_public_alg/userset_recursive_public_alg_user_3",
    "usersets_userset_recursive_public_alg/userset_recursive_public_alg_wild",
    "usersets_userset_recursive_public_alg/any",
    "usersets_userset_recursive_public_alg/userset_1",
    "usersets_userset_recursive_public_alg/userset_3",
    "usersets_userset_recursive_public_alg/userset_recursive_user_public_invalid_user",
    "usersets_userset_recursive_public_only/userset_recursive_public_only_multi_level",
    "usersets_userset_recursive_public_only/userset_recursive_public_only_multi_level_1",
    "usersets_userset_recursive_public_only/userset_recursive_public_only_multi_level_2",
    "usersets_userset_recursive_public_only/userset_recursive_public_only_multi_level_3",
    "usersets_userset_recursive_public_only/userset_recursive_public_only_multi_level_4",
    "usersets_userset_recursive_public_only/userset_recursive_public_only_invalid_object",
    "usersets_userset_recursive_public_only/userset_recursive_user_public_invalid_object",
    "usersets_userset_recursive_public_only/userset_recursive_public_only_invalid_multi_level",
    "usersets_userset_recursive_public_only/userset_recursive_public_only_invalid_multi_level_root",
    "usersets_userset_recursive_public_only/any",
    "usersets_userset_recursive_public_only_alg/userset_recursive_public_only_alg_multi_level",
    "usersets_userset_recursive_public_only_alg/userset_recursive_public_only_alg_multi_level_1",
    "usersets_userset_recursive_public_only_alg/userset_recursive_public_only_alg_multi_level_2",
    "usersets_userset_recursive_public_only_alg/userset_recursive_public_only_alg_multi_level_3",
    "usersets_userset_recursive_public_only_alg/userset_recursive_public_only_alg_multi_level_4",
    "usersets_userset_recursive_public_only_alg/userset_recursive_public_only_alg_wild",
    "usersets_userset_recursive_public_only_alg/userset_recursive_public_only_alg_invalid_object",
    "usersets_userset_recursive_public_only_alg/userset_recursive_user_public_invalid_object",
    "usersets_userset_recursive_public_only_alg/userset_recursive_public_only_alg_invalid_multi_level",
    "usersets_userset_recursive_public_only_alg/userset_recursive_public_only_alg_invalid_multi_level_root",
    "usersets_userset_recursive_public_only_alg/any",
    "usersets_userset_recursive_public_cond/userset_recursive_public_alg_cond_1_multi_level",
    "usersets_userset_recursive_public_cond/userset_recursive_public_alg_cond_1_multi_level_1",
    "usersets_userset_recursive_public_cond/userset_recursive_public_alg_cond_1_multi_level_2",
    "usersets_userset_recursive_public_cond/userset_recursive_public_alg_cond_1_multi_level_3",
    "usersets_userset_recursive_public_cond/userset_recursive_public_alg_cond_1_multi_level_4",
    "usersets_userset_recursive_public_cond/userset_recursive_public_alg_cond_1",
    "usersets_userset_recursive_public_cond/userset_recursive_public_alg_cond_alg",
    "usersets_userset_recursive_public_cond/userset_recursive_public_alg_cond_alg_direct",
    "usersets_userset_recursive_public_cond/userset_recursive_public_only_alg_invalid_object",
    "usersets_userset_recursive_public_cond/userset_recursive_public_alg_cond_invalid",
    "userset_recursive_mixed_direct_assignment_mixed_direct_assignment/userset_recursive_mixed_direct_assignment_1",
    "userset_recursive_mixed_direct_assignment_mixed_direct_assignment/userset_recursive_mixed_direct_assignment_user_1",
    "userset_recursive_mixed_direct_assignment_mixed_direct_assignment/userset_recursive_mixed_direct_assignment_2",
    "userset_recursive_mixed_direct_assignment_mixed_direct_assignment/userset_recursive_mixed_direct_assignment_multi_level",
    "userset_recursive_mixed_direct_assignment_mixed_direct_assignment/userset_recursive_mixed_direct_assignment_multi_level_1",
    "userset_recursive_mixed_direct_assignment_mixed_direct_assignment/userset_recursive_mixed_direct_assignment_multi_level_2",
    "userset_recursive_mixed_direct_assignment_mixed_direct_assignment/userset_recursive_mixed_direct_assignment_multi_level_3",
    "userset_recursive_mixed_direct_assignment_mixed_direct_assignment/userset_recursive_mixed_direct_assignment_multi_level_4",
    "userset_recursive_mixed_direct_assignment_mixed_direct_assignment/userset_recursive_mixed_direct_assignment_user_multi_level",
    "userset_recursive_mixed_direct_assignment_mixed_direct_assignment/userset_recursive_mixed_direct_assignment_invalid_object",
    "userset_recursive_mixed_direct_assignment_mixed_direct_assignment/userset_recursive_mixed_direct_assignment_user_invalid_object",
    "userset_recursive_mixed_direct_assignment_mixed_direct_assignment/userset_1",
    "userset_recursive_mixed_direct_assignment_mixed_direct_assignment/userset_3",
    "userset_recursive_mixed_direct_assignment_mixed_direct_assignment/userset_recursive_mixed_direct_assignment_user_invalid_user",
    "userset_mix_public/userset_mix_public_1",
    "userset_mix_public/userset_mix_public_user_public",
    "userset_mix_public/userset_mix_public_user_specific",
    "userset_mix_public/specific",
    "userset_mix_public/userset_mix_directs_user_public",
    "userset_mix_public/userset_mix_public_invalid",
    "userset_mix_public/any",
    "userset_mix_public/other",
    "or_userset_mix_public/or_userset_mix_public_1",
    "or_userset_mix_public/or_userset_mix_public_user_public",
    "or_userset_mix_public/or_userset_mix_public_user_specific",
    "or_userset_mix_public/or_specific",
    "or_userset_mix_public/or_userset_mix_public_2",
    "or_userset_mix_public/or_userset_mix_public_3",
    "or_userset_mix_public/or_userset_mix_directs_user_public",
    "or_userset_mix_public/or_userset_mix_public_invalid",
    "or_userset_mix_public/or_any",
    "or_userset_mix_public/or_other",
    "or_userset_mix_public/any",
    "or_userset_mix_public/or_userset_mix_public_3_invalid",
  ],
  "d480",
);

// Written in dependency order: a tupleset relation's config
// exists before the tuple-to-userset that names it, so
// `writeRelationConfig`'s tupleset gates can see it.
const CONFIGS: RelationConfig[] = [
  cfg(DE, "direct", { directlyAssignable: [{ type: EMPLOYEE }] }),
  cfg(DU, "direct", { directlyAssignable: [{ type: USER }] }),
  cfg(DU, "direct_wild", {
    directlyAssignable: [{ type: USER, wildcard: true }],
  }),
  cfg(UU, "direct_3", { directlyAssignable: [{ type: USER }] }),
  cfg(UU, "direct_2", {
    directlyAssignable: [{ type: USER }],
    intersection: [
      { type: "direct" },
      { type: "computedUserset", relation: "direct_3" },
    ],
  }),
  cfg(UU, "direct", {
    directlyAssignable: [{ type: USER }],
    impliedBy: ["direct_2"],
  }),
  cfg(UU, "computed", { computedUserset: "direct" }),
  cfg(UU, "direct_4", { directlyAssignable: [{ type: USER }] }),
  cfg(UU, "butnot_computed", {
    computedUserset: "computed",
    excludedBy: "direct_4",
  }),
  cfg(UU, "alg_combined", {
    computedUserset: "butnot_computed",
    excludedBy: "direct_4",
  }),
  cfg(UU, "alg_cond_combined", {
    directlyAssignable: [{ type: USER, condition: XCOND }],
    impliedBy: ["alg_combined"],
  }),
  cfg(UU, "direct_wild", {
    directlyAssignable: [{ type: USER, wildcard: true }],
  }),
  cfg(UU, "userset_mix_public", {
    directlyAssignable: [
      { type: DU, relation: "direct" },
      { type: DU, wildcard: true },
      { type: USER },
      { type: USER, wildcard: true },
    ],
  }),
  cfg(UU, "or_userset_mix_public", {
    directlyAssignable: [{ type: USER }, { type: USER, wildcard: true }],
    impliedBy: ["userset_mix_public"],
  }),
  cfg(UU, "userset", {
    directlyAssignable: [
      { type: DU, relation: "direct" },
      { type: DE, relation: "direct" },
    ],
  }),
  cfg(UU, "userset_recursive", {
    directlyAssignable: [
      { type: USER },
      { type: UU, relation: "userset_recursive" },
    ],
  }),
  cfg(UU, "userset_recursive_alg", {
    directlyAssignable: [
      { type: USER },
      { type: UU, relation: "userset_recursive_alg" },
    ],
    impliedBy: ["alg_combined"],
  }),
  cfg(UU, "userset_recursive_mixed_direct_assignment", {
    directlyAssignable: [
      { type: USER },
      { type: UU, relation: "userset_recursive_mixed_direct_assignment" },
      { type: UU, relation: "userset" },
    ],
  }),
  cfg(UU, "userset_recursive_public", {
    directlyAssignable: [
      { type: USER },
      { type: USER, wildcard: true },
      { type: UU, relation: "userset_recursive_public" },
    ],
  }),
  cfg(UU, "userset_recursive_public_alg", {
    directlyAssignable: [
      { type: USER },
      { type: USER, wildcard: true },
      { type: UU, relation: "userset_recursive_public_alg" },
    ],
    impliedBy: ["alg_combined", "direct_wild"],
  }),
  cfg(UU, "userset_recursive_public_alg_cond", {
    directlyAssignable: [
      { type: USER, condition: XCOND },
      { type: USER, wildcard: true },
      {
        type: UU,
        relation: "userset_recursive_public_alg_cond",
        condition: XCOND,
      },
    ],
    impliedBy: ["alg_cond_combined", "direct_wild"],
  }),
  cfg(UU, "userset_recursive_public_only", {
    directlyAssignable: [
      { type: USER, wildcard: true },
      { type: UU, relation: "userset_recursive_public_only" },
    ],
  }),
  cfg(UU, "userset_recursive_public_only_alg", {
    directlyAssignable: [
      { type: USER },
      { type: USER, wildcard: true },
      { type: UU, relation: "userset_recursive_public_only_alg" },
    ],
    impliedBy: ["direct_wild"],
  }),
];

const STAGES: Stage[] = [
  {
    name: "usersets_userset_recursive",
    tuples: [
      {
        objectType: UU,
        objectId: u("usersets_userset_recursive/userset_recursive_1"),
        relation: "userset_recursive",
        subjectType: USER,
        subjectId: u("usersets_userset_recursive/userset_recursive_user_1"),
      },
      {
        objectType: UU,
        objectId: u("usersets_userset_recursive/userset_recursive_1"),
        relation: "userset_recursive",
        subjectType: UU,
        subjectId: u("usersets_userset_recursive/userset_recursive_2"),
        subjectRelation: "userset_recursive",
      },
      {
        objectType: UU,
        objectId: u("usersets_userset_recursive/userset_recursive_multi_level"),
        relation: "userset_recursive",
        subjectType: UU,
        subjectId: u(
          "usersets_userset_recursive/userset_recursive_multi_level_1",
        ),
        subjectRelation: "userset_recursive",
      },
      {
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive/userset_recursive_multi_level_1",
        ),
        relation: "userset_recursive",
        subjectType: UU,
        subjectId: u(
          "usersets_userset_recursive/userset_recursive_multi_level_2",
        ),
        subjectRelation: "userset_recursive",
      },
      {
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive/userset_recursive_multi_level_2",
        ),
        relation: "userset_recursive",
        subjectType: UU,
        subjectId: u(
          "usersets_userset_recursive/userset_recursive_multi_level_3",
        ),
        subjectRelation: "userset_recursive",
      },
      {
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive/userset_recursive_multi_level_3",
        ),
        relation: "userset_recursive",
        subjectType: UU,
        subjectId: u(
          "usersets_userset_recursive/userset_recursive_multi_level_4",
        ),
        subjectRelation: "userset_recursive",
      },
      {
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive/userset_recursive_multi_level_4",
        ),
        relation: "userset_recursive",
        subjectType: USER,
        subjectId: u(
          "usersets_userset_recursive/userset_recursive_user_multi_level",
        ),
      },
      {
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive/userset_recursive_invalid_object",
        ),
        relation: "userset_recursive",
        subjectType: USER,
        subjectId: u(
          "usersets_userset_recursive/userset_recursive_user_invalid_object",
        ),
      },
    ],
    cases: [
      {
        name: "usersets_userset_recursive/valid_recursive",
        objectType: UU,
        objectId: u("usersets_userset_recursive/userset_recursive_1"),
        relation: "userset_recursive",
        subjectType: UU,
        subjectId: u("usersets_userset_recursive/userset_recursive_2"),
        subjectRelation: "userset_recursive",
        expected: true,
      },
      {
        name: "usersets_userset_recursive/valid_user",
        objectType: UU,
        objectId: u("usersets_userset_recursive/userset_recursive_1"),
        relation: "userset_recursive",
        subjectType: USER,
        subjectId: u("usersets_userset_recursive/userset_recursive_user_1"),
        expected: true,
      },
      {
        name: "usersets_userset_recursive/valid_user_multi_level",
        objectType: UU,
        objectId: u("usersets_userset_recursive/userset_recursive_multi_level"),
        relation: "userset_recursive",
        subjectType: USER,
        subjectId: u(
          "usersets_userset_recursive/userset_recursive_user_multi_level",
        ),
        expected: true,
      },
      {
        name: "usersets_userset_recursive/valid_userset_multi_level",
        objectType: UU,
        objectId: u("usersets_userset_recursive/userset_recursive_multi_level"),
        relation: "userset_recursive",
        subjectType: UU,
        subjectId: u(
          "usersets_userset_recursive/userset_recursive_multi_level_4",
        ),
        subjectRelation: "userset_recursive",
        expected: true,
      },
      {
        name: "usersets_userset_recursive/invalid_recursive",
        objectType: UU,
        objectId: u("usersets_userset_recursive/userset_1"),
        relation: "userset_recursive",
        subjectType: UU,
        subjectId: u("usersets_userset_recursive/userset_3"),
        subjectRelation: "userset_recursive",
        expected: false,
      },
      {
        name: "usersets_userset_recursive/invalid_user",
        objectType: UU,
        objectId: u("usersets_userset_recursive/userset_1"),
        relation: "userset_recursive",
        subjectType: USER,
        subjectId: u(
          "usersets_userset_recursive/userset_recursive_user_invalid_user",
        ),
        expected: false,
      },
      {
        name: "usersets_userset_recursive/invalid_user_multi_level",
        objectType: UU,
        objectId: u("usersets_userset_recursive/userset_recursive_multi_level"),
        relation: "userset_recursive",
        subjectType: USER,
        subjectId: u(
          "usersets_userset_recursive/userset_recursive_user_invalid_user",
        ),
        expected: false,
      },
      {
        name: "usersets_userset_recursive/invalid_object",
        objectType: UU,
        objectId: u("usersets_userset_recursive/userset_1"),
        relation: "userset_recursive",
        subjectType: USER,
        subjectId: u(
          "usersets_userset_recursive/userset_recursive_user_invalid_object",
        ),
        expected: false,
      },
      {
        name: "usersets_userset_recursive/invalid_object_multi_level",
        objectType: UU,
        objectId: u("usersets_userset_recursive/userset_recursive_multi_level"),
        relation: "userset_recursive",
        subjectType: USER,
        subjectId: u(
          "usersets_userset_recursive/userset_recursive_user_invalid_object",
        ),
        expected: false,
      },
    ],
  },
  {
    name: "usersets_userset_recursive_alg",
    tuples: [
      {
        objectType: UU,
        objectId: u("usersets_userset_recursive_alg/userset_recursive_alg_1"),
        relation: "direct_3",
        subjectType: USER,
        subjectId: u(
          "usersets_userset_recursive_alg/userset_recursive_alg_user_1",
        ),
      },
      {
        objectType: UU,
        objectId: u("usersets_userset_recursive_alg/userset_recursive_alg_1"),
        relation: "direct_2",
        subjectType: USER,
        subjectId: u(
          "usersets_userset_recursive_alg/userset_recursive_alg_user_1",
        ),
      },
      {
        objectType: UU,
        objectId: u("usersets_userset_recursive_alg/userset_recursive_alg_1"),
        relation: "direct_3",
        subjectType: USER,
        subjectId: u(
          "usersets_userset_recursive_alg/userset_recursive_alg_user_2",
        ),
      },
      {
        objectType: UU,
        objectId: u("usersets_userset_recursive_alg/userset_recursive_alg_1"),
        relation: "direct_2",
        subjectType: USER,
        subjectId: u(
          "usersets_userset_recursive_alg/userset_recursive_alg_user_2",
        ),
      },
      {
        objectType: UU,
        objectId: u("usersets_userset_recursive_alg/userset_recursive_alg_1"),
        relation: "direct_4",
        subjectType: USER,
        subjectId: u(
          "usersets_userset_recursive_alg/userset_recursive_alg_user_2",
        ),
      },
      {
        objectType: UU,
        objectId: u("usersets_userset_recursive_alg/userset_recursive_alg_1"),
        relation: "userset_recursive_alg",
        subjectType: UU,
        subjectId: u("usersets_userset_recursive_alg/userset_recursive_alg_2"),
        subjectRelation: "userset_recursive_alg",
      },
      {
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_alg/userset_recursive_alg_multi_level",
        ),
        relation: "userset_recursive_alg",
        subjectType: UU,
        subjectId: u(
          "usersets_userset_recursive_alg/userset_recursive_alg_multi_level_1",
        ),
        subjectRelation: "userset_recursive_alg",
      },
      {
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_alg/userset_recursive_alg_multi_level_1",
        ),
        relation: "userset_recursive_alg",
        subjectType: UU,
        subjectId: u(
          "usersets_userset_recursive_alg/userset_recursive_alg_multi_level_2",
        ),
        subjectRelation: "userset_recursive_alg",
      },
      {
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_alg/userset_recursive_alg_multi_level_2",
        ),
        relation: "userset_recursive_alg",
        subjectType: UU,
        subjectId: u(
          "usersets_userset_recursive_alg/userset_recursive_alg_multi_level_3",
        ),
        subjectRelation: "userset_recursive_alg",
      },
      {
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_alg/userset_recursive_alg_multi_level_3",
        ),
        relation: "userset_recursive_alg",
        subjectType: UU,
        subjectId: u(
          "usersets_userset_recursive_alg/userset_recursive_alg_multi_level_4",
        ),
        subjectRelation: "userset_recursive_alg",
      },
      {
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_alg/userset_recursive_alg_multi_level_4",
        ),
        relation: "userset_recursive_alg",
        subjectType: USER,
        subjectId: u(
          "usersets_userset_recursive_alg/userset_recursive_alg_user_multi_level",
        ),
      },
      {
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_alg/userset_recursive_alg_invalid_object",
        ),
        relation: "userset_recursive_alg",
        subjectType: USER,
        subjectId: u(
          "usersets_userset_recursive_alg/userset_recursive_alg_user_invalid_object",
        ),
      },
    ],
    cases: [
      {
        name: "usersets_userset_recursive_alg/valid_recursive",
        objectType: UU,
        objectId: u("usersets_userset_recursive_alg/userset_recursive_alg_1"),
        relation: "userset_recursive_alg",
        subjectType: UU,
        subjectId: u("usersets_userset_recursive_alg/userset_recursive_alg_2"),
        subjectRelation: "userset_recursive_alg",
        expected: true,
      },
      {
        name: "usersets_userset_recursive_alg/valid_user",
        objectType: UU,
        objectId: u("usersets_userset_recursive_alg/userset_recursive_alg_1"),
        relation: "userset_recursive_alg",
        subjectType: USER,
        subjectId: u(
          "usersets_userset_recursive_alg/userset_recursive_alg_user_1",
        ),
        expected: true,
      },
      {
        name: "usersets_userset_recursive_alg/valid_user_butnot_denied",
        objectType: UU,
        objectId: u("usersets_userset_recursive_alg/userset_recursive_alg_1"),
        relation: "userset_recursive_alg",
        subjectType: USER,
        subjectId: u(
          "usersets_userset_recursive_alg/userset_recursive_alg_user_2",
        ),
        expected: false,
      },
      {
        name: "usersets_userset_recursive_alg/valid_user_multi_level",
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_alg/userset_recursive_alg_multi_level",
        ),
        relation: "userset_recursive_alg",
        subjectType: USER,
        subjectId: u(
          "usersets_userset_recursive_alg/userset_recursive_alg_user_multi_level",
        ),
        expected: true,
      },
      {
        name: "usersets_userset_recursive_alg/valid_userset_multi_level",
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_alg/userset_recursive_alg_multi_level",
        ),
        relation: "userset_recursive_alg",
        subjectType: UU,
        subjectId: u(
          "usersets_userset_recursive_alg/userset_recursive_alg_multi_level_4",
        ),
        subjectRelation: "userset_recursive_alg",
        expected: true,
      },
      {
        name: "usersets_userset_recursive_alg/invalid_recursive",
        objectType: UU,
        objectId: u("usersets_userset_recursive_alg/userset_1_alg"),
        relation: "userset_recursive_alg",
        subjectType: UU,
        subjectId: u("usersets_userset_recursive_alg/userset_3"),
        subjectRelation: "userset_recursive_alg",
        expected: false,
      },
      {
        name: "usersets_userset_recursive_alg/invalid_user",
        objectType: UU,
        objectId: u("usersets_userset_recursive_alg/userset_1_alg"),
        relation: "userset_recursive_alg",
        subjectType: USER,
        subjectId: u(
          "usersets_userset_recursive_alg/userset_recursive_alg_user_invalid_user",
        ),
        expected: false,
      },
      {
        name: "usersets_userset_recursive_alg/invalid_user_multi_level",
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_alg/userset_recursive_alg_multi_level",
        ),
        relation: "userset_recursive_alg",
        subjectType: USER,
        subjectId: u(
          "usersets_userset_recursive_alg/userset_recursive_alg_user_invalid_user",
        ),
        expected: false,
      },
      {
        name: "usersets_userset_recursive_alg/invalid_object",
        objectType: UU,
        objectId: u("usersets_userset_recursive_alg/userset_1"),
        relation: "userset_recursive_alg",
        subjectType: USER,
        subjectId: u(
          "usersets_userset_recursive_alg/userset_recursive_alg_user_invalid_object",
        ),
        expected: false,
      },
      {
        name: "usersets_userset_recursive_alg/invalid_object_multi_level",
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_alg/userset_recursive_alg_multi_level",
        ),
        relation: "userset_recursive_alg",
        subjectType: USER,
        subjectId: u(
          "usersets_userset_recursive_alg/userset_recursive_alg_user_invalid_object",
        ),
        expected: false,
      },
    ],
  },
  {
    name: "usersets_userset_recursive_public",
    tuples: [
      {
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public/userset_recursive_public_1",
        ),
        relation: "userset_recursive_public",
        subjectType: USER,
        subjectId: u(
          "usersets_userset_recursive_public/userset_recursive_public_user_1",
        ),
      },
      {
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public/userset_recursive_public_1",
        ),
        relation: "userset_recursive_public",
        subjectType: UU,
        subjectId: u(
          "usersets_userset_recursive_public/userset_recursive_public_2",
        ),
        subjectRelation: "userset_recursive_public",
      },
      {
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public/userset_recursive_public_multi_level",
        ),
        relation: "userset_recursive_public",
        subjectType: UU,
        subjectId: u(
          "usersets_userset_recursive_public/userset_recursive_public_multi_level_1",
        ),
        subjectRelation: "userset_recursive_public",
      },
      {
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public/userset_recursive_public_multi_level_1",
        ),
        relation: "userset_recursive_public",
        subjectType: UU,
        subjectId: u(
          "usersets_userset_recursive_public/userset_recursive_public_multi_level_2",
        ),
        subjectRelation: "userset_recursive_public",
      },
      {
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public/userset_recursive_public_multi_level_2",
        ),
        relation: "userset_recursive_public",
        subjectType: UU,
        subjectId: u(
          "usersets_userset_recursive_public/userset_recursive_public_multi_level_3",
        ),
        subjectRelation: "userset_recursive_public",
      },
      {
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public/userset_recursive_public_multi_level_3",
        ),
        relation: "userset_recursive_public",
        subjectType: UU,
        subjectId: u(
          "usersets_userset_recursive_public/userset_recursive_public_multi_level_4",
        ),
        subjectRelation: "userset_recursive_public",
      },
      {
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public/userset_recursive_public_multi_level_4",
        ),
        relation: "userset_recursive_public",
        subjectType: USER,
        subjectId: u(
          "usersets_userset_recursive_public/userset_recursive_user_public_multi_level",
        ),
      },
      {
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public/userset_recursive_public_invalid_object",
        ),
        relation: "userset_recursive_public",
        subjectType: USER,
        subjectId: u(
          "usersets_userset_recursive_public/userset_recursive_user_public_invalid_object",
        ),
      },
      {
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public/userset_recursive_public_public_multi_level",
        ),
        relation: "userset_recursive_public",
        subjectType: UU,
        subjectId: u(
          "usersets_userset_recursive_public/userset_recursive_public_public_multi_level_1",
        ),
        subjectRelation: "userset_recursive_public",
      },
      {
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public/userset_recursive_public_public_multi_level_1",
        ),
        relation: "userset_recursive_public",
        subjectType: UU,
        subjectId: u(
          "usersets_userset_recursive_public/userset_recursive_public_public_multi_level_2",
        ),
        subjectRelation: "userset_recursive_public",
      },
      {
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public/userset_recursive_public_public_multi_level_2",
        ),
        relation: "userset_recursive_public",
        subjectType: UU,
        subjectId: u(
          "usersets_userset_recursive_public/userset_recursive_public_public_multi_level_3",
        ),
        subjectRelation: "userset_recursive_public",
      },
      {
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public/userset_recursive_public_public_multi_level_3",
        ),
        relation: "userset_recursive_public",
        subjectType: UU,
        subjectId: u(
          "usersets_userset_recursive_public/userset_recursive_public_public_multi_level_4",
        ),
        subjectRelation: "userset_recursive_public",
      },
      {
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public/userset_recursive_public_public_multi_level_4",
        ),
        relation: "userset_recursive_public",
        subjectType: USER,
        subjectId: "*",
      },
    ],
    cases: [
      {
        name: "usersets_userset_recursive_public/valid_recursive",
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public/userset_recursive_public_1",
        ),
        relation: "userset_recursive_public",
        subjectType: UU,
        subjectId: u(
          "usersets_userset_recursive_public/userset_recursive_public_2",
        ),
        subjectRelation: "userset_recursive_public",
        expected: true,
      },
      {
        name: "usersets_userset_recursive_public/valid_user",
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public/userset_recursive_public_1",
        ),
        relation: "userset_recursive_public",
        subjectType: USER,
        subjectId: u(
          "usersets_userset_recursive_public/userset_recursive_public_user_1",
        ),
        expected: true,
      },
      {
        name: "usersets_userset_recursive_public/valid_user_multi_level",
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public/userset_recursive_public_multi_level",
        ),
        relation: "userset_recursive_public",
        subjectType: USER,
        subjectId: u(
          "usersets_userset_recursive_public/userset_recursive_user_public_multi_level",
        ),
        expected: true,
      },
      {
        name: "usersets_userset_recursive_public/valid_userset_multi_level",
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public/userset_recursive_public_multi_level",
        ),
        relation: "userset_recursive_public",
        subjectType: UU,
        subjectId: u(
          "usersets_userset_recursive_public/userset_recursive_public_multi_level_4",
        ),
        subjectRelation: "userset_recursive_public",
        expected: true,
      },
      {
        name: "usersets_userset_recursive_public/invalid_recursive",
        objectType: UU,
        objectId: u("usersets_userset_recursive_public/userset_1"),
        relation: "userset_recursive_public",
        subjectType: UU,
        subjectId: u("usersets_userset_recursive_public/userset_3"),
        subjectRelation: "userset_recursive_public",
        expected: false,
      },
      {
        name: "usersets_userset_recursive_public/invalid_user",
        objectType: UU,
        objectId: u("usersets_userset_recursive_public/userset_1"),
        relation: "userset_recursive_public",
        subjectType: USER,
        subjectId: u(
          "usersets_userset_recursive_public/userset_recursive_user_public_invalid_user",
        ),
        expected: false,
      },
      {
        name: "usersets_userset_recursive_public/invalid_user_multi_level",
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public/userset_recursive_public_multi_level",
        ),
        relation: "userset_recursive_public",
        subjectType: USER,
        subjectId: u(
          "usersets_userset_recursive_public/userset_recursive_user_public_invalid_user",
        ),
        expected: false,
      },
      {
        name: "usersets_userset_recursive_public/invalid_object",
        objectType: UU,
        objectId: u("usersets_userset_recursive_public/userset_1"),
        relation: "userset_recursive_public",
        subjectType: USER,
        subjectId: u(
          "usersets_userset_recursive_public/userset_recursive_user_public_invalid_object",
        ),
        expected: false,
      },
      {
        name: "usersets_userset_recursive_public/invalid_object_multi_level",
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public/userset_recursive_public_multi_level",
        ),
        relation: "userset_recursive_public",
        subjectType: USER,
        subjectId: u(
          "usersets_userset_recursive_public/userset_recursive_user_public_invalid_object",
        ),
        expected: false,
      },
      {
        name: "usersets_userset_recursive_public/valid_user_multi_level_public",
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public/userset_recursive_public_public_multi_level",
        ),
        relation: "userset_recursive_public",
        subjectType: USER,
        subjectId: u("usersets_userset_recursive_public/any"),
        expected: true,
      },
      {
        name: "usersets_userset_recursive_public/valid_user_multi_level_4_public",
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public/userset_recursive_public_public_multi_level_4",
        ),
        relation: "userset_recursive_public",
        subjectType: USER,
        subjectId: u("usersets_userset_recursive_public/any"),
        expected: true,
      },
      {
        name: "usersets_userset_recursive_public/valid_user_multi_level_3_public",
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public/userset_recursive_public_public_multi_level_3",
        ),
        relation: "userset_recursive_public",
        subjectType: USER,
        subjectId: u("usersets_userset_recursive_public/any"),
        expected: true,
      },
      {
        name: "usersets_userset_recursive_public/valid_user_multi_level_2_public",
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public/userset_recursive_public_public_multi_level_2",
        ),
        relation: "userset_recursive_public",
        subjectType: USER,
        subjectId: u("usersets_userset_recursive_public/any"),
        expected: true,
      },
      {
        name: "usersets_userset_recursive_public/valid_user_multi_level_1_public",
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public/userset_recursive_public_public_multi_level_1",
        ),
        relation: "userset_recursive_public",
        subjectType: USER,
        subjectId: u("usersets_userset_recursive_public/any"),
        expected: true,
      },
      {
        name: "usersets_userset_recursive_public/valid_userset_multi_level_2_public_relation",
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public/userset_recursive_public_public_multi_level",
        ),
        relation: "userset_recursive_public",
        subjectType: UU,
        subjectId: u(
          "usersets_userset_recursive_public/userset_recursive_public_public_multi_level_2",
        ),
        subjectRelation: "userset_recursive_public",
        expected: true,
      },
      {
        name: "usersets_userset_recursive_public/valid_userset_multi_level_3_public_relation",
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public/userset_recursive_public_public_multi_level",
        ),
        relation: "userset_recursive_public",
        subjectType: UU,
        subjectId: u(
          "usersets_userset_recursive_public/userset_recursive_public_public_multi_level_3",
        ),
        subjectRelation: "userset_recursive_public",
        expected: true,
      },
      {
        name: "usersets_userset_recursive_public/valid_userset_multi_level_4_public_relation",
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public/userset_recursive_public_public_multi_level",
        ),
        relation: "userset_recursive_public",
        subjectType: UU,
        subjectId: u(
          "usersets_userset_recursive_public/userset_recursive_public_public_multi_level_4",
        ),
        subjectRelation: "userset_recursive_public",
        expected: true,
      },
    ],
  },
  {
    name: "usersets_userset_recursive_public_alg",
    tuples: [
      {
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_alg/userset_recursive_public_alg_1",
        ),
        relation: "userset_recursive_public_alg",
        subjectType: USER,
        subjectId: u(
          "usersets_userset_recursive_public_alg/userset_recursive_public_alg_user_1",
        ),
      },
      {
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_alg/userset_recursive_public_alg_1",
        ),
        relation: "userset_recursive_public_alg",
        subjectType: UU,
        subjectId: u(
          "usersets_userset_recursive_public_alg/userset_recursive_public_alg_2",
        ),
        subjectRelation: "userset_recursive_public_alg",
      },
      {
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_alg/userset_recursive_public_alg_multi_level",
        ),
        relation: "userset_recursive_public_alg",
        subjectType: UU,
        subjectId: u(
          "usersets_userset_recursive_public_alg/userset_recursive_public_alg_multi_level_1",
        ),
        subjectRelation: "userset_recursive_public_alg",
      },
      {
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_alg/userset_recursive_public_alg_multi_level_1",
        ),
        relation: "userset_recursive_public_alg",
        subjectType: UU,
        subjectId: u(
          "usersets_userset_recursive_public_alg/userset_recursive_public_alg_multi_level_2",
        ),
        subjectRelation: "userset_recursive_public_alg",
      },
      {
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_alg/userset_recursive_public_alg_multi_level_2",
        ),
        relation: "userset_recursive_public_alg",
        subjectType: UU,
        subjectId: u(
          "usersets_userset_recursive_public_alg/userset_recursive_public_alg_multi_level_3",
        ),
        subjectRelation: "userset_recursive_public_alg",
      },
      {
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_alg/userset_recursive_public_alg_multi_level_3",
        ),
        relation: "userset_recursive_public_alg",
        subjectType: UU,
        subjectId: u(
          "usersets_userset_recursive_public_alg/userset_recursive_public_alg_multi_level_4",
        ),
        subjectRelation: "userset_recursive_public_alg",
      },
      {
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_alg/userset_recursive_public_alg_multi_level_4",
        ),
        relation: "userset_recursive_public_alg",
        subjectType: USER,
        subjectId: u(
          "usersets_userset_recursive_public_alg/userset_recursive_user_public_multi_level",
        ),
      },
      {
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_alg/userset_recursive_public_alg_invalid_object",
        ),
        relation: "userset_recursive_public_alg",
        subjectType: USER,
        subjectId: u(
          "usersets_userset_recursive_public_alg/userset_recursive_user_public_invalid_object",
        ),
      },
      {
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_alg/userset_recursive_public_alg_public_multi_level",
        ),
        relation: "userset_recursive_public_alg",
        subjectType: UU,
        subjectId: u(
          "usersets_userset_recursive_public_alg/userset_recursive_public_alg_public_multi_level_1",
        ),
        subjectRelation: "userset_recursive_public_alg",
      },
      {
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_alg/userset_recursive_public_alg_public_multi_level_1",
        ),
        relation: "userset_recursive_public_alg",
        subjectType: UU,
        subjectId: u(
          "usersets_userset_recursive_public_alg/userset_recursive_public_alg_public_multi_level_2",
        ),
        subjectRelation: "userset_recursive_public_alg",
      },
      {
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_alg/userset_recursive_public_alg_public_multi_level_2",
        ),
        relation: "userset_recursive_public_alg",
        subjectType: UU,
        subjectId: u(
          "usersets_userset_recursive_public_alg/userset_recursive_public_alg_public_multi_level_3",
        ),
        subjectRelation: "userset_recursive_public_alg",
      },
      {
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_alg/userset_recursive_public_alg_public_multi_level_3",
        ),
        relation: "userset_recursive_public_alg",
        subjectType: UU,
        subjectId: u(
          "usersets_userset_recursive_public_alg/userset_recursive_public_alg_public_multi_level_4",
        ),
        subjectRelation: "userset_recursive_public_alg",
      },
      {
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_alg/userset_recursive_public_alg_public_multi_level_4",
        ),
        relation: "userset_recursive_public_alg",
        subjectType: USER,
        subjectId: "*",
      },
      {
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_alg/userset_recursive_public_alg_1",
        ),
        relation: "direct_3",
        subjectType: USER,
        subjectId: u(
          "usersets_userset_recursive_public_alg/userset_recursive_public_alg_user_2",
        ),
      },
      {
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_alg/userset_recursive_public_alg_1",
        ),
        relation: "direct_2",
        subjectType: USER,
        subjectId: u(
          "usersets_userset_recursive_public_alg/userset_recursive_public_alg_user_2",
        ),
      },
      {
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_alg/userset_recursive_public_alg_1",
        ),
        relation: "direct_3",
        subjectType: USER,
        subjectId: u(
          "usersets_userset_recursive_public_alg/userset_recursive_public_alg_user_3",
        ),
      },
      {
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_alg/userset_recursive_public_alg_1",
        ),
        relation: "direct_2",
        subjectType: USER,
        subjectId: u(
          "usersets_userset_recursive_public_alg/userset_recursive_public_alg_user_3",
        ),
      },
      {
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_alg/userset_recursive_public_alg_1",
        ),
        relation: "direct_4",
        subjectType: USER,
        subjectId: u(
          "usersets_userset_recursive_public_alg/userset_recursive_public_alg_user_3",
        ),
      },
      {
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_alg/userset_recursive_public_alg_wild",
        ),
        relation: "direct_wild",
        subjectType: USER,
        subjectId: "*",
      },
    ],
    cases: [
      {
        name: "usersets_userset_recursive_public_alg/valid_recursive",
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_alg/userset_recursive_public_alg_1",
        ),
        relation: "userset_recursive_public_alg",
        subjectType: UU,
        subjectId: u(
          "usersets_userset_recursive_public_alg/userset_recursive_public_alg_2",
        ),
        subjectRelation: "userset_recursive_public_alg",
        expected: true,
      },
      {
        name: "usersets_userset_recursive_public_alg/valid_user",
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_alg/userset_recursive_public_alg_1",
        ),
        relation: "userset_recursive_public_alg",
        subjectType: USER,
        subjectId: u(
          "usersets_userset_recursive_public_alg/userset_recursive_public_alg_user_1",
        ),
        expected: true,
      },
      {
        name: "usersets_userset_recursive_public_alg/valid_user_via_alg",
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_alg/userset_recursive_public_alg_1",
        ),
        relation: "userset_recursive_public_alg",
        subjectType: USER,
        subjectId: u(
          "usersets_userset_recursive_public_alg/userset_recursive_public_alg_user_2",
        ),
        expected: true,
      },
      {
        name: "usersets_userset_recursive_public_alg/valid_user_via_alg_but_denied",
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_alg/userset_recursive_public_alg_1",
        ),
        relation: "userset_recursive_public_alg",
        subjectType: USER,
        subjectId: u(
          "usersets_userset_recursive_public_alg/userset_recursive_public_alg_user_3",
        ),
        expected: false,
      },
      {
        name: "usersets_userset_recursive_public_alg/valid_user_via_wild",
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_alg/userset_recursive_public_alg_wild",
        ),
        relation: "userset_recursive_public_alg",
        subjectType: USER,
        subjectId: u("usersets_userset_recursive_public_alg/any"),
        expected: true,
      },
      {
        name: "usersets_userset_recursive_public_alg/valid_user_multi_level",
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_alg/userset_recursive_public_alg_multi_level",
        ),
        relation: "userset_recursive_public_alg",
        subjectType: USER,
        subjectId: u(
          "usersets_userset_recursive_public_alg/userset_recursive_user_public_multi_level",
        ),
        expected: true,
      },
      {
        name: "usersets_userset_recursive_public_alg/valid_userset_multi_level",
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_alg/userset_recursive_public_alg_multi_level",
        ),
        relation: "userset_recursive_public_alg",
        subjectType: UU,
        subjectId: u(
          "usersets_userset_recursive_public_alg/userset_recursive_public_alg_multi_level_4",
        ),
        subjectRelation: "userset_recursive_public_alg",
        expected: true,
      },
      {
        name: "usersets_userset_recursive_public_alg/invalid_recursive",
        objectType: UU,
        objectId: u("usersets_userset_recursive_public_alg/userset_1"),
        relation: "userset_recursive_public_alg",
        subjectType: UU,
        subjectId: u("usersets_userset_recursive_public_alg/userset_3"),
        subjectRelation: "userset_recursive_public_alg",
        expected: false,
      },
      {
        name: "usersets_userset_recursive_public_alg/invalid_user",
        objectType: UU,
        objectId: u("usersets_userset_recursive_public_alg/userset_1"),
        relation: "userset_recursive_public_alg",
        subjectType: USER,
        subjectId: u(
          "usersets_userset_recursive_public_alg/userset_recursive_user_public_invalid_user",
        ),
        expected: false,
      },
      {
        name: "usersets_userset_recursive_public_alg/invalid_user_multi_level",
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_alg/userset_recursive_public_alg_multi_level",
        ),
        relation: "userset_recursive_public_alg",
        subjectType: USER,
        subjectId: u(
          "usersets_userset_recursive_public_alg/userset_recursive_user_public_invalid_user",
        ),
        expected: false,
      },
      {
        name: "usersets_userset_recursive_public_alg/invalid_object",
        objectType: UU,
        objectId: u("usersets_userset_recursive_public_alg/userset_1"),
        relation: "userset_recursive_public_alg",
        subjectType: USER,
        subjectId: u(
          "usersets_userset_recursive_public_alg/userset_recursive_user_public_invalid_object",
        ),
        expected: false,
      },
      {
        name: "usersets_userset_recursive_public_alg/invalid_object_multi_level",
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_alg/userset_recursive_public_alg_multi_level",
        ),
        relation: "userset_recursive_public_alg",
        subjectType: USER,
        subjectId: u(
          "usersets_userset_recursive_public_alg/userset_recursive_user_public_invalid_object",
        ),
        expected: false,
      },
      {
        name: "usersets_userset_recursive_public_alg/valid_user_multi_level_public",
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_alg/userset_recursive_public_alg_public_multi_level",
        ),
        relation: "userset_recursive_public_alg",
        subjectType: USER,
        subjectId: u("usersets_userset_recursive_public_alg/any"),
        expected: true,
      },
      {
        name: "usersets_userset_recursive_public_alg/valid_user_multi_level_4_public",
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_alg/userset_recursive_public_alg_public_multi_level_4",
        ),
        relation: "userset_recursive_public_alg",
        subjectType: USER,
        subjectId: u("usersets_userset_recursive_public_alg/any"),
        expected: true,
      },
      {
        name: "usersets_userset_recursive_public_alg/valid_user_multi_level_3_public",
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_alg/userset_recursive_public_alg_public_multi_level_3",
        ),
        relation: "userset_recursive_public_alg",
        subjectType: USER,
        subjectId: u("usersets_userset_recursive_public_alg/any"),
        expected: true,
      },
      {
        name: "usersets_userset_recursive_public_alg/valid_user_multi_level_2_public",
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_alg/userset_recursive_public_alg_public_multi_level_2",
        ),
        relation: "userset_recursive_public_alg",
        subjectType: USER,
        subjectId: u("usersets_userset_recursive_public_alg/any"),
        expected: true,
      },
      {
        name: "usersets_userset_recursive_public_alg/valid_user_multi_level_1_public",
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_alg/userset_recursive_public_alg_public_multi_level_1",
        ),
        relation: "userset_recursive_public_alg",
        subjectType: USER,
        subjectId: u("usersets_userset_recursive_public_alg/any"),
        expected: true,
      },
      {
        name: "usersets_userset_recursive_public_alg/valid_userset_multi_level_2_public_relation",
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_alg/userset_recursive_public_alg_public_multi_level",
        ),
        relation: "userset_recursive_public_alg",
        subjectType: UU,
        subjectId: u(
          "usersets_userset_recursive_public_alg/userset_recursive_public_alg_public_multi_level_2",
        ),
        subjectRelation: "userset_recursive_public_alg",
        expected: true,
      },
      {
        name: "usersets_userset_recursive_public_alg/valid_userset_multi_level_3_public_relation",
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_alg/userset_recursive_public_alg_public_multi_level",
        ),
        relation: "userset_recursive_public_alg",
        subjectType: UU,
        subjectId: u(
          "usersets_userset_recursive_public_alg/userset_recursive_public_alg_public_multi_level_3",
        ),
        subjectRelation: "userset_recursive_public_alg",
        expected: true,
      },
      {
        name: "usersets_userset_recursive_public_alg/valid_userset_multi_level_4_public_relation",
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_alg/userset_recursive_public_alg_public_multi_level",
        ),
        relation: "userset_recursive_public_alg",
        subjectType: UU,
        subjectId: u(
          "usersets_userset_recursive_public_alg/userset_recursive_public_alg_public_multi_level_4",
        ),
        subjectRelation: "userset_recursive_public_alg",
        expected: true,
      },
    ],
  },
  {
    name: "usersets_userset_recursive_public_only",
    tuples: [
      {
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_only/userset_recursive_public_only_multi_level",
        ),
        relation: "userset_recursive_public_only",
        subjectType: UU,
        subjectId: u(
          "usersets_userset_recursive_public_only/userset_recursive_public_only_multi_level_1",
        ),
        subjectRelation: "userset_recursive_public_only",
      },
      {
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_only/userset_recursive_public_only_multi_level_1",
        ),
        relation: "userset_recursive_public_only",
        subjectType: UU,
        subjectId: u(
          "usersets_userset_recursive_public_only/userset_recursive_public_only_multi_level_2",
        ),
        subjectRelation: "userset_recursive_public_only",
      },
      {
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_only/userset_recursive_public_only_multi_level_2",
        ),
        relation: "userset_recursive_public_only",
        subjectType: UU,
        subjectId: u(
          "usersets_userset_recursive_public_only/userset_recursive_public_only_multi_level_3",
        ),
        subjectRelation: "userset_recursive_public_only",
      },
      {
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_only/userset_recursive_public_only_multi_level_3",
        ),
        relation: "userset_recursive_public_only",
        subjectType: UU,
        subjectId: u(
          "usersets_userset_recursive_public_only/userset_recursive_public_only_multi_level_4",
        ),
        subjectRelation: "userset_recursive_public_only",
      },
      {
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_only/userset_recursive_public_only_multi_level_4",
        ),
        relation: "userset_recursive_public_only",
        subjectType: USER,
        subjectId: "*",
      },
    ],
    cases: [
      {
        name: "usersets_userset_recursive_public_only/invalid_object",
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_only/userset_recursive_public_only_invalid_object",
        ),
        relation: "userset_recursive_public_only",
        subjectType: USER,
        subjectId: u(
          "usersets_userset_recursive_public_only/userset_recursive_user_public_invalid_object",
        ),
        expected: false,
      },
      {
        name: "usersets_userset_recursive_public_only/invalid_object_multi_level",
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_only/userset_recursive_public_only_invalid_multi_level",
        ),
        relation: "userset_recursive_public_only",
        subjectType: UU,
        subjectId: u(
          "usersets_userset_recursive_public_only/userset_recursive_public_only_invalid_multi_level_root",
        ),
        subjectRelation: "userset_recursive_public_only",
        expected: false,
      },
      {
        name: "usersets_userset_recursive_public_only/valid_user_multi_level_public",
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_only/userset_recursive_public_only_multi_level",
        ),
        relation: "userset_recursive_public_only",
        subjectType: USER,
        subjectId: u("usersets_userset_recursive_public_only/any"),
        expected: true,
      },
      {
        name: "usersets_userset_recursive_public_only/valid_user_multi_level_4_public",
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_only/userset_recursive_public_only_multi_level_4",
        ),
        relation: "userset_recursive_public_only",
        subjectType: USER,
        subjectId: u("usersets_userset_recursive_public_only/any"),
        expected: true,
      },
      {
        name: "usersets_userset_recursive_public_only/valid_user_multi_level_3_public",
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_only/userset_recursive_public_only_multi_level_3",
        ),
        relation: "userset_recursive_public_only",
        subjectType: USER,
        subjectId: u("usersets_userset_recursive_public_only/any"),
        expected: true,
      },
      {
        name: "usersets_userset_recursive_public_only/valid_user_multi_level_2_public",
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_only/userset_recursive_public_only_multi_level_2",
        ),
        relation: "userset_recursive_public_only",
        subjectType: USER,
        subjectId: u("usersets_userset_recursive_public_only/any"),
        expected: true,
      },
      {
        name: "usersets_userset_recursive_public_only/valid_user_multi_level_1_public",
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_only/userset_recursive_public_only_multi_level_1",
        ),
        relation: "userset_recursive_public_only",
        subjectType: USER,
        subjectId: u("usersets_userset_recursive_public_only/any"),
        expected: true,
      },
      {
        name: "usersets_userset_recursive_public_only/valid_userset_multi_level_2_public_relation",
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_only/userset_recursive_public_only_multi_level",
        ),
        relation: "userset_recursive_public_only",
        subjectType: UU,
        subjectId: u(
          "usersets_userset_recursive_public_only/userset_recursive_public_only_multi_level_2",
        ),
        subjectRelation: "userset_recursive_public_only",
        expected: true,
      },
      {
        name: "usersets_userset_recursive_public_only/valid_userset_multi_level_3_public_relation",
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_only/userset_recursive_public_only_multi_level",
        ),
        relation: "userset_recursive_public_only",
        subjectType: UU,
        subjectId: u(
          "usersets_userset_recursive_public_only/userset_recursive_public_only_multi_level_3",
        ),
        subjectRelation: "userset_recursive_public_only",
        expected: true,
      },
      {
        name: "usersets_userset_recursive_public_only/valid_userset_multi_level_4_public_relation",
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_only/userset_recursive_public_only_multi_level",
        ),
        relation: "userset_recursive_public_only",
        subjectType: UU,
        subjectId: u(
          "usersets_userset_recursive_public_only/userset_recursive_public_only_multi_level_4",
        ),
        subjectRelation: "userset_recursive_public_only",
        expected: true,
      },
    ],
  },
  {
    name: "usersets_userset_recursive_public_only_alg",
    tuples: [
      {
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_only_alg/userset_recursive_public_only_alg_multi_level",
        ),
        relation: "userset_recursive_public_only_alg",
        subjectType: UU,
        subjectId: u(
          "usersets_userset_recursive_public_only_alg/userset_recursive_public_only_alg_multi_level_1",
        ),
        subjectRelation: "userset_recursive_public_only_alg",
      },
      {
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_only_alg/userset_recursive_public_only_alg_multi_level_1",
        ),
        relation: "userset_recursive_public_only_alg",
        subjectType: UU,
        subjectId: u(
          "usersets_userset_recursive_public_only_alg/userset_recursive_public_only_alg_multi_level_2",
        ),
        subjectRelation: "userset_recursive_public_only_alg",
      },
      {
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_only_alg/userset_recursive_public_only_alg_multi_level_2",
        ),
        relation: "userset_recursive_public_only_alg",
        subjectType: UU,
        subjectId: u(
          "usersets_userset_recursive_public_only_alg/userset_recursive_public_only_alg_multi_level_3",
        ),
        subjectRelation: "userset_recursive_public_only_alg",
      },
      {
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_only_alg/userset_recursive_public_only_alg_multi_level_3",
        ),
        relation: "userset_recursive_public_only_alg",
        subjectType: UU,
        subjectId: u(
          "usersets_userset_recursive_public_only_alg/userset_recursive_public_only_alg_multi_level_4",
        ),
        subjectRelation: "userset_recursive_public_only_alg",
      },
      {
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_only_alg/userset_recursive_public_only_alg_multi_level_4",
        ),
        relation: "userset_recursive_public_only_alg",
        subjectType: USER,
        subjectId: "*",
      },
      {
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_only_alg/userset_recursive_public_only_alg_wild",
        ),
        relation: "direct_wild",
        subjectType: USER,
        subjectId: "*",
      },
    ],
    cases: [
      {
        name: "usersets_userset_recursive_public_only_alg/invalid_object",
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_only_alg/userset_recursive_public_only_alg_invalid_object",
        ),
        relation: "userset_recursive_public_only_alg",
        subjectType: USER,
        subjectId: u(
          "usersets_userset_recursive_public_only_alg/userset_recursive_user_public_invalid_object",
        ),
        expected: false,
      },
      {
        name: "usersets_userset_recursive_public_only_alg/invalid_object_multi_level",
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_only_alg/userset_recursive_public_only_alg_invalid_multi_level",
        ),
        relation: "userset_recursive_public_only_alg",
        subjectType: UU,
        subjectId: u(
          "usersets_userset_recursive_public_only_alg/userset_recursive_public_only_alg_invalid_multi_level_root",
        ),
        subjectRelation: "userset_recursive_public_only_alg",
        expected: false,
      },
      {
        name: "usersets_userset_recursive_public_only_alg/valid_user_multi_level_public",
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_only_alg/userset_recursive_public_only_alg_multi_level",
        ),
        relation: "userset_recursive_public_only_alg",
        subjectType: USER,
        subjectId: u("usersets_userset_recursive_public_only_alg/any"),
        expected: true,
      },
      {
        name: "usersets_userset_recursive_public_only_alg/valid_user_multi_level_4_public",
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_only_alg/userset_recursive_public_only_alg_multi_level_4",
        ),
        relation: "userset_recursive_public_only_alg",
        subjectType: USER,
        subjectId: u("usersets_userset_recursive_public_only_alg/any"),
        expected: true,
      },
      {
        name: "usersets_userset_recursive_public_only_alg/valid_user_multi_level_3_public",
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_only_alg/userset_recursive_public_only_alg_multi_level_3",
        ),
        relation: "userset_recursive_public_only_alg",
        subjectType: USER,
        subjectId: u("usersets_userset_recursive_public_only_alg/any"),
        expected: true,
      },
      {
        name: "usersets_userset_recursive_public_only_alg/valid_user_multi_level_2_public",
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_only_alg/userset_recursive_public_only_alg_multi_level_2",
        ),
        relation: "userset_recursive_public_only_alg",
        subjectType: USER,
        subjectId: u("usersets_userset_recursive_public_only_alg/any"),
        expected: true,
      },
      {
        name: "usersets_userset_recursive_public_only_alg/valid_user_multi_level_1_public",
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_only_alg/userset_recursive_public_only_alg_multi_level_1",
        ),
        relation: "userset_recursive_public_only_alg",
        subjectType: USER,
        subjectId: u("usersets_userset_recursive_public_only_alg/any"),
        expected: true,
      },
      {
        name: "usersets_userset_recursive_public_only_alg/valid_userset_multi_level_2_public_relation",
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_only_alg/userset_recursive_public_only_alg_multi_level",
        ),
        relation: "userset_recursive_public_only_alg",
        subjectType: UU,
        subjectId: u(
          "usersets_userset_recursive_public_only_alg/userset_recursive_public_only_alg_multi_level_2",
        ),
        subjectRelation: "userset_recursive_public_only_alg",
        expected: true,
      },
      {
        name: "usersets_userset_recursive_public_only_alg/valid_userset_multi_level_3_public_relation",
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_only_alg/userset_recursive_public_only_alg_multi_level",
        ),
        relation: "userset_recursive_public_only_alg",
        subjectType: UU,
        subjectId: u(
          "usersets_userset_recursive_public_only_alg/userset_recursive_public_only_alg_multi_level_3",
        ),
        subjectRelation: "userset_recursive_public_only_alg",
        expected: true,
      },
      {
        name: "usersets_userset_recursive_public_only_alg/valid_userset_multi_level_4_public_relation",
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_only_alg/userset_recursive_public_only_alg_multi_level",
        ),
        relation: "userset_recursive_public_only_alg",
        subjectType: UU,
        subjectId: u(
          "usersets_userset_recursive_public_only_alg/userset_recursive_public_only_alg_multi_level_4",
        ),
        subjectRelation: "userset_recursive_public_only_alg",
        expected: true,
      },
      {
        name: "usersets_userset_recursive_public_only_alg/valid_alg_wild",
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_only_alg/userset_recursive_public_only_alg_wild",
        ),
        relation: "userset_recursive_public_only_alg",
        subjectType: USER,
        subjectId: u("usersets_userset_recursive_public_only_alg/any"),
        expected: true,
      },
    ],
  },
  {
    name: "usersets_userset_recursive_public_cond",
    tuples: [
      {
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_cond/userset_recursive_public_alg_cond_1_multi_level",
        ),
        relation: "userset_recursive_public_alg_cond",
        subjectType: UU,
        subjectId: u(
          "usersets_userset_recursive_public_cond/userset_recursive_public_alg_cond_1_multi_level_1",
        ),
        subjectRelation: "userset_recursive_public_alg_cond",
        conditionName: XCOND,
      },
      {
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_cond/userset_recursive_public_alg_cond_1_multi_level_1",
        ),
        relation: "userset_recursive_public_alg_cond",
        subjectType: UU,
        subjectId: u(
          "usersets_userset_recursive_public_cond/userset_recursive_public_alg_cond_1_multi_level_2",
        ),
        subjectRelation: "userset_recursive_public_alg_cond",
        conditionName: XCOND,
      },
      {
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_cond/userset_recursive_public_alg_cond_1_multi_level_2",
        ),
        relation: "userset_recursive_public_alg_cond",
        subjectType: UU,
        subjectId: u(
          "usersets_userset_recursive_public_cond/userset_recursive_public_alg_cond_1_multi_level_3",
        ),
        subjectRelation: "userset_recursive_public_alg_cond",
        conditionName: XCOND,
      },
      {
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_cond/userset_recursive_public_alg_cond_1_multi_level_3",
        ),
        relation: "userset_recursive_public_alg_cond",
        subjectType: UU,
        subjectId: u(
          "usersets_userset_recursive_public_cond/userset_recursive_public_alg_cond_1_multi_level_4",
        ),
        subjectRelation: "userset_recursive_public_alg_cond",
        conditionName: XCOND,
      },
      {
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_cond/userset_recursive_public_alg_cond_1_multi_level_4",
        ),
        relation: "userset_recursive_public_alg_cond",
        subjectType: USER,
        subjectId: u(
          "usersets_userset_recursive_public_cond/userset_recursive_public_alg_cond_1",
        ),
        conditionName: XCOND,
      },
      {
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_cond/userset_recursive_public_alg_cond_1_multi_level_4",
        ),
        relation: "alg_cond_combined",
        subjectType: USER,
        subjectId: u(
          "usersets_userset_recursive_public_cond/userset_recursive_public_alg_cond_alg",
        ),
        conditionName: XCOND,
      },
      {
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_cond/userset_recursive_public_alg_cond_1_multi_level_4",
        ),
        relation: "direct",
        subjectType: USER,
        subjectId: u(
          "usersets_userset_recursive_public_cond/userset_recursive_public_alg_cond_alg_direct",
        ),
      },
    ],
    cases: [
      {
        name: "usersets_userset_recursive_public_cond/invalid_object",
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_cond/userset_recursive_public_only_alg_invalid_object",
        ),
        relation: "userset_recursive_public_alg_cond",
        subjectType: USER,
        subjectId: u(
          "usersets_userset_recursive_public_cond/userset_recursive_public_alg_cond_1",
        ),
        context: { x: "1" },
        expected: false,
      },
      {
        name: "usersets_userset_recursive_public_cond/invalid_user",
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_cond/userset_recursive_public_alg_cond_1_multi_level",
        ),
        relation: "userset_recursive_public_alg_cond",
        subjectType: USER,
        subjectId: u(
          "usersets_userset_recursive_public_cond/userset_recursive_public_alg_cond_invalid",
        ),
        context: { x: "1" },
        expected: false,
      },
      {
        name: "usersets_userset_recursive_public_cond/valid_recursion",
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_cond/userset_recursive_public_alg_cond_1_multi_level",
        ),
        relation: "userset_recursive_public_alg_cond",
        subjectType: USER,
        subjectId: u(
          "usersets_userset_recursive_public_cond/userset_recursive_public_alg_cond_1",
        ),
        context: { x: "1" },
        expected: true,
      },
      {
        name: "usersets_userset_recursive_public_cond/valid_recursive_userset_single_level",
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_cond/userset_recursive_public_alg_cond_1_multi_level",
        ),
        relation: "userset_recursive_public_alg_cond",
        subjectType: UU,
        subjectId: u(
          "usersets_userset_recursive_public_cond/userset_recursive_public_alg_cond_1_multi_level_1",
        ),
        subjectRelation: "userset_recursive_public_alg_cond",
        context: { x: "1" },
        expected: true,
      },
      {
        name: "usersets_userset_recursive_public_cond/valid_recursive_userset_multi_level",
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_cond/userset_recursive_public_alg_cond_1_multi_level",
        ),
        relation: "userset_recursive_public_alg_cond",
        subjectType: UU,
        subjectId: u(
          "usersets_userset_recursive_public_cond/userset_recursive_public_alg_cond_1_multi_level_3",
        ),
        subjectRelation: "userset_recursive_public_alg_cond",
        context: { x: "1" },
        expected: true,
      },
      {
        name: "usersets_userset_recursive_public_cond/fail_due_to_cond",
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_cond/userset_recursive_public_alg_cond_1_multi_level",
        ),
        relation: "userset_recursive_public_alg_cond",
        subjectType: USER,
        subjectId: u(
          "usersets_userset_recursive_public_cond/userset_recursive_public_alg_cond_1",
        ),
        context: { x: "2" },
        expected: false,
      },
      {
        name: "usersets_userset_recursive_public_cond/invalid_recursive_userset_single_level_due_to_cond",
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_cond/userset_recursive_public_alg_cond_1_multi_level",
        ),
        relation: "userset_recursive_public_alg_cond",
        subjectType: UU,
        subjectId: u(
          "usersets_userset_recursive_public_cond/userset_recursive_public_alg_cond_1_multi_level_1",
        ),
        subjectRelation: "userset_recursive_public_alg_cond",
        context: { x: "2" },
        expected: false,
      },
      {
        name: "usersets_userset_recursive_public_cond/invalid_recursive_userset_multi_level_due_to_cond",
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_cond/userset_recursive_public_alg_cond_1_multi_level",
        ),
        relation: "userset_recursive_public_alg_cond",
        subjectType: UU,
        subjectId: u(
          "usersets_userset_recursive_public_cond/userset_recursive_public_alg_cond_1_multi_level_3",
        ),
        subjectRelation: "userset_recursive_public_alg_cond",
        context: { x: "2" },
        expected: false,
      },
      {
        name: "usersets_userset_recursive_public_cond/alg_match",
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_cond/userset_recursive_public_alg_cond_1_multi_level",
        ),
        relation: "userset_recursive_public_alg_cond",
        subjectType: USER,
        subjectId: u(
          "usersets_userset_recursive_public_cond/userset_recursive_public_alg_cond_alg",
        ),
        context: { x: "1" },
        expected: true,
      },
      {
        name: "usersets_userset_recursive_public_cond/alg_match_cond_not_match",
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_cond/userset_recursive_public_alg_cond_1_multi_level",
        ),
        relation: "userset_recursive_public_alg_cond",
        subjectType: USER,
        subjectId: u(
          "usersets_userset_recursive_public_cond/userset_recursive_public_alg_cond_alg",
        ),
        context: { x: "2" },
        expected: false,
      },
      {
        name: "usersets_userset_recursive_public_cond/alg_match_direct",
        objectType: UU,
        objectId: u(
          "usersets_userset_recursive_public_cond/userset_recursive_public_alg_cond_1_multi_level",
        ),
        relation: "userset_recursive_public_alg_cond",
        subjectType: USER,
        subjectId: u(
          "usersets_userset_recursive_public_cond/userset_recursive_public_alg_cond_alg_direct",
        ),
        context: { x: "1" },
        expected: true,
      },
    ],
  },
  {
    name: "userset_recursive_mixed_direct_assignment_mixed_direct_assignment",
    tuples: [
      {
        objectType: UU,
        objectId: u(
          "userset_recursive_mixed_direct_assignment_mixed_direct_assignment/userset_recursive_mixed_direct_assignment_1",
        ),
        relation: "userset_recursive_mixed_direct_assignment",
        subjectType: USER,
        subjectId: u(
          "userset_recursive_mixed_direct_assignment_mixed_direct_assignment/userset_recursive_mixed_direct_assignment_user_1",
        ),
      },
      {
        objectType: UU,
        objectId: u(
          "userset_recursive_mixed_direct_assignment_mixed_direct_assignment/userset_recursive_mixed_direct_assignment_1",
        ),
        relation: "userset_recursive_mixed_direct_assignment",
        subjectType: UU,
        subjectId: u(
          "userset_recursive_mixed_direct_assignment_mixed_direct_assignment/userset_recursive_mixed_direct_assignment_2",
        ),
        subjectRelation: "userset_recursive_mixed_direct_assignment",
      },
      {
        objectType: UU,
        objectId: u(
          "userset_recursive_mixed_direct_assignment_mixed_direct_assignment/userset_recursive_mixed_direct_assignment_multi_level",
        ),
        relation: "userset_recursive_mixed_direct_assignment",
        subjectType: UU,
        subjectId: u(
          "userset_recursive_mixed_direct_assignment_mixed_direct_assignment/userset_recursive_mixed_direct_assignment_multi_level_1",
        ),
        subjectRelation: "userset_recursive_mixed_direct_assignment",
      },
      {
        objectType: UU,
        objectId: u(
          "userset_recursive_mixed_direct_assignment_mixed_direct_assignment/userset_recursive_mixed_direct_assignment_multi_level_1",
        ),
        relation: "userset_recursive_mixed_direct_assignment",
        subjectType: UU,
        subjectId: u(
          "userset_recursive_mixed_direct_assignment_mixed_direct_assignment/userset_recursive_mixed_direct_assignment_multi_level_2",
        ),
        subjectRelation: "userset_recursive_mixed_direct_assignment",
      },
      {
        objectType: UU,
        objectId: u(
          "userset_recursive_mixed_direct_assignment_mixed_direct_assignment/userset_recursive_mixed_direct_assignment_multi_level_2",
        ),
        relation: "userset_recursive_mixed_direct_assignment",
        subjectType: UU,
        subjectId: u(
          "userset_recursive_mixed_direct_assignment_mixed_direct_assignment/userset_recursive_mixed_direct_assignment_multi_level_3",
        ),
        subjectRelation: "userset_recursive_mixed_direct_assignment",
      },
      {
        objectType: UU,
        objectId: u(
          "userset_recursive_mixed_direct_assignment_mixed_direct_assignment/userset_recursive_mixed_direct_assignment_multi_level_3",
        ),
        relation: "userset_recursive_mixed_direct_assignment",
        subjectType: UU,
        subjectId: u(
          "userset_recursive_mixed_direct_assignment_mixed_direct_assignment/userset_recursive_mixed_direct_assignment_multi_level_4",
        ),
        subjectRelation: "userset_recursive_mixed_direct_assignment",
      },
      {
        objectType: UU,
        objectId: u(
          "userset_recursive_mixed_direct_assignment_mixed_direct_assignment/userset_recursive_mixed_direct_assignment_multi_level_4",
        ),
        relation: "userset_recursive_mixed_direct_assignment",
        subjectType: USER,
        subjectId: u(
          "userset_recursive_mixed_direct_assignment_mixed_direct_assignment/userset_recursive_mixed_direct_assignment_user_multi_level",
        ),
      },
      {
        objectType: UU,
        objectId: u(
          "userset_recursive_mixed_direct_assignment_mixed_direct_assignment/userset_recursive_mixed_direct_assignment_invalid_object",
        ),
        relation: "userset_recursive_mixed_direct_assignment",
        subjectType: USER,
        subjectId: u(
          "userset_recursive_mixed_direct_assignment_mixed_direct_assignment/userset_recursive_mixed_direct_assignment_user_invalid_object",
        ),
      },
      {
        objectType: UU,
        objectId: u(
          "userset_recursive_mixed_direct_assignment_mixed_direct_assignment/userset_recursive_mixed_direct_assignment_2",
        ),
        relation: "userset_recursive_mixed_direct_assignment",
        subjectType: UU,
        subjectId: u(
          "userset_recursive_mixed_direct_assignment_mixed_direct_assignment/userset_recursive_mixed_direct_assignment_2",
        ),
        subjectRelation: "userset",
      },
      {
        objectType: UU,
        objectId: u(
          "userset_recursive_mixed_direct_assignment_mixed_direct_assignment/userset_recursive_mixed_direct_assignment_2",
        ),
        relation: "userset",
        subjectType: DU,
        subjectId: u(
          "userset_recursive_mixed_direct_assignment_mixed_direct_assignment/userset_recursive_mixed_direct_assignment_2",
        ),
        subjectRelation: "direct",
      },
      {
        objectType: DU,
        objectId: u(
          "userset_recursive_mixed_direct_assignment_mixed_direct_assignment/userset_recursive_mixed_direct_assignment_2",
        ),
        relation: "direct",
        subjectType: USER,
        subjectId: u(
          "userset_recursive_mixed_direct_assignment_mixed_direct_assignment/userset_recursive_mixed_direct_assignment_2",
        ),
      },
    ],
    cases: [
      {
        name: "userset_recursive_mixed_direct_assignment_mixed_direct_assignment/valid_recursive",
        objectType: UU,
        objectId: u(
          "userset_recursive_mixed_direct_assignment_mixed_direct_assignment/userset_recursive_mixed_direct_assignment_1",
        ),
        relation: "userset_recursive_mixed_direct_assignment",
        subjectType: UU,
        subjectId: u(
          "userset_recursive_mixed_direct_assignment_mixed_direct_assignment/userset_recursive_mixed_direct_assignment_2",
        ),
        subjectRelation: "userset_recursive_mixed_direct_assignment",
        expected: true,
      },
      {
        name: "userset_recursive_mixed_direct_assignment_mixed_direct_assignment/valid_user",
        objectType: UU,
        objectId: u(
          "userset_recursive_mixed_direct_assignment_mixed_direct_assignment/userset_recursive_mixed_direct_assignment_1",
        ),
        relation: "userset_recursive_mixed_direct_assignment",
        subjectType: USER,
        subjectId: u(
          "userset_recursive_mixed_direct_assignment_mixed_direct_assignment/userset_recursive_mixed_direct_assignment_user_1",
        ),
        expected: true,
      },
      {
        name: "userset_recursive_mixed_direct_assignment_mixed_direct_assignment/valid_user_multi_level",
        objectType: UU,
        objectId: u(
          "userset_recursive_mixed_direct_assignment_mixed_direct_assignment/userset_recursive_mixed_direct_assignment_multi_level",
        ),
        relation: "userset_recursive_mixed_direct_assignment",
        subjectType: USER,
        subjectId: u(
          "userset_recursive_mixed_direct_assignment_mixed_direct_assignment/userset_recursive_mixed_direct_assignment_user_multi_level",
        ),
        expected: true,
      },
      {
        name: "userset_recursive_mixed_direct_assignment_mixed_direct_assignment/valid_userset_multi_level",
        objectType: UU,
        objectId: u(
          "userset_recursive_mixed_direct_assignment_mixed_direct_assignment/userset_recursive_mixed_direct_assignment_multi_level",
        ),
        relation: "userset_recursive_mixed_direct_assignment",
        subjectType: UU,
        subjectId: u(
          "userset_recursive_mixed_direct_assignment_mixed_direct_assignment/userset_recursive_mixed_direct_assignment_multi_level_4",
        ),
        subjectRelation: "userset_recursive_mixed_direct_assignment",
        expected: true,
      },
      {
        name: "userset_recursive_mixed_direct_assignment_mixed_direct_assignment/invalid_recursive",
        objectType: UU,
        objectId: u(
          "userset_recursive_mixed_direct_assignment_mixed_direct_assignment/userset_1",
        ),
        relation: "userset_recursive_mixed_direct_assignment",
        subjectType: UU,
        subjectId: u(
          "userset_recursive_mixed_direct_assignment_mixed_direct_assignment/userset_3",
        ),
        subjectRelation: "userset_recursive_mixed_direct_assignment",
        expected: false,
      },
      {
        name: "userset_recursive_mixed_direct_assignment_mixed_direct_assignment/invalid_user",
        objectType: UU,
        objectId: u(
          "userset_recursive_mixed_direct_assignment_mixed_direct_assignment/userset_1",
        ),
        relation: "userset_recursive_mixed_direct_assignment",
        subjectType: USER,
        subjectId: u(
          "userset_recursive_mixed_direct_assignment_mixed_direct_assignment/userset_recursive_mixed_direct_assignment_user_invalid_user",
        ),
        expected: false,
      },
      {
        name: "userset_recursive_mixed_direct_assignment_mixed_direct_assignment/invalid_user_multi_level",
        objectType: UU,
        objectId: u(
          "userset_recursive_mixed_direct_assignment_mixed_direct_assignment/userset_recursive_mixed_direct_assignment_multi_level",
        ),
        relation: "userset_recursive_mixed_direct_assignment",
        subjectType: USER,
        subjectId: u(
          "userset_recursive_mixed_direct_assignment_mixed_direct_assignment/userset_recursive_mixed_direct_assignment_user_invalid_user",
        ),
        expected: false,
      },
      {
        name: "userset_recursive_mixed_direct_assignment_mixed_direct_assignment/invalid_object",
        objectType: UU,
        objectId: u(
          "userset_recursive_mixed_direct_assignment_mixed_direct_assignment/userset_1",
        ),
        relation: "userset_recursive_mixed_direct_assignment",
        subjectType: USER,
        subjectId: u(
          "userset_recursive_mixed_direct_assignment_mixed_direct_assignment/userset_recursive_mixed_direct_assignment_user_invalid_object",
        ),
        expected: false,
      },
      {
        name: "userset_recursive_mixed_direct_assignment_mixed_direct_assignment/invalid_object_multi_level",
        objectType: UU,
        objectId: u(
          "userset_recursive_mixed_direct_assignment_mixed_direct_assignment/userset_recursive_mixed_direct_assignment_multi_level",
        ),
        relation: "userset_recursive_mixed_direct_assignment",
        subjectType: USER,
        subjectId: u(
          "userset_recursive_mixed_direct_assignment_mixed_direct_assignment/userset_recursive_mixed_direct_assignment_user_invalid_object",
        ),
        expected: false,
      },
      {
        name: "userset_recursive_mixed_direct_assignment_mixed_direct_assignment/valid_user_via_directs-user",
        objectType: UU,
        objectId: u(
          "userset_recursive_mixed_direct_assignment_mixed_direct_assignment/userset_recursive_mixed_direct_assignment_2",
        ),
        relation: "userset_recursive_mixed_direct_assignment",
        subjectType: USER,
        subjectId: u(
          "userset_recursive_mixed_direct_assignment_mixed_direct_assignment/userset_recursive_mixed_direct_assignment_2",
        ),
        expected: true,
      },
      {
        name: "userset_recursive_mixed_direct_assignment_mixed_direct_assignment/valid_direct_user_computed",
        objectType: UU,
        objectId: u(
          "userset_recursive_mixed_direct_assignment_mixed_direct_assignment/userset_recursive_mixed_direct_assignment_2",
        ),
        relation: "userset_recursive_mixed_direct_assignment",
        subjectType: DU,
        subjectId: u(
          "userset_recursive_mixed_direct_assignment_mixed_direct_assignment/userset_recursive_mixed_direct_assignment_2",
        ),
        subjectRelation: "direct",
        expected: true,
      },
    ],
  },
  {
    name: "userset_mix_public",
    tuples: [
      {
        objectType: UU,
        objectId: u("userset_mix_public/userset_mix_public_1"),
        relation: "userset_mix_public",
        subjectType: DU,
        subjectId: u("userset_mix_public/userset_mix_public_1"),
        subjectRelation: "direct",
      },
      {
        objectType: DU,
        objectId: u("userset_mix_public/userset_mix_public_1"),
        relation: "direct",
        subjectType: USER,
        subjectId: u("userset_mix_public/userset_mix_public_1"),
      },
      {
        objectType: UU,
        objectId: u("userset_mix_public/userset_mix_public_user_public"),
        relation: "userset_mix_public",
        subjectType: USER,
        subjectId: "*",
      },
      {
        objectType: UU,
        objectId: u("userset_mix_public/userset_mix_public_user_specific"),
        relation: "userset_mix_public",
        subjectType: USER,
        subjectId: u("userset_mix_public/specific"),
      },
      {
        objectType: UU,
        objectId: u("userset_mix_public/userset_mix_directs_user_public"),
        relation: "userset_mix_public",
        subjectType: DU,
        subjectId: "*",
      },
    ],
    cases: [
      {
        name: "userset_mix_public/valid_userset_assignment",
        objectType: UU,
        objectId: u("userset_mix_public/userset_mix_public_1"),
        relation: "userset_mix_public",
        subjectType: DU,
        subjectId: u("userset_mix_public/userset_mix_public_1"),
        subjectRelation: "direct",
        expected: true,
      },
      {
        name: "userset_mix_public/valid_user",
        objectType: UU,
        objectId: u("userset_mix_public/userset_mix_public_1"),
        relation: "userset_mix_public",
        subjectType: USER,
        subjectId: u("userset_mix_public/userset_mix_public_1"),
        expected: true,
      },
      {
        name: "userset_mix_public/invalid_userset_assignment",
        objectType: UU,
        objectId: u("userset_mix_public/userset_mix_public_1"),
        relation: "userset_mix_public",
        subjectType: DU,
        subjectId: u("userset_mix_public/userset_mix_public_invalid"),
        subjectRelation: "direct",
        expected: false,
      },
      {
        name: "userset_mix_public/invalid_user",
        objectType: UU,
        objectId: u("userset_mix_public/userset_mix_public_1"),
        relation: "userset_mix_public",
        subjectType: USER,
        subjectId: u("userset_mix_public/userset_mix_public_invalid"),
        expected: false,
      },
      {
        name: "userset_mix_public/user_public",
        objectType: UU,
        objectId: u("userset_mix_public/userset_mix_public_user_public"),
        relation: "userset_mix_public",
        subjectType: USER,
        subjectId: u("userset_mix_public/any"),
        expected: true,
      },
      {
        name: "userset_mix_public/user_specific",
        objectType: UU,
        objectId: u("userset_mix_public/userset_mix_public_user_specific"),
        relation: "userset_mix_public",
        subjectType: USER,
        subjectId: u("userset_mix_public/specific"),
        expected: true,
      },
      {
        name: "userset_mix_public/user_specific_other",
        objectType: UU,
        objectId: u("userset_mix_public/userset_mix_public_user_specific"),
        relation: "userset_mix_public",
        subjectType: USER,
        subjectId: u("userset_mix_public/other"),
        expected: false,
      },
      {
        name: "userset_mix_public/direct_user_public",
        objectType: UU,
        objectId: u("userset_mix_public/userset_mix_directs_user_public"),
        relation: "userset_mix_public",
        subjectType: DU,
        subjectId: u("userset_mix_public/any"),
        expected: true,
      },
      {
        name: "userset_mix_public/direct_user_public_userset_1",
        objectType: UU,
        objectId: u("userset_mix_public/userset_mix_directs_user_public"),
        relation: "userset_mix_public",
        subjectType: DU,
        subjectId: u("userset_mix_public/any"),
        subjectRelation: "direct",
        expected: false,
      },
      {
        name: "userset_mix_public/direct_user_public_userset_2",
        objectType: UU,
        objectId: u("userset_mix_public/userset_mix_directs_user_public"),
        relation: "userset_mix_public",
        subjectType: DU,
        subjectId: u("userset_mix_public/any"),
        subjectRelation: "direct_wild",
        expected: false,
      },
    ],
  },
  {
    name: "or_userset_mix_public",
    tuples: [
      {
        objectType: UU,
        objectId: u("or_userset_mix_public/or_userset_mix_public_1"),
        relation: "userset_mix_public",
        subjectType: DU,
        subjectId: u("or_userset_mix_public/or_userset_mix_public_1"),
        subjectRelation: "direct",
      },
      {
        objectType: DU,
        objectId: u("or_userset_mix_public/or_userset_mix_public_1"),
        relation: "direct",
        subjectType: USER,
        subjectId: u("or_userset_mix_public/or_userset_mix_public_1"),
      },
      {
        objectType: UU,
        objectId: u("or_userset_mix_public/or_userset_mix_public_user_public"),
        relation: "userset_mix_public",
        subjectType: USER,
        subjectId: "*",
      },
      {
        objectType: UU,
        objectId: u(
          "or_userset_mix_public/or_userset_mix_public_user_specific",
        ),
        relation: "userset_mix_public",
        subjectType: USER,
        subjectId: u("or_userset_mix_public/or_specific"),
      },
      {
        objectType: UU,
        objectId: u("or_userset_mix_public/or_userset_mix_public_2"),
        relation: "or_userset_mix_public",
        subjectType: USER,
        subjectId: "*",
      },
      {
        objectType: UU,
        objectId: u("or_userset_mix_public/or_userset_mix_public_3"),
        relation: "or_userset_mix_public",
        subjectType: USER,
        subjectId: u("or_userset_mix_public/or_userset_mix_public_3"),
      },
      {
        objectType: UU,
        objectId: u("or_userset_mix_public/or_userset_mix_directs_user_public"),
        relation: "userset_mix_public",
        subjectType: DU,
        subjectId: "*",
      },
    ],
    cases: [
      {
        name: "or_userset_mix_public/valid_userset_assignment",
        objectType: UU,
        objectId: u("or_userset_mix_public/or_userset_mix_public_1"),
        relation: "or_userset_mix_public",
        subjectType: DU,
        subjectId: u("or_userset_mix_public/or_userset_mix_public_1"),
        subjectRelation: "direct",
        expected: true,
      },
      {
        name: "or_userset_mix_public/valid_user",
        objectType: UU,
        objectId: u("or_userset_mix_public/or_userset_mix_public_1"),
        relation: "or_userset_mix_public",
        subjectType: USER,
        subjectId: u("or_userset_mix_public/or_userset_mix_public_1"),
        expected: true,
      },
      {
        name: "or_userset_mix_public/invalid_userset_assignment",
        objectType: UU,
        objectId: u("or_userset_mix_public/or_userset_mix_public_1"),
        relation: "or_userset_mix_public",
        subjectType: DU,
        subjectId: u("or_userset_mix_public/or_userset_mix_public_invalid"),
        subjectRelation: "direct",
        expected: false,
      },
      {
        name: "or_userset_mix_public/invalid_user",
        objectType: UU,
        objectId: u("or_userset_mix_public/or_userset_mix_public_1"),
        relation: "or_userset_mix_public",
        subjectType: USER,
        subjectId: u("or_userset_mix_public/or_userset_mix_public_invalid"),
        expected: false,
      },
      {
        name: "or_userset_mix_public/user_public",
        objectType: UU,
        objectId: u("or_userset_mix_public/or_userset_mix_public_user_public"),
        relation: "or_userset_mix_public",
        subjectType: USER,
        subjectId: u("or_userset_mix_public/or_any"),
        expected: true,
      },
      {
        name: "or_userset_mix_public/user_specific",
        objectType: UU,
        objectId: u(
          "or_userset_mix_public/or_userset_mix_public_user_specific",
        ),
        relation: "or_userset_mix_public",
        subjectType: USER,
        subjectId: u("or_userset_mix_public/or_specific"),
        expected: true,
      },
      {
        name: "or_userset_mix_public/user_specific_other",
        objectType: UU,
        objectId: u(
          "or_userset_mix_public/or_userset_mix_public_user_specific",
        ),
        relation: "or_userset_mix_public",
        subjectType: USER,
        subjectId: u("or_userset_mix_public/or_other"),
        expected: false,
      },
      {
        name: "or_userset_mix_public/public_user_direct_assign",
        objectType: UU,
        objectId: u("or_userset_mix_public/or_userset_mix_public_2"),
        relation: "or_userset_mix_public",
        subjectType: USER,
        subjectId: u("or_userset_mix_public/any"),
        expected: true,
      },
      {
        name: "or_userset_mix_public/specific_user_direct_assign",
        objectType: UU,
        objectId: u("or_userset_mix_public/or_userset_mix_public_3"),
        relation: "or_userset_mix_public",
        subjectType: USER,
        subjectId: u("or_userset_mix_public/or_userset_mix_public_3"),
        expected: true,
      },
      {
        name: "or_userset_mix_public/user_direct_assign_invalid_user",
        objectType: UU,
        objectId: u("or_userset_mix_public/or_userset_mix_public_3"),
        relation: "or_userset_mix_public",
        subjectType: USER,
        subjectId: u("or_userset_mix_public/or_userset_mix_public_3_invalid"),
        expected: false,
      },
      {
        name: "or_userset_mix_public/user_direct_assign_invalid_object",
        objectType: UU,
        objectId: u("or_userset_mix_public/or_userset_mix_public_3_invalid"),
        relation: "or_userset_mix_public",
        subjectType: USER,
        subjectId: u("or_userset_mix_public/or_userset_mix_public_3"),
        expected: false,
      },
      {
        name: "or_userset_mix_public/direct_user_public",
        objectType: UU,
        objectId: u("or_userset_mix_public/or_userset_mix_directs_user_public"),
        relation: "or_userset_mix_public",
        subjectType: DU,
        subjectId: u("or_userset_mix_public/any"),
        expected: true,
      },
      {
        name: "or_userset_mix_public/direct_user_public_userset_1",
        objectType: UU,
        objectId: u("or_userset_mix_public/or_userset_mix_directs_user_public"),
        relation: "or_userset_mix_public",
        subjectType: DU,
        subjectId: u("or_userset_mix_public/any"),
        subjectRelation: "direct",
        expected: false,
      },
      {
        name: "or_userset_mix_public/direct_user_public_userset_2",
        objectType: UU,
        objectId: u("or_userset_mix_public/or_userset_mix_directs_user_public"),
        relation: "or_userset_mix_public",
        subjectType: DU,
        subjectId: u("or_userset_mix_public/any"),
        subjectRelation: "direct_wild",
        expected: false,
      },
    ],
  },
];

describe("B1 userset corpus — recursive usersets and wildcards", () => {
  let db: Kysely<DB>;
  let corpus: Corpus;
  let fixture: FixtureRecord;

  beforeAll(async () => {
    db = getDb();
    await beginTransaction(db);

    const tsfgaClient = createTsfga(new KyselyTupleStore(db));
    fixture = recordFixture(tsfgaClient);
    corpus = await loadCorpus(tsfgaClient, {
      slug: "userset-recursive",
      modelPath: "./userset-recursive/model.dsl",
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
    expectConfigsMatchModel("./userset-recursive/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
