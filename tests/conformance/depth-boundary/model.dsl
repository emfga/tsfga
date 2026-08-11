model
  schema 1.1

type user

type doc
  relations
    define parent: [doc]
    define other: [doc]
    define m: [user]
    define plain: [user] or plain from parent
    define leafw2: [user] or m from other or leafw2 from parent
