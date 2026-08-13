model
  schema 1.1

type user_d2

type doc_d2
  relations
    define durctx_d2: [user_d2 with durctx_d2_c]
    define durlist_d2: [user_d2 with durlist_d2_c]
    define durmap_d2: [user_d2 with durmap_d2_c]
    define dblctx_d2: [user_d2 with dblctx_d2_c]
    define dbllist_d2: [user_d2 with dbllist_d2_c]
    define intctx_d2: [user_d2 with intctx_d2_c]
    define uintctx_d2: [user_d2 with uintctx_d2_c]
    define strctx_d2: [user_d2 with strctx_d2_c]
    define boolctx_d2: [user_d2 with boolctx_d2_c]
    define tsctx_d2: [user_d2 with tsctx_d2_c]
    define tslist_d2: [user_d2 with tslist_d2_c]

condition durctx_d2_c(d: duration) {
  d > duration('0s')
}

condition durlist_d2_c(ds: list<duration>) {
  ds[0] > duration('0s')
}

condition durmap_d2_c(dm: map<duration>) {
  dm['a'] > duration('0s')
}

condition dblctx_d2_c(x: double) {
  x > 0.0
}

condition dbllist_d2_c(xs: list<double>) {
  xs[0] > 0.0
}

condition intctx_d2_c(n: int) {
  n > 0
}

condition uintctx_d2_c(u: uint) {
  u > 0u
}

condition strctx_d2_c(s: string) {
  s == 'x'
}

condition boolctx_d2_c(b: bool) {
  b
}

condition tsctx_d2_c(t: timestamp) {
  t > timestamp('2020-01-01T00:00:00Z')
}

condition tslist_d2_c(ts: list<timestamp>) {
  ts[0] > timestamp('2020-01-01T00:00:00Z')
}
