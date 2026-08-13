model
  schema 1.1

type user_a8

type rgroup_a8
  relations
    define member: [user_a8, rgroup_a8#member]

type rfolder_a8
  relations
    define parent: [rfolder_a8]
    define viewer: [user_a8] or viewer from parent

type rdoc_a8
  relations
    define base: [user_a8]
    define loopset: [rgroup_a8#member]
    define loopttu: [rfolder_a8#viewer]
    define subtract_userset: base but not loopset
    define subtract_ttu: base but not loopttu
    define union_userset: base or loopset
    define intersect_userset: base and loopset
