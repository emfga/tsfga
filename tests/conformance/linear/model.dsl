model
  schema 1.1

type user_a6

type organization_a6
  relations
    define member: [user_a6]
    define admin: [user_a6]
    define suspended: [user_a6]
    define billing: [user_a6] but not suspended

type team_a6
  relations
    define organization: [organization_a6]
    define member: [user_a6, organization_a6#member]
    define lead: [user_a6]
    define can_view: member or lead or admin from organization

type project_a6
  relations
    define team: [team_a6]
    define lead: [user_a6]
    define guest_viewer: [user_a6]
    define archived: [organization_a6#member, user_a6:*]
    define member: [user_a6] or lead or member from team
    define can_view: member or guest_viewer
    define can_edit: member but not archived

type issue_a6
  relations
    define project: [project_a6]
    define assignee: [user_a6]
    define creator: [user_a6]
    define subscriber: [user_a6, team_a6#member]
    define confidential: [user_a6]
    define can_view: assignee or creator or subscriber or can_view from project
    define can_assign: can_edit from project
    define can_close: assignee and can_edit from project
    define can_comment: can_view but not confidential
