model
  schema 1.1

type user_b2a

type doc_b2a
  relations
    define roles_any: [user_b2a with roles_c_b2a]
    define perms_two: [user_b2a with perms_c_b2a]
    define roles_empty: [user_b2a with empty_c_b2a]
    define meta_admin: [user_b2a with meta_c_b2a]
    define limits_ok: [user_b2a with limits_c_b2a]
    define port_ok: [user_b2a with port_c_b2a]
    define upload_ok: [user_b2a with upload_c_b2a]
    define meta_missing: [user_b2a with meta_missing_c_b2a]

condition roles_c_b2a(subject_roles: list<string>) {
  "admin" in subject_roles || "editor" in subject_roles
}

condition perms_c_b2a(subject_permissions: list<string>) {
  size(subject_permissions) >= 2
}

condition empty_c_b2a(subject_roles: list<string>) {
  size(subject_roles) == 0
}

condition meta_c_b2a(subject_metadata: map<string>) {
  subject_metadata["role"] == "admin"
}

condition limits_c_b2a(resource_limits: map<int>) {
  resource_limits["max_views"] > 0 && resource_limits["max_views"] <= 100
}

condition port_c_b2a(resource_allowed_ports: list<int>, action_port: int) {
  action_port in resource_allowed_ports
}

condition upload_c_b2a(subject_tags: list<string>, resource_allowed_users: list<string>, action_max_size: int) {
  "verified" in subject_tags && size(resource_allowed_users) > 0 && action_max_size > 0
}

condition meta_missing_c_b2a(subject_metadata: map<string>) {
  subject_metadata["absent"] == "x"
}
