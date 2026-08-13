model
  schema 1.1

type user_a3

type team_a3
  relations
    define member: [user_a3]
    define secret: [user_a3]

type folder_a3
  relations
    define viewer: [user_a3]

type doc_a3
  relations
    define parent: [folder_a3]
    define bare: [user_a3]
    define cond_only: [user_a3 with cond_a3]
    define other_cond: [user_a3 with other_a3]
    define both: [user_a3, user_a3 with cond_a3]
    define userset_only: [team_a3#member]
    define wildcard_only: [user_a3:*]
    define wildcard_cond: [user_a3:* with cond_a3]
    define big: [user_a3 with bigstring_a3]
    define computed: bare
    define from_parent: viewer from parent
    define self_a: [doc_a3#self_a, doc_a3#self_b]
    define self_b: [user_a3, doc_a3#self_a]

condition cond_a3(n: int) {
  n > 5
}

condition other_a3(n: int) {
  n > 1
}

condition bigstring_a3(s: string) {
  s != ""
}
