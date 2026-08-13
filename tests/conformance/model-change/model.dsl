model
  schema 1.1

type user_a5

type employee_a5

type pti_document_a5
  relations
    define viewer: [employee_a5]

type ptw_document_a5
  relations
    define viewer: [user_a5]

type wos_document_a5
  relations
    define writer: [user_a5:*]
    define viewer: [user_a5] or writer

type uop_group1_a5
  relations
    define member: [user_a5, user_a5:*]

type uop_group2_a5
  relations
    define member: [user_a5, user_a5:*]

type uop_document_a5
  relations
    define viewer: [uop_group1_a5#member]

type trp_group_a5
  relations
    define member: [user_a5]

type trp_document_a5
  relations
    define parent: [trp_group_a5]
    define viewer: member from parent

type top_group_a5
  relations
    define member: [user_a5]

type top_document_a5
  relations
    define parent: [top_group_a5]
    define viewer: member from parent

type tdi_role_a5
  relations
    define assignee: [user_a5]

type tdi_job_a5
  relations
    define parent: [tdi_role_a5]
    define can_read: assignee from parent

type udi_role_a5
  relations
    define placeholder: [user_a5]
    define assignee: [user_a5]

type udi_job_a5
  relations
    define can_read: [udi_role_a5#assignee]

type udw_role_a5
  relations
    define assignee: [user_a5]

type udw_job_a5
  relations
    define can_read: [udw_role_a5#assignee]
