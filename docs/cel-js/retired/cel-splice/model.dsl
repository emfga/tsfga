model
  schema 1.1

type user_b3c

type doc_b3c
  relations
    define bare_posix: [user_b3c with bare_posix_b3]
    define paren_posix: [user_b3c with paren_posix_b3]
    define bare_flags: [user_b3c with bare_flags_b3]
    define paren_flags: [user_b3c with paren_flags_b3]
    define concat_posix: [user_b3c with concat_posix_b3]
    define index_posix: [user_b3c with index_posix_b3]
    define ternary_posix: [user_b3c with ternary_posix_b3]

condition bare_posix_b3(s: string) {
  s.matches("[[:alpha:]]+")
}

condition paren_posix_b3(s: string) {
  (s).matches("[[:alpha:]]+")
}

condition bare_flags_b3(s: string) {
  s.matches("(?i)ABC")
}

condition paren_flags_b3(s: string) {
  (s).matches("(?i)ABC")
}

condition concat_posix_b3(s: string) {
  (s + "").matches("[[:alpha:]]+")
}

condition index_posix_b3(s: string) {
  [s][0].matches("[[:alpha:]]+")
}

condition ternary_posix_b3(s: string) {
  (s == "" ? "zzz" : s).matches("[[:alpha:]]+")
}
