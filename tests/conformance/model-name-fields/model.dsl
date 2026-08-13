model
  schema 1.1

type user_c2n

type doc_c2n
  relations
    define viewer: [user_c2n with ok_c2n]

condition ok_c2n(s: string) {
  s != "zzz"
}
