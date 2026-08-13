model
  schema 1.1

type user_c3s

type role_c3s
  relations
    define parent: [role_c3s]
    define direct_member: [user_c3s]
    define member: direct_member or member from parent

type account_c3s
  relations
    define admin: [role_c3s#member]

type database_c3s
  relations
    define account: [account_c3s]
    define owner: [role_c3s#member]
    define usage_grant: [role_c3s#member]
    define can_admin: owner or admin from account
    define can_use: usage_grant or can_admin

type schema_c3s
  relations
    define database: [database_c3s]
    define owner: [role_c3s#member]
    define usage_grant: [role_c3s#member]
    define can_admin: owner or can_admin from database
    define local_use: usage_grant or can_admin
    define can_use: local_use and can_use from database

type table_c3s
  relations
    define schema: [schema_c3s]
    define owner: [role_c3s#member]
    define select_grant: [role_c3s#member, user_c3s]
    define masked: [role_c3s#member]
    define can_admin: owner or can_admin from schema
    define local_select: select_grant or can_admin
    define can_select: local_select and can_use from schema
    define can_select_pii: can_select but not masked
