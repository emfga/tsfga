model
  schema 1.1

type user_a5

type loc_repo_a5
  relations
    define blocked: [user_a5]
    define owner: [user_a5] but not blocked

type lod_repo_a5
  relations
    define blocked: [user_a5]
    define admin: [user_a5, user_a5:*] but not blocked

type low_repo_a5
  relations
    define blocked: [user_a5]
    define owner: [user_a5, user_a5:*] but not blocked
    define can_own: owner

type lor_company_a5
  relations
    define admin: [user_a5]
    define management: [user_a5]
    define employee: [user_a5] or admin

type lor_group_a5
  relations
    define observer: [lor_company_a5]
    define owner: [lor_company_a5]
    define admin: admin from owner
    define member: employee from owner

type lor_document_a5
  relations
    define owner: [lor_group_a5]
    define viewer: member from owner or observer from owner

type loy_document_a5
  relations
    define allowed: [user_a5, loy_document_a5#viewer]
    define viewer: [user_a5, loy_document_a5#allowed] and allowed
