model
  schema 1.1

type user_b6

type doc_b6
  relations
    define viewer: [user_b6, user_b6:*]
