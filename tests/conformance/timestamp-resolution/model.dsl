model
  schema 1.1

type user

type doc
  relations
    define eq_nano: [user with eq_nano_c]
    define eq_micro: [user with eq_micro_c]
    define gt_half_ms: [user with gt_half_ms_c]
    define gt_nano: [user with gt_nano_c]
    define ctl_ms: [user with ctl_ms_c]
    define ctl_exact: [user with ctl_exact_c]

condition eq_nano_c(n: timestamp) {
  n == timestamp('2026-01-01T00:00:00Z')
}

condition eq_micro_c(n: timestamp) {
  n == timestamp('2026-01-01T00:00:00Z')
}

condition gt_half_ms_c(n: timestamp) {
  n > timestamp('2026-01-01T00:00:00Z')
}

condition gt_nano_c(n: timestamp) {
  n > timestamp('2026-01-01T00:00:00.000000000Z')
}

condition ctl_ms_c(n: timestamp) {
  n > timestamp('2026-01-01T00:00:00Z')
}

condition ctl_exact_c(n: timestamp) {
  n == timestamp('2026-01-01T00:00:00Z')
}
