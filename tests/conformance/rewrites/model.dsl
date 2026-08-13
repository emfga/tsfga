model
  schema 1.1

type user_a4

type group_a4
  relations
    define member: [user_a4]

type folder_a4
  relations
    define viewer: [user_a4]

type doc_a4
  relations
    define parent: [folder_a4]
    define direct_viewer: [user_a4]
    define public_viewer: [user_a4:*]
    define group_viewer: [group_a4#member]
    define computed_viewer: direct_viewer
    define inherited_viewer: viewer from parent
    define union_viewer: direct_viewer or group_viewer or inherited_viewer or public_viewer
    define blocked: [user_a4]
    define guarded_viewer: union_viewer but not blocked
    define required: [user_a4]
    define strict_viewer: union_viewer and required
    define unused: [user_a4]
