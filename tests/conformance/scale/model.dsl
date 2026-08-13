model
  schema 1.1

type user_d5s

type group_d5s
  relations
    define member: [user_d5s, group_d5s#member]

type wide_d5
  relations
    define viewer: [user_d5s, group_d5s#member]
