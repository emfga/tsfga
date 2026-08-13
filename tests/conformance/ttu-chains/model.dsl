model
  schema 1.1

type user_a5

type employee_a5

type tu_role_a5
  relations
    define assignee: [user_a5]

type tu_permission_a5
  relations
    define role: [tu_role_a5]
    define assignee: assignee from role

type tu_job_a5
  relations
    define can_read: [tu_permission_a5#assignee]
    define cannot_read: [user_a5] but not can_read

type tt_role_a5
  relations
    define assignee: [user_a5]

type tt_permission_a5
  relations
    define role: [tt_role_a5]
    define assignee: assignee from role

type tt_job_a5
  relations
    define permission: [tt_permission_a5]
    define can_read: assignee from permission
    define cannot_read: [user_a5] but not can_read

type ut_role_a5
  relations
    define assignee: [user_a5]

type ut_permission_a5
  relations
    define assignee: [ut_role_a5#assignee]

type ut_job_a5
  relations
    define permission: [ut_permission_a5]
    define can_read: assignee from permission
    define cannot_read: [user_a5] but not can_read

type uu_role_a5
  relations
    define assignee: [user_a5]

type uu_permission_a5
  relations
    define assignee: [uu_role_a5#assignee]

type uu_job_a5
  relations
    define can_read: [uu_permission_a5#assignee]
    define cannot_read: [user_a5] but not can_read

type mt_group_a5
  relations
    define can_view: [employee_a5]

type mt_folder_a5
  relations
    define can_view: [user_a5]

type mt_document_a5
  relations
    define parent: [employee_a5, mt_group_a5, mt_folder_a5]
    define viewer: can_view from parent

type ct_folder_a5
  relations
    define owner: [user_a5]
    define viewer: owner

type ct_document_a5
  relations
    define parent: [ct_folder_a5]
    define can_view: viewer from parent

type cu_group_a5
  relations
    define member: [user_a5]

type cu_folder_a5
  relations
    define parent: [cu_folder_a5]
    define viewer: [cu_group_a5#member]
    define can_view: viewer or can_view from parent

type cu_document_a5
  relations
    define parent: [cu_folder_a5]
    define viewer: can_view from parent

type tc_group_a5
  relations
    define member: [user_a5]

type tc_module_a5
  relations
    define parent: [tc_module_a5]
    define viewer: [tc_group_a5#member]
    define can_view: viewer or can_view from parent

type tc_folder_a5
  relations
    define parent: [tc_module_a5, tc_folder_a5]
    define can_view: can_view from parent

type tc_document_a5
  relations
    define parent: [tc_folder_a5]
    define viewer: can_view from parent

type nd_folder1_a5

type nd_folder2_a5
  relations
    define viewer: [user_a5]

type nd_document_a5
  relations
    define parent: [nd_folder1_a5, nd_folder2_a5]
    define viewer: viewer from parent
