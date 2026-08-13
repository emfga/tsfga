model
  schema 1.1

type user_c4

type group_c4
  relations
    define member: [user_c4, group_c4#member]

type folder_c4
  relations
    define viewer: [user_c4]

type doc_c4
  relations
    define parent: [folder_c4]
    define owner: [user_c4]
    define blocked: [user_c4]
    define direct_viewer: [user_c4, user_c4:*, group_c4#member, user_c4 with weekday_c4]
    define viewer: direct_viewer or owner or viewer from parent
    define editor: viewer but not blocked

condition weekday_c4(day: string) {
  day == "mon"
}
