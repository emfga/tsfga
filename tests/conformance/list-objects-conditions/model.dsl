model
  schema 1.1

type user_a4c

type group_a4c
  relations
    define member: [user_a4c with flag_a4]

type folder_a4c
  relations
    define viewer: [user_a4c]

type doc_a4c
  relations
    define parent: [folder_a4c with flag_a4]
    define direct: [user_a4c, user_a4c with flag_a4]
    define pub: [user_a4c:* with flag_a4]
    define grp: [group_a4c#member]
    define inherited: viewer from parent
    define blocked: [user_a4c with flag_a4]
    define guarded: direct but not blocked
    define strict: [user_a4c with needs_x_a4]

condition flag_a4(flag: bool) {
  flag == true
}

condition needs_x_a4(x: int) {
  x > 5
}
