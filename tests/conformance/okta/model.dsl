model
  schema 1.1

type user_d4o

type group_d4o
  relations
    define direct_member: [user_d4o, group_d4o#direct_member]
    define excluded: [user_d4o, user_d4o:*]
    define member: direct_member but not excluded

type ou_d4o
  relations
    define parent_ou: [ou_d4o]
    define admin: [user_d4o, group_d4o#member] or admin from parent_ou
    define helpdesk: [user_d4o, group_d4o#member] or helpdesk from parent_ou
    define suspended: [user_d4o, user_d4o:*]
    define can_administer: admin but not suspended
    define can_reset_password: (admin or helpdesk) but not suspended

type app_d4o
  relations
    define owner_ou: [ou_d4o]
    define assigned: [user_d4o, group_d4o#member, user_d4o with mfa_ok_d4o]
    define deprovisioned: [user_d4o, user_d4o:*]
    define admin_access: can_administer from owner_ou
    define can_use: (assigned or admin_access) but not deprovisioned
    define can_configure: admin_access and can_use
    define can_audit: assigned and helpdesk from owner_ou

type session_d4o
  relations
    define app: [app_d4o]
    define principal: [user_d4o with device_trusted_d4o]
    define can_open: principal and can_use from app

condition mfa_ok_d4o(mfa_level: string, required_levels: list<string>) {
  mfa_level in required_levels
}

condition device_trusted_d4o(device_id: string) {
  device_id.startsWith("dev-") && size(device_id) == 12
}
