model
  schema 1.1

type user_a4d

type doc_a4d
  relations
    define parent: [doc_a4d]
    define plain: [user_a4d] or plain from parent

type deep_a4d
  relations
    define parent: [deep_a4d]
    define plain: [user_a4d] or plain from parent
