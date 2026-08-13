model
  schema 1.1

type user_c3b

type department_c3b
  relations
    define head: [user_c3b]
    define member: [user_c3b] or head

type account_c3b
  relations
    define department: [department_c3b]
    define owner: [user_c3b]
    define viewer: [user_c3b, department_c3b#member]
    define can_view: viewer or owner or head from department

type transfer_c3b
  relations
    define account: [account_c3b]
    define maker: [user_c3b]
    define auditor: [user_c3b]
    define designated_checker: [user_c3b, department_c3b#member]
    define compliance_hold: [user_c3b:*]
    define eligible_checker: designated_checker but not maker
    define can_approve: eligible_checker but not compliance_hold
    define can_post: can_approve but not auditor
    define can_view: maker or designated_checker or can_view from account
    define dual_control: can_approve and can_view from account
