model
  schema 1.1

type user_a5

type user2_a5

type wcu_document_a5
  relations
    define writer: [user_a5:*]
    define viewer: [user_a5] or writer

type wr_group_a5
  relations
    define member: [user2_a5]

type wr_document_a5
  relations
    define viewer: [user_a5:*, wr_group_a5#member]

type suo_group_a5
  relations
    define member: [user_a5:*, user2_a5:*]

type suo_folder_a5
  relations
    define viewer: [suo_group_a5#member]

type su_group_a5
  relations
    define member: [user_a5, user_a5:*, user2_a5, user2_a5:*]

type su_folder_a5
  relations
    define viewer: [su_group_a5#member]

type sto_group_a5
  relations
    define member: [user_a5:*, user2_a5:*]

type sto_folder_a5
  relations
    define owner: [sto_group_a5]
    define viewer: member from owner

type st_group_a5
  relations
    define member: [user_a5, user_a5:*, user2_a5, user2_a5:*]

type st_folder_a5
  relations
    define owner: [st_group_a5]
    define viewer: member from owner

type cp_role_a5
  relations
    define assignee: [user_a5]

type cp_deployment_a5
  relations
    define can_access: [user_a5:*, cp_role_a5#assignee]

type w2_scope_a5
  relations
    define public: [user_a5:*]
    define verified: [user_a5]

type w2_resource_a5
  relations
    define access: [w2_scope_a5#public, w2_scope_a5#verified]

type w2a_scope_a5
  relations
    define public: [user_a5:*]

type w2b_scope_a5
  relations
    define verified: [user_a5]

type w2d_resource_a5
  relations
    define access: [w2a_scope_a5#public, w2b_scope_a5#verified]
