import { InvalidRelationConfigError } from "./errors.ts";
import type { TupleStore } from "./store-interface.ts";
import { isRe2Space } from "./tuple-validation.ts";
import type { ConditionDefinition, RelationConfig } from "./types.ts";
import type { WriteRuleId } from "./write-rules.ts";

/**
 * Validate a relation config against the rules OpenFGA's
 * typesystem applies when it validates a model.
 *
 * Nine shapes are refused, each measured against v1.18.2 as an
 * `invalid_authorization_model` upstream and, before this,
 * accepted here — several of them changing an answer rather than
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
 * - **a tupleset relation that is not a direct relation.**
 *   Upstream: `the 'doc#alias' relation is referenced in at least
 *   one tupleset and thus must be a direct relation`.
 *   `resolveTupleset` reads a tupleset by tuples alone, with no
 *   rewrite expansion, so a computed one finds nothing and the
 *   relation answers `false` for every subject, forever.
 * - **type restrictions on a relation that admits no direct
 *   assignment.** Upstream: `the non-assignable relation 'viewer'
 *   in object type 'doc' should not contain a relation type`. The
 *   restrictions are dead weight with one live effect: a tuple can
 *   be *written* against them and is then invisible to every
 *   check.
 * - **a relation that admits nothing and rewrites nothing.**
 *   Upstream: `the assignable relation 'viewer' in object type
 *   'doc' must contain at least one relation type`. Inert in both
 *   directions, and there is no model it corresponds to.
 * - **a relation with no entrypoint**, in the one form a single
 *   config decides — see below.
 * - **a rewrite on the same object naming the relation it
 *   defines.** Upstream: `ErrInvalidUsersetRewrite`, in all four
 *   positions a computed userset can hold. Write-surface only in
 *   three of them; on the subtract side of an exclusion it made
 *   the relation answer `false` for a directly granted subject —
 *   see `selfNamingRewrite` below.
 *
 * ## The stated gap: write order
 *
 * A model is one document upstream, so its relations are validated
 * together. Here configs arrive one at a time, and several rules
 * are properties of a **different** relation than the one being
 * written — the relation named as `tupleset`, or a relation on a
 * linked type. When that relation's config has not been written
 * yet there is nothing to read, and this **skips the check**
 * rather than guessing.
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
 * ### Two rules this gap keeps out entirely
 *
 * Upstream also refuses a rewrite naming a relation that does not
 * exist, and a tuple-to-userset whose computed relation **no**
 * tupleset type defines. Neither can be decided from one config,
 * and not for want of trying: both premises are *always* absent
 * for a forward reference, so "skip when absent" degenerates into
 * "never check", while checking strictly refuses correct models.
 *
 * That is measured, not assumed. Run warn-only over this repo's
 * own conformance corpus, the strict forms refuse 43 config writes
 * across `deep-rewrite`, `nested-folders`, `ttu-chains`,
 * `recursive-relations`, `a8-*` and `theopenlane.*` — every one of them
 * an ordinary model whose relations happen to be written in
 * definition order rather than dependency order. `viewer: a but
 * not banned` written before `banned`, and `blocked: nblocked from
 * parent` written before `nblocked`, are not defects.
 *
 * Both belong to a validator that sees the whole model at once —
 * a batch config write, or a `validateModel()` pass — and both are
 * left open deliberately rather than half-closed here. The
 * check-time behaviour is already correct for the first (a check
 * reaching an undefined relation is refused, as upstream refuses
 * it); what is missing is only the earlier, cheaper refusal that
 * names the actual mistake.
 *
 * The condition rule has no such gap, because the absence of a
 * condition definition *is* the defect rather than a missing
 * premise. It does mean conditions must be defined before the
 * configs that name them, which is the order upstream's atomic
 * model write imposes anyway.
 *
 * ## The names themselves
 *
 * Ahead of all of them, and ahead of every store read, the config's
 * own `objectType` and `relation` are checked twice: for
 * well-formedness against the proto pattern (`isWellFormedName`),
 * and against the two names the model reserves
 * (`RESERVED_KEYWORDS`). They are the cheapest rules here and the
 * earliest ones upstream applies — `validateNames` runs from
 * `NewAndValidate` before any relation is validated at all.
 */
