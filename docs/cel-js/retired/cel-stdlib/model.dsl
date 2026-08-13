model
  schema 1.1

type user_c5

type doc_c5
  relations
    define mg_c5: [user_c5 with mg_c5_c]
    define mr_c5: [user_c5 with mr_c5_c]
    define it_c5: [user_c5 with it_c5_c]
    define id_c5: [user_c5 with id_c5_c]
    define is_c5: [user_c5 with is_c5_c]
    define iu_c5: [user_c5 with iu_c5_c]
    define st_c5: [user_c5 with st_c5_c]
    define ti_c5: [user_c5 with ti_c5_c]
    define ty_c5: [user_c5 with ty_c5_c]
    define by_c5: [user_c5 with by_c5_c]
    define bo_c5: [user_c5 with bo_c5_c]
    define sz_c5: [user_c5 with sz_c5_c]

condition mg_c5_c(s: string, p: string) {
  matches(s, p)
}

condition mr_c5_c(s: string, p: string) {
  s.matches(p)
}

condition it_c5_c(t: timestamp) {
  int(t) == 1767225600
}

condition id_c5_c(d: duration) {
  int(d) == 3600000000000
}

condition is_c5_c(s: string) {
  int(s) == 7
}

condition iu_c5_c(n: uint) {
  int(n) == 7
}

condition st_c5_c(t: timestamp) {
  string(t) == '2026-01-01T00:00:00Z'
}

condition ti_c5_c(n: int) {
  timestamp(n) == timestamp('1970-01-01T00:00:01Z')
}

condition ty_c5_c(n: int) {
  type(n) == int
}

condition by_c5_c(s: string) {
  size(bytes(s)) == 3
}

condition bo_c5_c(s: string) {
  bool(s)
}

condition sz_c5_c(s: string) {
  s.size() == 3
}
