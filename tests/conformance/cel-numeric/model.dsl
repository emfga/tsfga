model
  schema 1.1

type user_a2

type doc_a2
  relations
    define neg_min_a2: [user_a2 with neg_min_a2_c]
    define div_min_a2: [user_a2 with div_min_a2_c]
    define int_of_dbl_a2: [user_a2 with int_of_dbl_a2_c]
    define int_of_dbl_neg_a2: [user_a2 with int_of_dbl_neg_a2_c]
    define dbl_of_str_a2: [user_a2 with dbl_of_str_a2_c]
    define dbl_of_str_neg_a2: [user_a2 with dbl_of_str_neg_a2_c]
    define dbl_of_str_zero_a2: [user_a2 with dbl_of_str_zero_a2_c]
    define dur_plus_a2: [user_a2 with dur_plus_a2_c]
    define dur_minus_a2: [user_a2 with dur_minus_a2_c]
    define uint_add_a2: [user_a2 with uint_add_a2_c]
    define uint_mul_a2: [user_a2 with uint_mul_a2_c]
    define str_of_dur_a2: [user_a2 with str_of_dur_a2_c]
    define str_of_ts_a2: [user_a2 with str_of_ts_a2_c]
    define str_order_a2: [user_a2 with str_order_a2_c]
    define int_add_a2: [user_a2 with int_add_a2_c]
    define int_mul_a2: [user_a2 with int_mul_a2_c]
    define uint_sub_a2: [user_a2 with uint_sub_a2_c]
    define str_order_ascii_a2: [user_a2 with str_order_ascii_a2_c]
    define str_of_dbl_a2: [user_a2 with str_of_dbl_a2_c]
    define ts_plus_a2: [user_a2 with ts_plus_a2_c]

condition neg_min_a2_c(n: int) {
  -n > 0
}

condition div_min_a2_c(n: int) {
  n / -1 > 0
}

condition int_of_dbl_a2_c(x: double) {
  int(x) > 0
}

condition int_of_dbl_neg_a2_c(x: double) {
  int(x) < 0
}

condition dbl_of_str_a2_c(s: string) {
  double(s) > 0.0
}

condition dbl_of_str_neg_a2_c(s: string) {
  double(s) < 0.0
}

condition dbl_of_str_zero_a2_c(s: string) {
  double(s) == 0.0
}

condition dur_plus_a2_c(d: duration) {
  d + duration('2400000h') > d
}

condition dur_minus_a2_c(d: duration) {
  duration('-2400000h') - d < d
}

condition uint_add_a2_c(n: uint) {
  n + 1u > 0u
}

condition uint_mul_a2_c(n: uint) {
  n * n > 0u
}

condition str_of_dur_a2_c(d: duration) {
  string(d) == '3600s'
}

condition str_of_ts_a2_c(t: timestamp) {
  string(t) == '2026-01-02T00:00:00Z'
}

condition str_order_a2_c(s: string) {
  s < '�'
}

condition int_add_a2_c(n: int) {
  n + 9223372036854775807 > 0
}

condition int_mul_a2_c(n: int) {
  n * n > 0
}

condition uint_sub_a2_c(n: uint) {
  n - 5u == 0u
}

condition str_order_ascii_a2_c(s: string) {
  s < 'b'
}

condition str_of_dbl_a2_c(x: double) {
  string(x) == '1.5'
}

condition ts_plus_a2_c(t: timestamp) {
  t + duration('2400000h') > t
}
