model
  schema 1.1

type user

type group
  relations
    define member: [user, group#owner]
    define owner: [user, group#member]

type recursive_group
  relations
    define member: [user, recursive_group#member]

type document
  relations
    define cyclic: [group#member]
    define recursive_cyclic: [recursive_group#member]
    define granted: [user]
    define base: [user]
    define blocked: [user]
    define union_with_cycle: cyclic or granted
    define subtract_cycle: base but not cyclic
    define cyclic_base: cyclic but not blocked
    define intersect_cycle: granted and cyclic
    define intersect_recursive: granted and recursive_cyclic
