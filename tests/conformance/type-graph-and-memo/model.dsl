model
  schema 1.1

type user_b3g

type group_b3g
  relations
    define member: [user_b3g, group_b3g#member]

type folder_b3g
  relations
    define viewer: [group_b3g#member]
    define public: [user_b3g:*]

type shelf_b3g
  relations
    define viewer: [user_b3g]

type doc_b3g
  relations
    define parent: [folder_b3g, shelf_b3g]
    define arm_a: [group_b3g#member]
    define arm_b: [user_b3g]
    define either: arm_a or arm_b
    define from_parent: viewer from parent
    define anyone: public from parent
    define self_a: [user_b3g, doc_b3g#self_b]
    define self_b: [doc_b3g#self_a]
