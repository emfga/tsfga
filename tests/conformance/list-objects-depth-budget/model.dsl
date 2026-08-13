model
  schema 1.1

type user_a8

type sdoc_a8
  relations
    define parent: [sdoc_a8]
    define viewer: [user_a8] or viewer from parent

type tdoc_a8
  relations
    define parent: [tdoc_a8]
    define viewer: [user_a8] or viewer from parent

type sgroup_a8
  relations
    define member: [user_a8, sgroup_a8#member]

type xdoc_a8
  relations
    define parent: [xdoc_a8]
    define base: [user_a8]
    define deep: [user_a8] or deep from parent
    define allow_not_deep: base but not deep
    define allow_or_deep: base or deep
    define allow_and_deep: base and deep
