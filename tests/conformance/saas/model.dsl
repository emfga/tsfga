model
  schema 1.1

type user_a6s

type idp_group_a6s
  relations
    define member: [user_a6s, user_a6s:*]

type tenant_a6s
  relations
    define subscriber: [user_a6s, idp_group_a6s#member, idp_group_a6s#member with within_window_a6s]
    define suspended: [user_a6s:* with past_grace_a6s]
    define admin: [user_a6s]
    define active_member: subscriber but not suspended

type workspace_a6s
  relations
    define tenant: [tenant_a6s with subscription_active_a6s]
    define direct_member: [user_a6s]
    define legal_hold: [user_a6s:*]
    define admin: [user_a6s] or admin from tenant
    define member: direct_member or active_member from tenant
    define frozen: legal_hold but not admin
    define can_read: member
    define can_write: member but not frozen
    define can_purge: admin but not frozen

condition within_window_a6s(now: timestamp, expires_at: timestamp) {
  now < expires_at
}

condition past_grace_a6s(grace_days: int) {
  grace_days > 30
}

condition subscription_active_a6s(subscription_active: bool) {
  subscription_active
}
