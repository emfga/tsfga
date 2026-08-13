model
  schema 1.1
type user_b1g
type du_b1g
  relations
    define direct: [user_b1g]
    define direct_cond: [user_b1g with xcond_b1g]
    define computed: direct
    define computed_cond: direct_cond
    define or_computed: computed or computed_cond
type tt_b1g
  relations
    define direct_parent: [du_b1g]
    define ttu: or_computed from direct_parent
type uu_b1g
  relations
    define userset: [du_b1g#or_computed]
    define blocked: [du_b1g#or_computed]
    define allowed: userset but not blocked
condition xcond_b1g(x: string) {
  x == '1'
}
