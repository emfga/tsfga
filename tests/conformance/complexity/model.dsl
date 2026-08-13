model
  schema 1.1

type user_b2

type employee_b2

type directs_user_b2
  relations
    define direct: [user_b2]
    define direct_cond: [user_b2 with xcond_b2]
    define direct_wild: [user_b2:*]
    define computed: direct
    define computed_cond: direct_cond
    define or_computed: computed or computed_cond or direct_wild
    define tuple_cycle3: [user_b2, complexity3_b2#cycle_nested]
    define compute_tuple_cycle3: tuple_cycle3

type directs_employee_b2
  relations
    define direct: [employee_b2]

type usersets_user_b2
  relations
    define userset: [directs_user_b2#direct, directs_employee_b2#direct]
    define ttu_direct_userset: [ttus_b2#direct_pa_direct_ch]
    define tuple_cycle3: [directs_user_b2#compute_tuple_cycle3]
    define userset_mix_public: [directs_user_b2#direct, directs_user_b2:*, user_b2, user_b2:*]
    define or_userset_mix_public: [user_b2, user_b2:*] or userset_mix_public

type ttus_b2
  relations
    define direct_parent: [directs_user_b2]
    define mult_parent_types: [directs_user_b2, directs_employee_b2]
    define userset_parent: [usersets_user_b2]
    define direct_pa_direct_ch: direct from mult_parent_types
    define or_comp_from_direct_parent: or_computed from direct_parent
    define and_ttu: or_comp_from_direct_parent and direct_pa_direct_ch
    define userset_pa_userset_ch: userset from userset_parent
    define tuple_cycle3: tuple_cycle3 from userset_parent

type complexity3_b2
  relations
    define ttu_parent: [ttus_b2]
    define userset_parent: [usersets_user_b2]
    define ttu_userset_ttu: ttu_direct_userset from userset_parent
    define ttu_ttu_userset: userset_pa_userset_ch from ttu_parent
    define userset_ttu_userset: [ttus_b2#userset_pa_userset_ch]
    define userset_userset_ttu: [usersets_user_b2#ttu_direct_userset]
    define compute_ttu_userset_ttu: ttu_userset_ttu
    define compute_userset_ttu_userset: userset_ttu_userset
    define or_compute_complex3: compute_ttu_userset_ttu or compute_userset_ttu_userset
    define and_nested_complex3: [ttus_b2#and_ttu] and compute_ttu_userset_ttu
    define cycle_nested: [ttus_b2#tuple_cycle3]
    define or_userset_mix_public_complex3: or_userset_mix_public from userset_parent

type complexity4_b2
  relations
    define parent: [complexity3_b2]
    define userset_ttu_userset_ttu: [complexity3_b2#ttu_userset_ttu]
    define ttu_ttu_ttu_userset: ttu_ttu_userset from parent
    define userset_or_compute_complex3: [complexity3_b2#or_compute_complex3]
    define ttu_and_nested_complex3: and_nested_complex3 from parent
    define or_complex4: userset_or_compute_complex3 or ttu_and_nested_complex3

condition xcond_b2(x: string) {
  x == '1'
}
