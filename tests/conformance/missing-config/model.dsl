model
  schema 1.1

type user

type folder
  relations
    define viewer: [user]

type org
  relations
    define member: [user]

type document
  relations
    define parent: [folder, org]
    define viewer: viewer from parent
