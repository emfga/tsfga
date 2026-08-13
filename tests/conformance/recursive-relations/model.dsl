model
  schema 1.1

type user_a7r

type folder_a7r
  relations
    define parent: [folder_a7r]
    define viewer: [user_a7r] or viewer from parent
    define blocked: [user_a7r] or blocked from parent
    define can_read: viewer but not blocked

type team_a7r
  relations
    define parent: [team_a7r]
    define member: [user_a7r] or lead from parent
    define lead: [user_a7r] or member from parent
