model
  schema 1.1

type user_a5

type nf_folder_a5
  relations
    define parent: [nf_folder_a5]
    define owner: [nf_group_a5]
    define folder_reader: [user_a5, nf_group_a5#member] or folder_reader from owner or folder_reader from parent
    define blocked: [user_a5, user_a5:*, nf_group_a5#member] or nblocked from parent
    define unblocked: [user_a5, nf_group_a5#member]
    define nblocked: blocked but not unblocked
    define allowed: [user_a5, user_a5:*, nf_group_a5#member] or allowed from parent
    define super_allowed: [user_a5, nf_group_a5#member] or super_allowed from parent
    define reader: folder_reader and allowed and super_allowed
    define can_read: reader but not nblocked

type nf_group_a5
  relations
    define parent: [nf_group_a5]
    define allowed: [user_a5, nf_group_a5#member] or allowed from parent
    define super_allowed: [user_a5, nf_group_a5#super_allowed]
    define blocked: [user_a5, nf_group_a5#member] or blocked from parent
    define og_member: [user_a5] or member from parent
    define allowed_member: og_member and allowed and super_allowed
    define member: allowed_member but not blocked
    define folder_reader: [nf_group_a5#member] or folder_reader from parent
