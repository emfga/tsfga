model
  schema 1.1

type user_c3h

type department_c3h
  relations
    define member: [user_c3h]

type patient_c3h
  relations
    define primary_physician: [user_c3h]
    define care_team: [user_c3h, department_c3h#member]
    define opted_out: [user_c3h, department_c3h#member]
    define consented_viewer: care_team but not opted_out
    define emergency_responder: [user_c3h with active_emergency_c3h]
    define can_view: consented_viewer or primary_physician or emergency_responder

type record_c3h
  relations
    define patient: [patient_c3h]
    define author: [user_c3h]
    define sensitivity_locked: [user_c3h:*]
    define clearance_reader: [user_c3h with min_clearance_c3h]
    define break_glass: [user_c3h with break_glass_window_c3h]
    define can_view: author or can_view from patient
    define can_view_sensitive: can_view but not sensitivity_locked
    define can_view_restricted: can_view_sensitive or clearance_reader or break_glass
    define can_amend: author and can_view from patient

condition active_emergency_c3h(emergency: bool, facility: string) {
  emergency && facility.startsWith("ward-")
}

condition min_clearance_c3h(clearance: int, required: int) {
  clearance >= required
}

condition break_glass_window_c3h(now: timestamp, expires_at: timestamp) {
  now < expires_at
}
