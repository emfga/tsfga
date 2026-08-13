model
  schema 1.1

type user_c1

type employee_c1

type directs_c1
  relations
    define direct: [user_c1]
    define direct_comb: [user_c1, user_c1 with xcond_c1, user_c1:*, user_c1:* with xcond_c1]
    define direct_mult_types: [user_c1, user_c1:*, employee_c1, employee_c1:*]
    define other_rel: [user_c1, user_c1 with xcond_c1, user_c1:*, user_c1:* with xcond_c1, employee_c1]
    define computed: direct
    define computed_comb: direct_comb
    define computed_mult_types: direct_mult_types
    define computed_2_times: computed
    define computed_3_times: computed_2_times
    define or_computed: computed_3_times or computed_comb
    define or_computed_mult_types: or_computed or computed_mult_types
    define and_computed_mult_types: or_computed_mult_types and other_rel
    define butnot_computed: and_computed_mult_types but not computed_comb
    define alg_combined: butnot_computed but not computed_3_times
    define alg_combined_oneline: (computed_3_times or computed_comb) and (computed_mult_types or other_rel)
    define tuple_cycle_len3: [user_c1, employee_c1, complexity3_c1#tuple_cycle_len3]

type directs_employee_c1
  relations
    define direct: [employee_c1, employee_c1:*, employee_c1 with xcond_c1, employee_c1:* with xcond_c1]
    define other_rel: [employee_c1]
    define direct_wild: [employee_c1:*]
    define computed: direct
    define computed_2_times: computed
    define computed_3_times: computed_2_times
    define or_computed: computed_3_times or other_rel
    define and_computed: or_computed and direct_wild
    define alg_combined: and_computed but not other_rel
    define alg_combined_oneline: (computed_3_times or other_rel) and (computed or direct_wild)
    define tuple_cycle_len3: [employee_c1, complexity3_c1#tuple_cycle_len3]

type usersets_user_c1
  relations
    define userset: [directs_c1#direct_comb, directs_employee_c1#direct]
    define userset_other_rel: [directs_c1#other_rel, directs_employee_c1#other_rel]
    define userset_alg_combined: [directs_c1#alg_combined, directs_employee_c1#alg_combined]
    define userset_alg_combined_oneline: [directs_c1#alg_combined_oneline, directs_employee_c1#alg_combined_oneline]
    define userset_combined_cond: [directs_c1#computed_mult_types with xcond_c1, directs_employee_c1#computed_3_times]
    define user_rel1: [user_c1, user_c1:*]
    define user_rel2: [user_c1, user_c1 with xcond_c1]
    define user_rel3: [user_c1, user_c1:* with xcond_c1]
    define user_rel5: user_rel2 and user_rel3
    define user_rel4: user_rel1 or user_rel5
    define userset_computed: userset
    define userset_alg_combined_computed: userset_alg_combined
    define userset_intersect_mixed: [user_c1, user_c1:*, directs_c1#alg_combined_oneline] and (user_rel1 or (user_rel2 and user_rel3))
    define userset_exclude_mixed: [user_c1, user_c1:*, directs_c1#alg_combined_oneline] but not userset_intersect_mixed
    define or_userset: userset_computed or userset_alg_combined_computed
    define and_userset: or_userset and userset_combined_cond
    define alg_combined: and_userset but not userset_alg_combined_oneline
    define alg_combined_computed: alg_combined
    define tuple_cycle_len3: [directs_c1#tuple_cycle_len3, directs_employee_c1#tuple_cycle_len3]

type ttus_c1
  relations
    define direct_parent: [directs_c1]
    define mult_parent_types: [directs_c1, directs_employee_c1, directs_c1 with xcond_c1, directs_employee_c1 with xcond_c1]
    define ttu_direct: direct from direct_parent
    define ttu_other_rel: other_rel from mult_parent_types
    define ttu_alg_combined: alg_combined from mult_parent_types
    define ttu_alg_combined_oneline: alg_combined_oneline from mult_parent_types
    define ttu_computed: ttu_direct
    define ttu_alg_combined_computed: ttu_alg_combined
    define or_ttu: ttu_computed or ttu_alg_combined_computed
    define and_ttu: or_ttu and ttu_other_rel
    define alg_combined: and_ttu but not ttu_alg_combined_oneline
    define alg_combined_computed: alg_combined

type complexity3_c1
  relations
    define userset_parent: [usersets_user_c1, usersets_user_c1 with xcond_c1]
    define ttu_userset: userset from userset_parent
    define ttu_userset_public: [user_c1:*] or ttu_userset
    define ttu_userset_other_rel: userset_other_rel from userset_parent
    define ttu_userset_inner_alg_combined: userset_alg_combined_computed from userset_parent
    define ttu_userset_alg_combined: alg_combined_computed from userset_parent
    define or_ttu_userset: ttu_userset or ttu_userset_other_rel
    define and_ttu_userset: or_ttu_userset and ttu_userset_inner_alg_combined
    define alg_combined_ttu_userset: and_ttu_userset but not ttu_userset_public
    define ttu_userset_intersect_mixed: userset_intersect_mixed from userset_parent
    define ttu_userset_exclude_mixed: userset_exclude_mixed from userset_parent
    define userset_userset_intersect_mixed: [usersets_user_c1#userset_intersect_mixed]
    define userset_userset_exclude_mixed: [usersets_user_c1#userset_exclude_mixed]
    define userset_ttu: [ttus_c1#ttu_direct, ttus_c1#ttu_direct with xcond_c1]
    define userset_ttu_public: [user_c1:*, ttus_c1#ttu_direct]
    define userset_ttu_other_rel: [ttus_c1#ttu_other_rel]
    define userset_ttu_inner_alg_combined: [ttus_c1#ttu_alg_combined_computed]
    define userset_ttu_alg_combined: [ttus_c1#alg_combined_computed]
    define or_userset_ttu: userset_ttu or userset_ttu_other_rel
    define and_userset_ttu: or_userset_ttu and userset_ttu_inner_alg_combined
    define alg_combined_userset_ttu: and_userset_ttu but not userset_ttu_public
    define tuple_cycle_len3: [user_c1, employee_c1] or tuple_cycle_len3 from userset_parent

type complexity4_c1
  relations
    define parent: [complexity3_c1, complexity3_c1 with xcond_c1]
    define ttu_userset_ttu: userset_ttu from parent
    define userset_ttu_userset: [complexity3_c1#ttu_userset, complexity3_c1#ttu_userset_other_rel with xcond_c1]
    define or_complex4: [complexity3_c1#userset_ttu_public] or ttu_userset_ttu
    define alg_combined_complex4: or_complex4 and alg_combined_userset_ttu from parent

condition xcond_c1(x: string) {
  x == '1'
}
