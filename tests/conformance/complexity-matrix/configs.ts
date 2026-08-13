import type { RelationConfig, TypeRestriction } from "@tsfga/core";

/**
 * tsfga's rendering of the `complexity3` / `complexity4` half of
 * OpenFGA's `listobjects` matrix model
 * (`tests/listobjects/matrix.go`, v1.18.2), suffixed `_c1`.
 *
 * The `listobjects-matrix` fixture stops one type short of these:
 * it carries `directs`, `directs-employee`, `usersets-user` and
 * `ttus`, and says so. `complexity3` stacks a third rewrite kind
 * on top of those — a TTU whose computed relation is itself a
 * userset relation, and a userset whose referenced relation is
 * itself a TTU — and `complexity4` stacks a fourth. Everything
 * upstream's matrix asserts about them lives here.
 *
 * Three relations exist only in tsfga, because there is no single
 * `RelationConfig` shape for a parenthesised set expression:
 * `h_oneline_right` on both `directs` types, and `h_uim_direct`,
 * which carries the direct assignment of
 * `usersets_user_c1.userset_intersect_mixed` so the relation
 * itself can be the two-way intersection the DSL writes.
 */

const COND = "xcond_c1";

const user: TypeRestriction = { type: "user_c1" };
const userCond: TypeRestriction = { type: "user_c1", condition: COND };
const userWild: TypeRestriction = { type: "user_c1", wildcard: true };
const userWildCond: TypeRestriction = {
  type: "user_c1",
  wildcard: true,
  condition: COND,
};
const employee: TypeRestriction = { type: "employee_c1" };
const employeeCond: TypeRestriction = { type: "employee_c1", condition: COND };
const employeeWild: TypeRestriction = { type: "employee_c1", wildcard: true };
const employeeWildCond: TypeRestriction = {
  type: "employee_c1",
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
  rel("directs_c1", "direct", { directlyAssignable: [user] }),
  rel("directs_c1", "direct_comb", {
    directlyAssignable: [user, userCond, userWild, userWildCond],
  }),
  rel("directs_c1", "direct_mult_types", {
    directlyAssignable: [user, userWild, employee, employeeWild],
  }),
  rel("directs_c1", "other_rel", {
    directlyAssignable: [user, userCond, userWild, userWildCond, employee],
  }),
  rel("directs_c1", "computed", { computedUserset: "direct" }),
  rel("directs_c1", "computed_comb", { computedUserset: "direct_comb" }),
  rel("directs_c1", "computed_mult_types", {
    computedUserset: "direct_mult_types",
  }),
  rel("directs_c1", "computed_2_times", { computedUserset: "computed" }),
  rel("directs_c1", "computed_3_times", {
    computedUserset: "computed_2_times",
  }),
  rel("directs_c1", "or_computed", {
    impliedBy: ["computed_3_times", "computed_comb"],
  }),
  rel("directs_c1", "or_computed_mult_types", {
    impliedBy: ["or_computed", "computed_mult_types"],
  }),
  rel("directs_c1", "and_computed_mult_types", {
    intersection: allOf("or_computed_mult_types", "other_rel"),
  }),
  rel("directs_c1", "butnot_computed", {
    computedUserset: "and_computed_mult_types",
    excludedBy: "computed_comb",
  }),
  rel("directs_c1", "alg_combined", {
    computedUserset: "butnot_computed",
    excludedBy: "computed_3_times",
  }),
  // `(computed_3_times or computed_comb)` is `or_computed` verbatim;
  // only the right operand needs a name of its own.
  rel("directs_c1", "h_oneline_right", {
    impliedBy: ["computed_mult_types", "other_rel"],
  }),
  rel("directs_c1", "alg_combined_oneline", {
    intersection: allOf("or_computed", "h_oneline_right"),
  }),
  rel("directs_c1", "tuple_cycle_len3", {
    directlyAssignable: [
      user,
      employee,
      { type: "complexity3_c1", relation: "tuple_cycle_len3" },
    ],
  }),
];

