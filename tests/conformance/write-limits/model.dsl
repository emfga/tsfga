model
  schema 1.1

type user_b3w

type doc_b3w
  relations
    define bare: [user_b3w]
    define big: [user_b3w with big_b3]
    define both: [user_b3w, user_b3w with big_b3]
    define wild: [user_b3w:*]

condition big_b3(s: string) {
  s != "zzz"
}
