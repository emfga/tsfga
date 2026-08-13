model
  schema 1.1

type user_b4

type employee_b4

type directs_b4
  relations
    define direct: [user_b4]
    define direct_comb: [user_b4, user_b4 with xcond_b4, user_b4:*, user_b4:* with xcond_b4]
    define direct_mult_types: [user_b4, user_b4:*, employee_b4, employee_b4:*]
    define other_rel: [user_b4, user_b4 with xcond_b4, user_b4:*, user_b4:* with xcond_b4, employee_b4]
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
    define cycle_len2_parent: [ttus_b4]
    define tuple_cycle_len2_ttu: [user_b4, employee_b4] or tuple_cycle_len2_ttu from cycle_len2_parent
    define tuple_cycle_len2_userset: [user_b4, employee_b4, usersets_user_b4#tuple_cycle_len2_userset]

type directs_employee_b4
  relations
    define direct: [employee_b4, employee_b4:*, employee_b4 with xcond_b4, employee_b4:* with xcond_b4]
    define other_rel: [employee_b4]
    define direct_wild: [employee_b4:*]
    define computed: direct
    define computed_2_times: computed
    define computed_3_times: computed_2_times
    define or_computed: computed_3_times or other_rel
    define and_computed: or_computed and direct_wild
    define alg_combined: and_computed but not other_rel
    define alg_combined_oneline: (computed_3_times or other_rel) and (computed or direct_wild)
    define cycle_len2_parent: [ttus_b4]
    define tuple_cycle_len2_ttu: [user_b4, employee_b4] or tuple_cycle_len2_ttu from cycle_len2_parent
    define tuple_cycle_len2_userset: [employee_b4, usersets_user_b4#tuple_cycle_len2_userset]

type usersets_user_b4
  relations
    define userset: [directs_b4#direct_comb, directs_employee_b4#direct]
    define userset_alg_combined: [directs_b4#alg_combined, directs_employee_b4#alg_combined]
    define userset_alg_combined_oneline: [directs_b4#alg_combined_oneline, directs_employee_b4#alg_combined_oneline]
    define user_rel1: [user_b4, user_b4:*]
    define user_rel2: [user_b4, user_b4 with xcond_b4]
    define user_rel3: [user_b4, user_b4:* with xcond_b4]
    define user_rel5: user_rel2 and user_rel3
    define user_rel4: user_rel1 or user_rel5
    define userset_recursive: [user_b4, usersets_user_b4#userset_recursive]
    define userset_recursive_public: [user_b4:*, usersets_user_b4#userset_recursive_public]
    define userset_recursive_combined_w3: [user_b4, user_b4:*, employee_b4, usersets_user_b4#userset_recursive_combined_w3, usersets_user_b4#userset]
    define userset_recursive_alg_combined_oneline: ([user_b4, usersets_user_b4#userset_recursive_alg_combined_oneline] or user_rel1) or (user_rel2 and user_rel3)
    define tuple_cycle_len2_userset: [user_b4, directs_b4#tuple_cycle_len2_userset, directs_employee_b4#tuple_cycle_len2_userset with xcond_b4]
    define probe_parent: [usersets_user_b4]
    define probe_blocked: [directs_b4#alg_combined_oneline]
    define probe_computed: userset_alg_combined
    define probe_union: userset_alg_combined or probe_blocked
    define probe_intersect: userset_alg_combined and probe_blocked
    define probe_excluded: userset_alg_combined but not probe_blocked
    define probe_ttu: userset_alg_combined from probe_parent

type ttus_b4
  relations
    define direct_parent: [directs_b4]
    define mult_parent_types: [directs_b4, directs_employee_b4, directs_b4 with xcond_b4, directs_employee_b4 with xcond_b4]
    define ttu_direct: direct from direct_parent
    define ttu_other_rel: other_rel from mult_parent_types
    define ttu_alg_combined: alg_combined from mult_parent_types
    define ttu_alg_combined_oneline: alg_combined_oneline from mult_parent_types
    define duplicate_ttu: direct from direct_parent or direct from mult_parent_types
    define ttu_computed: ttu_direct
    define ttu_alg_combined_computed: ttu_alg_combined
    define user_rel1: [user_b4, user_b4:*]
    define user_rel2: [user_b4, user_b4 with xcond_b4]
    define user_rel3: [user_b4, user_b4:* with xcond_b4]
    define or_ttu: ttu_computed or ttu_alg_combined_computed
    define and_ttu: or_ttu and ttu_other_rel
    define alg_combined: and_ttu but not ttu_alg_combined_oneline
    define alg_combined_computed: alg_combined
    define user_rel5: user_rel2 and user_rel3
    define user_rel4: user_rel1 or user_rel5
    define alg_inline: [user_b4, user_b4:*] and user_rel4 and (direct from direct_parent but not other_rel from mult_parent_types)
    define ttu_parent: [ttus_b4]
    define ttu_recursive: [user_b4] or ttu_recursive from ttu_parent
    define ttu_recursive_public: [user_b4:*] or ttu_recursive_public from ttu_parent
    define ttu_recursive_combined_w3: [user_b4, user_b4:*, employee_b4] or ttu_recursive_combined_w3 from ttu_parent or direct from direct_parent
    define ttu_recursive_alg_combined: ttu_recursive_alg_combined from ttu_parent or user_rel4
    define ttu_recursive_alg_combined_oneline: ([user_b4] or ttu_recursive_alg_combined_oneline from ttu_parent) or (user_rel1 or (user_rel2 and user_rel3))
    define ttu_recursive_alg_combined_w2: ([user_b4] or ttu_recursive_alg_combined from ttu_parent) or (user_rel1 or (user_rel2 and ttu_direct))
    define tuple_cycle_len2_ttu: [user_b4, employee_b4] or tuple_cycle_len2_ttu from mult_parent_types

condition xcond_b4(x: string) {
  x == '1'
}
