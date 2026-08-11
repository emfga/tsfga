model
  schema 1.1

type user

type report
  relations
    define viewer: [user with at_least]

condition at_least(n: int) {
  n >= 10
}
