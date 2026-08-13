model
  schema 1.1

type user_d4l

type group_d4l
  relations
    define member: [user_d4l, group_d4l#member]

type course_d4l
  relations
    define instructor: [user_d4l, group_d4l#member]
    define ta: [user_d4l, group_d4l#member]
    define student: [user_d4l, group_d4l#member]
    define withdrawn: [user_d4l, user_d4l:*]
    define staff: instructor or ta
    define participant: (staff or student) but not withdrawn

type section_d4l
  relations
    define course: [course_d4l]
    define ta: [user_d4l] or ta from course
    define student: [user_d4l, user_d4l with enrollment_code_d4l] or student from course
    define staff: [user_d4l] or staff from course
    define blocked: [user_d4l, user_d4l:*] or withdrawn from course
    define can_view: (staff or student) but not blocked

type assignment_d4l
  relations
    define section: [section_d4l]
    define published: [user_d4l:* with after_release_d4l]
    define conflicted: [user_d4l]
    define visible: published or staff from section
    define can_view: visible and can_view from section
    define can_grade: ta from section but not conflicted

type submission_d4l
  relations
    define assignment: [assignment_d4l]
    define peer_of: [submission_d4l]
    define author: [user_d4l]
    define peer_reviewer: [user_d4l with review_window_d4l]
    define muted: [user_d4l, user_d4l:*]
    define can_view: author or peer_reviewer or can_grade from assignment or can_view from peer_of
    define can_comment: can_view but not muted

condition enrollment_code_d4l(code: string) {
  size(code) == 7 && code.startsWith("ABC-")
}

condition after_release_d4l(now: timestamp, release_at: timestamp) {
  now >= release_at
}

condition review_window_d4l(now: timestamp, opens_at: timestamp, closes_at: timestamp) {
  now >= opens_at && now < closes_at
}
