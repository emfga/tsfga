model
  schema 1.1

type user_a1

type folder_a1
  relations
    define viewer: [user_a1]

type org_a1
  relations
    define viewer: [user_a1]

type doc_a1
  relations
    define parent: [folder_a1 with valid_ip_a1]
    define owner: [org_a1]
    define two_arms: viewer from parent or viewer from owner
    define arm_and_direct: [user_a1] or viewer from parent

condition valid_ip_a1(user_ip: string) {
  user_ip == "192.168.0.1"
}
