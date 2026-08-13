import type { RelationConfig, TypeRestriction } from "@tsfga/core";

/**
 * tsfga's rendering of OpenFGA's own `listobjects` matrix model
 * (`tests/listobjects/matrix.go`, v1.18.2), trimmed to the types
 * and relations the ported cases exercise and suffixed `_b4`.
 *
 * `complexity3` / `complexity4` and the `tuple_cycle_len3` family
 * are deliberately absent: the cases that read them are the ones
 * not ported.
 *
 * Five relations exist only here, because tsfga has no single
 * `RelationConfig` shape for a parenthesised set expression:
 * `h_oneline_right` on both `directs` types, and
 * `h_alg_inline_direct` / `h_alg_inline_ttu` / `h_w2_and` on
 * `ttus_b4`. They are declared to `expectConfigsMatchModel`, which
 * proves each names no relation the DSL defines.
 */

const COND = "xcond_b4";

const user: TypeRestriction = { type: "user_b4" };
const userCond: TypeRestriction = { type: "user_b4", condition: COND };
const userWild: TypeRestriction = { type: "user_b4", wildcard: true };
const userWildCond: TypeRestriction = {
  type: "user_b4",
  wildcard: true,
  condition: COND,
};
const employee: TypeRestriction = { type: "employee_b4" };
const employeeCond: TypeRestriction = { type: "employee_b4", condition: COND };
const employeeWild: TypeRestriction = { type: "employee_b4", wildcard: true };
const employeeWildCond: TypeRestriction = {
  type: "employee_b4",
  wildcard: true,
  condition: COND,
};

/** A config with every field spelled, so no caller forgets one. */
function rel(
  objectType: string,
  relation: string,
  shape: Partial<Omit<RelationConfig, "objectType" | "relation">> = {},
): RelationConfig {
  return {
    objectType,
    relation,
    directlyAssignable: shape.directlyAssignable ?? [],
    impliedBy: shape.impliedBy ?? null,
    computedUserset: shape.computedUserset ?? null,
    tupleToUserset: shape.tupleToUserset ?? null,
    excludedBy: shape.excludedBy ?? null,
    intersection: shape.intersection ?? null,
  };
}

/** `relation and relation and ...` over same-object rewrites. */
function allOf(...relations: string[]): RelationConfig["intersection"] {
  return relations.map((relation) => ({
    type: "computedUserset" as const,
    relation,
  }));
}

const DIRECTS: RelationConfig[] = [
  rel("directs_b4", "direct", { directlyAssignable: [user] }),
  rel("directs_b4", "direct_comb", {
    directlyAssignable: [user, userCond, userWild, userWildCond],
  }),
  rel("directs_b4", "direct_mult_types", {
    directlyAssignable: [user, userWild, employee, employeeWild],
  }),
  rel("directs_b4", "other_rel", {
    directlyAssignable: [user, userCond, userWild, userWildCond, employee],
  }),
  rel("directs_b4", "computed", { computedUserset: "direct" }),
  rel("directs_b4", "computed_comb", { computedUserset: "direct_comb" }),
  rel("directs_b4", "computed_mult_types", {
    computedUserset: "direct_mult_types",
  }),
  rel("directs_b4", "computed_2_times", { computedUserset: "computed" }),
  rel("directs_b4", "computed_3_times", {
    computedUserset: "computed_2_times",
  }),
  rel("directs_b4", "or_computed", {
    impliedBy: ["computed_3_times", "computed_comb"],
  }),
  rel("directs_b4", "or_computed_mult_types", {
    impliedBy: ["or_computed", "computed_mult_types"],
  }),
  rel("directs_b4", "and_computed_mult_types", {
    intersection: allOf("or_computed_mult_types", "other_rel"),
  }),
  rel("directs_b4", "butnot_computed", {
    computedUserset: "and_computed_mult_types",
    excludedBy: "computed_comb",
  }),
  rel("directs_b4", "alg_combined", {
    computedUserset: "butnot_computed",
    excludedBy: "computed_3_times",
  }),
  // (computed_3_times or computed_comb) is `or_computed` verbatim;
  // only the right operand needs a name of its own.
  rel("directs_b4", "h_oneline_right", {
    impliedBy: ["computed_mult_types", "other_rel"],
  }),
  rel("directs_b4", "alg_combined_oneline", {
    intersection: allOf("or_computed", "h_oneline_right"),
  }),
  rel("directs_b4", "cycle_len2_parent", {
    directlyAssignable: [{ type: "ttus_b4" }],
  }),
  rel("directs_b4", "tuple_cycle_len2_ttu", {
    directlyAssignable: [user, employee],
    tupleToUserset: [
      {
        tupleset: "cycle_len2_parent",
        computedUserset: "tuple_cycle_len2_ttu",
      },
    ],
  }),
  rel("directs_b4", "tuple_cycle_len2_userset", {
    directlyAssignable: [
      user,
      employee,
      { type: "usersets_user_b4", relation: "tuple_cycle_len2_userset" },
    ],
  }),
];