const DIRECTS_EMPLOYEE: RelationConfig[] = [
  rel("directs_employee_c1", "direct", {
    directlyAssignable: [
      employee,
      employeeWild,
      employeeCond,
      employeeWildCond,
    ],
  }),
  rel("directs_employee_c1", "other_rel", { directlyAssignable: [employee] }),
  rel("directs_employee_c1", "direct_wild", {
    directlyAssignable: [employeeWild],
  }),
  rel("directs_employee_c1", "computed", { computedUserset: "direct" }),
  rel("directs_employee_c1", "computed_2_times", {
    computedUserset: "computed",
  }),
  rel("directs_employee_c1", "computed_3_times", {
    computedUserset: "computed_2_times",
  }),
  rel("directs_employee_c1", "or_computed", {
    impliedBy: ["computed_3_times", "other_rel"],
  }),
  rel("directs_employee_c1", "and_computed", {
    intersection: allOf("or_computed", "direct_wild"),
  }),
  rel("directs_employee_c1", "alg_combined", {
    computedUserset: "and_computed",
    excludedBy: "other_rel",
  }),
  rel("directs_employee_c1", "h_oneline_right", {
    impliedBy: ["computed", "direct_wild"],
  }),
  rel("directs_employee_c1", "alg_combined_oneline", {
    intersection: allOf("or_computed", "h_oneline_right"),
  }),
  rel("directs_employee_c1", "tuple_cycle_len3", {
    directlyAssignable: [
      employee,
      { type: "complexity3_c1", relation: "tuple_cycle_len3" },
    ],
  }),
];

const USERSETS: RelationConfig[] = [
  rel("usersets_user_c1", "userset", {
    directlyAssignable: [
      { type: "directs_c1", relation: "direct_comb" },
      { type: "directs_employee_c1", relation: "direct" },
    ],
  }),
  rel("usersets_user_c1", "userset_other_rel", {
    directlyAssignable: [
      { type: "directs_c1", relation: "other_rel" },
      { type: "directs_employee_c1", relation: "other_rel" },
    ],
  }),
  rel("usersets_user_c1", "userset_alg_combined", {
    directlyAssignable: [
      { type: "directs_c1", relation: "alg_combined" },
      { type: "directs_employee_c1", relation: "alg_combined" },
    ],
  }),
  rel("usersets_user_c1", "userset_alg_combined_oneline", {
    directlyAssignable: [
      { type: "directs_c1", relation: "alg_combined_oneline" },
      { type: "directs_employee_c1", relation: "alg_combined_oneline" },
    ],
  }),
  rel("usersets_user_c1", "userset_combined_cond", {
    directlyAssignable: [
      {
        type: "directs_c1",
        relation: "computed_mult_types",
        condition: COND,
      },
      { type: "directs_employee_c1", relation: "computed_3_times" },
    ],
  }),
  rel("usersets_user_c1", "user_rel1", {
    directlyAssignable: [user, userWild],
  }),
  rel("usersets_user_c1", "user_rel2", {
    directlyAssignable: [user, userCond],
  }),
  rel("usersets_user_c1", "user_rel3", {
    directlyAssignable: [user, userWildCond],
  }),
  rel("usersets_user_c1", "user_rel5", {
    intersection: allOf("user_rel2", "user_rel3"),
  }),
  rel("usersets_user_c1", "user_rel4", {
    impliedBy: ["user_rel1", "user_rel5"],
  }),
  rel("usersets_user_c1", "userset_computed", { computedUserset: "userset" }),
  rel("usersets_user_c1", "userset_alg_combined_computed", {
    computedUserset: "userset_alg_combined",
  }),
  // `[...] and (user_rel1 or (user_rel2 and user_rel3))`. The right
  // operand is `user_rel4` verbatim; the left is the bracket, which
  // has to be a relation of its own for the intersection to name it.
  rel("usersets_user_c1", "h_uim_direct", {
    directlyAssignable: [
      user,
      userWild,
      { type: "directs_c1", relation: "alg_combined_oneline" },
    ],
  }),
  rel("usersets_user_c1", "userset_intersect_mixed", {
    intersection: allOf("h_uim_direct", "user_rel4"),
  }),
  rel("usersets_user_c1", "userset_exclude_mixed", {
    directlyAssignable: [
      user,
      userWild,
      { type: "directs_c1", relation: "alg_combined_oneline" },
    ],
    excludedBy: "userset_intersect_mixed",
  }),
  rel("usersets_user_c1", "or_userset", {
    impliedBy: ["userset_computed", "userset_alg_combined_computed"],
  }),
  rel("usersets_user_c1", "and_userset", {
    intersection: allOf("or_userset", "userset_combined_cond"),
  }),
  rel("usersets_user_c1", "alg_combined", {
    computedUserset: "and_userset",
    excludedBy: "userset_alg_combined_oneline",
  }),
  rel("usersets_user_c1", "alg_combined_computed", {
    computedUserset: "alg_combined",
  }),
  rel("usersets_user_c1", "tuple_cycle_len3", {
    directlyAssignable: [
      { type: "directs_c1", relation: "tuple_cycle_len3" },
      { type: "directs_employee_c1", relation: "tuple_cycle_len3" },
    ],
  }),
];

