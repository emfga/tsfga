model
  schema 1.1

type user

type team
  relations
    define member: [user]

type document
  relations
    define viewer: [team#member]
