model
  schema 1.1

type user_d4c

type group_d4c
  relations
    define member: [user_d4c, group_d4c#member]

type org_d4c
  relations
    define admin: [user_d4c, group_d4c#member]
    define member: [user_d4c, group_d4c#member] or admin

type team_d4c
  relations
    define org: [org_d4c]
    define parent_team: [team_d4c]
    define member: [user_d4c, group_d4c#member] or member from parent_team or member from org
    define on_call: [user_d4c with on_shift_d4c]
    define escalation: [user_d4c, group_d4c#member]

type service_d4c
  relations
    define team: [team_d4c]
    define responder: [user_d4c, group_d4c#member] or member from team
    define on_call: [user_d4c with on_shift_d4c] or on_call from team
    define escalation: [user_d4c] or escalation from team
    define public_status: [user_d4c:*]
    define barred: [user_d4c, user_d4c:*]
    define can_view_status: (responder or public_status) but not barred

type alert_rule_d4c
  relations
    define service: [service_d4c]
    define editor: [user_d4c, group_d4c#member]
    define notifier: [user_d4c with webhook_host_d4c]
    define responder: [user_d4c] or responder from service
    define on_call: on_call from service
    define escalation: escalation from service
    define can_tune: editor and responder from service

type incident_d4c
  relations
    define rule: [alert_rule_d4c]
    define responder: [user_d4c, user_d4c with sev_scope_d4c] or responder from rule
    define on_call: on_call from rule
    define escalation_target: [group_d4c#member] or escalation from rule
    define suppressed: [user_d4c, user_d4c:*]
    define can_ack: (responder or on_call or escalation_target) but not suppressed

condition on_shift_d4c(now: timestamp, shift_start: timestamp, shift_end: timestamp) {
  now >= shift_start && now < shift_end
}

condition sev_scope_d4c(severity: string) {
  severity in ["sev-1", "sev-2", "sev-3"]
}

condition webhook_host_d4c(endpoint: string) {
  endpoint.startsWith("https://hooks.acme.io/")
}
