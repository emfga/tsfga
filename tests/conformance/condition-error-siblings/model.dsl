model
  schema 1.1

type user

type team
  relations
    define member: [user]

type folder
  relations
    define viewer: [user]

type document
  relations
    define parent: [folder with valid_ip]
    define viewer: [user with valid_ip, team#member, team#member with valid_ip]
    define ttu_viewer: viewer from parent

condition valid_ip(user_ip: string) {
  user_ip == "192.168.0.1"
}
