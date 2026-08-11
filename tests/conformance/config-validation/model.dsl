model
  schema 1.1

type user

type document
  relations
    define blocked: [user, document#blocked]
    define member: [user, document#member]
    define viewer: [user] but not blocked
