model
  schema 1.1

type user_a8

type cgroup_a8
  relations
    define member: [user_a8]

type cdoc_a8
  relations
    define parent: [cdoc_a8]
    define viewer: [user_a8, cgroup_a8#member] or viewer from parent

type kdoc_a8
  relations
    define viewer: [user_a8 with ok_a8]

condition ok_a8(x: int) {
  x > 5
}
