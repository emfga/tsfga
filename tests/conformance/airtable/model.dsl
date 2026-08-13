model
  schema 1.1

type user_c3t

type group_c3t
  relations
    define member: [user_c3t, group_c3t#member]

type workspace_c3t
  relations
    define owner: [user_c3t]
    define collaborator: [user_c3t, group_c3t#member]
    define can_manage: owner
    define can_access: collaborator or owner

type base_c3t
  relations
    define workspace: [workspace_c3t]
    define editor: [user_c3t, group_c3t#member]
    define can_manage: can_manage from workspace
    define can_edit: editor or can_manage
    define can_view: can_edit or can_access from workspace

type table_c3t
  relations
    define base: [base_c3t]
    define hidden: [user_c3t:*]
    define inherited_view: can_view from base
    define can_edit: can_edit from base
    define can_view: inherited_view but not hidden

type view_c3t
  relations
    define table: [table_c3t]
    define locked: [user_c3t:*]
    define personal_owner: [user_c3t]
    define inherited_view: can_view from table
    define open_view: inherited_view but not locked
    define can_view: open_view or personal_owner

type record_c3t
  relations
    define table: [table_c3t]
    define restricted_to: [user_c3t, group_c3t#member]
    define open: [user_c3t:*]
    define visible_to: restricted_to or open
    define can_view: can_view from table and visible_to
    define can_edit: can_edit from table and visible_to
