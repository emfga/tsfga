model
  schema 1.1
type user_b1f
type employee_b1f
type directs_user_b1f
  relations
    define tuple_cycle3: [user_b1f, complexity3_b1f#cycle_nested]
    define compute_tuple_cycle3: tuple_cycle3
    define direct_cond: [user_b1f with xcond_b1f]
    define computed_cond: direct_cond
    define direct_wild: [user_b1f:*]
    define computed_wild: direct_wild
    define and_computed: computed_cond and computed_wild
    define direct: [user_b1f]
    define computed: direct
    define or_computed: computed or computed_cond or direct_wild
    define tuple_cycle2: [user_b1f, usersets_user_b1f#tuple_cycle2, employee_b1f]
type directs_employee_b1f
  relations
    define direct: [employee_b1f]
type usersets_user_b1f
  relations
    define tuple_cycle3: [directs_user_b1f#compute_tuple_cycle3]
    define tuple_cycle2: [ttus_b1f#tuple_cycle2]
    define ttu_and_direct_userset: [ttus_b1f#and_comp_from_direct_parent]
    define ttu_direct_cond_userset: [ttus_b1f#direct_cond_pa_direct_ch]
    define ttu_direct_userset: [ttus_b1f#direct_pa_direct_ch]
    define ttu_or_direct_userset: [ttus_b1f#or_comp_from_direct_parent]
type ttus_b1f
  relations
    define userset_parent: [usersets_user_b1f]
    define tuple_cycle3: tuple_cycle3 from userset_parent
    define direct_parent: [directs_user_b1f]
    define tuple_cycle2: tuple_cycle2 from direct_parent
    define direct_cond_parent: [directs_user_b1f with xcond_b1f]
    define and_comp_from_direct_parent: and_computed from direct_cond_parent
    define mult_parent_types_cond: [directs_user_b1f with xcond_b1f, directs_employee_b1f with xcond_b1f]
    define direct_cond_pa_direct_ch: direct from mult_parent_types_cond
    define mult_parent_types: [directs_user_b1f, directs_employee_b1f]
    define direct_pa_direct_ch: direct from mult_parent_types
    define or_comp_from_direct_parent: or_computed from direct_parent
type complexity3_b1f
  relations
    define cycle_nested: [ttus_b1f#tuple_cycle3]
condition xcond_b1f(x: string) {
  x == '1'
}
