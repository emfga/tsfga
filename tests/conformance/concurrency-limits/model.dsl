model
  schema 1.1

type user_d5

type group_d5
  relations
    define member: [user_d5, user_d5:*, group_d5#member]

type folder_d5
  relations
    define owner: [user_d5]
    define viewer: [user_d5, group_d5#member] or owner

type doc_d5
  relations
    define parent: [folder_d5]
    define owner: [user_d5]
    define banned: [user_d5]
    define editor: [user_d5, group_d5#member] or owner
    define viewer: [user_d5, user_d5:*, group_d5#member] or editor or viewer from parent
    define can_view: viewer but not banned
    define restricted: viewer and editor
