model
  schema 1.1

type user_a6g

type group_a6g
  relations
    define parent: [group_a6g]
    define direct_owner: [user_a6g]
    define direct_maintainer: [user_a6g]
    define direct_developer: [user_a6g]
    define direct_guest: [user_a6g, user_a6g:*]
    define banned: [user_a6g]
    define owner: direct_owner or owner from parent
    define maintainer: direct_maintainer or owner or maintainer from parent
    define developer: direct_developer or maintainer or developer from parent
    define guest: direct_guest or developer or guest from parent
    define can_admin: owner but not banned

type project_a6g
  relations
    define group: [group_a6g]
    define direct_developer: [user_a6g]
    define direct_guest: [user_a6g]
    define archived: [user_a6g:*]
    define maintainer: maintainer from group
    define developer: direct_developer or maintainer or developer from group
    define guest: direct_guest or developer or guest from group
    define can_read: guest
    define can_push: developer but not archived
    define can_admin: maintainer but not archived
