model
  schema 1.1

type user_c2s

type doc_c2s
  relations
    define viewer: [user_c2s with any_c2s]

condition any_c2s(s: string, u: string, v: string, m: map<string>, mb: map<bool>, l: list<string>, b: bool, d: double, i: int) {
  s != "zzz"
}
