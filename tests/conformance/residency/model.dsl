model
  schema 1.1

type user_d4r

type group_d4r
  relations
    define member: [user_d4r, group_d4r#member]

type tenant_d4r
  relations
    define steward: [user_d4r, group_d4r#member]
    define auditor: [user_d4r, user_d4r with class_ok_d4r]
    define embargoed: [user_d4r with retained_d4r, user_d4r:*]
    define reader: (steward or auditor) but not embargoed

type dataset_d4r
  relations
    define tenant: [tenant_d4r with region_ok_d4r]
    define curator: [user_d4r with eu_principal_d4r, group_d4r#member]
    define classified: [user_d4r with class_ok_d4r]
    define can_read: curator or classified or reader from tenant
    define can_manage: [user_d4r with residency_d4r] and reader from tenant

type record_d4r
  relations
    define dataset: [dataset_d4r with region_ok_d4r]
    define owner: [user_d4r]
    define reviewer: [user_d4r with retained_d4r, group_d4r#member]
    define embargoed: [user_d4r with retained_d4r, user_d4r:*]
    define inherited_read: can_read from dataset
    define can_view: (owner or reviewer or inherited_read) but not embargoed

condition region_ok_d4r(region: string, allowed_regions: list<string>) {
  region in allowed_regions
}

condition class_ok_d4r(clearance: int, required: int) {
  clearance >= required
}

condition retained_d4r(now: timestamp, expires_at: timestamp) {
  now < expires_at
}

condition eu_principal_d4r(principal: string) {
  principal.startsWith("mira.k@") && principal.endsWith("@eu.example")
}

condition residency_d4r(residency: map<string>, tenant_key: string, region: string) {
  residency[tenant_key] == region
}
