model
  schema 1.1

type user_c2i

type team_c2i
  relations
    define member: [user_c2i]

type folder_c2i
  relations
    define viewer: [user_c2i]

type doc_c2i
  relations
    define parent: [folder_c2i]
    define owner: [user_c2i]
    define blocked: [user_c2i]
    define viewer: [user_c2i, user_c2i:*, team_c2i#member] or owner or viewer from parent
    define allowed: viewer but not blocked
