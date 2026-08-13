model
  schema 1.1
type user_b1a
type employee_b1a
type directs_user_b1a
  relations
    define direct_cond: [user_b1a with xcond_b1a]
    define computed_cond: direct_cond
    define direct: [user_b1a]
    define computed: direct
    define computed_computed: computed
    define butnot_computed_cond: computed_cond but not computed_computed
    define direct_and_direct_cond: [user_b1a, user_b1a with xcond_b1a, employee_b1a]
    define alg_combined: butnot_computed_cond but not direct_and_direct_cond
    define direct_wild: [user_b1a:*]
    define computed_wild: direct_wild
    define direct_wild_cond: [user_b1a:* with xcond_b1a]
    define computed_wild_cond: direct_wild_cond
    define direct_and_direct_wild: [user_b1a, user_b1a:*, employee_b1a:*]
type directs_employee_b1a
  relations
    define direct: [employee_b1a]
    define computed: direct
    define computed_computed: computed
    define computed_computed_computed: computed_computed
    define or_computed: computed_computed_computed or direct
    define and_computed: or_computed and direct
    define direct_2: [employee_b1a]
    define butnot_computed: and_computed but not direct_2
    define direct_cond: [employee_b1a with xcond_b1a]
    define alg_combined: butnot_computed and direct_cond
    define direct_wild: [employee_b1a:*]
    define direct_wild_cond: [employee_b1a:* with xcond_b1a]
type usersets_user_b1a
  relations
    define userset: [directs_user_b1a#direct, directs_employee_b1a#direct]
    define userset_alg: [directs_user_b1a#alg_combined, directs_employee_b1a#alg_combined]
    define userset_cond: [directs_user_b1a#direct with xcond_b1a]
    define userset_cond_to_computed: [directs_user_b1a#computed with xcond_b1a]
    define userset_cond_to_computed_cond: [directs_user_b1a#computed_cond with xcond_b1a]
    define userset_cond_to_computed_wild: [directs_user_b1a#computed_wild with xcond_b1a]
    define userset_cond_to_computed_wild_cond: [directs_user_b1a#computed_wild_cond with xcond_b1a]
    define userset_direct_and_direct_wild: [directs_user_b1a#direct_and_direct_wild]
    define userset_to_computed: [directs_user_b1a#computed, directs_employee_b1a#computed]
    define userset_to_computed_wild: [directs_user_b1a#computed_wild, directs_employee_b1a#direct_wild]
    define userset_to_computed_wild_cond: [directs_user_b1a#direct_wild_cond, directs_employee_b1a#direct_wild_cond]
type ttus_b1a
condition xcond_b1a(x: string) {
  x == '1'
}
