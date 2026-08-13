model
  schema 1.1

type user_a1

type team_a1
  relations
    define member: [user_a1, user_a1:*, team_a1#member]

type group_a1
  relations
    define member: [user_a1, group_a1#member]

type pair_a1
  relations
    define member: [user_a1, pair_a1#owner]
    define owner: [user_a1, pair_a1#member]

type folder_a1
  relations
    define viewer: [user_a1, user_a1:*]
    define blocked: [user_a1, user_a1:*]

type doc_a1
  relations
    define parent: [folder_a1]
    define owner: [team_a1]
    define a: [user_a1]
    define b: [user_a1]
    define c: [user_a1]
    define cyc: [group_a1#member]
    define cyc2: [pair_a1#member]
    define wild_blocked: [user_a1:*]

    define three_way: a and b and c
    define sub_of_sub: b but not c
    define nested_sub: a but not sub_of_sub
    define ttu_sub: a but not blocked from parent
    define int_ttu: viewer from parent and member from owner
    define int_and_excl: (a and b) but not c
    define union_with_excl: a or sub_of_sub
    define wide: a or b or c or sub_of_sub
    define cyc_excluded: a but not cyc
    define cyc_int: a and cyc
    define cyc2_excluded: a but not cyc2
    define cyc2_int: a and cyc2
    define wild_excluded: a but not wild_blocked
