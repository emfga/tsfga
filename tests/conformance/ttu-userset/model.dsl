model
  schema 1.1

type user_a1

type org_a1
  relations
    define blocked: [user_a1]
    define base: [user_a1, user_a1:*]
    define ok: base but not blocked
    define admin: [user_a1]
    define super: admin

type squad_a1
  relations
    define crew: [user_a1, squad_a1#crew]

type folder_a1
  relations
    define parent: [folder_a1]
    define viewer: [user_a1] or viewer from parent
    define editor: [user_a1]

type box_a1
  relations
    define viewer: [user_a1]

type crate_a1
  relations
    define holder: [user_a1]

type doc_a1
  relations
    define parent: [folder_a1]
    define container: [box_a1, crate_a1]
    define via_excl: [org_a1#ok]
    define via_computed: [org_a1#super]
    define via_crew: [squad_a1#crew]
    define two_from_parent: viewer from parent or editor from parent
    define chained: viewer from parent
    define via_container: viewer from container
