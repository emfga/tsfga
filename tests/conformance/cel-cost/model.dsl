model
  schema 1.1

type user_d3c

type doc_d3c
  relations
    define viewer: [user_d3c with equal_d3c]
    define member: [user_d3c with member_d3c]
    define exists_viewer: [user_d3c with exists_d3c]
    define all_viewer: [user_d3c with all_d3c]
    define map_viewer: [user_d3c with map_d3c]
    define filter_viewer: [user_d3c with filter_d3c]
    define one_viewer: [user_d3c with one_d3c]

condition equal_d3c(x: string, y: string) {
  x == y
}

condition member_d3c(needle: string, haystack: list<string>) {
  needle in haystack
}

condition exists_d3c(l: list<string>) {
  l.exists(x, x == 'zz')
}

condition all_d3c(l: list<string>) {
  l.all(x, x != 'nope')
}

condition map_d3c(l: list<string>) {
  size(l.map(x, x + '!')) > 0
}

condition filter_d3c(l: list<string>) {
  size(l.filter(x, x != 'nope')) >= 0
}

condition one_d3c(l: list<string>) {
  l.exists_one(x, x == 'zz')
}
