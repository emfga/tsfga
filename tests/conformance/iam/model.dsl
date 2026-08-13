model
  schema 1.1

type user_a6i

type group_a6i
  relations
    define member: [user_a6i, group_a6i#member]

type policy_a6i
  relations
    define allowed_principal: [user_a6i, group_a6i#member, user_a6i:*]
    define denied_principal: [user_a6i, group_a6i#member, user_a6i:* with outside_vpc_a6i]

type account_a6i
  relations
    define root_user: [user_a6i]
    define attached_policy: [policy_a6i]
    define scp: [policy_a6i]
    define allow: allowed_principal from attached_policy
    define deny: denied_principal from scp

type resource_a6i
  relations
    define account: [account_a6i]
    define resource_policy: [policy_a6i]
    define explicit_allow: allowed_principal from resource_policy or allow from account
    define explicit_deny: denied_principal from resource_policy or deny from account
    define can_access: explicit_allow but not explicit_deny
    define can_administer: root_user from account but not explicit_deny

condition outside_vpc_a6i(source_vpc: string) {
  source_vpc != "vpc-acme"
}
