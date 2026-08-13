model
  schema 1.1

type user_c3a

type team_c3a
  relations
    define member: [user_c3a, team_c3a#member]

type org_c3a
  relations
    define admin: [user_c3a]
    define member: [user_c3a, team_c3a#member] or admin

type repo_c3a
  relations
    define org: [org_c3a]
    define public: [user_c3a:*]
    define writer: [user_c3a, team_c3a#member]
    define can_read: writer or public or member from org
    define can_push: writer or admin from org

type environment_c3a
  relations
    define repo: [repo_c3a]
    define required_reviewer: [user_c3a, team_c3a#member]
    define branch_allowed: [user_c3a:* with branch_pattern_c3a]
    define blocked: [user_c3a:* with branch_pattern_c3a]
    define can_deploy: can_push from repo
    define can_deploy_now: can_deploy and branch_allowed
    define can_deploy_unblocked: can_deploy but not blocked

type deployment_c3a
  relations
    define environment: [environment_c3a]
    define requester: [user_c3a]
    define can_approve: required_reviewer from environment but not requester
    define can_run: can_approve and can_deploy_now from environment

condition branch_pattern_c3a(branch: string, pattern: string) {
  branch.matches(pattern)
}
