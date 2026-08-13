model
  schema 1.1

type user_d1

type doc_d1
  relations
    define re_d1: [user_d1 with re_gate_d1]

condition re_gate_d1(s: string, p: string) {
  s.matches(p)
}
