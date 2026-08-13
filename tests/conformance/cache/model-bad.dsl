model
  schema 1.1

type user_d5c

type doc_d5c
  relations
    define str_view: [user_d5c with size_str_d5]
    define cmp_view: [user_d5c with cmp_str_d5]

condition size_str_d5(p: string) {
  p.size() > 0
}

condition cmp_str_d5(q: string) {
  q > 0
}
