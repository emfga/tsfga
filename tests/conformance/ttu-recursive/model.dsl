model
  schema 1.1
type user_b1e
type employee_b1e
type directs_user_b1e
  relations
    define direct: [user_b1e]
    define computed: direct
    define direct_wild: [user_b1e:*]
    define or_computed_no_cond: computed or direct_wild
    define mixed_use: or_computed_no_cond
type ttus_b1e
  relations
    define direct_3: [user_b1e]
    define direct_2: [user_b1e] and direct_3
    define direct: [user_b1e] or direct_2
    define computed: direct
    define direct_4: [user_b1e]
    define butnot_computed: computed but not direct_4
    define alg_combined: butnot_computed but not direct_4
    define alg_combined_cond: [user_b1e with xcond_b1e] or alg_combined
    define direct_wild: [directs_user_b1e:*]
    define mixed_ttu_parent: [ttus_b1e, directs_user_b1e]
    define mixed_use: [directs_user_b1e] or mixed_use from mixed_ttu_parent
    define ttu_parent: [ttus_b1e]
    define recursive_ttu: [directs_user_b1e] or recursive_ttu from ttu_parent
    define recursive_ttu_alg: [directs_user_b1e] or recursive_ttu_alg from ttu_parent or alg_combined
    define ttu_parent_cond: [ttus_b1e with xcond_b1e]
    define recursive_ttu_alg_cond: [directs_user_b1e with xcond_b1e] or recursive_ttu_alg_cond from ttu_parent_cond or alg_combined_cond
    define recursive_ttu_public: [directs_user_b1e, directs_user_b1e:*] or recursive_ttu_public from ttu_parent
    define recursive_ttu_public_alg: [directs_user_b1e, directs_user_b1e:*] or recursive_ttu_public_alg from ttu_parent or direct_wild
type multi_recursive_b1e
  relations
    define child: [multi_recursive_b1e]
    define parent: [multi_recursive_b1e]
    define multi_recursive_ttu: [user_b1e] or multi_recursive_ttu from parent or multi_recursive_ttu from child
condition xcond_b1e(x: string) {
  x == '1'
}