export async function validateRelationConfigWrite(
  store: TupleStore,
  config: RelationConfig,
): Promise<void> {
  // Each rule names itself. The id is a trailing argument at the
  // raise site rather than an index in a table, so nothing about
  // the order below moves -- and the order is the precedence.
  const refuse = (
    ruleId: WriteRuleId,
    cause: ConstructorParameters<typeof InvalidRelationConfigError>[0],
    detail?: string,
  ): never => {
    throw new InvalidRelationConfigError(
      cause,
      config.objectType,
      config.relation,
      detail,
      undefined,
      ruleId,
    );
  };

  if (!isWellFormedName(config.objectType, MAX_TYPE_NAME_LENGTH)) {
    refuse(
      "CONFIG-TYPE-NAME-MALFORMED",
      "malformed type name",
      describeName(config.objectType),
    );
  }

  if (RESERVED_KEYWORDS.has(config.objectType)) {
    refuse(
      "CONFIG-TYPE-NAME-RESERVED",
      "reserved keyword",
      `type name '${config.objectType}'`,
    );
  }

  if (!isWellFormedName(config.relation, MAX_RELATION_NAME_LENGTH)) {
    refuse(
      "CONFIG-RELATION-NAME-MALFORMED",
      "malformed relation name",
      describeName(config.relation),
    );
  }

  if (RESERVED_KEYWORDS.has(config.relation)) {
    refuse(
      "CONFIG-RELATION-NAME-RESERVED",
      "reserved keyword",
      `relation name '${config.relation}'`,
    );
  }

  const selfNamed = selfNamingRewrite(config);
  if (selfNamed !== null) {
    refuse(
      "CONFIG-REWRITE-NAMES-ITSELF",
      "rewrite names its own relation",
      selfNamed,
    );
  }

  if (await hasRewriteCycle(store, config)) {
    refuse("CONFIG-REWRITE-CYCLE", "rewrite cycle");
  }

  if (config.intersection !== null && config.intersection.length < 2) {
    refuse(
      "CONFIG-INTERSECTION-TOO-FEW-OPERANDS",
      "intersection has fewer than two operands",
      `${config.intersection.length}`,
    );
  }

  if (config.directlyAssignable.length === 0 && !hasRewrite(config)) {
    refuse(
      "CONFIG-ADMITS-AND-REWRITES-NOTHING",
      "relation admits nothing and rewrites nothing",
    );
  }

  // An `intersection` with no `direct` operand is upstream's
  // `intersection(...)` with no `This` child: the relation admits
  // no direct assignment at all, so restrictions on it describe
  // nothing. The converse is *not* a defect -- `directlyAssignable`
  // beside `impliedBy` / `computedUserset` / `tupleToUserset` /
  // `excludedBy` is `union(This, ...)` and `difference(This, ...)`,
  // both valid and both all over the corpus.
  if (
    config.directlyAssignable.length > 0 &&
    config.intersection !== null &&
    !config.intersection.some((operand) => operand.type === "direct")
  ) {
    refuse(
      "CONFIG-RESTRICTIONS-ON-NON-ASSIGNABLE",
      "type restrictions on a non-assignable relation",
      config.directlyAssignable.map((each) => each.type).join(", "),
    );
  }

  for (const restriction of config.directlyAssignable) {
    if (restriction.condition === undefined) continue;
    const definition = await store.findConditionDefinition(
      restriction.condition,
    );
    if (!definition) {
      refuse(
        "CONFIG-CONDITION-UNDEFINED",
        "undefined condition",
        restriction.condition,
      );
    }
  }

  for (const tupleset of tuplesetRelations(config)) {
    const linked = await store.findRelationConfig(config.objectType, tupleset);
    // Not yet written: see the write-order gap above.
    if (!linked) continue;
    if (hasRewrite(linked)) {
      refuse(
        "CONFIG-TUPLESET-NOT-DIRECT",
        "tupleset relation is not a direct relation",
        `${tupleset} is computed`,
      );
    }
    for (const restriction of linked.directlyAssignable) {
      if (restriction.relation !== undefined) {
        refuse(
          "CONFIG-TUPLESET-ADMITS-USERSET",
          "tupleset relation admits a userset",
          `${tupleset} admits ${restriction.type}#${restriction.relation}`,
        );
      }
      if (restriction.wildcard) {
        refuse(
          "CONFIG-TUPLESET-ADMITS-WILDCARD",
          "tupleset relation admits a wildcard",
          `${tupleset} admits ${restriction.type}:*`,
        );
      }
    }
  }

  if (await hasNoEntrypoint(store, config)) {
    refuse("CONFIG-NO-ENTRYPOINT", "relation has no entrypoint");
  }
}

