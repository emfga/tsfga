model
  schema 1.1

type user_d3u

type doca_d3u
  relations
    define restricted: [user_d3u, doca_d3u#viewer]
    define viewer: [user_d3u] but not restricted

type docb_d3u
  relations
    define restrictedb: [user_d3u, docb_d3u#viewer]
    define restricteda: restrictedb
    define viewer: [user_d3u] but not restricteda

type docc_d3u
  relations
    define admin: [user_d3u:*]
    define viewer: [user_d3u with cond_d3u] but not admin

type docd_d3u
  relations
    define admin: [user_d3u with cond_d3u]
    define viewer: [user_d3u] but not admin

condition cond_d3u(x: int) {
  x < 100
}