const DIRECTS_EMPLOYEE: RelationConfig[] = [
  rel("directs_employee_b4", "direct", {
    directlyAssignable: [
      employee,
      employeeWild,
      employeeCond,
      employeeWildCond,
    ],
  }),
  rel("directs_employee_b4", "other_rel", { directlyAssignable: [employee] }),
  rel("directs_employee_b4", "direct_wild", {
    directlyAssignable: [employeeWild],
  }),
  rel("directs_employee_b4", "computed", { computedUserset: "direct" }),
  rel("directs_employee_b4", "computed_2_times", {
    computedUserset: "computed",
  }),
  rel("directs_employee_b4", "computed_3_times", {
    computedUserset: "computed_2_times",
  }),
  rel("directs_employee_b4", "or_computed", {
    impliedBy: ["computed_3_times", "other_rel"],
  }),
  rel("directs_employee_b4", "and_computed", {
    intersection: allOf("or_computed", "direct_wild"),
  }),
  rel("directs_employee_b4", "alg_combined", {
    computedUserset: "and_computed",
    excludedBy: "other_rel",
  }),
  rel("directs_employee_b4", "h_oneline_right", {
    impliedBy: ["computed", "direct_wild"],
  }),
  rel("directs_employee_b4", "alg_combined_oneline", {
    intersection: allOf("or_computed", "h_oneline_right"),
  }),
  rel("directs_employee_b4", "cycle_len2_parent", {
    directlyAssignable: [{ type: "ttus_b4" }],
  }),
  rel("directs_employee_b4", "tuple_cycle_len2_ttu", {
    directlyAssignable: [user, employee],
    tupleToUserset: [
      {
        tupleset: "cycle_len2_parent",
        computedUserset: "tuple_cycle_len2_ttu",
      },
    ],
  }),
  rel("directs_employee_b4", "tuple_cycle_len2_userset", {
    directlyAssignable: [
      employee,
      { type: "usersets_user_b4", relation: "tuple_cycle_len2_userset" },
    ],
  }),
];

