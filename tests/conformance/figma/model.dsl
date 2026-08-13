model
  schema 1.1

type user_a6f

type org_a6f
  relations
    define member: [user_a6f]
    define admin: [user_a6f]

type team_a6f
  relations
    define org: [org_a6f]
    define member: [user_a6f, org_a6f#member]
    define admin: [user_a6f] or admin from org

type project_a6f
  relations
    define team: [team_a6f]
    define editor: [user_a6f, team_a6f#member]
    define viewer: [user_a6f] or editor
    define org_admin: admin from team

type file_a6f
  relations
    define project: [project_a6f]
    define owner: [user_a6f]
    define publisher: [user_a6f]
    define locked: [user_a6f:*]
    define link_editor: [user_a6f:* with link_active_a6f]
    define link_viewer: [user_a6f:* with link_active_a6f]
    define editor: [user_a6f] or owner or link_editor or editor from project
    define viewer: [user_a6f] or editor or link_viewer or viewer from project
    define can_edit: editor but not locked
    define can_publish: (editor or publisher) and (owner or org_admin from project)

type branch_a6f
  relations
    define source_file: [file_a6f]
    define author: [user_a6f]
    define can_view: author or viewer from source_file
    define can_edit: author or can_edit from source_file
    define can_merge: author and can_edit from source_file

condition link_active_a6f(link_enabled: bool, viewer_domain: string) {
  link_enabled && viewer_domain == "acme.com"
}
