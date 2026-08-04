---
"@tsfga/core": minor
"@tsfga/kysely": minor
---

Production-readiness release. Breaking/behavior changes: check()
throws DepthExceededError on depth exhaustion and cycles instead of
returning false (fixes a fail-open in excludedBy resolution);
exclusion now applies on top of intersection results; CEL condition
cache is keyed by expression content so redefinitions take effect
immediately; contextual tuples are validated like addTuple;
listObjects accepts and propagates request context; listSubjects
returns "*" instead of the wildcard sentinel UUID; the generated DB
type only covers the tsfga schema; kysely peer range capped at
<0.30.0; packages are ESM-only and require Node >= 22.12. New:
@tsfga/kysely/migrations exports a static migrationProvider for
one-call schema provisioning; LICENSE ships in both tarballs.
