model
  schema 1.1

type user_d2i

type doc_d2i
  relations
    define viewer: [user_d2i, team_d2i#member]

type team_d2i
  relations
    define member: [user_d2i]
