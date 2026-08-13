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
 * B1 tuple-to-userset corpus — recursion and mixed parents.
 *
 * A port of upstream's own case matrix —
 * `tests/check/check_ttu.go` at v1.18.2 — over the stages
 * listed below. Every `expected` is the `Expectation:` the Go
 * corpus states, so a shape both engines answer the same
 * *wrong* way still fails.
 *
 * Stages ported here:
 * - `recursive_ttu`
 * - `recursive_ttu_alg`
 * - `recursive_ttu_public`
 * - `recursive_ttu_public_alg`
 * - `recursive_ttu_alg_cond`
 * - `multi_branch_recursive_ttu`
 * - `mixed_use`
 *
 * Upstream's `ErrorCode: 2000` (a check whose condition
 * parameter the request never supplied) is transcribed as
 * `"refused"`: both engines decline to answer rather than
 * denying.
 *
 * Types and the condition carry a `_b1e` suffix so this
 * fixture cannot collide with another fixture's rows in the
 * shared Postgres and OpenFGA.
 */

const USER = "user_b1e";
const DU = "directs_user_b1e";
const TT = "ttus_b1e";
const MR = "multi_recursive_b1e";
const XCOND = "xcond_b1e";

/** Upstream's object and subject names, as UUIDs. */
const u = ids(
  [
    "recursive_ttu/ttus_recursive_ttu_direct_assign",
    "recursive_ttu/ttus_recursive_ttu_parent_case_1_1",
    "recursive_ttu/ttus_recursive_ttu_parent_case_1_2",
    "recursive_ttu/ttus_recursive_ttu_parent_case_1_3",
    "recursive_ttu/ttus_recursive_ttu_parent_case_1_4",
    "recursive_ttu/ttus_recursive_ttu_not_direct_assign",
    "recursive_ttu_alg/ttus_recursive_ttu_alg_direct_assign",
    "recursive_ttu_alg/ttus_recursive_ttu_alg_parent_case_1_1",
    "recursive_ttu_alg/ttus_recursive_ttu_alg_parent_case_1_2",
    "recursive_ttu_alg/ttus_recursive_ttu_alg_parent_case_1_3",
    "recursive_ttu_alg/ttus_recursive_ttu_alg_parent_case_1_4",
    "recursive_ttu_alg/ttus_recursive_ttu_alg_alg_case_1",
    "recursive_ttu_alg/ttus_recursive_ttu_alg_user_1",
    "recursive_ttu_alg/ttus_recursive_ttu_alg_alg_case_2",
    "recursive_ttu_alg/ttus_recursive_ttu_alg_user_2",
    "recursive_ttu_alg/ttus_recursive_ttu_alg_not_direct_assign",
    "recursive_ttu_public/ttus_recursive_ttu_public_direct_assign",
    "recursive_ttu_public/ttus_recursive_ttu_public_parent_case_1_1",
    "recursive_ttu_public/ttus_recursive_ttu_public_parent_case_1_2",
    "recursive_ttu_public/ttus_recursive_ttu_public_parent_case_1_3",
    "recursive_ttu_public/ttus_recursive_ttu_public_parent_case_1_4",
    "recursive_ttu_public/ttus_recursive_ttu_public_wildcard",
    "recursive_ttu_public/ttus_recursive_ttu_public_wildcard_parent_case_1_1",
    "recursive_ttu_public/ttus_recursive_ttu_public_wildcard_parent_case_1_2",
    "recursive_ttu_public/ttus_recursive_ttu_public_wildcard_parent_case_1_3",
    "recursive_ttu_public/ttus_recursive_ttu_public_wildcard_parent_case_1_4",
    "recursive_ttu_public/ttus_recursive_ttu_public_not_direct_assign",
    "recursive_ttu_public/any",
    "recursive_ttu_public_alg/ttus_recursive_ttu_public_alg_direct_assign",
    "recursive_ttu_public_alg/ttus_recursive_ttu_public_alg_parent_case_1_1",
    "recursive_ttu_public_alg/ttus_recursive_ttu_public_alg_parent_case_1_2",
    "recursive_ttu_public_alg/ttus_recursive_ttu_public_alg_parent_case_1_3",
    "recursive_ttu_public_alg/ttus_recursive_ttu_public_alg_parent_case_1_4",
    "recursive_ttu_public_alg/ttus_recursive_ttu_public_alg_wildcard",
    "recursive_ttu_public_alg/ttus_recursive_ttu_public_alg_wildcard_parent_case_1_1",
    "recursive_ttu_public_alg/ttus_recursive_ttu_public_alg_wildcard_parent_case_1_2",
    "recursive_ttu_public_alg/ttus_recursive_ttu_public_alg_wildcard_parent_case_1_3",
    "recursive_ttu_public_alg/ttus_recursive_ttu_public_alg_wildcard_parent_case_1_4",
    "recursive_ttu_public_alg/ttus_recursive_ttu_public_alg_wildcard_1",
    "recursive_ttu_public_alg/ttus_recursive_ttu_public_alg_not_direct_assign",
    "recursive_ttu_public_alg/any",
    "recursive_ttu_alg_cond/ttus_recursive_ttu_alg_cond_direct_assign",
    "recursive_ttu_alg_cond/ttus_recursive_ttu_alg_cond_parent_case_1_1",
    "recursive_ttu_alg_cond/ttus_recursive_ttu_alg_cond_parent_case_1_2",
    "recursive_ttu_alg_cond/ttus_recursive_ttu_alg_cond_parent_case_1_3",
    "recursive_ttu_alg_cond/ttus_recursive_ttu_alg_cond_parent_case_1_4",
    "recursive_ttu_alg_cond/ttus_recursive_ttu_alg_cond_alg",
    "recursive_ttu_alg_cond/ttus_recursive_ttu_alg_cond_not_assigned",
    "recursive_ttu_alg_cond/other",
    "recursive_ttu_alg_cond/ttus_recursive_ttu_alg_cond_other",
    "multi_branch_recursive_ttu/mr_direct",
    "multi_branch_recursive_ttu/mr_valid",
    "multi_branch_recursive_ttu/mr_parent_1",
    "multi_branch_recursive_ttu/mr_child_1",
    "multi_branch_recursive_ttu/mr_alt_1",
    "multi_branch_recursive_ttu/mr_alt_2",
    "multi_branch_recursive_ttu/mr_invalid",
    "mixed_use/ttus_mixed_use_direct_assign",
    "mixed_use/ttus_mixed_use_direct_assign_level_1",
    "mixed_use/ttus_mixed_use_direct_assign_level_2",
    "mixed_use/ttus_mixed_use_direct_assign_level_3",
    "mixed_use/ttus_mixed_use_direct_assign_should_not_connect",
    "mixed_use/ttus_mixed_use_mixed_use",
    "mixed_use/ttus_mixed_use_mixed_use_side",
    "mixed_use/ttus_mixed_use_mixed_use_level_1",
    "mixed_use/ttus_mixed_use_mixed_use_level_2",
    "mixed_use/ttus_mixed_use_direct_assign_user_not_assigned",
  ],
  "d480",
);

