model
  schema 1.1

type user_d4m

type group_d4m
  relations
    define member: [user_d4m, group_d4m#member]

type merchant_d4m
  relations
    define owner: [user_d4m, group_d4m#member]
    define staff: [user_d4m, group_d4m#member]
    define banned: [user_d4m, user_d4m:*]
    define can_administer: owner or staff

type seller_d4m
  relations
    define merchant: [merchant_d4m]
    define operator: [user_d4m, group_d4m#member]
    define banned: banned from merchant
    define can_manage: (operator or can_administer from merchant) but not banned

type listing_d4m
  relations
    define seller: [seller_d4m]
    define editor: [user_d4m, user_d4m with escrow_state_d4m]
    define verified: [user_d4m, group_d4m#member]
    define manager: can_manage from seller
    define banned: banned from seller
    define can_edit: (editor or manager) but not banned
    define can_publish: verified and can_manage from seller

type order_d4m
  relations
    define listing: [listing_d4m]
    define buyer: [user_d4m, user_d4m with escrow_state_d4m]
    define seller: manager from listing
    define auditor: [user_d4m with order_ref_d4m]
    define blocked: [user_d4m:*]
    define banned: banned from listing
    define can_release: (buyer or auditor) but not blocked
    define can_view: (buyer or seller or auditor) but not banned

type dispute_d4m
  relations
    define order: [order_d4m]
    define arbiter: [user_d4m, group_d4m#member]
    define party: buyer from order or seller from order
    define banned: banned from order
    define can_comment: (party or arbiter) but not banned

condition escrow_state_d4m(state: string, allowed: list<string>) {
  state in allowed
}

condition order_ref_d4m(ref: string) {
  ref.startsWith("ord-") && ref.endsWith(".web") && size(ref) == 12
}
