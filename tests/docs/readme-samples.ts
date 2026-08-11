/**
 * The code samples the READMEs publish, compiled.
 *
 * These shipped as prose and had never been type-checked: both
 * quick starts omitted five required `RelationConfig` fields, and
 * the gate-predicate example passed three of `directSubjectRef`'s
 * four arguments -- a call that also demonstrated the
 * unconditioned-ref mistake the fourth parameter exists to
 * prevent.
 *
 * This file is authoritative. `scripts/check-readme-samples.mjs`
 * fails if a README's fenced block has drifted from the region it
 * quotes, and `bun run tsc` fails if a region stops compiling. To
 * change a sample, change it here and run the check.
 *
 * Nothing here is executed. The samples open connections and write
 * rows; compiling them is the whole point.
 */

import {
  admitsSubjectRef,
  createTsfga,
  directSubjectRef,
  type TupleStore,
} from "@tsfga/core";

declare const store: TupleStore;

export async function coreQuickStart(): Promise<void> {
  // #region core-quick-start
  const fga = createTsfga(store);

  // Write a relation config
  await fga.writeRelationConfig({
    objectType: "document",
    relation: "viewer",
    // What the relation admits, one entry per entry of OpenFGA's
    // `directly_related_user_types`: `{ type }` for a bare type,
    // `{ type, wildcard: true }` for `user:*`, `{ type, relation }`
    // for a userset, and `condition` on any of them. `[]` means the
    // relation admits no direct assignment at all.
    directlyAssignable: [{ type: "user" }],
    // The rewrite fields. A relation that is only directly
    // assignable names none of them, but all are required, so a
    // config cannot silently omit one it meant to set.
    impliedBy: null,
    computedUserset: null,
    tupleToUserset: null,
    excludedBy: null,
    intersection: null,
  });

  // Add a tuple
  await fga.addTuple({
    objectType: "document",
    objectId: "550e8400-e29b-41d4-a716-446655440000",
    relation: "viewer",
    subjectType: "user",
    subjectId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  });

  // Check access
  const allowed = await fga.check({
    objectType: "document",
    objectId: "550e8400-e29b-41d4-a716-446655440000",
    relation: "viewer",
    subjectType: "user",
    subjectId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  });
  // #endregion core-quick-start
  void allowed;
}

export async function gatePredicate(): Promise<void> {
  // #region gate-predicate
  const config = await store.findRelationConfig("document", "viewer");
  // No config means the model does not define the relation, which
  // `check` refuses rather than treats as unrestricted. The
  // predicate takes it non-null so the same decision is yours to
  // make here.
  if (config === null) throw new Error("document.viewer is not configured");
  // The fourth argument is the condition name. Passing null asks
  // whether the relation admits `team#member` *unconditioned* --
  // a relation admitting only `team#member with in_hours` will
  // say no, which is the answer `check` gives too.
  admitsSubjectRef(config, directSubjectRef("team", "eng", "member", null));
  // #endregion gate-predicate
}
