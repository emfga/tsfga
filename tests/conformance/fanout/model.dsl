model
  schema 1.1

type user_a8

type wgroup_a8
  relations
    define member: [user_a8]

type wdoc_a8
  relations
    define viewer: [user_a8, wgroup_a8#member]
