model
  schema 1.1

type user_a1

type bot_a1

# `member` admits `bot_a1` and itself -- an entrypoint the model
# validator requires, and one that no `user_a1` can ever take. So
# upstream's type-graph reachability test prunes the whole subtree
# before a single tuple is read.
type ring_a1
  relations
    define member: [bot_a1, ring_a1#member with valid_ip_a1]

# p1 and p2 loop through two different relations, so upstream's
# recursive-relation resolvers do not apply -- a walk of this pair
# really is a cycle. `bot_a1` is again the entrypoint no `user_a1`
# can take.
type pair_a1
  relations
    define member: [bot_a1, pair_a1#owner]
    define owner: [bot_a1, pair_a1#member]

type chain_a1
  relations
    define member: [bot_a1, chain_a1#member]

type doc_a1
  relations
    define via_ring: [ring_a1#member]
    define via_chain: [chain_a1#member]
    define via_pair: [pair_a1#member]
    define granted: [user_a1]
    define ring_excluded: granted but not via_ring
    define chain_excluded: granted but not via_chain
    define pair_excluded: granted but not via_pair

condition valid_ip_a1(user_ip: string) {
  user_ip == "192.168.0.1"
}
