model
  schema 1.1

type user_a6k

type serviceaccount_a6k
  relations
    define namespace: [namespace_a6k]

type group_a6k
  relations
    define member: [user_a6k, serviceaccount_a6k]

type cluster_a6k
  relations
    define crb_view: [user_a6k, group_a6k#member, user_a6k:*]
    define crb_edit: [user_a6k, group_a6k#member]
    define crb_admin: [user_a6k, group_a6k#member]

type namespace_a6k
  relations
    define cluster: [cluster_a6k]
    define rb_view: [user_a6k, group_a6k#member, serviceaccount_a6k]
    define rb_edit: [user_a6k, group_a6k#member, serviceaccount_a6k]
    define rb_admin: [user_a6k, group_a6k#member, serviceaccount_a6k]
    define can_admin: rb_admin or crb_admin from cluster
    define can_update: rb_edit or can_admin or crb_edit from cluster
    define can_get: rb_view or can_update or crb_view from cluster

type pod_a6k
  relations
    define owner: [namespace_a6k, cluster_a6k]
    define can_get: can_get from owner
    define can_delete: can_update from owner
    define can_exec: can_admin from owner
