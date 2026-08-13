model
  schema 1.1

type user_a5

type dci_document_a5
  relations
    define allowed: [user_a5 with condx_a5]
    define viewer: [user_a5 with condy_a5] and allowed

type swc_folder_a5
  relations
    define viewer: [user_a5 with xcond_a5, user_a5]

type swc_document_a5
  relations
    define viewer: [swc_folder_a5#viewer]

type stm_folder_a5
  relations
    define viewer: [user_a5 with xcond_a5, user_a5 with ycond_a5]

type stm_document_a5
  relations
    define parent: [stm_folder_a5]
    define viewer: viewer from parent

type facet_group_a5
  relations
    define member: [user_a5]

type facet_document_a5
  relations
    define concrete_cond: [user_a5 with is_ok_a5, user_a5:*]
    define wildcard_cond: [user_a5, user_a5:* with is_ok_a5]
    define userset_cond: [user_a5, facet_group_a5#member with is_ok_a5]

type tmp_group1_a5
  relations
    define member: [user_a5 with ts_less_than_a5, user_a5:* with ts_less_than_a5]

type tmp_group2_a5
  relations
    define member: [user_a5]

type tmp_folder_a5
  relations
    define viewer: [user_a5, tmp_group1_a5#member, tmp_group2_a5#member]

type tmp_document_a5
  relations
    define parent: [tmp_folder_a5]
    define viewer: viewer from parent

condition condx_a5(x: int) {
  x < 100
}

condition condy_a5(y: int) {
  y < 50
}

condition xcond_a5(x: int) {
  x == 10
}

condition ycond_a5(y: int) {
  y == 10
}

condition is_ok_a5(ok: bool) {
  ok
}

condition ts_less_than_a5(ts: timestamp) {
  ts < timestamp("2023-10-11T10:00:00.000Z")
}
