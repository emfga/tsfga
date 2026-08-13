model
  schema 1.1

type user_c3v

type org_c3v
  relations
    define owner: [user_c3v]
    define member: [user_c3v] or owner

type team_c3v
  relations
    define org: [org_c3v]
    define member: [user_c3v, team_c3v#member]
    define maintainer: [user_c3v]

type workspace_c3v
  relations
    define org: [org_c3v]
    define locked: [user_c3v:*]
    define reader: [team_c3v#member, user_c3v with ip_allowed_c3v]
    define writer: [user_c3v, team_c3v#member with business_hours_c3v]
    define admin: [user_c3v, team_c3v#maintainer]
    define deployer: [user_c3v with env_tagged_c3v]
    define can_read: reader or writer or admin or owner from org
    define can_queue_plan: writer or admin
    define can_apply: can_queue_plan but not locked

type run_c3v
  relations
    define workspace: [workspace_c3v]
    define requester: [user_c3v]
    define approver: [user_c3v with under_budget_c3v]
    define can_apply: approver and can_apply from workspace

type secret_c3v
  relations
    define workspace: [workspace_c3v]
    define path_reader: [user_c3v with path_allowed_c3v]
    define can_read: path_reader or admin from workspace

condition ip_allowed_c3v(ip: string) {
  ip in ["10.0.4.7", "10.0.9.9"]
}

condition business_hours_c3v(now: timestamp) {
  now >= timestamp("2026-01-01T09:00:00Z") && now < timestamp("2026-01-01T17:00:00Z")
}

condition env_tagged_c3v(env: string) {
  env in ["prod", "PROD", "Prod", "production", "Production"]
}

condition under_budget_c3v(cost: double, budget: double) {
  cost <= budget
}

condition path_allowed_c3v(path: string, allowed: list<string>) {
  path in allowed
}
