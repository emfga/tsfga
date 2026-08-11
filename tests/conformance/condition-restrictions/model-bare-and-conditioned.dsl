model
  schema 1.1

type user

type team
  relations
    define member: [user]

type document
  relations
    define viewer: [user, user with weekday_only]

condition weekday_only(is_weekday: bool) {
  is_weekday == true
}

condition other_cond(is_weekday: bool) {
  is_weekday == true
}
