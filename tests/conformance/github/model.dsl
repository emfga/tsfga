model
  schema 1.1

type user

type organization
  relations
    define member: [user]
    define repo_admin: [user]
    define repo_reader: [user]

type team
  relations
    define member: [user, team#member]

type repo
  relations
    define organization: [organization]
    define admin: [user, team#member] or repo_admin from organization
    define maintainer: [user, team#member] or admin
    define writer: [user, team#member] or maintainer
    define triager: [user, team#member] or writer
    define reader: [user, team#member] or triager or repo_reader from organization