/**
 * Validate a condition definition's **names** against the rules
 * OpenFGA applies to a model write.
 *
 * Two fields, one predicate. `Condition.name` and every key of
 * `Condition.parameters` carry the proto pattern
 * `^[^:#@\s]{1,50}$` — the same character class and the same bound
 * as a relation name, on a different field. Measured on v1.18.2,
 * which reports the pattern verbatim: `invalid Condition.Name` for
 * the first and `invalid Condition.Parameters[…]` for the second.
 *
 * Both are refused *before* the expression is compiled. A
 * condition stored under a name upstream refuses is one no
 * `directly_related_user_types` entry of an acceptable model could
 * ever name, so the model tsfga holds is one OpenFGA would not
 * store — the same defect the gate on a config's own names
 * closes, reached through the other write path.
 *
 * A parameter name is the one place the model's name class and
 * CEL's identifier grammar disagree: CEL cannot *reference* a
 * parameter named `bad:p`, so the expression would fail to
 * resolve, but the model gate refuses the key before that ever
 * matters — which is why the rule is on the key and not on the
 * expression.
 *
 * Nothing else here is checked. The expression is
 * `compileCondition`'s, and the parameter *types* are the type
 * union's.
 */
export function validateConditionWrite(condition: ConditionDefinition): void {
  const refuse = (
    ruleId: WriteRuleId,
    cause: ConstructorParameters<typeof InvalidRelationConfigError>[0],
    detail: string,
  ): never => {
    throw new InvalidRelationConfigError(
      cause,
      null,
      null,
      detail,
      condition.name,
      ruleId,
    );
  };

  if (!isWellFormedName(condition.name, MAX_RELATION_NAME_LENGTH)) {
    refuse(
      "CONDITION-NAME-MALFORMED",
      "malformed condition name",
      describeName(condition.name),
    );
  }

  // A different loop, and every key runs it: upstream's message
  // names the offending key, so the detail does too.
  for (const parameter of Object.keys(condition.parameters ?? {})) {
    if (!isWellFormedName(parameter, MAX_RELATION_NAME_LENGTH)) {
      refuse(
        "CONDITION-PARAMETER-NAME-MALFORMED",
        "malformed condition parameter name",
        `${describeName(parameter)} in '${parameter}'`,
      );
    }
  }
}

/**
 * The characters no name in a model may hold — a type's, a
 * relation's, a condition's, or a condition parameter's — measured
 * against v1.18.2 rather than read off a Go file.
 *
 * The model write path is guarded by protobuf field patterns, not
 * by the typesystem and not by `pkg/tuple`'s `IsValidRelation`:
 * `^[^:#@\s]{1,254}$` on `TypeDefinition.Type` and
 * `^[^:#@\s]{1,50}$` on each key of `TypeDefinition.Relations`.
 * Both classes are identical, so this is one predicate under two
 * bounds rather than two predicates — including `@`, which
 * `IsValidRelation` refuses and which the type pattern refuses
 * too.
 *
 * The `\s` half is `isRe2Space`, shared with the tuple write and
 * delete paths, which is where the measurements and the reason for
 * not borrowing JavaScript's class are written down. This
 * deliberately does not reuse `tuple-validation.ts`'s
 * control-character rule: that one is the tuple write path's, and
 * applying it here would refuse names upstream stores.
 */
