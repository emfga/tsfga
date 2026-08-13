model
  schema 1.1

type user_c5

type group_c5
  relations
    define member: [user_c5 with g1_c5]

type folder_c5
  relations
    define viewer: [group_c5#member, group_c5#member with g2_c5]

type doc_c5
  relations
    define parent: [folder_c5 with g3_c5]
    define viewer: viewer from parent
    define ctl: [user_c5 with ctl_c5]

condition g1_c5(n: int) {
  n > 0
}

condition g2_c5(m: int) {
  m > 0
}

condition g3_c5(k: int) {
  k > 0
}

condition ctl_c5(s: string) {
  s.size() == 3
}
