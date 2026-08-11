model
  schema 1.1

type user

type doc
  relations
    define typed: [user with typed_c]
    define suffixed: [user with suffixed_c]
    define converted: [user with converted_c]

condition typed_c(n: uint) {
  type(n) == uint
}

condition suffixed_c(n: uint) {
  n + 1u == 8u
}

condition converted_c(n: uint) {
  uint(n) + 1u == 8u
}
