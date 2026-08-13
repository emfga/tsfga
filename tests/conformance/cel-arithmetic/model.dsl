model
  schema 1.1

type user_c5b

type doc_c5b
  relations
    define durctx_c5b: [user_c5b with durctx_c5b_c]
    define durofs_c5b: [user_c5b with durofs_c5b_c]
    define durdiff_c5b: [user_c5b with durdiff_c5b_c]
    define durts_c5b: [user_c5b with durts_c5b_c]
    define durtslit_c5b: [user_c5b with durtslit_c5b_c]
    define tsdiff_c5b: [user_c5b with tsdiff_c5b_c]
    define tssubdc_c5b: [user_c5b with tssubdc_c5b_c]
    define grace_c5b: [user_c5b with grace_c5b_c]
    define tsctx_c5b: [user_c5b with tsctx_c5b_c]
    define intctx_c5b: [user_c5b with intctx_c5b_c]
    define idiv0_c5b: [user_c5b with idiv0_c5b_c]
    define imod0_c5b: [user_c5b with imod0_c5b_c]
    define isub_c5b: [user_c5b with isub_c5b_c]
    define udiv0_c5b: [user_c5b with udiv0_c5b_c]
    define umod0_c5b: [user_c5b with umod0_c5b_c]
    define umul_c5b: [user_c5b with umul_c5b_c]
    define ddiv0_c5b: [user_c5b with ddiv0_c5b_c]
    define dmul_c5b: [user_c5b with dmul_c5b_c]

condition durctx_c5b_c(d: duration) {
  d > duration('0s')
}

condition durofs_c5b_c(s: string) {
  duration(s) > duration('0s')
}

condition durdiff_c5b_c(a: duration, b: duration) {
  (a - b) > duration('0s')
}

condition durts_c5b_c(t: timestamp, d: duration) {
  d + t > t
}

condition durtslit_c5b_c(t: timestamp) {
  duration('1h') + t > t
}

condition tsdiff_c5b_c(a: timestamp, b: timestamp) {
  (a - b) < duration('0s')
}

condition tssubdc_c5b_c(t: timestamp, d: duration) {
  t - d < t
}

condition grace_c5b_c(t: timestamp) {
  t + duration('24h') > timestamp('2026-01-01T00:00:00Z')
}

condition tsctx_c5b_c(t: timestamp) {
  t > timestamp('2020-01-01T00:00:00Z')
}

condition intctx_c5b_c(n: int) {
  n > 0
}

condition idiv0_c5b_c(n: int) {
  n / 0 > 0
}

condition imod0_c5b_c(n: int) {
  n % 0 == 0
}

condition isub_c5b_c(n: int) {
  n - 9223372036854775807 < 0
}

condition udiv0_c5b_c(n: uint) {
  n / 0u > 0u
}

condition umod0_c5b_c(n: uint) {
  n % 0u == 0u
}

condition umul_c5b_c(n: uint) {
  n * n > 0u
}

condition ddiv0_c5b_c(x: double) {
  x / 0.0 > 0.0
}

condition dmul_c5b_c(x: double) {
  x * x > 0.0
}