const USERSETS: RelationConfig[] = [
  rel("usersets_user_b4", "userset", {
    directlyAssignable: [
      { type: "directs_b4", relation: "direct_comb" },
      { type: "directs_employee_b4", relation: "direct" },
    ],
  }),
  rel("usersets_user_b4", "userset_alg_combined", {
    directlyAssignable: [
      { type: "directs_b4", relation: "alg_combined" },
      { type: "directs_employee_b4", relation: "alg_combined" },
    ],
  }),
  rel("usersets_user_b4", "userset_alg_combined_oneline", {
    directlyAssignable: [
      { type: "directs_b4", relation: "alg_combined_oneline" },
      { type: "directs_employee_b4", relation: "alg_combined_oneline" },
    ],
  }),
  rel("usersets_user_b4", "user_rel1", {
    directlyAssignable: [user, userWild],
  }),
  rel("usersets_user_b4", "user_rel2", {
    directlyAssignable: [user, userCond],
  }),
  rel("usersets_user_b4", "user_rel3", {
    directlyAssignable: [user, userWildCond],
  }),
  rel("usersets_user_b4", "user_rel5", {
    intersection: allOf("user_rel2", "user_rel3"),
  }),
  rel("usersets_user_b4", "user_rel4", {
    impliedBy: ["user_rel1", "user_rel5"],
  }),
  rel("usersets_user_b4", "userset_recursive", {
    directlyAssignable: [
      user,
      { type: "usersets_user_b4", relation: "userset_recursive" },
    ],
  }),
  rel("usersets_user_b4", "userset_recursive_public", {
    directlyAssignable: [
      userWild,
      { type: "usersets_user_b4", relation: "userset_recursive_public" },
    ],
  }),
  rel("usersets_user_b4", "userset_recursive_combined_w3", {
    directlyAssignable: [
      user,
      userWild,
      employee,
      { type: "usersets_user_b4", relation: "userset_recursive_combined_w3" },
      { type: "usersets_user_b4", relation: "userset" },
    ],
  }),
  rel("usersets_user_b4", "userset_recursive_alg_combined_oneline", {
    directlyAssignable: [
      user,
      {
        type: "usersets_user_b4",
        relation: "userset_recursive_alg_combined_oneline",
      },
    ],
    impliedBy: ["user_rel1", "user_rel5"],
  }),
  rel("usersets_user_b4", "tuple_cycle_len2_userset", {
    directlyAssignable: [
      user,
      { type: "directs_b4", relation: "tuple_cycle_len2_userset" },
      {
        type: "directs_employee_b4",
        relation: "tuple_cycle_len2_userset",
        condition: COND,
      },
    ],
  }),
  // Not upstream's. The matrix admits a userset subject on a
  // *direct* relation and on a union arm, and nowhere else; these
  // put the same `directs_b4#alg_combined` userset behind each of
  // the remaining rewrite kinds, which is what
  // `list-objects-probes.test.ts` asks `listObjects` about.
  rel("usersets_user_b4", "probe_parent", {
    directlyAssignable: [{ type: "usersets_user_b4" }],
  }),
  rel("usersets_user_b4", "probe_blocked", {
    directlyAssignable: [
      { type: "directs_b4", relation: "alg_combined_oneline" },
    ],
  }),
  rel("usersets_user_b4", "probe_computed", {
    computedUserset: "userset_alg_combined",
  }),
  rel("usersets_user_b4", "probe_union", {
    impliedBy: ["userset_alg_combined", "probe_blocked"],
  }),
  rel("usersets_user_b4", "probe_intersect", {
    intersection: allOf("userset_alg_combined", "probe_blocked"),
  }),
  rel("usersets_user_b4", "probe_excluded", {
    computedUserset: "userset_alg_combined",
    excludedBy: "probe_blocked",
  }),
  rel("usersets_user_b4", "probe_ttu", {
    tupleToUserset: [
      { tupleset: "probe_parent", computedUserset: "userset_alg_combined" },
    ],
  }),
];

