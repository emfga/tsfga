model
  schema 1.1

type user_a8

type doc_a8
  relations
    define parent: [doc_a8]
    define viewer: [user_a8] or viewer from parent

type group_a8
  relations
    define member: [user_a8, group_a8#member]

type adoc_a8
  relations
    define bparent: [bdoc_a8]
    define viewer: [user_a8] or viewer from bparent

type bdoc_a8
  relations
    define aparent: [adoc_a8]
    define viewer: [user_a8] or viewer from aparent

type ddoc_a8
  relations
    define parent: [ddoc_a8]
    define shortcut: [ddoc_a8]
    define viewer: [user_a8] or viewer from parent or viewer from shortcut

type mgroup_a8
  relations
    define member: [user_a8]

type mdoc_a8
  relations
    define parent: [mdoc_a8]
    define viewer: [user_a8, mgroup_a8#member] or viewer from parent

type ndoc_a8
  relations
    define parent: [ndoc_a8]
    define owner: [user_a8]
    define viewer: [user_a8] or owner or viewer from parent

type ogroup_a8
  relations
    define admin: [user_a8]
    define member: [user_a8, ogroup_a8#member] or admin

type ldoc_a8
  relations
    define r0: [user_a8]
    define r1: r0
    define r2: r1
    define r3: r2
    define r4: r3
    define r5: r4
    define r6: r5
    define r7: r6
    define r8: r7
    define r9: r8
    define r10: r9
    define r11: r10
    define r12: r11
    define r13: r12
    define r14: r13
    define r15: r14
    define r16: r15
    define r17: r16
    define r18: r17
    define r19: r18
    define r20: r19
    define r21: r20
    define r22: r21
    define r23: r22
    define r24: r23
    define r25: r24
    define r26: r25
    define r27: r26
    define r28: r27
    define r29: r28
    define r30: r29
    define r31: r30
    define r32: r31
    define r33: r32
    define r34: r33
    define r35: r34
    define r36: r35
    define r37: r36
    define r38: r37
    define r39: r38
    define r40: r39
