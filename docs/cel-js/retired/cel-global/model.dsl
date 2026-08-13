model
  schema 1.1

type user_c2g

type doc_c2g
  relations
    define recv_posix: [user_c2g with recv_posix_c2]
    define global_posix: [user_c2g with global_posix_c2]
    define global_plain: [user_c2g with global_plain_c2]
    define comment_arg: [user_c2g with comment_arg_c2]
    define slashes: [user_c2g with slashes_c2]
    define nest_parens: [user_c2g with nest_parens_c2]
    define raw_pattern: [user_c2g with raw_pattern_c2]
    define list_hetero: [user_c2g with list_hetero_c2]
    define list_dynfirst: [user_c2g with list_dynfirst_c2]
    define two_calls: [user_c2g with two_calls_c2]

condition recv_posix_c2(s: string) {
  s.matches("[[:alpha:]]+")
}

condition global_posix_c2(s: string) {
  matches(s, "[[:alpha:]]+")
}

condition global_plain_c2(s: string) {
  matches(s, "^a.c$")
}

condition comment_arg_c2(s: string) {
  s.matches(
    // the pattern lives on its own line
    "[[:alpha:]]+")
}

condition slashes_c2(s: string) {
  ("//" + s).matches("[[:alpha:]]+")
}

condition nest_parens_c2(s: string) {
  ((((s)))).matches("[[:alpha:]]+")
}

condition raw_pattern_c2(s: string) {
  s.matches(r"[[:alpha:]]+")
}

condition list_hetero_c2(s: string) {
  ["x", s][1].matches("[[:alpha:]]+")
}

condition list_dynfirst_c2(s: string) {
  [s, "//"][0].matches("[[:alpha:]]+")
}

condition two_calls_c2(s: string) {
  s.matches("a//b") || s.matches("[[:alpha:]]+")
}
