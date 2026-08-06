model
  schema 1.1

type user

type team
  relations
    define member: [user]

type document
  relations
    define viewer: [user with valid_ip, team#member]

condition valid_ip(user_ip: string) {
  user_ip == "192.168.0.1"
}
