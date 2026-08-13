model
  schema 1.1

type user_a5

type employee_a5

type ctx_orphan_a5

type ctx_group_a5
  relations
    define member: [user_a5]

type ctx_document_a5
  relations
    define viewer: [user_a5, ctx_group_a5#member]

type ctxp_document_a5
  relations
    define viewer: [user_a5]

type ctxw_folder_a5
  relations
    define viewer: [user_a5]

type ctxw_document_a5
  relations
    define parent: [ctxw_folder_a5]
    define viewer: viewer from parent

type ctxb_document_a5
  relations
    define blocked: [user_a5]
    define viewer: [user_a5] but not blocked
