model
  schema 1.1

type user_b5

type team_b5
  relations
    define member: [user_b5]

type doc_b5
  relations
    define viewer: [user_b5]
    define userset_only: [team_b5#member]
    define public: [user_b5:*]
