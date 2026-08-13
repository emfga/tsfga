model
  schema 1.1

type user_a5

type us_group_a5
  relations
    define member: [user_a5]
    define admin: [user_a5]

type us_folder_a5
  relations
    define viewer: [us_group_a5#member]

type us_document_a5
  relations
    define parent: [us_folder_a5]
    define viewer: [us_group_a5#member]
    define can_view: viewer
    define owner: [us_group_a5]
    define anyone: [us_group_a5:*]
    define inherited: viewer from parent
    define blocked: [us_group_a5#member]
    define restricted: viewer but not blocked