// Written in dependency order: a tupleset relation's config
// exists before the tuple-to-userset that names it, so
// `writeRelationConfig`'s tupleset gates can see it.
const CONFIGS: RelationConfig[] = [
  cfg(DU, "direct", { directlyAssignable: [{ type: USER }] }),
  cfg(DU, "computed", { computedUserset: "direct" }),
  cfg(DU, "direct_wild", {
    directlyAssignable: [{ type: USER, wildcard: true }],
  }),
  cfg(DU, "or_computed_no_cond", { impliedBy: ["computed", "direct_wild"] }),
  cfg(DU, "mixed_use", { computedUserset: "or_computed_no_cond" }),
  cfg(MR, "child", { directlyAssignable: [{ type: MR }] }),
  cfg(MR, "parent", { directlyAssignable: [{ type: MR }] }),
  cfg(MR, "multi_recursive_ttu", {
    directlyAssignable: [{ type: USER }],
    tupleToUserset: [
      { tupleset: "parent", computedUserset: "multi_recursive_ttu" },
      { tupleset: "child", computedUserset: "multi_recursive_ttu" },
    ],
  }),
  cfg(TT, "direct_3", { directlyAssignable: [{ type: USER }] }),
  cfg(TT, "direct_2", {
    directlyAssignable: [{ type: USER }],
    intersection: [
      { type: "direct" },
      { type: "computedUserset", relation: "direct_3" },
    ],
  }),
  cfg(TT, "direct", {
    directlyAssignable: [{ type: USER }],
    impliedBy: ["direct_2"],
  }),
  cfg(TT, "computed", { computedUserset: "direct" }),
  cfg(TT, "direct_4", { directlyAssignable: [{ type: USER }] }),
  cfg(TT, "butnot_computed", {
    computedUserset: "computed",
    excludedBy: "direct_4",
  }),
  cfg(TT, "alg_combined", {
    computedUserset: "butnot_computed",
    excludedBy: "direct_4",
  }),
  cfg(TT, "alg_combined_cond", {
    directlyAssignable: [{ type: USER, condition: XCOND }],
    impliedBy: ["alg_combined"],
  }),
  cfg(TT, "direct_wild", {
    directlyAssignable: [{ type: DU, wildcard: true }],
  }),
  cfg(TT, "mixed_ttu_parent", {
    directlyAssignable: [{ type: TT }, { type: DU }],
  }),
  cfg(TT, "mixed_use", {
    directlyAssignable: [{ type: DU }],
    tupleToUserset: [
      { tupleset: "mixed_ttu_parent", computedUserset: "mixed_use" },
    ],
  }),
  cfg(TT, "ttu_parent", { directlyAssignable: [{ type: TT }] }),
  cfg(TT, "recursive_ttu", {
    directlyAssignable: [{ type: DU }],
    tupleToUserset: [
      { tupleset: "ttu_parent", computedUserset: "recursive_ttu" },
    ],
  }),
  cfg(TT, "recursive_ttu_alg", {
    directlyAssignable: [{ type: DU }],
    impliedBy: ["alg_combined"],
    tupleToUserset: [
      { tupleset: "ttu_parent", computedUserset: "recursive_ttu_alg" },
    ],
  }),
  cfg(TT, "ttu_parent_cond", {
    directlyAssignable: [{ type: TT, condition: XCOND }],
  }),
  cfg(TT, "recursive_ttu_alg_cond", {
    directlyAssignable: [{ type: DU, condition: XCOND }],
    impliedBy: ["alg_combined_cond"],
    tupleToUserset: [
      {
        tupleset: "ttu_parent_cond",
        computedUserset: "recursive_ttu_alg_cond",
      },
    ],
  }),
  cfg(TT, "recursive_ttu_public", {
    directlyAssignable: [{ type: DU }, { type: DU, wildcard: true }],
    tupleToUserset: [
      { tupleset: "ttu_parent", computedUserset: "recursive_ttu_public" },
    ],
  }),
  cfg(TT, "recursive_ttu_public_alg", {
    directlyAssignable: [{ type: DU }, { type: DU, wildcard: true }],
    impliedBy: ["direct_wild"],
    tupleToUserset: [
      { tupleset: "ttu_parent", computedUserset: "recursive_ttu_public_alg" },
    ],
  }),
];