const NAME_RESERVED: ReadonlySet<string> = new Set([":", "#", "@"]);

/** A character no name may hold: reserved, or Go's `\s`. */
function isNameReserved(char: string): boolean {
  return NAME_RESERVED.has(char) || isRe2Space(char);
}

/**
 * The two names a model may not give a type or a relation.
 *
 * `validateNames` refuses both, on both fields, with
 * `ErrReservedKeywords` — and it runs from `NewAndValidate` before
 * any relation is validated, so it is the earliest model rule
 * upstream has. It is also one of the few that is decidable from a
 * single config, because both premises are the config's own.
 *
 * **This is deliberately not applied to `validateConditionWrite`.**
 * `validateNames` walks type definitions and their relation keys
 * and looks at nothing else; v1.18.2 stores a condition named
 * `self` without complaint, measured against the container. A
 * tidying pass that "unifies" the two name gates would refuse a
 * definition upstream takes.
 *
 * Exact names, not a prefix or a substring: `selfish` and `this_1`
 * are ordinary and the corpus has their like.
 */
const RESERVED_KEYWORDS: ReadonlySet<string> = new Set(["self", "this"]);

/**
 * 254, measured by bisecting model writes against the container:
 * accepted at 254, `type_invalid_pattern` at 255.
 */
const MAX_TYPE_NAME_LENGTH = 254;

/**
 * 50, bisected the same way; 51 is `relations_invalid_pattern`.
 * Note the code is plural — there is no `relation_invalid_pattern`
 * and no `*_invalid_length` on either field, because the bound
 * lives in the pattern.
 *
 * The same bound carries `Condition.name` and every key of
 * `Condition.parameters` — one constant for three fields, because
 * upstream spells the one pattern on all three rather than because
 * they happen to agree.
 */
const MAX_RELATION_NAME_LENGTH = 50;

/**
 * Whether a name is one the model can carry.
 *
 * The bound counts **code points**, as a Go regexp quantifier
 * does: a 254-character name of `é` is accepted at 508 bytes, and
 * 254 astral code points are accepted at 508 UTF-16 units. So
 * neither `Buffer.byteLength` nor `String.length` is the measure —
 * hence the spread.
 */
function isWellFormedName(name: string, maxLength: number): boolean {
  const codePoints = [...name];
  if (codePoints.length === 0) return false;
  if (codePoints.length > maxLength) return false;
  return !codePoints.some(isNameReserved);
}

/** Why the name was refused, for the error's `detail`. */
function describeName(name: string): string {
  const codePoints = [...name];
  if (codePoints.length === 0) return "empty";
  const offending = codePoints.find(isNameReserved);
  if (offending !== undefined) {
    const code = offending.codePointAt(0) ?? 0;
    const hex = code.toString(16).toUpperCase().padStart(4, "0");
    return `reserved character U+${hex}`;
  }
  return `${codePoints.length} characters`;
}

/** Whether the config rewrites at all, in any of the five arms. */
function hasRewrite(config: RelationConfig): boolean {
  return (
    (config.impliedBy ?? []).length > 0 ||
    config.computedUserset !== null ||
    (config.tupleToUserset ?? []).length > 0 ||
    config.excludedBy !== null ||
    (config.intersection ?? []).length > 0
  );
}

