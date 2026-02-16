model
  schema 1.1

type employee
  relations
    define manager: [employee]
    define can_manage: manager or can_manage from manager

type report
  relations
    define submitter: [employee]
    define can_approve: can_manage from submitter
