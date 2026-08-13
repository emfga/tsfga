model
  schema 1.1

type user_d5c

type doc_d5c
  relations
    define str_view: [user_d5c with size_str_d5]
    define list_view: [user_d5c with size_list_d5]
    define map_view: [user_d5c with size_map_d5]

condition size_str_d5(p: string) {
  p.size() > 0
}

condition size_list_d5(p: list<string>) {
  p.size() > 0
}

condition size_map_d5(p: map<string>) {
  p.size() > 0
}
