model
  schema 1.1

type user_c5

type doc_c5
  relations
    define mod_c5: [user_c5 with mod_c5_c]
    define tsadd_c5: [user_c5 with tsadd_c5_c]
    define tsadd1_c5: [user_c5 with tsadd1_c5_c]
    define tssubd_c5: [user_c5 with tssubd_c5_c]
    define tssubt_c5: [user_c5 with tssubt_c5_c]
    define duradd_c5: [user_c5 with duradd_c5_c]

condition mod_c5_c(n: int) {
  n % -1 == 0
}

condition tsadd_c5_c(t: timestamp) {
  t + duration('2400000h') > t
}

condition tsadd1_c5_c(t: timestamp) {
  t + duration('1h') > t
}

condition tssubd_c5_c(t: timestamp) {
  t - duration('1h') < t
}

condition tssubt_c5_c(t: timestamp) {
  (t - timestamp('9999-12-31T23:59:59Z')) < duration('0s')
}

condition duradd_c5_c(d: duration) {
  (d + d) > d
}
