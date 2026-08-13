model
  schema 1.1

type user_a3r

type team_a3r
  relations
    define member: [user_a3r]

type folder_a3r
  relations
    define viewer: [user_a3r]

type doc_a3r
  relations
    define parent: [folder_a3r]
    define blocked: [user_a3r]
    define gated: [user_a3r]
    define editor: [user_a3r, team_a3r#member, user_a3r:*]
    define timed: [user_a3r with when_a3r]
    define viewer: editor or viewer from parent
    define safe: editor but not blocked
    define both: editor and gated

condition when_a3r(n: int) {
  n > 5
}
