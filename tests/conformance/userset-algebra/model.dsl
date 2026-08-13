model
  schema 1.1
type user_b1b
type employee_b1b
type directs_user_b1b
  relations
    define direct_cond: [user_b1b with xcond_b1b]
    define computed_cond: direct_cond
    define direct_wild: [user_b1b:*]
    define computed_wild: direct_wild
    define and_computed: computed_cond and computed_wild
    define direct_wild_cond: [user_b1b:* with xcond_b1b]
    define computed_wild_cond: direct_wild_cond
    define direct: [user_b1b]
    define computed: direct
    define computed_computed: computed
    define butnot_computed: computed_wild_cond but not computed_computed
    define or_computed: computed or computed_cond or direct_wild
    define or_computed_no_cond: computed or direct_wild
type directs_employee_b1b
  relations
    define direct: [employee_b1b]
    define direct_cond: [employee_b1b with xcond_b1b]
    define direct_wild: [employee_b1b:*]
type usersets_user_b1b
  relations
    define userset_to_computed_cond: [directs_user_b1b#computed_cond, directs_employee_b1b#direct_cond]
    define userset_to_computed_wild: [directs_user_b1b#computed_wild, directs_employee_b1b#direct_wild]
    define and_userset: userset_to_computed_cond and userset_to_computed_wild
    define userset_cond_to_computed_wild: [directs_user_b1b#computed_wild with xcond_b1b]
    define userset_cond: [directs_user_b1b#direct with xcond_b1b]
    define butnot_userset: userset_cond_to_computed_wild but not userset_cond
    define userset_to_and_computed: [directs_user_b1b#and_computed]
    define userset_to_or_computed: [directs_user_b1b#or_computed]
    define nested_and_userset: userset_to_and_computed and userset_to_or_computed
    define userset_to_butnot_computed: [directs_user_b1b#butnot_computed]
    define nested_or_userset: userset_to_or_computed or userset_to_butnot_computed
    define userset: [directs_user_b1b#direct, directs_employee_b1b#direct]
    define or_userset: userset or userset_to_computed_cond
    define userset_to_or_computed_no_cond: [directs_user_b1b#or_computed_no_cond]
condition xcond_b1b(x: string) {
  x == '1'
}
