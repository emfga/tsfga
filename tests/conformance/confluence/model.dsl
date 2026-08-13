model
  schema 1.1

type user_c3f

type group_c3f
  relations
    define member: [user_c3f, group_c3f#member]

type space_c3f
  relations
    define admin: [user_c3f, group_c3f#member]
    define member: [user_c3f, group_c3f#member] or admin
    define anonymous: [user_c3f:*]
    define can_view: member or anonymous
    define can_admin: admin

type page_c3f
  relations
    define space: [space_c3f]
    define parent: [page_c3f]
    define owner: [user_c3f]
    define restricted_viewer: [user_c3f, group_c3f#member]
    define locked: [user_c3f:*, group_c3f#member]
    define comments_disabled: [user_c3f:*]
    define inherited_view: can_view from parent or can_view from space
    define open_view: inherited_view but not locked
    define can_view: owner or restricted_viewer or open_view
    define can_edit: owner or can_admin from space
    define can_comment: can_view but not comments_disabled