/**
 * Where, if anywhere, a rewrite on this object names the relation
 * it defines — `viewer: viewer`, `viewer: a or viewer`,
 * `viewer: a and viewer`, `viewer: a but not viewer`.
 *
 * `isUsersetRewriteValid` refuses `computedUserset == relation`
 * outright and recurses into union children, intersection children
 * and **both** sides of a difference, so upstream's one rule
 * reaches every position a `ComputedUserset` node can sit in.
 * Mapped onto a `RelationConfig` that is exactly four fields:
 * `computedUserset`, an entry of `impliedBy`, `excludedBy`, and an
 * `intersection` operand of type `computedUserset`. The returned
 * string names which, for the error's detail; the cause is the
 * same one upstream reports for all four.
 *
 * ## `tupleToUserset` is not one of them, and that is the rule
 *
 * A `TupleToUserset` is its own case in upstream's switch and
 * carries no self-relation test — `viewer: viewer from parent`
 * names this relation on **another** object, which is the single
 * most common shape an OpenFGA model has. Extending this
 * predicate to `tupleToUserset` would refuse
 * `gcloud`'s deny policy, `oncall`'s `member from
 * parent_team`, `market`'s TTU onto a TTU, `nested-folders`,
 * `recursive-relations`, `recursion-depth-boundary` and `snowflake` — every one of
 * them a model the container stores. The self-recursive TTU that
 * *is* refused upstream is refused for having no entrypoint, and
 * only in the closed form `hasNoEntrypoint` below decides.
 *
 * ## The one arm with a behaviour behind it
 *
 * Three of the four are write-surface only: a rewrite onto its own
 * relation revisits a node already on the resolution path, the
 * cycle path resolves it `false`, and the relation answers what
 * its other arms say. `excludedBy` is different — a cycle on the
 * **subtract** side denies, so `viewer: [user] but not viewer`
 * answered `false` for a directly granted subject, on a model
 * OpenFGA would never have stored. Refusing the config removes the
 * only way to reach that, so the check path needs no change.
 */
function selfNamingRewrite(config: RelationConfig): string | null {
  const { relation } = config;
  if (config.computedUserset === relation) return "computedUserset";
  if ((config.impliedBy ?? []).includes(relation)) return "an impliedBy arm";
  if (config.excludedBy === relation) return "excludedBy";
  for (const operand of config.intersection ?? []) {
    if (operand.type === "computedUserset" && operand.relation === relation) {
      return "an intersection operand";
    }
  }
  return null;
}

/**
 * Every relation on the *same object type* that this config's
 * rewrites read.
 *
 * `directlyAssignable` and `tupleToUserset` are deliberately not
 * among them. `hasCycle` returns `false` immediately on both
 * `Userset_This` and `Userset_TupleToUserset`
 * (`pkg/typesystem/typesystem.go`), so following either would
 * refuse models upstream stores -- `viewer: viewer from parent`
 * is the single most common shape an OpenFGA model has.
 */
function sameTypeRewriteTargets(config: RelationConfig): string[] {
  const targets = [...(config.impliedBy ?? [])];
  if (config.computedUserset !== null) targets.push(config.computedUserset);
  if (config.excludedBy !== null) targets.push(config.excludedBy);
  for (const operand of config.intersection ?? []) {
    if (operand.type === "computedUserset" && operand.relation !== undefined) {
      targets.push(operand.relation);
    }
  }
  return targets;
}

