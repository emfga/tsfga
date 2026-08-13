model
  schema 1.1

type user_a2

type doc_a2
  relations
    define re_match_a2: [user_a2 with re_gate_a2]

condition re_gate_a2(s: string, r: string) {
  s.matches(r)
}
