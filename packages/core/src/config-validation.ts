import { InvalidRelationConfigError } from "./errors.ts";
import type { TupleStore } from "./store-interface.ts";
import type { RelationConfig } from "./types.ts";

/**
 * Validate a relation config against the rules OpenFGA's
 * typesystem applies when it validates a model.
 *
 * Four shapes are refused, each measured against v1.18.2 as an
 * `invalid_authorization_model` upstream and, before this,
 * accepted here — two of them changing an answer rather than
 * merely widening the write surface:
 *
 * - **an `intersection` with fewer than two operands.** Upstream:
 *   `as intersection has less than 2 children`. tsfga resolved a
 *   single-operand intersection to whatever that operand said, so
 *   a config that means nothing granted.
 * - **a tupleset relation admitting a userset.** Upstream: `the
 *   relation type 'folder#owner' on 'parent' in object type 'doc'
 *   is not valid`. tsfga admitted the row and then dispatched on
 *   its object while **discarding its subject relation**, landing
 *   on a different relation of the linked object and granting.
 * - **a tupleset relation admitting a wildcard.** Refused the same
 *   way upstream; here it resolved to `false` rather than
 *   granting, so it is a write-surface gap only.
 * - **a type restriction naming a condition the store does not
 *   define.** Upstream: `condition nope is undefined for relation
 *   viewer`.
 *
 * ## The stated gap: write order
 *
 * A model is one document upstream, so its relations are validated
 * together. Here configs arrive one at a time, and the two tupleset
 * rules are properties of a **different** relation than the one
 * being written — the relation named as `tupleset`. When that
 * relation's config has not been written yet there is nothing to
 * read, and this **skips the check** rather than guessing.
 *
 * So a config declaring a tuple-to-userset **before** its tupleset
 * relation's config exists is not validated, and neither is a later
 * widening of that tupleset relation. Closing either would need a
 * reverse lookup — "which configs name me as a tupleset" — that
 * `TupleStore` does not have and that is not worth adding for this.
 * A validator that fired on write order would be worse than one
 * with a gap written down: it would refuse correct models for
 * arriving in an order nothing documents.
 *
 * The condition rule has no such gap, because the absence of a
 * condition definition *is* the defect rather than a missing
 * premise. It does mean conditions must be defined before the
 * configs that name them, which is the order upstream's atomic
 * model write imposes anyway.
 */
export async function validateRelationConfigWrite(
  store: TupleStore,
  config: RelationConfig,
): Promise<void> {
  const refuse = (
    cause: ConstructorParameters<typeof InvalidRelationConfigError>[0],
    detail?: string,
  ): never => {
    throw new InvalidRelationConfigError(
      cause,
      config.objectType,
      config.relation,
      detail,
    );
  };

  if (config.intersection !== null && config.intersection.length < 2) {
    refuse(
      "intersection has fewer than two operands",
      `${config.intersection.length}`,
    );
  }

  for (const restriction of config.directlyAssignable) {
    if (restriction.condition === undefined) continue;
    const definition = await store.findConditionDefinition(
      restriction.condition,
    );
    if (!definition) refuse("undefined condition", restriction.condition);
  }

  for (const tupleset of tuplesetRelations(config)) {
    const linked = await store.findRelationConfig(config.objectType, tupleset);
    // Not yet written: see the write-order gap above.
    if (!linked) continue;
    for (const restriction of linked.directlyAssignable) {
      if (restriction.relation !== undefined) {
        refuse(
          "tupleset relation admits a userset",
          `${tupleset} admits ${restriction.type}#${restriction.relation}`,
        );
      }
      if (restriction.wildcard) {
        refuse(
          "tupleset relation admits a wildcard",
          `${tupleset} admits ${restriction.type}:*`,
        );
      }
    }
  }
}

/**
 * Every relation this config reads as a tupleset.
 *
 * Both places one can appear: the plain `tupleToUserset` entries
 * of step 5 and an `intersection` operand of that type. The second
 * is the one a fix applied to the first alone would leave open,
 * which is the same pairing `resolveTupleset` exists for.
 */
function tuplesetRelations(config: RelationConfig): Set<string> {
  const relations = new Set<string>();
  for (const entry of config.tupleToUserset ?? []) {
    relations.add(entry.tupleset);
  }
  for (const operand of config.intersection ?? []) {
    if (operand.type === "tupleToUserset") relations.add(operand.tupleset);
  }
  return relations;
}