const TTUS: RelationConfig[] = [
  rel("ttus_c1", "direct_parent", {
    directlyAssignable: [{ type: "directs_c1" }],
  }),
  rel("ttus_c1", "mult_parent_types", {
    directlyAssignable: [
      { type: "directs_c1" },
      { type: "directs_employee_c1" },
      { type: "directs_c1", condition: COND },
      { type: "directs_employee_c1", condition: COND },
    ],
  }),
  rel("ttus_c1", "ttu_direct", {
    tupleToUserset: [{ tupleset: "direct_parent", computedUserset: "direct" }],
  }),
  rel("ttus_c1", "ttu_other_rel", {
    tupleToUserset: [
      { tupleset: "mult_parent_types", computedUserset: "other_rel" },
    ],
  }),
  rel("ttus_c1", "ttu_alg_combined", {
    tupleToUserset: [
      { tupleset: "mult_parent_types", computedUserset: "alg_combined" },
    ],
  }),
  rel("ttus_c1", "ttu_alg_combined_oneline", {
    tupleToUserset: [
      {
        tupleset: "mult_parent_types",
        computedUserset: "alg_combined_oneline",
      },
    ],
  }),
  rel("ttus_c1", "ttu_computed", { computedUserset: "ttu_direct" }),
  rel("ttus_c1", "ttu_alg_combined_computed", {
    computedUserset: "ttu_alg_combined",
  }),
  rel("ttus_c1", "or_ttu", {
    impliedBy: ["ttu_computed", "ttu_alg_combined_computed"],
  }),
  rel("ttus_c1", "and_ttu", { intersection: allOf("or_ttu", "ttu_other_rel") }),
  rel("ttus_c1", "alg_combined", {
    computedUserset: "and_ttu",
    excludedBy: "ttu_alg_combined_oneline",
  }),
  rel("ttus_c1", "alg_combined_computed", { computedUserset: "alg_combined" }),
];

