model
  schema 1.1

type user

type team
  relations
    define member: [user]
    define owner: [user]

type document
  relations
    define viewer: [user, team#member, team#owner]
    define editor: [team#member, team#owner]
    define owner: [user, user:*, team#member]
    define public: [user:*]
    define derived: viewer