const TTUS: RelationConfig[] = [
  rel("ttus_b4", "direct_parent", {
    directlyAssignable: [{ type: "directs_b4" }],
  }),
  rel("ttus_b4", "mult_parent_types", {
    directlyAssignable: [
      { type: "directs_b4" },
      { type: "directs_employee_b4" },
      { type: "directs_b4", condition: COND },
      { type: "directs_employee_b4", condition: COND },
    ],
  }),
  rel("ttus_b4", "ttu_direct", {
    tupleToUserset: [{ tupleset: "direct_parent", computedUserset: "direct" }],
  }),
  rel("ttus_b4", "ttu_other_rel", {
    tupleToUserset: [
      { tupleset: "mult_parent_types", computedUserset: "other_rel" },
    ],
  }),
  rel("ttus_b4", "ttu_alg_combined", {
    tupleToUserset: [
      { tupleset: "mult_parent_types", computedUserset: "alg_combined" },
    ],
  }),
  rel("ttus_b4", "ttu_alg_combined_oneline", {
    tupleToUserset: [
      {
        tupleset: "mult_parent_types",
        computedUserset: "alg_combined_oneline",
      },
    ],
  }),
  rel("ttus_b4", "duplicate_ttu", {
    tupleToUserset: [
      { tupleset: "direct_parent", computedUserset: "direct" },
      { tupleset: "mult_parent_types", computedUserset: "direct" },
    ],
  }),
  rel("ttus_b4", "ttu_computed", { computedUserset: "ttu_direct" }),
  rel("ttus_b4", "ttu_alg_combined_computed", {
    computedUserset: "ttu_alg_combined",
  }),
  rel("ttus_b4", "user_rel1", { directlyAssignable: [user, userWild] }),
  rel("ttus_b4", "user_rel2", { directlyAssignable: [user, userCond] }),
  rel("ttus_b4", "user_rel3", { directlyAssignable: [user, userWildCond] }),
  rel("ttus_b4", "or_ttu", {
    impliedBy: ["ttu_computed", "ttu_alg_combined_computed"],
  }),
  rel("ttus_b4", "and_ttu", { intersection: allOf("or_ttu", "ttu_other_rel") }),
  rel("ttus_b4", "alg_combined", {
    computedUserset: "and_ttu",
    excludedBy: "ttu_alg_combined_oneline",
  }),
  rel("ttus_b4", "alg_combined_computed", { computedUserset: "alg_combined" }),
  rel("ttus_b4", "user_rel5", {
    intersection: allOf("user_rel2", "user_rel3"),
  }),
  rel("ttus_b4", "user_rel4", { impliedBy: ["user_rel1", "user_rel5"] }),
  // `alg_inline`'s own `[user_b4, user_b4:*]` lives here, and its
  // parenthesised `but not` arm next door, so the relation itself
  // is one three-way intersection.
  rel("ttus_b4", "h_alg_inline_direct", {
    directlyAssignable: [user, userWild],
  }),
  rel("ttus_b4", "h_alg_inline_ttu", {
    computedUserset: "ttu_direct",
    excludedBy: "ttu_other_rel",
  }),
  rel("ttus_b4", "alg_inline", {
    intersection: allOf("h_alg_inline_direct", "user_rel4", "h_alg_inline_ttu"),
  }),
  rel("ttus_b4", "ttu_parent", { directlyAssignable: [{ type: "ttus_b4" }] }),
  rel("ttus_b4", "ttu_recursive", {
    directlyAssignable: [user],
    tupleToUserset: [
      { tupleset: "ttu_parent", computedUserset: "ttu_recursive" },
    ],
  }),
  rel("ttus_b4", "ttu_recursive_public", {
    directlyAssignable: [userWild],
    tupleToUserset: [
      { tupleset: "ttu_parent", computedUserset: "ttu_recursive_public" },
    ],
  }),
  rel("ttus_b4", "ttu_recursive_combined_w3", {
    directlyAssignable: [user, userWild, employee],
    tupleToUserset: [
      { tupleset: "ttu_parent", computedUserset: "ttu_recursive_combined_w3" },
      { tupleset: "direct_parent", computedUserset: "direct" },
    ],
  }),
  rel("ttus_b4", "ttu_recursive_alg_combined", {
    tupleToUserset: [
      { tupleset: "ttu_parent", computedUserset: "ttu_recursive_alg_combined" },
    ],
    impliedBy: ["user_rel4"],
  }),
  rel("ttus_b4", "ttu_recursive_alg_combined_oneline", {
    directlyAssignable: [user],
    tupleToUserset: [
      {
        tupleset: "ttu_parent",
        computedUserset: "ttu_recursive_alg_combined_oneline",
      },
    ],
    impliedBy: ["user_rel1", "user_rel5"],
  }),
  rel("ttus_b4", "h_w2_and", {
    intersection: allOf("user_rel2", "ttu_direct"),
  }),
  rel("ttus_b4", "ttu_recursive_alg_combined_w2", {
    directlyAssignable: [user],
    tupleToUserset: [
      { tupleset: "ttu_parent", computedUserset: "ttu_recursive_alg_combined" },
    ],
    impliedBy: ["user_rel1", "h_w2_and"],
  }),
  rel("ttus_b4", "tuple_cycle_len2_ttu", {
    directlyAssignable: [user, employee],
    tupleToUserset: [
      {
        tupleset: "mult_parent_types",
        computedUserset: "tuple_cycle_len2_ttu",
      },
    ],
  }),
];

export const MATRIX_CONFIGS: RelationConfig[] = [
  ...DIRECTS,
  ...DIRECTS_EMPLOYEE,
  ...USERSETS,
  ...TTUS,
];

/** Relations tsfga has that the DSL does not. */
export const MATRIX_HELPERS = [
  "directs_b4.h_oneline_right",
  "directs_employee_b4.h_oneline_right",
  "ttus_b4.h_alg_inline_direct",
  "ttus_b4.h_alg_inline_ttu",
  "ttus_b4.h_w2_and",
];

/** Relations whose direct assignment moved onto a helper. */
export const MATRIX_MOVED = [
  { relation: "ttus_b4.alg_inline", movedTo: "ttus_b4.h_alg_inline_direct" },
];
