model
  schema 1.1

type user_a6

type workspace_a6
  relations
    define owner: [user_a6]
    define admin: [user_a6] or owner
    define member: [user_a6] or admin
    define guest: [user_a6]

type teamspace_a6
  relations
    define workspace: [workspace_a6]
    define owner: [user_a6]
    define member: [user_a6, workspace_a6#member] or owner
    define can_view: member or admin from workspace

type page_a6
  relations
    define parent_teamspace: [teamspace_a6]
    define parent_page: [page_a6]
    define owner: [user_a6]
    define restricted: [user_a6]
    define full_access: [user_a6, teamspace_a6#member] or owner or full_access from parent_page
    define can_comment_direct: [user_a6, workspace_a6#guest]
    define commenter: can_comment_direct or full_access or commenter from parent_page
    define public_viewer: [user_a6:* with link_shared_a6]
    define viewer: [user_a6] or commenter or public_viewer or can_view from parent_teamspace
    define can_read: viewer but not restricted
    define can_edit: full_access but not restricted

condition link_shared_a6(link_enabled: bool) {
  link_enabled == true
}
