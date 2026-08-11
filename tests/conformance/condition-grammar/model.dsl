model
  schema 1.1

type user

type doc
  relations
    define blocked_int_exp: [user with int_exp_c]
    define int_exp: [user] but not blocked_int_exp
    define blocked_int_point: [user with int_point_c]
    define int_point: [user] but not blocked_int_point
    define blocked_uint_sat: [user with uint_sat_c]
    define uint_sat: [user] but not blocked_uint_sat
    define blocked_dbl_hex: [user with dbl_hex_c]
    define dbl_hex: [user] but not blocked_dbl_hex
    define blocked_dbl_pad: [user with dbl_pad_c]
    define dbl_pad: [user] but not blocked_dbl_pad
    define blocked_dbl_prec: [user with dbl_prec_c]
    define dbl_prec: [user] but not blocked_dbl_prec
    define blocked_dbl_inexact: [user with dbl_inexact_c]
    define dbl_inexact: [user] but not blocked_dbl_inexact
    define blocked_dbl_inf: [user with dbl_inf_c]
    define dbl_inf: [user] but not blocked_dbl_inf
    define blocked_dbl_ninf: [user with dbl_ninf_c]
    define dbl_ninf: [user] but not blocked_dbl_ninf
    define blocked_dur_zero: [user with dur_zero_c]
    define dur_zero: [user] but not blocked_dur_zero
    define blocked_dur_neg_zero: [user with dur_neg_zero_c]
    define dur_neg_zero: [user] but not blocked_dur_neg_zero
    define blocked_ts_lower: [user with ts_lower_c]
    define ts_lower: [user] but not blocked_ts_lower
    define blocked_ts_lower_zone: [user with ts_lower_zone_c]
    define ts_lower_zone: [user] but not blocked_ts_lower_zone
    define blocked_ts_frac: [user with ts_frac_c]
    define ts_frac: [user] but not blocked_ts_frac
    define blocked_list_string: [user with list_string_c]
    define list_string: [user] but not blocked_list_string
    define blocked_map_string: [user with map_string_c]
    define map_string: [user] but not blocked_map_string
    define blocked_list_int_bad: [user with list_int_bad_c]
    define list_int_bad: [user] but not blocked_list_int_bad
    define blocked_list_int: [user with list_int_c]
    define list_int: [user] but not blocked_list_int
    define blocked_map_int: [user with map_int_c]
    define map_int: [user] but not blocked_map_int
    define blocked_ok_int: [user with ok_int_c]
    define ok_int: [user] but not blocked_ok_int
    define blocked_ok_double: [user with ok_double_c]
    define ok_double: [user] but not blocked_ok_double
    define blocked_ok_duration: [user with ok_duration_c]
    define ok_duration: [user] but not blocked_ok_duration
    define blocked_ok_timestamp: [user with ok_timestamp_c]
    define ok_timestamp: [user] but not blocked_ok_timestamp
    define blocked_ok_list: [user with ok_list_c]
    define ok_list: [user] but not blocked_ok_list

condition int_exp_c(n: int) {
  n == 1000
}

condition int_point_c(n: int) {
  n == 4
}

condition uint_sat_c(n: uint) {
  n == 9223372036854775807u
}

condition dbl_hex_c(n: double) {
  n == 16.0
}

condition dbl_pad_c(n: double) {
  n == 1.5
}

condition dbl_prec_c(n: double) {
  n == 1.0
}

condition dbl_inexact_c(n: double) {
  n > 0.0
}

condition dbl_inf_c(n: double) {
  n > 1.0
}

condition dbl_ninf_c(n: double) {
  n < 1.0
}

condition dur_zero_c(n: duration) {
  n == duration('0s')
}

condition dur_neg_zero_c(n: duration) {
  n == duration('0s')
}

condition ts_lower_c(n: timestamp) {
  n == timestamp('2026-01-01T00:00:00Z')
}

condition ts_lower_zone_c(n: timestamp) {
  n == timestamp('2026-01-01T00:00:00Z')
}

condition ts_frac_c(n: timestamp) {
  n > timestamp('2026-01-01T00:00:00Z')
}

condition list_string_c(n: list<string>) {
  'a' in n
}

condition map_string_c(n: map<string>) {
  n['a'] == 'x'
}

condition list_int_bad_c(n: list<int>) {
  1 in n
}

condition list_int_c(n: list<int>) {
  n[0] + 1 == 2
}

condition map_int_c(n: map<int>) {
  n['a'] + 1 == 2
}

condition ok_int_c(n: int) {
  n == 42
}

condition ok_double_c(n: double) {
  n == 1.5
}

condition ok_duration_c(n: duration) {
  n == duration('0s')
}

condition ok_timestamp_c(n: timestamp) {
  n > timestamp('2026-01-01T00:00:00Z')
}

condition ok_list_c(n: list<string>) {
  'a' in n
}
