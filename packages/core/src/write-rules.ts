/**
 * The names of the rules the write gates apply.
 *
 * Two namespaces, not one. `UPSTREAM_RULE_IDS` is in total
 * bijection with `packages/core/write-gate-causes.json` — every id
 * here is claimed by at least one upstream cause, and every id a
 * cause claims is here. That bijection is the completeness
 * argument, and it is asserted by
 * `packages/core/tests/write-gate-causes.test.ts`.
 * `CAPABILITY_RULE_IDS` is for refusals tsfga makes that upstream
 * does not; they have no upstream cause and must never be given
 * one.
 *
 * **These are ids, not an order.** The rules stay where they are
 * in `tuple-validation.ts`, `config-validation.ts` and
 * `index.ts`, and their precedence is the order of the statements
 * that raise them. Lifting them into an ordered table was
 * considered and rejected: a rule's index would become its
 * precedence, and no per-rule diff can see an index. Measured on
 * this repository, splitting one restriction loop into two passes
 * changed which cause a malformed write reported and 879 tests
 * still passed.
 *
 * What an id buys is the join. `error.ruleId` says which rule
 * fired, so a conformance assertion can be about *which* of two
 * competing refusals won rather than only that one did — which is
 * what precedence means — and the inventory can point at executed
 * code rather than at a string in a JSON file matching a string
 * in an array.
 */

/**
 * Rules that implement a refusal OpenFGA also makes.
 *
 * Sorted, because the order here means nothing at all and a sorted
 * list is the one a reader can check against the inventory.
 */
export const UPSTREAM_RULE_IDS = [
  "CONDITION-EXPRESSION-COMPILE",
  "CONDITION-NAME-MALFORMED",
  "CONDITION-PARAMETER-NAME-MALFORMED",
  "CONFIG-ADMITS-AND-REWRITES-NOTHING",
  "CONFIG-CONDITION-UNDEFINED",
  "CONFIG-INTERSECTION-TOO-FEW-OPERANDS",
  "CONFIG-NO-ENTRYPOINT",
  "CONFIG-RELATION-NAME-MALFORMED",
  "CONFIG-RELATION-NAME-RESERVED",
  "CONFIG-RESTRICTIONS-ON-NON-ASSIGNABLE",
  "CONFIG-REWRITE-CYCLE",
  "CONFIG-REWRITE-NAMES-ITSELF",
  "CONFIG-TUPLESET-ADMITS-USERSET",
  "CONFIG-TUPLESET-ADMITS-WILDCARD",
  "CONFIG-TUPLESET-NOT-DIRECT",
  "CONFIG-TYPE-NAME-MALFORMED",
  "CONFIG-TYPE-NAME-RESERVED",
  "DELETE-OBJECT-MALFORMED",
  "DELETE-RELATION-MALFORMED",
  "DELETE-SUBJECT-MALFORMED",
  "DELETE-SUBJECT-TOO-LONG",
  "DELETE-TUPLE-MISSING",
  "REQUEST-CONTEXT-FORBIDDEN-CHARS",
  "TUPLE-CONDITION-MISSING",
  "TUPLE-CONDITION-NAME-FORBIDDEN-CHARS",
  "TUPLE-CONDITION-NOT-ADMITTED",
  "TUPLE-CONDITION-UNDEFINED",
  "TUPLE-CONTEXT-FORBIDDEN-CHARS",
  "TUPLE-CONTEXT-PARAMETER-TYPE",
  "TUPLE-CONTEXT-PARAMETER-UNDECLARED",
  "TUPLE-CONTEXT-TOO-LARGE",
  "TUPLE-DUPLICATE",
  "TUPLE-IMPLICIT",
  "TUPLE-OBJECT-MALFORMED",
  "TUPLE-OBJECT-TOO-LONG",
  "TUPLE-OBJECT-WILDCARD",
  "TUPLE-RELATION-UNDEFINED",
  "TUPLE-SUBJECT-MALFORMED",
  "TUPLE-SUBJECT-NOT-ADMITTED",
  "TUPLE-SUBJECT-WILDCARD-SHAPE",
] as const;

/**
 * Rules that refuse something OpenFGA accepts.
 *
 * Each has an entry in `packages/core/capability-refusals.json`
 * carrying a conformance test that pins the divergence, and none
 * may appear in an upstream cause's `rules`. A rule cannot declare
 * itself one of these: the pin helpers refuse to pass on
 * agreement, so an entry has to exhibit a case where OpenFGA
 * demonstrably accepts what tsfga refuses.
 */
export const CAPABILITY_RULE_IDS = [
  "CEL-MATCHES-UNSUPPORTED",
  "ID-DOMAIN-OUT-OF-DOMAIN",
] as const;

export type UpstreamRuleId = (typeof UPSTREAM_RULE_IDS)[number];
export type CapabilityRuleId = (typeof CAPABILITY_RULE_IDS)[number];

/** Every rule id, either namespace. */
export type WriteRuleId = UpstreamRuleId | CapabilityRuleId;
