model
  schema 1.1

type user_d5o

type group_d5o
  relations
    define member: [user_d5o]

type doc_d5o
  relations
    define ok: [group_d5o#member]
    define mix: [group_d5o#member, group_d5o#member with need_ctx_d5]
    define blocker: [user_d5o]
    define guarded: mix but not blocker
    define both: mix and ok

condition need_ctx_d5(required: string) {
  required == "yes"
}
