model
  schema 1.1

type user

type doc
  relations
    define v: [user with at_least]

condition at_least(n: int) {
  n >= 40
}
