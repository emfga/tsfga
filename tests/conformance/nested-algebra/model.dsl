model
  schema 1.1

type user_a7

type group_a7
  relations
    define member: [user_a7]

type folder_a7
  relations
    define viewer: [user_a7]
    define editor: [user_a7]
    define reader: viewer or editor

type doc_a7
  relations
    define parent: [folder_a7]
    define a: [user_a7]
    define b: [user_a7]
    define c: [user_a7]
    define u_mixed: a or b or viewer from parent or (c and a)
    define i3: a and b and c
    define i_union: (a or b) and c
    define i_union2: a and (b or c)
    define e_union: a but not (b or c)
    define e_inter: a but not (b and c)
    define e_union_base: (a or b) but not c
    define e_in_i: (a but not b) and c
    define i_in_e: (a and b) but not c
    define u_excl: c or (a but not b)
    define ttu_union: reader from parent
    define direct_or: [user_a7] or a
    define direct_and: [user_a7] and viewer from parent
    define direct_not: [user_a7] but not b
    define all_refs: [user_a7, user_a7:*, group_a7#member, user_a7 with weekday_only_a7]

condition weekday_only_a7(day: string) {
  day == "monday"
}
