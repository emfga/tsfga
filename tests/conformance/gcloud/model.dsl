model
  schema 1.1

type user_d4g

type group_d4g
  relations
    define member: [user_d4g, group_d4g#member]

type org_d4g
  relations
    define admin: [user_d4g, group_d4g#member]
    define viewer: [user_d4g, group_d4g#member, user_d4g with tag_scope_d4g]
    define denied: [user_d4g, group_d4g#member]
    define can_view: (viewer or admin) but not denied

type folder_d4g
  relations
    define parent_org: [org_d4g]
    define parent_folder: [folder_d4g]
    define admin: [user_d4g, group_d4g#member] or admin from parent_org or admin from parent_folder
    define viewer: [user_d4g, group_d4g#member, user_d4g with tag_scope_d4g] or viewer from parent_org or viewer from parent_folder
    define denied: [user_d4g, group_d4g#member] or denied from parent_org or denied from parent_folder
    define can_view: (viewer or admin) but not denied

type project_d4g
  relations
    define parent: [folder_d4g]
    define owner: [user_d4g]
    define admin: [user_d4g] or admin from parent
    define viewer: [user_d4g, group_d4g#member, user_d4g with tag_scope_d4g] or viewer from parent
    define denied: [user_d4g, group_d4g#member] or denied from parent
    define can_view: (viewer or admin or owner) but not denied
    define can_setiam: admin but not denied

type bucket_d4g
  relations
    define project: [project_d4g]
    define reader: [user_d4g, group_d4g#member, user_d4g with svc_account_d4g]
    define writer: [user_d4g with in_window_d4g]
    define quarantined: [user_d4g:*]
    define inherited_read: reader or can_view from project
    define can_read: inherited_read but not quarantined
    define write_grant: writer or can_setiam from project
    define can_write: write_grant and can_read

condition tag_scope_d4g(resource_tags: list<string>, required_tag: string) {
  required_tag in resource_tags
}

condition in_window_d4g(now: timestamp, not_before: timestamp, not_after: timestamp) {
  now >= not_before && now < not_after
}

condition svc_account_d4g(principal: string) {
  principal.startsWith("svc-") && principal.endsWith("@ex.io")
}
