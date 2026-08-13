model
  schema 1.1

type user_d1w

type doc_d1w
  relations
    define viewer: [user_d1w, user_d1w:*, user_d1w:* with ctx_d1w]
    define editor: [user_d1w:* with ctx_d1w]

condition ctx_d1w(ok: bool) {
  ok == true
}
