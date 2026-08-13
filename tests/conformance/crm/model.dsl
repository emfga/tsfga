model
  schema 1.1

type user_a6c

type role_a6c
  relations
    define parent: [role_a6c]
    define assignee: [user_a6c]
    define at_or_above: assignee or at_or_above from parent

type group_a6c
  relations
    define member: [user_a6c, role_a6c#at_or_above]

type org_a6c
  relations
    define member: [user_a6c]
    define sysadmin: [user_a6c]
    define owd_public_read: [user_a6c:*]

type account_a6c
  relations
    define org: [org_a6c]
    define owner: [user_a6c]
    define owner_role: [role_a6c]
    define shared_with: [user_a6c, group_a6c#member]
    define confidential: [user_a6c]
    define can_view: owner or shared_with or at_or_above from owner_role or owd_public_read from org or sysadmin from org
    define can_edit: owner or at_or_above from owner_role
    define can_view_gated: can_view but not confidential
    define can_transfer: can_edit and sysadmin from org
