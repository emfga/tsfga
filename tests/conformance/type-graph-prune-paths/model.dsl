model
  schema 1.1

type user_b2p

type agent_b2p

type grp_b2p
  relations
    define member: [user_b2p, grp_b2p#member]
    define open_member: [user_b2p:*]
    define any_member: member or open_member

type alpha_b2p
  relations
    define rel: [beta_b2p#rel]

type beta_b2p
  relations
    define rel: [alpha_b2p#rel, user_b2p]

type bin_b2p
  relations
    define keeper: [agent_b2p]

type shelf_b2p
  relations
    define keeper: [user_b2p]

type crate_b2p
  relations
    define holder: [user_b2p]

type box_b2p
  relations
    define slot: [bin_b2p, shelf_b2p, crate_b2p]
    define reach: keeper from slot

type gate_b2p
  relations
    define parent: [grp_b2p]
    define assigned: [user_b2p]
    define via_parent: any_member from parent
    define both: assigned and via_parent
    define lifted: both
    define lifted2: lifted
    define narrow: [grp_b2p#member] and via_parent
