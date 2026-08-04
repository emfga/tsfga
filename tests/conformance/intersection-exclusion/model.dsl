model
  schema 1.1

type user

type organization
  relations
    define member: [user]

type document
  relations
    define banned: [user]
    define owner: [organization]
    define writer: [user]
    define can_delete: (writer and member from owner) but not banned
