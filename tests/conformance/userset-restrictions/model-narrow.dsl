model
  schema 1.1

type user

type team
  relations
    define member: [user]
    define owner: [user]

type document
  relations
    define viewer: [user, team#member]
    define editor: [team#member, team#owner]
    define owner: [user]
    define public: [user:*]
    define derived: viewer
