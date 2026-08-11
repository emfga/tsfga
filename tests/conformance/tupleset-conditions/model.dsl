model
  schema 1.1

type user

type folder
  relations
    define viewer: [user]
    define editor: [user]

type document
  relations
    define parent: [folder, folder with flag]
    define viewer: viewer from parent
    define gated: (editor from parent) and (viewer from parent)

condition flag(on: bool) {
  on == true
}
