model
  schema 1.1

type user_d4x

type org_d4x
  relations
    define member: [user_d4x, user_d4x with verified_domain_d4x]
    define guest: [user_d4x with guest_window_d4x]
    define admin: [user_d4x]
    define suspended: [user_d4x, user_d4x:*]
    define principal: member or guest
    define active_principal: principal but not suspended

type channel_d4x
  relations
    define owner_org: [org_d4x]
    define shared_org: [org_d4x]
    define invited: [user_d4x, org_d4x#member, org_d4x#active_principal]
    define internal_only: [user_d4x:*]
    define banned: [user_d4x, org_d4x#member]
    define readonly: [user_d4x, user_d4x:*]
    define moderators: admin from owner_org
    define internal_member: invited and active_principal from owner_org
    define external_candidate: invited and active_principal from shared_org
    define external_member: external_candidate but not internal_only
    define can_view: (internal_member or external_member) but not banned
    define can_post: can_view but not readonly

type message_d4x
  relations
    define channel: [channel_d4x]
    define author: [user_d4x]
    define moderator: moderators from channel
    define can_view: can_view from channel
    define can_edit: author and can_post from channel
    define can_delete: can_edit or moderator

condition guest_window_d4x(now: timestamp, expires_at: timestamp) {
  now < expires_at
}

condition verified_domain_d4x(email: string, domain: string) {
  email.endsWith("@" + domain)
}
