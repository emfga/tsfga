model
  schema 1.1

type user_c5

type doc_c5
  relations
    define re_c5: [user_c5 with re_gate_c5]

condition re_gate_c5(s: string, p: string) {
  s.matches(p)
}