const COMPLEXITY3: RelationConfig[] = [
  rel("complexity3_c1", "userset_parent", {
    directlyAssignable: [
      { type: "usersets_user_c1" },
      { type: "usersets_user_c1", condition: COND },
    ],
  }),
  rel("complexity3_c1", "ttu_userset", {
    tupleToUserset: [
      { tupleset: "userset_parent", computedUserset: "userset" },
    ],
  }),
  rel("complexity3_c1", "ttu_userset_public", {
    directlyAssignable: [userWild],
    impliedBy: ["ttu_userset"],
  }),
  rel("complexity3_c1", "ttu_userset_other_rel", {
    tupleToUserset: [
      { tupleset: "userset_parent", computedUserset: "userset_other_rel" },
    ],
  }),
  rel("complexity3_c1", "ttu_userset_inner_alg_combined", {
    tupleToUserset: [
      {
        tupleset: "userset_parent",
        computedUserset: "userset_alg_combined_computed",
      },
    ],
  }),
  rel("complexity3_c1", "ttu_userset_alg_combined", {
    tupleToUserset: [
      {
        tupleset: "userset_parent",
        computedUserset: "alg_combined_computed",
      },
    ],
  }),
  rel("complexity3_c1", "or_ttu_userset", {
    impliedBy: ["ttu_userset", "ttu_userset_other_rel"],
  }),
  rel("complexity3_c1", "and_ttu_userset", {
    intersection: allOf("or_ttu_userset", "ttu_userset_inner_alg_combined"),
  }),
  rel("complexity3_c1", "alg_combined_ttu_userset", {
    computedUserset: "and_ttu_userset",
    excludedBy: "ttu_userset_public",
  }),
  rel("complexity3_c1", "ttu_userset_intersect_mixed", {
    tupleToUserset: [
      {
        tupleset: "userset_parent",
        computedUserset: "userset_intersect_mixed",
      },
    ],
  }),
  rel("complexity3_c1", "ttu_userset_exclude_mixed", {
    tupleToUserset: [
      {
        tupleset: "userset_parent",
        computedUserset: "userset_exclude_mixed",
      },
    ],
  }),
  rel("complexity3_c1", "userset_userset_intersect_mixed", {
    directlyAssignable: [
      { type: "usersets_user_c1", relation: "userset_intersect_mixed" },
    ],
  }),
  rel("complexity3_c1", "userset_userset_exclude_mixed", {
    directlyAssignable: [
      { type: "usersets_user_c1", relation: "userset_exclude_mixed" },
    ],
  }),
  rel("complexity3_c1", "userset_ttu", {
    directlyAssignable: [
      { type: "ttus_c1", relation: "ttu_direct" },
      { type: "ttus_c1", relation: "ttu_direct", condition: COND },
    ],
  }),
  rel("complexity3_c1", "userset_ttu_public", {
    directlyAssignable: [userWild, { type: "ttus_c1", relation: "ttu_direct" }],
  }),
  rel("complexity3_c1", "userset_ttu_other_rel", {
    directlyAssignable: [{ type: "ttus_c1", relation: "ttu_other_rel" }],
  }),
  rel("complexity3_c1", "userset_ttu_inner_alg_combined", {
    directlyAssignable: [
      { type: "ttus_c1", relation: "ttu_alg_combined_computed" },
    ],
  }),
  rel("complexity3_c1", "userset_ttu_alg_combined", {
    directlyAssignable: [
      { type: "ttus_c1", relation: "alg_combined_computed" },
    ],
  }),
  rel("complexity3_c1", "or_userset_ttu", {
    impliedBy: ["userset_ttu", "userset_ttu_other_rel"],
  }),
  rel("complexity3_c1", "and_userset_ttu", {
    intersection: allOf("or_userset_ttu", "userset_ttu_inner_alg_combined"),
  }),
  rel("complexity3_c1", "alg_combined_userset_ttu", {
    computedUserset: "and_userset_ttu",
    excludedBy: "userset_ttu_public",
  }),
  rel("complexity3_c1", "tuple_cycle_len3", {
    directlyAssignable: [user, employee],
    tupleToUserset: [
      { tupleset: "userset_parent", computedUserset: "tuple_cycle_len3" },
    ],
  }),
];

const COMPLEXITY4: RelationConfig[] = [
  rel("complexity4_c1", "parent", {
    directlyAssignable: [
      { type: "complexity3_c1" },
      { type: "complexity3_c1", condition: COND },
    ],
  }),
  rel("complexity4_c1", "ttu_userset_ttu", {
    tupleToUserset: [{ tupleset: "parent", computedUserset: "userset_ttu" }],
  }),
  rel("complexity4_c1", "userset_ttu_userset", {
    directlyAssignable: [
      { type: "complexity3_c1", relation: "ttu_userset" },
      {
        type: "complexity3_c1",
        relation: "ttu_userset_other_rel",
        condition: COND,
      },
    ],
  }),
  rel("complexity4_c1", "or_complex4", {
    directlyAssignable: [
      { type: "complexity3_c1", relation: "userset_ttu_public" },
    ],
    impliedBy: ["ttu_userset_ttu"],
  }),
  rel("complexity4_c1", "alg_combined_complex4", {
    intersection: [
      { type: "computedUserset", relation: "or_complex4" },
      {
        type: "tupleToUserset",
        tupleset: "parent",
        computedUserset: "alg_combined_userset_ttu",
      },
    ],
  }),
];

export const MATRIX_CONFIGS: RelationConfig[] = [
  ...DIRECTS,
  ...DIRECTS_EMPLOYEE,
  ...USERSETS,
  ...TTUS,
  ...COMPLEXITY3,
  ...COMPLEXITY4,
];

/** Relations tsfga has that the DSL does not. */
export const MATRIX_HELPERS = [
  "directs_c1.h_oneline_right",
  "directs_employee_c1.h_oneline_right",
  "usersets_user_c1.h_uim_direct",
];

/** Relations whose direct assignment moved onto a helper. */
export const MATRIX_MOVED = [
  {
    relation: "usersets_user_c1.userset_intersect_mixed",
    movedTo: "usersets_user_c1.h_uim_direct",
  },
];
