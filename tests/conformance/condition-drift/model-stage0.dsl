model
  schema 1.1

type user_a5

type pci_document_a5
  relations
    define viewer: [user_a5 with oldcondition_a5]

type pcd_document_a5
  relations
    define viewer: [user_a5 with oldcondition_a5]

type wwc_group_a5
  relations
    define member: [user_a5, user_a5:*]

type flt_document_a5
  relations
    define viewer: [user_a5 with condfloat_a5]

condition oldcondition_a5(x: int) {
  x > 200
}

condition newcondition_a5(x: int) {
  x > 200
}

condition condfloat_a5(x: double) {
  x > 0.0
}

condition ts_less_than_a5(ts: timestamp) {
  ts < timestamp("2023-10-11T10:00:00.000Z")
}
