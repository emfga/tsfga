model
  schema 1.1

type user_a5

type document_a5
  relations
    define writer: [user_a5]
    define editor: [user_a5]
    define owner: [user_a5]
    define banned: [user_a5]
    define active: [user_a5]
    define active_wc: [user_a5:*, user_a5]
    define verified: [user_a5]
    define org_member: [user_a5:*, user_a5]
    define u_or_ex: writer or (editor but not owner)
    define i_and_ex: writer and (editor but not owner)
    define ex_and_i_sub: writer but not (editor and owner)
    define ex_and_ex_base: (writer but not editor) but not owner
    define ex_and_ex_sub: writer but not (editor but not owner)
    define wc_ex_in_int: (org_member but not banned) and active
    define wc_ex_in_int_wc: (org_member but not banned) and active_wc
    define wc_ex_in_int3: (org_member but not banned) and active and verified
