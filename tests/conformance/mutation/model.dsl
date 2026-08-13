model
  schema 1.1

type user_d5m

type group_d5m
  relations
    define member: [user_d5m]

type doc_d5m
  relations
    define banned: [user_d5m]
    define viewer: [user_d5m, group_d5m#member]
    define can_view: viewer but not banned