const STAGES: Stage[] = [
  {
    name: "recursive_ttu",
    tuples: [
      {
        objectType: TT,
        objectId: u("recursive_ttu/ttus_recursive_ttu_direct_assign"),
        relation: "recursive_ttu",
        subjectType: DU,
        subjectId: u("recursive_ttu/ttus_recursive_ttu_direct_assign"),
      },
      {
        objectType: TT,
        objectId: u("recursive_ttu/ttus_recursive_ttu_parent_case_1_1"),
        relation: "ttu_parent",
        subjectType: TT,
        subjectId: u("recursive_ttu/ttus_recursive_ttu_direct_assign"),
      },
      {
        objectType: TT,
        objectId: u("recursive_ttu/ttus_recursive_ttu_parent_case_1_2"),
        relation: "ttu_parent",
        subjectType: TT,
        subjectId: u("recursive_ttu/ttus_recursive_ttu_parent_case_1_1"),
      },
      {
        objectType: TT,
        objectId: u("recursive_ttu/ttus_recursive_ttu_parent_case_1_3"),
        relation: "ttu_parent",
        subjectType: TT,
        subjectId: u("recursive_ttu/ttus_recursive_ttu_parent_case_1_2"),
      },
      {
        objectType: TT,
        objectId: u("recursive_ttu/ttus_recursive_ttu_parent_case_1_4"),
        relation: "ttu_parent",
        subjectType: TT,
        subjectId: u("recursive_ttu/ttus_recursive_ttu_parent_case_1_3"),
      },
    ],
    cases: [
      {
        name: "recursive_ttu/recursive_ttu_direct_assigned",
        objectType: TT,
        objectId: u("recursive_ttu/ttus_recursive_ttu_direct_assign"),
        relation: "recursive_ttu",
        subjectType: DU,
        subjectId: u("recursive_ttu/ttus_recursive_ttu_direct_assign"),
        expected: true,
      },
      {
        name: "recursive_ttu/recursive_ttu_not_direct_assigned",
        objectType: TT,
        objectId: u("recursive_ttu/ttus_recursive_ttu_direct_assign"),
        relation: "recursive_ttu",
        subjectType: DU,
        subjectId: u("recursive_ttu/ttus_recursive_ttu_not_direct_assign"),
        expected: false,
      },
      {
        name: "recursive_ttu/recursive_ttu_level_1",
        objectType: TT,
        objectId: u("recursive_ttu/ttus_recursive_ttu_parent_case_1_1"),
        relation: "recursive_ttu",
        subjectType: DU,
        subjectId: u("recursive_ttu/ttus_recursive_ttu_direct_assign"),
        expected: true,
      },
      {
        name: "recursive_ttu/recursive_ttu_not_direct_assigned_level_1",
        objectType: TT,
        objectId: u("recursive_ttu/ttus_recursive_ttu_parent_case_1_1"),
        relation: "recursive_ttu",
        subjectType: DU,
        subjectId: u("recursive_ttu/ttus_recursive_ttu_not_direct_assign"),
        expected: false,
      },
      {
        name: "recursive_ttu/recursive_ttu_level_2",
        objectType: TT,
        objectId: u("recursive_ttu/ttus_recursive_ttu_parent_case_1_2"),
        relation: "recursive_ttu",
        subjectType: DU,
        subjectId: u("recursive_ttu/ttus_recursive_ttu_direct_assign"),
        expected: true,
      },
      {
        name: "recursive_ttu/recursive_ttu_not_direct_assigned_level_2",
        objectType: TT,
        objectId: u("recursive_ttu/ttus_recursive_ttu_parent_case_1_2"),
        relation: "recursive_ttu",
        subjectType: DU,
        subjectId: u("recursive_ttu/ttus_recursive_ttu_not_direct_assign"),
        expected: false,
      },
      {
        name: "recursive_ttu/recursive_ttu_level_3",
        objectType: TT,
        objectId: u("recursive_ttu/ttus_recursive_ttu_parent_case_1_3"),
        relation: "recursive_ttu",
        subjectType: DU,
        subjectId: u("recursive_ttu/ttus_recursive_ttu_direct_assign"),
        expected: true,
      },
      {
        name: "recursive_ttu/recursive_ttu_not_direct_assigned_level_3",
        objectType: TT,
        objectId: u("recursive_ttu/ttus_recursive_ttu_parent_case_1_3"),
        relation: "recursive_ttu",
        subjectType: DU,
        subjectId: u("recursive_ttu/ttus_recursive_ttu_not_direct_assign"),
        expected: false,
      },
      {
        name: "recursive_ttu/recursive_ttu_level_4",
        objectType: TT,
        objectId: u("recursive_ttu/ttus_recursive_ttu_parent_case_1_4"),
        relation: "recursive_ttu",
        subjectType: DU,
        subjectId: u("recursive_ttu/ttus_recursive_ttu_direct_assign"),
        expected: true,
      },
      {
        name: "recursive_ttu/recursive_ttu_not_direct_assigned_level_4",
        objectType: TT,
        objectId: u("recursive_ttu/ttus_recursive_ttu_parent_case_1_4"),
        relation: "recursive_ttu",
        subjectType: DU,
        subjectId: u("recursive_ttu/ttus_recursive_ttu_not_direct_assign"),
        expected: false,
      },
    ],
  },
  {
    name: "recursive_ttu_alg",
    tuples: [
      {
        objectType: TT,
        objectId: u("recursive_ttu_alg/ttus_recursive_ttu_alg_direct_assign"),
        relation: "recursive_ttu_alg",
        subjectType: DU,
        subjectId: u("recursive_ttu_alg/ttus_recursive_ttu_alg_direct_assign"),
      },
      {
        objectType: TT,
        objectId: u("recursive_ttu_alg/ttus_recursive_ttu_alg_parent_case_1_1"),
        relation: "ttu_parent",
        subjectType: TT,
        subjectId: u("recursive_ttu_alg/ttus_recursive_ttu_alg_direct_assign"),
      },
      {
        objectType: TT,
        objectId: u("recursive_ttu_alg/ttus_recursive_ttu_alg_parent_case_1_2"),
        relation: "ttu_parent",
        subjectType: TT,
        subjectId: u(
          "recursive_ttu_alg/ttus_recursive_ttu_alg_parent_case_1_1",
        ),
      },
      {
        objectType: TT,
        objectId: u("recursive_ttu_alg/ttus_recursive_ttu_alg_parent_case_1_3"),
        relation: "ttu_parent",
        subjectType: TT,
        subjectId: u(
          "recursive_ttu_alg/ttus_recursive_ttu_alg_parent_case_1_2",
        ),
      },
      {
        objectType: TT,
        objectId: u("recursive_ttu_alg/ttus_recursive_ttu_alg_parent_case_1_4"),
        relation: "ttu_parent",
        subjectType: TT,
        subjectId: u(
          "recursive_ttu_alg/ttus_recursive_ttu_alg_parent_case_1_3",
        ),
      },
      {
        objectType: TT,
        objectId: u("recursive_ttu_alg/ttus_recursive_ttu_alg_alg_case_1"),
        relation: "direct_3",
        subjectType: USER,
        subjectId: u("recursive_ttu_alg/ttus_recursive_ttu_alg_user_1"),
      },
      {
        objectType: TT,
        objectId: u("recursive_ttu_alg/ttus_recursive_ttu_alg_alg_case_1"),
        relation: "direct_2",
        subjectType: USER,
        subjectId: u("recursive_ttu_alg/ttus_recursive_ttu_alg_user_1"),
      },
      {
        objectType: TT,
        objectId: u("recursive_ttu_alg/ttus_recursive_ttu_alg_alg_case_2"),
        relation: "direct_3",
        subjectType: USER,
        subjectId: u("recursive_ttu_alg/ttus_recursive_ttu_alg_user_2"),
      },
      {
        objectType: TT,
        objectId: u("recursive_ttu_alg/ttus_recursive_ttu_alg_alg_case_2"),
        relation: "direct_2",
        subjectType: USER,
        subjectId: u("recursive_ttu_alg/ttus_recursive_ttu_alg_user_2"),
      },
      {
        objectType: TT,
        objectId: u("recursive_ttu_alg/ttus_recursive_ttu_alg_alg_case_2"),
        relation: "direct_4",
        subjectType: USER,
        subjectId: u("recursive_ttu_alg/ttus_recursive_ttu_alg_user_2"),
      },
    ],
    cases: [
      {
        name: "recursive_ttu_alg/recursive_ttu_alg_direct_assigned",
        objectType: TT,
        objectId: u("recursive_ttu_alg/ttus_recursive_ttu_alg_direct_assign"),
        relation: "recursive_ttu_alg",
        subjectType: DU,
        subjectId: u("recursive_ttu_alg/ttus_recursive_ttu_alg_direct_assign"),
        expected: true,
      },
      {
        name: "recursive_ttu_alg/recursive_ttu_alg_not_direct_assigned",
        objectType: TT,
        objectId: u("recursive_ttu_alg/ttus_recursive_ttu_alg_direct_assign"),
        relation: "recursive_ttu_alg",
        subjectType: DU,
        subjectId: u(
          "recursive_ttu_alg/ttus_recursive_ttu_alg_not_direct_assign",
        ),
        expected: false,
      },
      {
        name: "recursive_ttu_alg/recursive_ttu_alg_level_1",
        objectType: TT,
        objectId: u("recursive_ttu_alg/ttus_recursive_ttu_alg_parent_case_1_1"),
        relation: "recursive_ttu_alg",
        subjectType: DU,
        subjectId: u("recursive_ttu_alg/ttus_recursive_ttu_alg_direct_assign"),
        expected: true,
      },
      {
        name: "recursive_ttu_alg/recursive_ttu_alg_not_direct_assigned_level_1",
        objectType: TT,
        objectId: u("recursive_ttu_alg/ttus_recursive_ttu_alg_parent_case_1_1"),
        relation: "recursive_ttu_alg",
        subjectType: DU,
        subjectId: u(
          "recursive_ttu_alg/ttus_recursive_ttu_alg_not_direct_assign",
        ),
        expected: false,
      },
      {
        name: "recursive_ttu_alg/recursive_ttu_alg_level_2",
        objectType: TT,
        objectId: u("recursive_ttu_alg/ttus_recursive_ttu_alg_parent_case_1_2"),
        relation: "recursive_ttu_alg",
        subjectType: DU,
        subjectId: u("recursive_ttu_alg/ttus_recursive_ttu_alg_direct_assign"),
        expected: true,
      },
      {
        name: "recursive_ttu_alg/recursive_ttu_alg_not_direct_assigned_level_2",
        objectType: TT,
        objectId: u("recursive_ttu_alg/ttus_recursive_ttu_alg_parent_case_1_2"),
        relation: "recursive_ttu_alg",
        subjectType: DU,
        subjectId: u(
          "recursive_ttu_alg/ttus_recursive_ttu_alg_not_direct_assign",
        ),
        expected: false,
      },
      {
        name: "recursive_ttu_alg/recursive_ttu_alg_level_3",
        objectType: TT,
        objectId: u("recursive_ttu_alg/ttus_recursive_ttu_alg_parent_case_1_3"),
        relation: "recursive_ttu_alg",
        subjectType: DU,
        subjectId: u("recursive_ttu_alg/ttus_recursive_ttu_alg_direct_assign"),
        expected: true,
      },
      {
        name: "recursive_ttu_alg/recursive_ttu_alg_not_direct_assigned_level_3",
        objectType: TT,
        objectId: u("recursive_ttu_alg/ttus_recursive_ttu_alg_parent_case_1_3"),
        relation: "recursive_ttu_alg",
        subjectType: DU,
        subjectId: u(
          "recursive_ttu_alg/ttus_recursive_ttu_alg_not_direct_assign",
        ),
        expected: false,
      },
      {
        name: "recursive_ttu_alg/recursive_ttu_alg_level_4",
        objectType: TT,
        objectId: u("recursive_ttu_alg/ttus_recursive_ttu_alg_parent_case_1_4"),
        relation: "recursive_ttu_alg",
        subjectType: DU,
        subjectId: u("recursive_ttu_alg/ttus_recursive_ttu_alg_direct_assign"),
        expected: true,
      },
      {
        name: "recursive_ttu_alg/recursive_ttu_alg_not_direct_assigned_level_4",
        objectType: TT,
        objectId: u("recursive_ttu_alg/ttus_recursive_ttu_alg_parent_case_1_4"),
        relation: "recursive_ttu_alg",
        subjectType: DU,
        subjectId: u(
          "recursive_ttu_alg/ttus_recursive_ttu_alg_not_direct_assign",
        ),
        expected: false,
      },
      {
        name: "recursive_ttu_alg/valid_user_alg",
        objectType: TT,
        objectId: u("recursive_ttu_alg/ttus_recursive_ttu_alg_alg_case_1"),
        relation: "recursive_ttu_alg",
        subjectType: USER,
        subjectId: u("recursive_ttu_alg/ttus_recursive_ttu_alg_user_1"),
        expected: true,
      },
      {
        name: "recursive_ttu_alg/valid_user_alg_butnot_denied",
        objectType: TT,
        objectId: u("recursive_ttu_alg/ttus_recursive_ttu_alg_alg_case_2"),
        relation: "recursive_ttu_alg",
        subjectType: USER,
        subjectId: u("recursive_ttu_alg/ttus_recursive_ttu_alg_user_2"),
        expected: false,
      },
    ],
  },
  {
    name: "recursive_ttu_public",
    tuples: [
      {
        objectType: TT,
        objectId: u(
          "recursive_ttu_public/ttus_recursive_ttu_public_direct_assign",
        ),
        relation: "recursive_ttu_public",
        subjectType: DU,
        subjectId: u(
          "recursive_ttu_public/ttus_recursive_ttu_public_direct_assign",
        ),
      },
      {
        objectType: TT,
        objectId: u(
          "recursive_ttu_public/ttus_recursive_ttu_public_parent_case_1_1",
        ),
        relation: "ttu_parent",
        subjectType: TT,
        subjectId: u(
          "recursive_ttu_public/ttus_recursive_ttu_public_direct_assign",
        ),
      },
      {
        objectType: TT,
        objectId: u(
          "recursive_ttu_public/ttus_recursive_ttu_public_parent_case_1_2",
        ),
        relation: "ttu_parent",
        subjectType: TT,
        subjectId: u(
          "recursive_ttu_public/ttus_recursive_ttu_public_parent_case_1_1",
        ),
      },
      {
        objectType: TT,
        objectId: u(
          "recursive_ttu_public/ttus_recursive_ttu_public_parent_case_1_3",
        ),
        relation: "ttu_parent",
        subjectType: TT,
        subjectId: u(
          "recursive_ttu_public/ttus_recursive_ttu_public_parent_case_1_2",
        ),
      },
      {
        objectType: TT,
        objectId: u(
          "recursive_ttu_public/ttus_recursive_ttu_public_parent_case_1_4",
        ),
        relation: "ttu_parent",
        subjectType: TT,
        subjectId: u(
          "recursive_ttu_public/ttus_recursive_ttu_public_parent_case_1_3",
        ),
      },
      {
        objectType: TT,
        objectId: u("recursive_ttu_public/ttus_recursive_ttu_public_wildcard"),
        relation: "recursive_ttu_public",
        subjectType: DU,
        subjectId: "*",
      },
      {
        objectType: TT,
        objectId: u(
          "recursive_ttu_public/ttus_recursive_ttu_public_wildcard_parent_case_1_1",
        ),
        relation: "ttu_parent",
        subjectType: TT,
        subjectId: u("recursive_ttu_public/ttus_recursive_ttu_public_wildcard"),
      },
      {
        objectType: TT,
        objectId: u(
          "recursive_ttu_public/ttus_recursive_ttu_public_wildcard_parent_case_1_2",
        ),
        relation: "ttu_parent",
        subjectType: TT,
        subjectId: u(
          "recursive_ttu_public/ttus_recursive_ttu_public_wildcard_parent_case_1_1",
        ),
      },
      {
        objectType: TT,
        objectId: u(
          "recursive_ttu_public/ttus_recursive_ttu_public_wildcard_parent_case_1_3",
        ),
        relation: "ttu_parent",
        subjectType: TT,
        subjectId: u(
          "recursive_ttu_public/ttus_recursive_ttu_public_wildcard_parent_case_1_2",
        ),
      },
      {
        objectType: TT,
        objectId: u(
          "recursive_ttu_public/ttus_recursive_ttu_public_wildcard_parent_case_1_4",
        ),
        relation: "ttu_parent",
        subjectType: TT,
        subjectId: u(
          "recursive_ttu_public/ttus_recursive_ttu_public_wildcard_parent_case_1_3",
        ),
      },
    ],
    cases: [
      {
        name: "recursive_ttu_public/recursive_ttu_direct_assigned",
        objectType: TT,
        objectId: u(
          "recursive_ttu_public/ttus_recursive_ttu_public_direct_assign",
        ),
        relation: "recursive_ttu_public",
        subjectType: DU,
        subjectId: u(
          "recursive_ttu_public/ttus_recursive_ttu_public_direct_assign",
        ),
        expected: true,
      },
      {
        name: "recursive_ttu_public/recursive_ttu_not_direct_assigned",
        objectType: TT,
        objectId: u(
          "recursive_ttu_public/ttus_recursive_ttu_public_direct_assign",
        ),
        relation: "recursive_ttu_public",
        subjectType: DU,
        subjectId: u(
          "recursive_ttu_public/ttus_recursive_ttu_public_not_direct_assign",
        ),
        expected: false,
      },
      {
        name: "recursive_ttu_public/recursive_ttu_level_1",
        objectType: TT,
        objectId: u(
          "recursive_ttu_public/ttus_recursive_ttu_public_parent_case_1_1",
        ),
        relation: "recursive_ttu_public",
        subjectType: DU,
        subjectId: u(
          "recursive_ttu_public/ttus_recursive_ttu_public_direct_assign",
        ),
        expected: true,
      },
      {
        name: "recursive_ttu_public/recursive_ttu_not_direct_assigned_level_1",
        objectType: TT,
        objectId: u(
          "recursive_ttu_public/ttus_recursive_ttu_public_parent_case_1_1",
        ),
        relation: "recursive_ttu_public",
        subjectType: DU,
        subjectId: u(
          "recursive_ttu_public/ttus_recursive_ttu_public_not_direct_assign",
        ),
        expected: false,
      },
      {
        name: "recursive_ttu_public/recursive_ttu_level_2",
        objectType: TT,
        objectId: u(
          "recursive_ttu_public/ttus_recursive_ttu_public_parent_case_1_2",
        ),
        relation: "recursive_ttu_public",
        subjectType: DU,
        subjectId: u(
          "recursive_ttu_public/ttus_recursive_ttu_public_direct_assign",
        ),
        expected: true,
      },
      {
        name: "recursive_ttu_public/recursive_ttu_not_direct_assigned_level_2",
        objectType: TT,
        objectId: u(
          "recursive_ttu_public/ttus_recursive_ttu_public_parent_case_1_2",
        ),
        relation: "recursive_ttu_public",
        subjectType: DU,
        subjectId: u(
          "recursive_ttu_public/ttus_recursive_ttu_public_not_direct_assign",
        ),
        expected: false,
      },
      {
        name: "recursive_ttu_public/recursive_ttu_level_3",
        objectType: TT,
        objectId: u(
          "recursive_ttu_public/ttus_recursive_ttu_public_parent_case_1_3",
        ),
        relation: "recursive_ttu_public",
        subjectType: DU,
        subjectId: u(
          "recursive_ttu_public/ttus_recursive_ttu_public_direct_assign",
        ),
        expected: true,
      },
      {
        name: "recursive_ttu_public/recursive_ttu_not_direct_assigned_level_3",
        objectType: TT,
        objectId: u(
          "recursive_ttu_public/ttus_recursive_ttu_public_parent_case_1_3",
        ),
        relation: "recursive_ttu_public",
        subjectType: DU,
        subjectId: u(
          "recursive_ttu_public/ttus_recursive_ttu_public_not_direct_assign",
        ),
        expected: false,
      },
      {
        name: "recursive_ttu_public/recursive_ttu_level_4",
        objectType: TT,
        objectId: u(
          "recursive_ttu_public/ttus_recursive_ttu_public_parent_case_1_4",
        ),
        relation: "recursive_ttu_public",
        subjectType: DU,
        subjectId: u(
          "recursive_ttu_public/ttus_recursive_ttu_public_direct_assign",
        ),
        expected: true,
      },
      {
        name: "recursive_ttu_public/recursive_ttu_not_direct_assigned_level_4",
        objectType: TT,
        objectId: u(
          "recursive_ttu_public/ttus_recursive_ttu_public_parent_case_1_4",
        ),
        relation: "recursive_ttu_public",
        subjectType: DU,
        subjectId: u(
          "recursive_ttu_public/ttus_recursive_ttu_public_not_direct_assign",
        ),
        expected: false,
      },
      {
        name: "recursive_ttu_public/recursive_ttu_public_wildcard",
        objectType: TT,
        objectId: u("recursive_ttu_public/ttus_recursive_ttu_public_wildcard"),
        relation: "recursive_ttu_public",
        subjectType: DU,
        subjectId: u("recursive_ttu_public/any"),
        expected: true,
      },
      {
        name: "recursive_ttu_public/recursive_ttu_public_wildcard_level_1",
        objectType: TT,
        objectId: u(
          "recursive_ttu_public/ttus_recursive_ttu_public_wildcard_parent_case_1_1",
        ),
        relation: "recursive_ttu_public",
        subjectType: DU,
        subjectId: u("recursive_ttu_public/any"),
        expected: true,
      },
      {
        name: "recursive_ttu_public/recursive_ttu_public_wildcard_level_2",
        objectType: TT,
        objectId: u(
          "recursive_ttu_public/ttus_recursive_ttu_public_wildcard_parent_case_1_2",
        ),
        relation: "recursive_ttu_public",
        subjectType: DU,
        subjectId: u("recursive_ttu_public/any"),
        expected: true,
      },
      {
        name: "recursive_ttu_public/recursive_ttu_public_wildcard_level_3",
        objectType: TT,
        objectId: u(
          "recursive_ttu_public/ttus_recursive_ttu_public_wildcard_parent_case_1_3",
        ),
        relation: "recursive_ttu_public",
        subjectType: DU,
        subjectId: u("recursive_ttu_public/any"),
        expected: true,
      },
      {
        name: "recursive_ttu_public/recursive_ttu_public_wildcard_level_4",
        objectType: TT,
        objectId: u(
          "recursive_ttu_public/ttus_recursive_ttu_public_wildcard_parent_case_1_4",
        ),
        relation: "recursive_ttu_public",
        subjectType: DU,
        subjectId: u("recursive_ttu_public/any"),
        expected: true,
      },
    ],
  },
  {
    name: "recursive_ttu_public_alg",
    tuples: [
      {
        objectType: TT,
        objectId: u(
          "recursive_ttu_public_alg/ttus_recursive_ttu_public_alg_direct_assign",
        ),
        relation: "recursive_ttu_public_alg",
        subjectType: DU,
        subjectId: u(
          "recursive_ttu_public_alg/ttus_recursive_ttu_public_alg_direct_assign",
        ),
      },
      {
        objectType: TT,
        objectId: u(
          "recursive_ttu_public_alg/ttus_recursive_ttu_public_alg_parent_case_1_1",
        ),
        relation: "ttu_parent",
        subjectType: TT,
        subjectId: u(
          "recursive_ttu_public_alg/ttus_recursive_ttu_public_alg_direct_assign",
        ),
      },
      {
        objectType: TT,
        objectId: u(
          "recursive_ttu_public_alg/ttus_recursive_ttu_public_alg_parent_case_1_2",
        ),
        relation: "ttu_parent",
        subjectType: TT,
        subjectId: u(
          "recursive_ttu_public_alg/ttus_recursive_ttu_public_alg_parent_case_1_1",
        ),
      },
      {
        objectType: TT,
        objectId: u(
          "recursive_ttu_public_alg/ttus_recursive_ttu_public_alg_parent_case_1_3",
        ),
        relation: "ttu_parent",
        subjectType: TT,
        subjectId: u(
          "recursive_ttu_public_alg/ttus_recursive_ttu_public_alg_parent_case_1_2",
        ),
      },
      {
        objectType: TT,
        objectId: u(
          "recursive_ttu_public_alg/ttus_recursive_ttu_public_alg_parent_case_1_4",
        ),
        relation: "ttu_parent",
        subjectType: TT,
        subjectId: u(
          "recursive_ttu_public_alg/ttus_recursive_ttu_public_alg_parent_case_1_3",
        ),
      },
      {
        objectType: TT,
        objectId: u(
          "recursive_ttu_public_alg/ttus_recursive_ttu_public_alg_wildcard",
        ),
        relation: "recursive_ttu_public_alg",
        subjectType: DU,
        subjectId: "*",
      },
      {
        objectType: TT,
        objectId: u(
          "recursive_ttu_public_alg/ttus_recursive_ttu_public_alg_wildcard_parent_case_1_1",
        ),
        relation: "ttu_parent",
        subjectType: TT,
        subjectId: u(
          "recursive_ttu_public_alg/ttus_recursive_ttu_public_alg_wildcard",
        ),
      },
      {
        objectType: TT,
        objectId: u(
          "recursive_ttu_public_alg/ttus_recursive_ttu_public_alg_wildcard_parent_case_1_2",
        ),
        relation: "ttu_parent",
        subjectType: TT,
        subjectId: u(
          "recursive_ttu_public_alg/ttus_recursive_ttu_public_alg_wildcard_parent_case_1_1",
        ),
      },
      {
        objectType: TT,
        objectId: u(
          "recursive_ttu_public_alg/ttus_recursive_ttu_public_alg_wildcard_parent_case_1_3",
        ),
        relation: "ttu_parent",
        subjectType: TT,
        subjectId: u(
          "recursive_ttu_public_alg/ttus_recursive_ttu_public_alg_wildcard_parent_case_1_2",
        ),
      },
      {
        objectType: TT,
        objectId: u(
          "recursive_ttu_public_alg/ttus_recursive_ttu_public_alg_wildcard_parent_case_1_4",
        ),
        relation: "ttu_parent",
        subjectType: TT,
        subjectId: u(
          "recursive_ttu_public_alg/ttus_recursive_ttu_public_alg_wildcard_parent_case_1_3",
        ),
      },
      {
        objectType: TT,
        objectId: u(
          "recursive_ttu_public_alg/ttus_recursive_ttu_public_alg_wildcard_1",
        ),
        relation: "direct_wild",
        subjectType: DU,
        subjectId: "*",
      },
    ],
    cases: [
      {
        name: "recursive_ttu_public_alg/recursive_ttu_direct_assigned",
        objectType: TT,
        objectId: u(
          "recursive_ttu_public_alg/ttus_recursive_ttu_public_alg_direct_assign",
        ),
        relation: "recursive_ttu_public_alg",
        subjectType: DU,
        subjectId: u(
          "recursive_ttu_public_alg/ttus_recursive_ttu_public_alg_direct_assign",
        ),
        expected: true,
      },
      {
        name: "recursive_ttu_public_alg/recursive_ttu_not_direct_assigned",
        objectType: TT,
        objectId: u(
          "recursive_ttu_public_alg/ttus_recursive_ttu_public_alg_direct_assign",
        ),
        relation: "recursive_ttu_public_alg",
        subjectType: DU,
        subjectId: u(
          "recursive_ttu_public_alg/ttus_recursive_ttu_public_alg_not_direct_assign",
        ),
        expected: false,
      },
      {
        name: "recursive_ttu_public_alg/recursive_ttu_level_1",
        objectType: TT,
        objectId: u(
          "recursive_ttu_public_alg/ttus_recursive_ttu_public_alg_parent_case_1_1",
        ),
        relation: "recursive_ttu_public_alg",
        subjectType: DU,
        subjectId: u(
          "recursive_ttu_public_alg/ttus_recursive_ttu_public_alg_direct_assign",
        ),
        expected: true,
      },
      {
        name: "recursive_ttu_public_alg/recursive_ttu_not_direct_assigned_level_1",
        objectType: TT,
        objectId: u(
          "recursive_ttu_public_alg/ttus_recursive_ttu_public_alg_parent_case_1_1",
        ),
        relation: "recursive_ttu_public_alg",
        subjectType: DU,
        subjectId: u(
          "recursive_ttu_public_alg/ttus_recursive_ttu_public_alg_not_direct_assign",
        ),
        expected: false,
      },
      {
        name: "recursive_ttu_public_alg/recursive_ttu_level_2",
        objectType: TT,
        objectId: u(
          "recursive_ttu_public_alg/ttus_recursive_ttu_public_alg_parent_case_1_2",
        ),
        relation: "recursive_ttu_public_alg",
        subjectType: DU,
        subjectId: u(
          "recursive_ttu_public_alg/ttus_recursive_ttu_public_alg_direct_assign",
        ),
        expected: true,
      },
      {
        name: "recursive_ttu_public_alg/recursive_ttu_not_direct_assigned_level_2",
        objectType: TT,
        objectId: u(
          "recursive_ttu_public_alg/ttus_recursive_ttu_public_alg_parent_case_1_2",
        ),
        relation: "recursive_ttu_public_alg",
        subjectType: DU,
        subjectId: u(
          "recursive_ttu_public_alg/ttus_recursive_ttu_public_alg_not_direct_assign",
        ),
        expected: false,
      },
      {
        name: "recursive_ttu_public_alg/recursive_ttu_level_3",
        objectType: TT,
        objectId: u(
          "recursive_ttu_public_alg/ttus_recursive_ttu_public_alg_parent_case_1_3",
        ),
        relation: "recursive_ttu_public_alg",
        subjectType: DU,
        subjectId: u(
          "recursive_ttu_public_alg/ttus_recursive_ttu_public_alg_direct_assign",
        ),
        expected: true,
      },
      {
        name: "recursive_ttu_public_alg/recursive_ttu_not_direct_assigned_level_3",
        objectType: TT,
        objectId: u(
          "recursive_ttu_public_alg/ttus_recursive_ttu_public_alg_parent_case_1_3",
        ),
        relation: "recursive_ttu_public_alg",
        subjectType: DU,
        subjectId: u(
          "recursive_ttu_public_alg/ttus_recursive_ttu_public_alg_not_direct_assign",
        ),
        expected: false,
      },
      {
        name: "recursive_ttu_public_alg/recursive_ttu_level_4",
        objectType: TT,
        objectId: u(
          "recursive_ttu_public_alg/ttus_recursive_ttu_public_alg_parent_case_1_4",
        ),
        relation: "recursive_ttu_public_alg",
        subjectType: DU,
        subjectId: u(
          "recursive_ttu_public_alg/ttus_recursive_ttu_public_alg_direct_assign",
        ),
        expected: true,
      },
      {
        name: "recursive_ttu_public_alg/recursive_ttu_not_direct_assigned_level_4",
        objectType: TT,
        objectId: u(
          "recursive_ttu_public_alg/ttus_recursive_ttu_public_alg_parent_case_1_4",
        ),
        relation: "recursive_ttu_public_alg",
        subjectType: DU,
        subjectId: u(
          "recursive_ttu_public_alg/ttus_recursive_ttu_public_alg_not_direct_assign",
        ),
        expected: false,
      },
      {
        name: "recursive_ttu_public_alg/recursive_ttu_public_alg_wildcard",
        objectType: TT,
        objectId: u(
          "recursive_ttu_public_alg/ttus_recursive_ttu_public_alg_wildcard",
        ),
        relation: "recursive_ttu_public_alg",
        subjectType: DU,
        subjectId: u("recursive_ttu_public_alg/any"),
        expected: true,
      },
      {
        name: "recursive_ttu_public_alg/recursive_ttu_public_alg_wildcard_level_1",
        objectType: TT,
        objectId: u(
          "recursive_ttu_public_alg/ttus_recursive_ttu_public_alg_wildcard_parent_case_1_1",
        ),
        relation: "recursive_ttu_public_alg",
        subjectType: DU,
        subjectId: u("recursive_ttu_public_alg/any"),
        expected: true,
      },
      {
        name: "recursive_ttu_public_alg/recursive_ttu_public_alg_wildcard_level_2",
        objectType: TT,
        objectId: u(
          "recursive_ttu_public_alg/ttus_recursive_ttu_public_alg_wildcard_parent_case_1_2",
        ),
        relation: "recursive_ttu_public_alg",
        subjectType: DU,
        subjectId: u("recursive_ttu_public_alg/any"),
        expected: true,
      },
      {
        name: "recursive_ttu_public_alg/recursive_ttu_public_alg_wildcard_level_3",
        objectType: TT,
        objectId: u(
          "recursive_ttu_public_alg/ttus_recursive_ttu_public_alg_wildcard_parent_case_1_3",
        ),
        relation: "recursive_ttu_public_alg",
        subjectType: DU,
        subjectId: u("recursive_ttu_public_alg/any"),
        expected: true,
      },
      {
        name: "recursive_ttu_public_alg/recursive_ttu_public_alg_wildcard_level_4",
        objectType: TT,
        objectId: u(
          "recursive_ttu_public_alg/ttus_recursive_ttu_public_alg_wildcard_parent_case_1_4",
        ),
        relation: "recursive_ttu_public_alg",
        subjectType: DU,
        subjectId: u("recursive_ttu_public_alg/any"),
        expected: true,
      },
      {
        name: "recursive_ttu_public_alg/recursive_ttu_public_alg_wild",
        objectType: TT,
        objectId: u(
          "recursive_ttu_public_alg/ttus_recursive_ttu_public_alg_wildcard_1",
        ),
        relation: "recursive_ttu_public_alg",
        subjectType: DU,
        subjectId: u("recursive_ttu_public_alg/any"),
        expected: true,
      },
    ],
  },
  {
    name: "recursive_ttu_alg_cond",
    tuples: [
      {
        objectType: TT,
        objectId: u(
          "recursive_ttu_alg_cond/ttus_recursive_ttu_alg_cond_direct_assign",
        ),
        relation: "recursive_ttu_alg_cond",
        subjectType: DU,
        subjectId: u(
          "recursive_ttu_alg_cond/ttus_recursive_ttu_alg_cond_direct_assign",
        ),
        conditionName: XCOND,
      },
      {
        objectType: TT,
        objectId: u(
          "recursive_ttu_alg_cond/ttus_recursive_ttu_alg_cond_parent_case_1_1",
        ),
        relation: "ttu_parent_cond",
        subjectType: TT,
        subjectId: u(
          "recursive_ttu_alg_cond/ttus_recursive_ttu_alg_cond_direct_assign",
        ),
        conditionName: XCOND,
      },
      {
        objectType: TT,
        objectId: u(
          "recursive_ttu_alg_cond/ttus_recursive_ttu_alg_cond_parent_case_1_2",
        ),
        relation: "ttu_parent_cond",
        subjectType: TT,
        subjectId: u(
          "recursive_ttu_alg_cond/ttus_recursive_ttu_alg_cond_parent_case_1_1",
        ),
        conditionName: XCOND,
      },
      {
        objectType: TT,
        objectId: u(
          "recursive_ttu_alg_cond/ttus_recursive_ttu_alg_cond_parent_case_1_3",
        ),
        relation: "ttu_parent_cond",
        subjectType: TT,
        subjectId: u(
          "recursive_ttu_alg_cond/ttus_recursive_ttu_alg_cond_parent_case_1_2",
        ),
        conditionName: XCOND,
      },
      {
        objectType: TT,
        objectId: u(
          "recursive_ttu_alg_cond/ttus_recursive_ttu_alg_cond_parent_case_1_4",
        ),
        relation: "ttu_parent_cond",
        subjectType: TT,
        subjectId: u(
          "recursive_ttu_alg_cond/ttus_recursive_ttu_alg_cond_parent_case_1_3",
        ),
        conditionName: XCOND,
      },
      {
        objectType: TT,
        objectId: u("recursive_ttu_alg_cond/ttus_recursive_ttu_alg_cond_alg"),
        relation: "alg_combined_cond",
        subjectType: USER,
        subjectId: u("recursive_ttu_alg_cond/ttus_recursive_ttu_alg_cond_alg"),
        conditionName: XCOND,
      },
    ],
    cases: [
      {
        name: "recursive_ttu_alg_cond/recursive_ttu_direct_assigned",
        objectType: TT,
        objectId: u(
          "recursive_ttu_alg_cond/ttus_recursive_ttu_alg_cond_direct_assign",
        ),
        relation: "recursive_ttu_alg_cond",
        subjectType: DU,
        subjectId: u(
          "recursive_ttu_alg_cond/ttus_recursive_ttu_alg_cond_direct_assign",
        ),
        context: { x: "1" },
        expected: true,
      },
      {
        name: "recursive_ttu_alg_cond/recursive_ttu_direct_user_not_assigned",
        objectType: TT,
        objectId: u(
          "recursive_ttu_alg_cond/ttus_recursive_ttu_alg_cond_direct_assign",
        ),
        relation: "recursive_ttu_alg_cond",
        subjectType: DU,
        subjectId: u(
          "recursive_ttu_alg_cond/ttus_recursive_ttu_alg_cond_not_assigned",
        ),
        context: { x: "1" },
        expected: false,
      },
      {
        name: "recursive_ttu_alg_cond/recursive_ttu_direct_obj_not_assigned",
        objectType: TT,
        objectId: u("recursive_ttu_alg_cond/other"),
        relation: "recursive_ttu_alg_cond",
        subjectType: DU,
        subjectId: u(
          "recursive_ttu_alg_cond/ttus_recursive_ttu_alg_cond_direct_assign",
        ),
        context: { x: "1" },
        expected: false,
      },
      {
        name: "recursive_ttu_alg_cond/recursive_ttu_direct_assigned_false_cond",
        objectType: TT,
        objectId: u(
          "recursive_ttu_alg_cond/ttus_recursive_ttu_alg_cond_direct_assign",
        ),
        relation: "recursive_ttu_alg_cond",
        subjectType: DU,
        subjectId: u(
          "recursive_ttu_alg_cond/ttus_recursive_ttu_alg_cond_direct_assign",
        ),
        context: { x: "2" },
        expected: false,
      },
      {
        name: "recursive_ttu_alg_cond/recursive_ttu_level_1",
        objectType: TT,
        objectId: u(
          "recursive_ttu_alg_cond/ttus_recursive_ttu_alg_cond_parent_case_1_1",
        ),
        relation: "recursive_ttu_alg_cond",
        subjectType: DU,
        subjectId: u(
          "recursive_ttu_alg_cond/ttus_recursive_ttu_alg_cond_direct_assign",
        ),
        context: { x: "1" },
        expected: true,
      },
      {
        name: "recursive_ttu_alg_cond/recursive_ttu_level_1_cond_not_met",
        objectType: TT,
        objectId: u(
          "recursive_ttu_alg_cond/ttus_recursive_ttu_alg_cond_parent_case_1_1",
        ),
        relation: "recursive_ttu_alg_cond",
        subjectType: DU,
        subjectId: u(
          "recursive_ttu_alg_cond/ttus_recursive_ttu_alg_cond_direct_assign",
        ),
        context: { x: "2" },
        expected: false,
      },
      {
        name: "recursive_ttu_alg_cond/recursive_ttu_level_1_not_assigned",
        objectType: TT,
        objectId: u(
          "recursive_ttu_alg_cond/ttus_recursive_ttu_alg_cond_parent_case_1_1",
        ),
        relation: "recursive_ttu_alg_cond",
        subjectType: DU,
        subjectId: u(
          "recursive_ttu_alg_cond/ttus_recursive_ttu_alg_cond_other",
        ),
        context: { x: "1" },
        expected: false,
      },
      {
        name: "recursive_ttu_alg_cond/recursive_ttu_level_4",
        objectType: TT,
        objectId: u(
          "recursive_ttu_alg_cond/ttus_recursive_ttu_alg_cond_parent_case_1_4",
        ),
        relation: "recursive_ttu_alg_cond",
        subjectType: DU,
        subjectId: u(
          "recursive_ttu_alg_cond/ttus_recursive_ttu_alg_cond_direct_assign",
        ),
        context: { x: "1" },
        expected: true,
      },
      {
        name: "recursive_ttu_alg_cond/recursive_ttu_level_4_cond_not_met",
        objectType: TT,
        objectId: u(
          "recursive_ttu_alg_cond/ttus_recursive_ttu_alg_cond_parent_case_1_4",
        ),
        relation: "recursive_ttu_alg_cond",
        subjectType: DU,
        subjectId: u(
          "recursive_ttu_alg_cond/ttus_recursive_ttu_alg_cond_direct_assign",
        ),
        context: { x: "2" },
        expected: false,
      },
      {
        name: "recursive_ttu_alg_cond/recursive_ttu_level_4_not_assigned",
        objectType: TT,
        objectId: u(
          "recursive_ttu_alg_cond/ttus_recursive_ttu_alg_cond_parent_case_1_4",
        ),
        relation: "recursive_ttu_alg_cond",
        subjectType: DU,
        subjectId: u(
          "recursive_ttu_alg_cond/ttus_recursive_ttu_alg_cond_other",
        ),
        context: { x: "1" },
        expected: false,
      },
      {
        name: "recursive_ttu_alg_cond/recursive_ttu_direct_alg",
        objectType: TT,
        objectId: u("recursive_ttu_alg_cond/ttus_recursive_ttu_alg_cond_alg"),
        relation: "recursive_ttu_alg_cond",
        subjectType: USER,
        subjectId: u("recursive_ttu_alg_cond/ttus_recursive_ttu_alg_cond_alg"),
        context: { x: "1" },
        expected: true,
      },
      {
        name: "recursive_ttu_alg_cond/recursive_ttu_direct_alg_bad_cond",
        objectType: TT,
        objectId: u("recursive_ttu_alg_cond/ttus_recursive_ttu_alg_cond_alg"),
        relation: "recursive_ttu_alg_cond",
        subjectType: USER,
        subjectId: u("recursive_ttu_alg_cond/ttus_recursive_ttu_alg_cond_alg"),
        context: { x: "2" },
        expected: false,
      },
    ],
  },
  {
    name: "multi_branch_recursive_ttu",
    tuples: [
      {
        objectType: MR,
        objectId: u("multi_branch_recursive_ttu/mr_direct"),
        relation: "multi_recursive_ttu",
        subjectType: USER,
        subjectId: u("multi_branch_recursive_ttu/mr_valid"),
      },
      {
        objectType: MR,
        objectId: u("multi_branch_recursive_ttu/mr_parent_1"),
        relation: "parent",
        subjectType: MR,
        subjectId: u("multi_branch_recursive_ttu/mr_direct"),
      },
      {
        objectType: MR,
        objectId: u("multi_branch_recursive_ttu/mr_child_1"),
        relation: "child",
        subjectType: MR,
        subjectId: u("multi_branch_recursive_ttu/mr_direct"),
      },
      {
        objectType: MR,
        objectId: u("multi_branch_recursive_ttu/mr_alt_1"),
        relation: "parent",
        subjectType: MR,
        subjectId: u("multi_branch_recursive_ttu/mr_child_1"),
      },
      {
        objectType: MR,
        objectId: u("multi_branch_recursive_ttu/mr_alt_2"),
        relation: "child",
        subjectType: MR,
        subjectId: u("multi_branch_recursive_ttu/mr_alt_1"),
      },
    ],
    cases: [
      {
        name: "multi_branch_recursive_ttu/multi_branch_recursive_ttu_direct_assigned",
        objectType: MR,
        objectId: u("multi_branch_recursive_ttu/mr_direct"),
        relation: "multi_recursive_ttu",
        subjectType: USER,
        subjectId: u("multi_branch_recursive_ttu/mr_valid"),
        expected: true,
      },
      {
        name: "multi_branch_recursive_ttu/multi_branch_recursive_ttu_not_direct_assigned",
        objectType: MR,
        objectId: u("multi_branch_recursive_ttu/mr_direct"),
        relation: "multi_recursive_ttu",
        subjectType: USER,
        subjectId: u("multi_branch_recursive_ttu/mr_invalid"),
        expected: false,
      },
      {
        name: "multi_branch_recursive_ttu/multi_branch_recursive_ttu_parent_branch_only",
        objectType: MR,
        objectId: u("multi_branch_recursive_ttu/mr_parent_1"),
        relation: "multi_recursive_ttu",
        subjectType: USER,
        subjectId: u("multi_branch_recursive_ttu/mr_valid"),
        expected: true,
      },
      {
        name: "multi_branch_recursive_ttu/multi_branch_recursive_ttu_parent_branch_only_not_assigned",
        objectType: MR,
        objectId: u("multi_branch_recursive_ttu/mr_parent_1"),
        relation: "multi_recursive_ttu",
        subjectType: USER,
        subjectId: u("multi_branch_recursive_ttu/mr_invalid"),
        expected: false,
      },
      {
        name: "multi_branch_recursive_ttu/multi_branch_recursive_ttu_child_branch_only",
        objectType: MR,
        objectId: u("multi_branch_recursive_ttu/mr_child_1"),
        relation: "multi_recursive_ttu",
        subjectType: USER,
        subjectId: u("multi_branch_recursive_ttu/mr_valid"),
        expected: true,
      },
      {
        name: "multi_branch_recursive_ttu/multi_branch_recursive_ttu_child_branch_only_not_assigned",
        objectType: MR,
        objectId: u("multi_branch_recursive_ttu/mr_child_1"),
        relation: "multi_recursive_ttu",
        subjectType: USER,
        subjectId: u("multi_branch_recursive_ttu/mr_invalid"),
        expected: false,
      },
      {
        name: "multi_branch_recursive_ttu/multi_branch_recursive_ttu_alternating_branches_level_1",
        objectType: MR,
        objectId: u("multi_branch_recursive_ttu/mr_alt_1"),
        relation: "multi_recursive_ttu",
        subjectType: USER,
        subjectId: u("multi_branch_recursive_ttu/mr_valid"),
        expected: true,
      },
      {
        name: "multi_branch_recursive_ttu/multi_branch_recursive_ttu_alternating_branches_level_1_not_assigned",
        objectType: MR,
        objectId: u("multi_branch_recursive_ttu/mr_alt_1"),
        relation: "multi_recursive_ttu",
        subjectType: USER,
        subjectId: u("multi_branch_recursive_ttu/mr_invalid"),
        expected: false,
      },
      {
        name: "multi_branch_recursive_ttu/multi_branch_recursive_ttu_alternating_branches_level_2",
        objectType: MR,
        objectId: u("multi_branch_recursive_ttu/mr_alt_2"),
        relation: "multi_recursive_ttu",
        subjectType: USER,
        subjectId: u("multi_branch_recursive_ttu/mr_valid"),
        expected: true,
      },
      {
        name: "multi_branch_recursive_ttu/multi_branch_recursive_ttu_alternating_branches_level_2_not_assigned",
        objectType: MR,
        objectId: u("multi_branch_recursive_ttu/mr_alt_2"),
        relation: "multi_recursive_ttu",
        subjectType: USER,
        subjectId: u("multi_branch_recursive_ttu/mr_invalid"),
        expected: false,
      },
    ],
  },
  {
    name: "mixed_use",
    tuples: [
      {
        objectType: TT,
        objectId: u("mixed_use/ttus_mixed_use_direct_assign"),
        relation: "mixed_use",
        subjectType: DU,
        subjectId: u("mixed_use/ttus_mixed_use_direct_assign"),
      },
      {
        objectType: TT,
        objectId: u("mixed_use/ttus_mixed_use_direct_assign_level_1"),
        relation: "mixed_ttu_parent",
        subjectType: TT,
        subjectId: u("mixed_use/ttus_mixed_use_direct_assign"),
      },
      {
        objectType: TT,
        objectId: u("mixed_use/ttus_mixed_use_direct_assign_level_2"),
        relation: "mixed_ttu_parent",
        subjectType: TT,
        subjectId: u("mixed_use/ttus_mixed_use_direct_assign_level_1"),
      },
      {
        objectType: TT,
        objectId: u("mixed_use/ttus_mixed_use_direct_assign_level_3"),
        relation: "mixed_ttu_parent",
        subjectType: TT,
        subjectId: u("mixed_use/ttus_mixed_use_direct_assign_level_2"),
      },
      {
        objectType: DU,
        objectId: u("mixed_use/ttus_mixed_use_direct_assign"),
        relation: "direct",
        subjectType: USER,
        subjectId: u(
          "mixed_use/ttus_mixed_use_direct_assign_should_not_connect",
        ),
      },
      {
        objectType: DU,
        objectId: u("mixed_use/ttus_mixed_use_mixed_use"),
        relation: "direct",
        subjectType: USER,
        subjectId: u("mixed_use/ttus_mixed_use_mixed_use_side"),
      },
      {
        objectType: TT,
        objectId: u("mixed_use/ttus_mixed_use_mixed_use"),
        relation: "mixed_ttu_parent",
        subjectType: DU,
        subjectId: u("mixed_use/ttus_mixed_use_mixed_use"),
      },
      {
        objectType: TT,
        objectId: u("mixed_use/ttus_mixed_use_mixed_use_level_1"),
        relation: "mixed_ttu_parent",
        subjectType: TT,
        subjectId: u("mixed_use/ttus_mixed_use_mixed_use"),
      },
      {
        objectType: TT,
        objectId: u("mixed_use/ttus_mixed_use_mixed_use_level_2"),
        relation: "mixed_ttu_parent",
        subjectType: TT,
        subjectId: u("mixed_use/ttus_mixed_use_mixed_use_level_1"),
      },
    ],
    cases: [
      {
        name: "mixed_use/recursive_ttu_direct_assigned",
        objectType: TT,
        objectId: u("mixed_use/ttus_mixed_use_direct_assign"),
        relation: "mixed_use",
        subjectType: DU,
        subjectId: u("mixed_use/ttus_mixed_use_direct_assign"),
        expected: true,
      },
      {
        name: "mixed_use/recursive_ttu_direct_user_not_assigned",
        objectType: TT,
        objectId: u("mixed_use/ttus_mixed_use_direct_assign"),
        relation: "mixed_use",
        subjectType: DU,
        subjectId: u(
          "mixed_use/ttus_mixed_use_direct_assign_user_not_assigned",
        ),
        expected: false,
      },
      {
        name: "mixed_use/recursive_ttu_direct_assigned_recursive_parent",
        objectType: TT,
        objectId: u("mixed_use/ttus_mixed_use_direct_assign_level_3"),
        relation: "mixed_use",
        subjectType: DU,
        subjectId: u("mixed_use/ttus_mixed_use_direct_assign"),
        expected: true,
      },
      {
        name: "mixed_use/mixed_use_should_not_connect",
        objectType: TT,
        objectId: u("mixed_use/ttus_mixed_use_direct_assign_level_3"),
        relation: "mixed_use",
        subjectType: USER,
        subjectId: u(
          "mixed_use/ttus_mixed_use_direct_assign_should_not_connect",
        ),
        expected: false,
      },
      {
        name: "mixed_use/mixed_use_mixed_use_side",
        objectType: TT,
        objectId: u("mixed_use/ttus_mixed_use_mixed_use"),
        relation: "mixed_use",
        subjectType: USER,
        subjectId: u("mixed_use/ttus_mixed_use_mixed_use_side"),
        expected: true,
      },
      {
        name: "mixed_use/mixed_use_mixed_use_side_level_2",
        objectType: TT,
        objectId: u("mixed_use/ttus_mixed_use_mixed_use_level_2"),
        relation: "mixed_use",
        subjectType: USER,
        subjectId: u("mixed_use/ttus_mixed_use_mixed_use_side"),
        expected: true,
      },
    ],
  },
];

describe("B1 tuple-to-userset corpus — recursion and mixed parents", () => {
  let db: Kysely<DB>;
  let corpus: Corpus;
  let fixture: FixtureRecord;

  beforeAll(async () => {
    db = getDb();
    await beginTransaction(db);

    const tsfgaClient = createTsfga(new KyselyTupleStore(db));
    fixture = recordFixture(tsfgaClient);
    corpus = await loadCorpus(tsfgaClient, {
      slug: "ttu-recursive",
      modelPath: "./ttu-recursive/model.dsl",
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
    expectConfigsMatchModel("./ttu-recursive/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
