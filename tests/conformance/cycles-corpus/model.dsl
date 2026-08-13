model
  schema 1.1

type user_a5

type coc_document_a5
  relations
    define editor: [user_a5, coc_document_a5#viewer]
    define viewer: [coc_document_a5#editor] or editor

type icc_document_a5
  relations
    define editor: [user_a5, icc_document_a5#viewer]
    define viewer: editor

type tbc_document_a5
  relations
    define restricted: [user_a5, tbc_document_a5#viewer]
    define viewer: [user_a5] but not restricted

type cac_document_a5
  relations
    define editor: [user_a5, cac_document_a5#viewer]
    define viewer: [user_a5, cac_document_a5#editor] and editor

type cat_document_a5
  relations
    define allowed: [user_a5]
    define viewer: [user_a5, cat_document_a5#viewer] and allowed

type icr_document_a5
  relations
    define viewer: [user_a5, icr_document_a5#viewer]

type cbf_document_a5
  relations
    define restricted: [user_a5]
    define viewer: [user_a5, cbf_document_a5#viewer] but not restricted

type fbc_document_a5
  relations
    define restricted: [user_a5, fbc_document_a5#viewer]
    define viewer: [user_a5] but not restricted

type tpr_module_a5
  relations
    define owner: [user_a5] or owner from parent
    define parent: [tpr_document_a5, tpr_module_a5]
    define viewer: [user_a5] or owner or viewer from parent

type tpr_folder_a5
  relations
    define owner: [user_a5] or owner from parent
    define parent: [tpr_module_a5, tpr_folder_a5]
    define viewer: [user_a5] or owner or viewer from parent

type tpr_document_a5
  relations
    define owner: [user_a5] or owner from parent
    define parent: [tpr_folder_a5, tpr_document_a5]
    define viewer: [user_a5] or owner or viewer from parent

type tpl_module_a5
  relations
    define owner: [user_a5] or owner from parent
    define parent: [tpl_document_a5, tpl_module_a5]
    define viewer: [user_a5] or owner or viewer from parent

type tpl_folder_a5
  relations
    define owner: [user_a5] or owner from parent
    define parent: [tpl_module_a5, tpl_folder_a5]
    define viewer: [user_a5] or owner or viewer from parent

type tpl_document_a5
  relations
    define owner: [user_a5] or owner from parent
    define parent: [tpl_folder_a5, tpl_document_a5]
    define viewer: [user_a5] or owner or viewer from parent

type tpe_module_a5
  relations
    define owner: [user_a5] or has_owned from parent
    define parent: [tpe_document_a5, tpe_module_a5]
    define has_owned: owner
    define viewer: [user_a5] or has_owned or viewer from parent

type tpe_folder_a5
  relations
    define owner: [user_a5] or has_owned from parent
    define parent: [tpe_module_a5, tpe_folder_a5]
    define has_owned: owner
    define viewer: [user_a5] or has_owned or viewer from parent

type tpe_document_a5
  relations
    define banned: [user_a5]
    define owner: [user_a5] or has_owned from parent
    define has_owned: owner but not banned
    define parent: [tpe_folder_a5, tpe_document_a5]
    define viewer: [user_a5] or has_owned or viewer from parent

type efs_group_a5
  relations
    define member: [user_a5]

type efs_folder_a5
  relations
    define owner: [efs_group_a5]
    define viewer: member from owner

type efs_document_a5
  relations
    define banned: [user_a5]
    define owner: [efs_folder_a5]
    define viewer: viewer from owner
    define can_view: viewer but not banned
    define can_see: can_view

type ctd_company_a5
  relations
    define admin: [user_a5]
    define management: [user_a5]
    define employee: [user_a5] or admin

type ctd_group_a5
  relations
    define corp: [ctd_company_a5]
    define member: employee from corp

type ctd_document_a5
  relations
    define viewer: [ctd_group_a5#member]

type ctd_diagram_a5
  relations
    define parent: [ctd_document_a5]
    define viewer: viewer from parent