/**
 * Whether the rewrites reachable from this config lead back to a
 * relation already on the path -- upstream's `ErrCycle`, `an
 * authorization model cannot contain a cycle`.
 *
 * Refused outright by OpenFGA and, until this rule, stored here.
 * Nothing was granted by it: every check under such a model walks
 * onto a node already on the resolution path and resolves `false`.
 * The damage is that a model upstream will not store is accepted
 * silently, and every later assumption about it starts from a
 * premise upstream refuses.
 *
 * ## Two sets, and both are load-bearing
 *
 * The **path** set is copied per branch, as upstream copies its
 * `visited` map. A single global set would call the diamond
 * `a: b or c`, `b: d`, `c: d` a cycle, because `d` is reached
 * twice and is not on either path when it is.
 *
 * The **finished** set is shared, and it is what keeps the walk
 * linear. A relation whose whole subtree has been cleared once
 * cannot start a cycle on any later path, so re-walking it buys
 * nothing and costs a store read each time. Without it the walk
 * is exponential on a re-convergent rewrite graph and costs one
 * read per edge on a chain -- 40 sequential reads on this
 * repository's deepest fixture.
 *
 * ## Where it stops, and why that cannot produce a false positive
 *
 * A target whose config has not been written yet is skipped, for
 * the write-order reason above: the premise is absent rather than
 * false. So this is deliberately weaker than upstream's rule, in
 * the direction that accepts rather than refuses. Run over this
 * repository's whole conformance corpus -- 3158 configs across 144
 * files, 2082 same-type rewrite edges -- it refuses nothing, both
 * as the configs arrive and against the final state.
 *
 * A target naming the relation being written is left to
 * `selfNamingRewrite`, which runs first and reports upstream's
 * *other* cause for it, `ErrInvalidUsersetRewrite`. So the depth-1
 * case never arrives here and needs no guard.
 */
async function hasRewriteCycle(
  store: TupleStore,
  config: RelationConfig,
): Promise<boolean> {
  const finished = new Set<string>();

  const walk = async (
    current: RelationConfig,
    path: ReadonlySet<string>,
  ): Promise<boolean> => {
    for (const target of sameTypeRewriteTargets(current)) {
      if (path.has(target)) return true;
      if (finished.has(target)) continue;
      const linked = await store.findRelationConfig(config.objectType, target);
      // Not yet written: see the write-order gap above.
      if (!linked) continue;
      const branch = new Set(path);
      branch.add(target);
      if (await walk(linked, branch)) return true;
      finished.add(target);
    }
    return false;
  };

  return walk(config, new Set([config.relation]));
}

/**
 * The one form of "no entrypoint" a single config decides.
 *
 * Upstream applies `hasEntrypoints` to every relation of a whole
 * model: a relation is invalid when nothing can ever satisfy it.
 * That is a whole-model property and `writeRelationConfig` sees one
 * config, so only the closed case is decidable here — the relation
 * whose *sole* arm is a tuple-to-userset onto itself, over a
 * tupleset that admits its own object type and nothing else:
 *
 *     define parent: [doc]
 *     define viewer: viewer from parent      # never `[user] or ...`
 *
 * Every check on it walks the parent chain and answers `false`, or
 * — on a chain longer than the depth budget — raises, which is a
 * *refusal* for a model upstream would never have stored.
 *
 * The three narrowings are each load-bearing. A directly
 * assignable arm, or any second arm, is an entrypoint. A tupleset
 * admitting some *other* type is not a cycle at all: that type's
 * relation may well have one, which is why `adoc#viewer: viewer
 * from bparent` over `bdoc` is ordinary. And a tupleset relation
 * with no restrictions at all is not evidence of a cycle either;
 * it is a config not yet written the way it will be.
 *
 * The general rule stays open beside the write-order gap above,
 * rather than being closed half-way.
 */
async function hasNoEntrypoint(
  store: TupleStore,
  config: RelationConfig,
): Promise<boolean> {
  const entries = config.tupleToUserset ?? [];
  if (entries.length === 0) return false;
  if (config.directlyAssignable.length > 0) return false;
  if (
    (config.impliedBy ?? []).length > 0 ||
    config.computedUserset !== null ||
    config.excludedBy !== null ||
    (config.intersection ?? []).length > 0
  ) {
    return false;
  }

  for (const entry of entries) {
    if (entry.computedUserset !== config.relation) return false;
    const linked = await store.findRelationConfig(
      config.objectType,
      entry.tupleset,
    );
    // Not yet written: see the write-order gap above.
    if (!linked) return false;
    if (linked.directlyAssignable.length === 0) return false;
    const selfOnly = linked.directlyAssignable.every(
      (restriction) => restriction.type === config.objectType,
    );
    if (!selfOnly) return false;
  }
  return true;
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
