model
  schema 1.1
type user_b1d
type employee_b1d
type directs_user_b1d
  relations
    define direct_cond: [user_b1d with xcond_b1d]
    define computed_cond: direct_cond
    define direct_wild: [user_b1d:*]
    define computed_wild: direct_wild
    define and_computed: computed_cond and computed_wild
    define direct_wild_cond: [user_b1d:* with xcond_b1d]
    define computed_wild_cond: direct_wild_cond
    define direct: [user_b1d]
    define computed: direct
    define computed_computed: computed
    define butnot_computed: computed_wild_cond but not computed_computed
    define or_computed: computed or computed_cond or direct_wild
type directs_employee_b1d
  relations
    define direct: [employee_b1d]
    define computed: direct
    define direct_cond: [employee_b1d with xcond_b1d]
    define direct_wild: [employee_b1d:*]
    define direct_wild_cond: [employee_b1d:* with xcond_b1d]
type usersets_user_b1d
  relations
    define userset_to_computed_wild: [directs_user_b1d#computed_wild, directs_employee_b1d#direct_wild]
    define userset: [directs_user_b1d#direct, directs_employee_b1d#direct]
    define userset_to_computed: [directs_user_b1d#computed, directs_employee_b1d#computed]
    define userset_to_computed_cond: [directs_user_b1d#computed_cond, directs_employee_b1d#direct_cond]
    define userset_to_computed_wild_cond: [directs_user_b1d#direct_wild_cond, directs_employee_b1d#direct_wild_cond]
type ttus_b1d
  relations
    define direct_cond_parent: [directs_user_b1d with xcond_b1d]
    define and_comp_from_direct_parent: and_computed from direct_cond_parent
    define direct_parent: [directs_user_b1d]
    define or_comp_from_direct_parent: or_computed from direct_parent
    define mult_parent_types: [directs_user_b1d, directs_employee_b1d]
    define direct_pa_direct_ch: direct from mult_parent_types
    define and_ttu: or_comp_from_direct_parent and direct_pa_direct_ch
    define butnot_comp_from_direct_parent: butnot_computed from direct_cond_parent
    define mult_parent_types_cond: [directs_user_b1d with xcond_b1d, directs_employee_b1d with xcond_b1d]
    define direct_cond_pa_direct_ch: direct from mult_parent_types_cond
    define userset_parent: [usersets_user_b1d]
    define userset_pa_userset_comp_wild_ch: userset_to_computed_wild from userset_parent
    define nested_butnot_ttu: or_comp_from_direct_parent but not userset_pa_userset_comp_wild_ch
    define or_ttu: direct_pa_direct_ch or direct_cond_pa_direct_ch
    define userset_cond_parent: [usersets_user_b1d with xcond_b1d]
    define userset_cond_userset_ch: userset from userset_cond_parent
    define userset_cond_userset_comp_ch: userset_to_computed from userset_cond_parent
    define userset_cond_userset_comp_cond_ch: userset_to_computed_cond from userset_cond_parent
    define userset_cond_userset_comp_wild_ch: userset_to_computed_wild from userset_cond_parent
    define userset_cond_userset_comp_wild_cond_ch: userset_to_computed_wild_cond from userset_cond_parent
    define userset_pa_userset_ch: userset from userset_parent
    define userset_pa_userset_comp_ch: userset_to_computed from userset_parent
    define userset_pa_userset_comp_cond_ch: userset_to_computed_cond from userset_parent
    define userset_pa_userset_comp_wild_cond_ch: userset_to_computed_wild_cond from userset_parent
condition xcond_b1d(x: string) {
  x == '1'
}
