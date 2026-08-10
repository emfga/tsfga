model
  schema 1.1

type user

type group
  relations
    define member: [user, group#owner]
    define owner: [user, group#member]

type document
  relations
    define parent: [document]
    define base: [user]
    define cyclic: [group#member]
    define conditioned: [user with valid_ip]
    define chain0: [user]
    define chain1: chain0 from parent
    define chain2: chain1 from parent
    define chain3: chain2 from parent
    define chain4: chain3 from parent
    define chain5: chain4 from parent
    define chain6: chain5 from parent
    define chain7: chain6 from parent
    define chain8: chain7 from parent
    define chain9: chain8 from parent
    define slow_and_cycle: chain9 and cyclic
    define blocked: slow_and_cycle
    define guarded: base but not blocked
    define errored_and_cycle: conditioned and cyclic

condition valid_ip(user_ip: string) {
  user_ip == "192.168.0.1"
}
