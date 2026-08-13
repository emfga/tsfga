model
  schema 1.1

type user_a3n

type doc_a3n
  relations
    define mixed: [user_a3n, user_a3n:*]
    define narrow: [user_a3n]
