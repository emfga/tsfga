model
  schema 1.1

type user_a1

type team_a1
  relations
    define member: [user_a1:* with valid_ip_a1]

type team2_a1
  relations
    define member: [user_a1 with valid_ip_a1]

type doc_a1
  relations
    define both: [user_a1, user_a1:*]
    define conditioned: [user_a1:* with valid_ip_a1]
    define via_team: [team_a1#member]
    define via_team2: [team2_a1#member]
    define blocked: [user_a1]
    define ok: both but not blocked
    define wild_and_named: conditioned and both

condition valid_ip_a1(user_ip: string) {
  user_ip == "192.168.0.1"
}
