model
  schema 1.1

type user

type doc
  relations
    define arith: [user with arith_c]
    define precise: [user with precise_c]
    define saturating: [user with saturating_c]
    define typed: [user with typed_c]
    define overflowing: [user with overflowing_c]

condition arith_c(n: int) {
  n + 1 == 8 && n - 1 == 6 && n * 2 == 14 && n / 2 == 3 && n % 2 == 1
}

condition precise_c(n: int) {
  n == 9007199254740993 && n > 9007199254740992
}

condition saturating_c(n: int) {
  n == 9223372036854775807
}

condition typed_c(n: int) {
  type(n) == int
}

condition overflowing_c(n: int) {
  n + 1 > 0
}
