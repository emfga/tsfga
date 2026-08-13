model
  schema 1.1
type user_b1c
type employee_b1c
type directs_user_b1c
  relations
    define direct: [user_b1c]
    define direct_wild: [user_b1c:*]
type directs_employee_b1c
  relations
    define direct: [employee_b1c]
type usersets_user_b1c
  relations
    define direct_3: [user_b1c]
    define direct_2: [user_b1c] and direct_3
    define direct: [user_b1c] or direct_2
    define computed: direct
    define direct_4: [user_b1c]
    define butnot_computed: computed but not direct_4
    define alg_combined: butnot_computed but not direct_4
    define alg_cond_combined: [user_b1c with xcond_b1c] or alg_combined
    define direct_wild: [user_b1c:*]
    define userset_mix_public: [directs_user_b1c#direct, directs_user_b1c:*, user_b1c, user_b1c:*]
    define or_userset_mix_public: [user_b1c, user_b1c:*] or userset_mix_public
    define userset: [directs_user_b1c#direct, directs_employee_b1c#direct]
    define userset_recursive: [user_b1c, usersets_user_b1c#userset_recursive]
    define userset_recursive_alg: [user_b1c, usersets_user_b1c#userset_recursive_alg] or alg_combined
    define userset_recursive_mixed_direct_assignment: [user_b1c, usersets_user_b1c#userset_recursive_mixed_direct_assignment, usersets_user_b1c#userset]
    define userset_recursive_public: [user_b1c, user_b1c:*, usersets_user_b1c#userset_recursive_public]
    define userset_recursive_public_alg: [user_b1c, user_b1c:*, usersets_user_b1c#userset_recursive_public_alg] or alg_combined or direct_wild
    define userset_recursive_public_alg_cond: [user_b1c with xcond_b1c, user_b1c:*, usersets_user_b1c#userset_recursive_public_alg_cond with xcond_b1c] or alg_cond_combined or direct_wild
    define userset_recursive_public_only: [user_b1c:*, usersets_user_b1c#userset_recursive_public_only]
    define userset_recursive_public_only_alg: [user_b1c, user_b1c:*, usersets_user_b1c#userset_recursive_public_only_alg] or direct_wild
condition xcond_b1c(x: string) {
  x == '1'
}
