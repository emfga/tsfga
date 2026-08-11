model
  schema 1.1

type user

type doc
  relations
    define both: [user, user with cond_a]
    define conditioned: [user with cond_a]

condition cond_a(n: int) {
  n >= 40
}

condition cond_b(n: int) {
  n >= 10
}
