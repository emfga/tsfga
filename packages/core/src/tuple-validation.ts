import { coerceContext } from "./conditions.ts";
import {
  type ConditionalTupleCause,
  IdDomainError,
  type IdPosition,
  InvalidConditionalTupleError,
  InvalidObjectError,
  InvalidRequestContextError,
  InvalidSubjectTypeError,
  RelationConfigNotFoundError,
} from "./errors.ts";
import type { TupleStore } from "./store-interface.ts";
import type {
  AddTupleRequest,
  RelationConfig,
  RemoveTupleRequest,
  TypeRestriction,
} from "./types.ts";
import type { WriteRuleId } from "./write-rules.ts";

/**
 * A subject ref with its condition dropped.
 *
 * The type dimension and the condition dimension are checked
 * separately, because OpenFGA checks them separately and answers
 * differently for each: a wrong *type* is refused by the type
 * pass, which never looks at the condition
 * (`internal/validation/validation.go`), and a wrong condition on
 * an admitted type is a different error with its own cause. This
 * is the value the first pass compares.
 */
export interface SubjectShape {
  type: string;
  /** Set for a userset ref: `team#member`. */
  relation?: string;
  /** Set for the typed wildcard: `user:*`. */
  wildcard?: true;
}

/**
 * The shape a tuple's subject presents to a type restriction.
 *
 * A wildcard row is one whose subject id is literally `*`, so the
 * id is what distinguishes `user:*` from `user`; a subject
 * relation makes it a userset regardless of the id.
 */
export function subjectShape(
  subjectType: string,
  subjectId: string,
  subjectRelation: string | null | undefined,
): SubjectShape {
  if (subjectRelation !== null && subjectRelation !== undefined) {
    return { type: subjectType, relation: subjectRelation };
  }
  if (subjectId === "*") {
    return { type: subjectType, wildcard: true };
  }
  return { type: subjectType };
}

/**
 * The full restriction a tuple must be admitted under, condition
 * included.
 *
 * `conditionName` is a **required** parameter rather than an
 * optional fourth one. Every caller has to state it, so adding the
 * condition dimension made the compiler enumerate the call sites
 * instead of letting an existing one keep compiling while silently
 * building an unconditioned ref — which is the fail-open direction.
 */
export function directSubjectRef(
  subjectType: string,
  subjectId: string,
  subjectRelation: string | null | undefined,
  conditionName: string | null | undefined,
): TypeRestriction {
  const shape = subjectShape(subjectType, subjectId, subjectRelation);
  if (conditionName === null || conditionName === undefined) return shape;
  return { ...shape, condition: conditionName };
}

/** Whether two restrictions name the same shape, condition aside. */
function sameShape(restriction: TypeRestriction, shape: SubjectShape): boolean {
  return (
    restriction.type === shape.type &&
    restriction.relation === shape.relation &&
    restriction.wildcard === shape.wildcard
  );
}

/**
 * Whether the relation admits *any* assignment of this shape,
 * whatever condition it carries.
 *
 * This is the read gate, and it is condition-blind **by
 * necessity**: it runs before the row exists, and the condition
 * lives on the row. Asking for a conditioned row and a bare one
 * separately would be two queries for what the store answers in
 * one.
 *
 * So the gate is deliberately wider than the write gate. What
 * makes that safe is that `clampToQuery` performs the exact
 * four-field match on the reply, before the check algorithm sees a
 * row. The invariant is `readGate ⊇ writeGate ∧ clamp ≡ writeGate`
 * — *not* that the two gates agree, which they cannot.
 *
 * The config is required rather than nullable. It used to admit
 * `null` and answer `true` for it, which made a relation nobody
 * had configured the widest gate in the library instead of the
 * narrowest; every caller now establishes the config exists before
 * asking, and a relation without one is refused rather than
 * unrestricted.
 */
export function admitsSubjectShape(
  config: RelationConfig,
  shape: SubjectShape,
): boolean {
  return config.directlyAssignable.some((r) => sameShape(r, shape));
}

/**
 * Whether the relation admits exactly this restriction — type,
 * userset relation, wildcard **and** condition.
 *
 * Used by the clamp and by the write path, which are the two
 * places holding a real row.
 *
 * Exported so a consumer narrowing their own query can apply the
 * gate tsfga applies rather than reimplementing it and drifting.
 * Three hazards come with that, and they are why this is
 * documented rather than merely exposed:
 *
 * - **The config is not optional.** This used to accept `null` and
 *   answer `true` for it, matching a `check()` that read a missing
 *   config as unrestricted. Both are gone: `check()` now raises
 *   `RelationConfigNotFoundError` on a relation with no config, so
 *   the misspelled relation name that used to silently admit
 *   everything is a `null` the compiler makes you handle.
 * - **This is not the read gate.** Narrowing a query by this
 *   predicate is narrowing by the *exact* restriction, which is
 *   correct for filtering rows you already hold and wrong for
 *   deciding which rows to fetch — the condition is on the row.
 *   Use `admitsSubjectShape` to decide what to ask for.
 * - **This is not the whole gate either.** It filters tuple
 *   shapes. It knows nothing of `excludedBy` or `intersection`,
 *   which revoke a grant after the row is read, so a row passing
 *   it is a row `check()` will *consider*, not one it will allow.
 */
export function admitsSubjectRef(
  config: RelationConfig,
  ref: TypeRestriction,
): boolean {
  return config.directlyAssignable.some(
    (r) => sameShape(r, ref) && r.condition === ref.condition,
  );
}

/**
 * The restrictions of this shape the relation admits, for the
 * store to narrow on.
 *
 * `[]` is a positive answer — the relation admits nothing of this
 * shape — and the caller reads it as "do not ask". There is no
 * "declines to narrow" answer any more: every relation a check
 * reaches has a config, so there is always something to narrow
 * against.
 */
export function admittedRefsForShape(
  config: RelationConfig,
  shape: SubjectShape,
): readonly TypeRestriction[] {
  return config.directlyAssignable.filter((r) => sameShape(r, shape));
}

/** The userset refs the relation admits. */
export function admittedUsersetRefs(
  config: RelationConfig,
): readonly TypeRestriction[] {
  return config.directlyAssignable.filter((r) => r.relation !== undefined);
}

/**
 * Whether a set of admitted refs covers this one.
 *
 * `null` declines to narrow and so admits everything; `[]` admits
 * nothing. Shared by the clamp and the store-reply checks so the
 * two cannot read the same query differently.
 *
 * **Deliberately still permissive on `null`,** where the config
 * gates above no longer are. This one reads a `CheckTuplesQuery`
 * rather than a config, and that type keeps its nullable fields:
 * they are how a wrapper says "I did not narrow this part", which
 * is a statement about a query and not about a model. Core stopped
 * emitting `null` in them — it always holds a config now — so what
 * the clamp compares against is always the real restriction list.
 */
export function refsAdmit(
  refs: readonly TypeRestriction[] | null,
  ref: TypeRestriction,
): boolean {
  if (refs === null) return true;
  return refs.some(
    (r) =>
      r.type === ref.type &&
      r.relation === ref.relation &&
      r.wildcard === ref.wildcard &&
      r.condition === ref.condition,
  );
}

/**
 * Whether the tuple says only what the model already says:
 * `doc:1#blocked@doc:1#blocked`.
 *
 * A predicate, not a gate, and deliberately **not** called from
 * `validateTupleWrite`. That function is shared by `addTuple` and
 * by contextual-tuple validation, and the two paths differ here:
 * upstream refuses the write and *accepts* the contextual tuple.
 * Only `addTuple` applies it.
 */
export function isSelfDefining(request: AddTupleRequest): boolean {
  return (
    request.subjectType === request.objectType &&
    request.subjectId === request.objectId &&
    request.subjectRelation === request.relation
  );
}

/**
 * OpenFGA's `DefaultWriteContextByteLimit`
 * (`pkg/server/config/config.go:36`) — 32 KiB.
 */
export const DEFAULT_WRITE_CONTEXT_BYTE_LIMIT = 32 * 1024;

/**
 * The `TupleKey.user` proto constraint — 512 **UTF-8 bytes** on the
 * whole wire string, `type:id` or `type:id#relation`, not on the id
 * alone.
 *
 * It is an API-layer constraint (`openfga.pb.validate.go`,
 * `len(m.GetUser()) > 512`) rather than a `pkg/tuple` rule, so it
 * sits beside the context limit rather than inside the
 * well-formedness predicate. Bisected against the v1.18.2
 * container: `user_q2:` plus 504 bytes is accepted and plus 505 is
 * refused, and 252 two-byte runes are accepted where 253 are not —
 * so the unit is bytes, not code points.
 */
const WRITE_SUBJECT_BYTE_LIMIT = 512;

/**
 * The `TupleKey.object` proto constraint — `^[^\s]{2,256}$`, so 256
 * **code points** on the whole `type:id` wire string.
 *
 * Go's regexp quantifier counts runes, and the container agrees:
 * `doc_q2:` plus 249 ASCII characters is accepted and plus 250 is
 * refused, while 200 two-byte runes (407 bytes) are accepted. The
 * two limits therefore have different units, which is why they are
 * two constants and not one.
 */
const WRITE_OBJECT_RUNE_LIMIT = 256;

/** One encoder, reused: the contexts measured here can be large. */
const UTF8 = new TextEncoder();

/** UTF-8 byte length, which is what protobuf and Go's `len` count. */
function utf8Length(value: string): number {
  return UTF8.encode(value).length;
}

/** Bytes in the base-128 varint encoding of a length. */
function varintLength(value: number): number {
  let bytes = 1;
  let rest = Math.floor(value / 128);
  while (rest > 0) {
    bytes += 1;
    rest = Math.floor(rest / 128);
  }
  return bytes;
}

/**
 * The serialised size of one `google.protobuf.Value`.
 *
 * Each kind is a field of the `kind` oneof, so exactly one is
 * emitted: `null_value` (1, varint enum), `number_value` (2,
 * fixed64 double), `string_value` (3, length-delimited),
 * `bool_value` (4, varint), `struct_value` (5) and `list_value`
 * (6). A oneof member is written even when it holds its zero
 * value, which is why `null` costs 2 bytes and not 0.
 *
 * A value protobuf cannot carry at all — `bigint`, `undefined`, a
 * function — is measured as `null`, because that is what a
 * `structpb.Value` built from it would hold.
 */
function protoValueSize(value: unknown): number {
  if (typeof value === "string") {
    const n = utf8Length(value);
    return 1 + varintLength(n) + n;
  }
  if (typeof value === "number") return 9;
  if (typeof value === "boolean") return 2;
  if (Array.isArray(value)) {
    let items = 0;
    for (const item of value) {
      const size = protoValueSize(item);
      items += 1 + varintLength(size) + size;
    }
    return 1 + varintLength(items) + items;
  }
  if (typeof value === "object" && value !== null) {
    const size = protoStructSize(value);
    return 1 + varintLength(size) + size;
  }
  return 2;
}

/**
 * The serialised size of a `google.protobuf.Struct`, which is what
 * upstream measures a condition context with.
 *
 * `Struct` is a single `map<string, Value> fields = 1`, and a
 * protobuf map field is sugar for a repeated message of `key` (1)
 * and `value` (2). So each entry costs its own tag and length
 * prefix on top of the two it contains.
 *
 * This replaces `JSON.stringify`, which diverged from upstream in
 * both directions: JSON's framing is 8 bytes where protobuf's is
 * 15, and `JSON.stringify` escapes quotes, backslashes and control
 * characters where protobuf carries raw UTF-8 — so a context of
 * 20 KiB of quote characters measured 40 KiB and was refused,
 * though upstream accepts it.
 *
 * Calibration, asserted in `tuple-validation.test.ts`: one string
 * entry keyed `s` comes out at `len(s) + 15`, so `"x".repeat(32753)`
 * is exactly 32768 and is the largest context upstream accepts.
 */
function protoStructSize(struct: object): number {
  let total = 0;
  for (const [key, value] of Object.entries(struct)) {
    const keyBytes = utf8Length(key);
    const valueSize = protoValueSize(value);
    const entry =
      1 +
      varintLength(keyBytes) +
      keyBytes +
      1 +
      varintLength(valueSize) +
      valueSize;
    total += 1 + varintLength(entry) + entry;
  }
  return total;
}

/**
 * Whether an id is well-formed in the sense the four `pkg/tuple`
 * predicates share: at least one character, no Unicode control
 * character anywhere, and none of the separators the wire string
 * reserves.
 *
 * `IsValidUserID` reserves `#`, `:` and U+0020; `IsValidObject`
 * reserves `#` and U+0020, and reserves `:` for the one separating
 * the type from the id — which tsfga carries in a field of its own,
 * so a `:` inside `objectId` is always a second one and is refused
 * the same way. `*` is reserved by neither: it is the wildcard, and
 * both predicates admit it in the `default` arm.
 */
function isWellFormedId(id: string, reserved: readonly string[]): boolean {
  if (id.length === 0) return false;
  if (hasControlChar(id)) return false;
  return !reserved.some((char) => id.includes(char));
}

/** The five characters Go's `\s` matches inside an RE2 pattern. */
const RE2_SPACE: ReadonlySet<string> = new Set([" ", "\t", "\n", "\f", "\r"]);

/**
 * Go's `\s` inside an RE2 pattern — `[\t\n\f\r ]` and nothing else.
 *
 * Every upstream rule this package ports that mentions whitespace
 * spells it with that class: `TupleKey.object`'s `^[^\s]{2,256}$`,
 * `TupleKey.relation`'s `^[^:#@\s]{1,50}$`, `ListUsers`'s object
 * pattern, and the model write path's `^[^:#@\s]{1,254}$` on a
 * type name and `^[^:#@\s]{1,50}$` on a relation name.
 *
 * It is a shared predicate, and not a `/\s/` at each site, because
 * the difference is the whole point and it is invisible at a
 * glance. JavaScript's `\s` is the Unicode space property: it also
 * matches a vertical tab, a no-break space, U+2028 and every other
 * space separator, none of which Go matches. Probed against
 * v1.18.2: a vertical tab (U+000B), a no-break space (U+00A0),
 * U+2028 and an ideographic space are all **accepted** wherever
 * these patterns run, and so is every control character outside
 * the five. Borrowing JavaScript's class refuses what upstream
 * accepts — and on the delete path it did exactly that, leaving a
 * row that was writable, resolved `true`, and had no library path
 * that removed it.
 */
export function isRe2Space(char: string): boolean {
  return RE2_SPACE.has(char);
}

/**
 * The store's own id gate: refuse an id the store has declared it
 * cannot hold.
 *
 * **A capability refusal, not a parity claim.** Every id this
 * refuses is one OpenFGA accepts, which is why it carries a rule
 * id from `CAPABILITY_RULE_IDS` and has an entry in
 * `capability-refusals.json` rather than a cause in the upstream
 * inventory.
 *
 * **Where it sits is the decision: after every upstream rule about
 * the request's own strings, and before the first rule about the
 * subject's place in the model.** An id can be malformed by
 * upstream's rules *and*
 * outside the store's domain — every malformed id is, since none
 * of them is a canonical UUID — so the order is observable on
 * nearly every refusing input, and a caller must hear the refusal
 * that is portable rather than the one that is local to this
 * deployment. `doc:*` reports the typed-wildcard rule; a subject
 * holding `#` reports the malformed-subject rule; a perfectly
 * well-formed `user:alice` is what is left over, and that is the
 * request this rule exists to answer.
 *
 * It goes *before* the model rules for the symmetric reason. This
 * is a rule about a string, and upstream settles every string
 * question — `ValidateUser`, `ValidateObject` — before it consults
 * a single type restriction. A store that cannot hold the id has
 * nothing to say about whether the relation would have admitted
 * the subject, and asking anyway would make this the one string
 * rule in the gate that runs after the model.
 *
 * **One model question does precede it, at two call sites, and it
 * is not a restriction.** `validateTupleWrite` and `listObjects`
 * both fetch the relation config before anything else they do, so
 * a bad id on a relation the model does not define reports
 * `RelationConfigNotFoundError` rather than `IdDomainError`.
 * That is the config *lookup* — whether the relation exists at
 * all — and not a rule about what it admits. `check` and
 * `checkMany` have no such ordering: the id gate runs at the
 * request boundary, ahead of every read.
 *
 * **Absence is refused, and refused named.** `store.idDomain` may
 * be `undefined` at runtime — a JavaScript consumer, a spread
 * clone, a `Proxy`. Reading `.defect` off it there would throw a
 * bare `TypeError` from inside `check()`, breaking the invariant
 * that every error on the check and write paths extends
 * `TsfgaError`, and shipping the same unnamed crash this whole
 * design was bought to fix one layer up. So the read is
 * defensive and fails closed.
 *
 * `"*"` never reaches here: the typed wildcard is a subject
 * *shape*, not an id, and it is exempted at every call site.
 */
export function validateIdDomain(
  store: TupleStore,
  position: IdPosition,
  type: string,
  id: string,
): void {
  const domain: TupleStore["idDomain"] | undefined = store.idDomain;
  if (domain === undefined || domain === null) {
    throw new IdDomainError(
      position,
      type,
      id,
      "unknown",
      "store declares no id domain",
      "ID-DOMAIN-OUT-OF-DOMAIN",
    );
  }
  const defect = domain.defect(id);
  if (defect !== null) {
    throw new IdDomainError(
      position,
      type,
      id,
      domain.name,
      defect,
      "ID-DOMAIN-OUT-OF-DOMAIN",
    );
  }
}

/**
 * The subject half, with the typed wildcard exempted.
 *
 * `user:*` is a subject shape rather than an id — it names no
 * subject at all — so no store has to be able to hold `*` as one,
 * and refusing it here would refuse every wildcard grant there is.
 * Object ids get no such exemption: `validateObjectRef` already
 * refuses `doc:*` outright, before this runs.
 */
export function validateSubjectIdDomain(
  store: TupleStore,
  subjectType: string,
  subjectId: string,
): void {
  if (subjectId === "*") return;
  validateIdDomain(store, "subject", subjectType, subjectId);
}

/** `IsValidUserID`'s reserved set. */
const SUBJECT_ID_RESERVED: readonly string[] = ["#", ":", " "];

/** `IsValidObject`'s, once the type separator is accounted for. */
const OBJECT_ID_RESERVED: readonly string[] = ["#", ":", " "];

/**
 * The object half of the same well-formedness gate, shared by the
 * write path and the check path.
 *
 * It closed a hole rather than a failing test on the write side.
 * The rule was missing for as long as `@tsfga/kysely`'s
 * `object_id` was a `uuid` column, because the driver refused
 * every malformed object id on its own account and nothing could
 * observe the absence. It stayed missing for a window in which the
 * column was `text` and could observe it, which is how the gap
 * came to be reported at all. The column is `uuid` again and the
 * rule is core's, where it belongs: a store that holds opaque
 * strings gets it too.
 *
 * The check path once had no object gate at all: a malformed id is
 * a perfectly good text column value, so tsfga read no row and
 * answered `false` where upstream answers 400. The two
 * paths run the same predicate here because upstream runs the same
 * one — `ValidateObject`, reached from `ValidateUserObjectRelation`,
 * which `CheckCommand` and `WriteCommand` (through
 * `ValidateTupleForWrite`) both call, contextual tuples included.
 *
 * `IsValidObject` is **not** `IsValidUserID`. It walks the whole
 * `type:id` string, so the one `:` it allows is the type separator
 * — which tsfga carries in a field of its own, making any `:` in
 * `objectId` a second one. It has no userset arm either, so a `#`
 * is refused outright rather than reinterpreted.
 *
 * The three refusals are upstream's three, in upstream's order:
 * the format predicate, then the typed wildcard (`*` is a
 * *subject*, and `doc:*` is a row nothing may ever read), then
 * the `TupleKey.object` proto bound. The bound is the caller's
 * argument rather than a constant here because the error names the
 * measurement, and the two paths inherit it from different places
 * upstream even though both land on 256 runes.
 *
 * @throws InvalidObjectError — its own class, rather than
 *   `InvalidSubjectTypeError`, whose `subject` field would have to
 *   be a lie here.
 */
export function validateObjectRef(
  objectType: string,
  objectId: string,
  runeLimit: number,
  ruleIds?: {
    malformed: WriteRuleId;
    wildcard: WriteRuleId;
    tooLong: WriteRuleId;
  },
): void {
  if (!isWellFormedId(objectId, OBJECT_ID_RESERVED)) {
    throw new InvalidObjectError(
      "malformed object id",
      objectType,
      objectId,
      "an object id must be non-empty and hold no ':', '#', " +
        "space or control character",
      ruleIds?.malformed,
    );
  }
  if (objectId === "*") {
    throw new InvalidObjectError(
      "object id is a typed wildcard",
      objectType,
      objectId,
      undefined,
      ruleIds?.wildcard,
    );
  }
  const runes = [...`${objectType}:${objectId}`].length;
  if (runes > runeLimit) {
    throw new InvalidObjectError(
      "object too long",
      objectType,
      objectId,
      `${runes} characters exceeds ${runeLimit}`,
      ruleIds?.tooLong,
    );
  }
}

/**
 * What the check path measures the object against: the same 256
 * code points the write path does, on the same rendered string.
 *
 * Two names for one number, deliberately. Upstream reaches the
 * bound through two different constraints — the `TupleKey.object`
 * proto pattern on the write and the `CheckRequestTupleKey.Object`
 * pattern on the check — and they are free to diverge without
 * either being a bug, so the two call sites name their own.
 */
export const CHECK_OBJECT_RUNE_LIMIT = 256;

/**
 * And the subject: `CheckRequestTupleKey.User` is `^[^\s]{2,512}$`,
 * the same 512 UTF-8 bytes on the same rendered wire string as
 * `TupleKey.user`, for the same reason.
 */
export const CHECK_SUBJECT_BYTE_LIMIT = 512;

/**
 * The subject half of the request gate, as a complaint rather than
 * a throw: the write path reports it as an
 * `InvalidSubjectTypeError` carrying the relation's allow-list and
 * the check path as one carrying an empty list, and neither may
 * borrow the other's fields.
 *
 * Returns the detail string for the refusal, or `null` when the
 * subject is well formed. The two rules are `IsValidUserID` —
 * non-empty, no `:`, `#`, space or control character — and the
 * proto bound on the rendered `type:id` or `type:id#relation`
 * string, measured in bytes, which is the unit the container was
 * bisected against.
 */
export function requestSubjectDefect(
  subjectType: string,
  subjectId: string,
  subjectRelation: string | null | undefined,
  byteLimit: number,
): string | null {
  if (!isWellFormedId(subjectId, SUBJECT_ID_RESERVED)) {
    return (
      "a subject id must be non-empty and hold no ':', '#', " +
      "space or control character"
    );
  }
  const wire =
    subjectRelation === null || subjectRelation === undefined
      ? `${subjectType}:${subjectId}`
      : `${subjectType}:${subjectId}#${subjectRelation}`;
  const bytes = utf8Length(wire);
  if (bytes > byteLimit) {
    return `${bytes} bytes exceeds ${byteLimit}`;
  }
  return null;
}

/**
 * Whether a string holds a Unicode control character.
 *
 * Go's `unicode.IsControl` is exactly the `Cc` category —
 * U+0000-U+001F and U+007F-U+009F
 * (`internal/utils/sanitize.go:8-11`). Written as a scan rather
 * than a regular expression, because a regex literal spelling
 * that range has to hold the control characters themselves.
 */
function hasControlChar(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0);
    if (code === undefined) continue;
    if (code <= 0x1f) return true;
    if (code >= 0x7f && code <= 0x9f) return true;
  }
  return false;
}

/**
 * Whether a context holds a control character in a key or in a
 * string value, at any depth.
 *
 * Upstream walks the protobuf `Struct` the same way — keys, string
 * values, and recursively through lists and nested structs
 * (`ValidateStruct` / `validateValueForbiddenChars`,
 * `internal/validation/validation.go:402-441`). Numbers, booleans
 * and nulls carry no characters and are skipped, exactly as the
 * `switch` on the value kind skips them.
 *
 * Returns the offending string so the refusal can name it, with
 * the keys leading to it outermost first, or `null`.
 *
 * The path names keys only: a list contributes no element to it,
 * so a bad string inside `claims.roles` reports
 * `["claims", "roles"]` whether it is the value or an element of
 * it. Upstream reports no path at all, so this is additional
 * rather than divergent.
 */
interface ForbiddenChar {
  readonly path: readonly string[];
  readonly value: string;
}

function forbiddenChars(
  value: unknown,
  path: readonly string[] = [],
): ForbiddenChar | null {
  if (typeof value === "string") {
    return hasControlChar(value) ? { path, value } : null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = forbiddenChars(item, path);
      if (found !== null) return found;
    }
    return null;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, nested] of Object.entries(value)) {
      if (hasControlChar(key)) return { path, value: key };
      const found = forbiddenChars(nested, [...path, key]);
      if (found !== null) return found;
    }
  }
  return null;
}

/**
 * The same walk over a *request's* context, which upstream
 * validates before it resolves anything.
 *
 * `CheckCommand` runs `validation.ValidateStruct(requestCtx)`
 * ahead of the resolver (`pkg/server/commands/check_command.go:197`,
 * `internal/validation/validation.go:402-440`), so a control
 * character in the request context is a request-level refusal and
 * not a denial: the check never happens. tsfga applied the rule to
 * a tuple's context and nowhere else, which let a caller put a
 * value through the gate that upstream rejects outright.
 *
 * A tuple's context is *not* validated here — it is validated by
 * `validateTupleWrite`, which names the tuple it belongs to.
 *
 * @throws InvalidRequestContextError when a key or a string value,
 *   at any depth, holds a Unicode control character.
 */
export function validateRequestContext(
  context: Record<string, unknown> | undefined,
): void {
  if (context === undefined) return;
  const found = forbiddenChars(context);
  if (found === null) return;
  throw new InvalidRequestContextError(
    "context contains forbidden characters",
    found.path,
    found.value,
    "REQUEST-CONTEXT-FORBIDDEN-CHARS",
  );
}

/** What only the write path applies, on top of the shared gate. */
export interface TupleWriteValidationOptions {
  /**
   * Refuse a condition context larger than this many bytes,
   * measured as upstream measures it: the serialised size of the
   * `google.protobuf.Struct` the context becomes on the wire.
   *
   * `undefined` does not measure at all, which is what the
   * contextual-tuple path wants: upstream's limit lives in the
   * Write command and is not applied to a check request's
   * contextual tuples.
   */
  contextByteLimit?: number;
}

/**
 * Validate that a tuple is writable under the relation's config.
 * Used by both `addTuple` and contextual-tuple validation so the
 * two paths cannot drift apart.
 *
 * The two dimensions are checked in OpenFGA's order and reported
 * as OpenFGA reports them: the type first, condition-blind, then
 * the condition. Folding the second into `InvalidSubjectTypeError`
 * would produce `Subject type 'user with weekday_only' is not
 * allowed`, which names a type nobody wrote.
 *
 * @throws RelationConfigNotFoundError when no relation config
 *   exists for the tuple's object type + relation.
 * @throws InvalidSubjectTypeError when the subject's shape —
 *   `type`, `type:*` or `type#relation` — is not directly
 *   assignable under any condition.
 * @throws InvalidConditionalTupleError when the shape is
 *   assignable but not with the condition the tuple carries, or
 *   without one; when the condition name or the context holds a
 *   control character; or when the context is over the write
 *   limit, if one was given.
 */
export async function validateTupleWrite(
  store: TupleStore,
  request: AddTupleRequest,
  options?: TupleWriteValidationOptions,
): Promise<void> {
  const config = await store.findRelationConfig(
    request.objectType,
    request.relation,
  );
  if (!config) {
    throw new RelationConfigNotFoundError(
      request.objectType,
      request.relation,
      "TUPLE-RELATION-UNDEFINED",
    );
  }

  const shape = subjectShape(
    request.subjectType,
    request.subjectId,
    request.subjectRelation,
  );

  // `team:*#member` is not a userset, not a wildcard and not a
  // concrete subject: it is not a well-formed subject at all.
  // `subjectShape` reads the subject relation first and so files it
  // as the userset `team#member`, which a relation admitting
  // `team#member` would then accept — storing a row no model can
  // describe. Upstream refuses it in `ValidateUser`, before any
  // type restriction or condition is consulted
  // (`pkg/tuple/tuple.go:477-517`), and the order is observable, so
  // this runs before the shape gate rather than inside it.
  if (
    request.subjectId === "*" &&
    request.subjectRelation !== null &&
    request.subjectRelation !== undefined
  ) {
    throw new InvalidSubjectTypeError(
      shape,
      request.objectType,
      request.relation,
      config.directlyAssignable,
      "malformed subject",
      undefined,
      "TUPLE-SUBJECT-WILDCARD-SHAPE",
    );
  }

  // The rest of `IsValidUser`, in the same place and for the same
  // reason as the wildcard gate above it: it is a statement about
  // the request, not about what the relation admits, and upstream
  // decides it in `ValidateUser` before any type restriction or
  // condition is read (`pkg/tuple/tuple.go:459-518`).
  //
  // The check path applied this rule first (`validateCheckSubject`),
  // so for a while a subject id holding `:` or `#` was writable and
  // *uncheckable* — a grant that existed and could never be
  // exercised. Same class, same cause, so the
  // two gates report identically.
  //
  // `*` is exempt from nothing: it holds none of the reserved
  // characters, and `IsValidUser` admits the bare wildcard
  // explicitly.
  const subjectDefect = requestSubjectDefect(
    request.subjectType,
    request.subjectId,
    request.subjectRelation,
    WRITE_SUBJECT_BYTE_LIMIT,
  );
  if (subjectDefect !== null) {
    throw new InvalidSubjectTypeError(
      shape,
      request.objectType,
      request.relation,
      config.directlyAssignable,
      "malformed subject",
      subjectDefect,
      "TUPLE-SUBJECT-MALFORMED",
    );
  }

  validateObjectRef(
    request.objectType,
    request.objectId,
    WRITE_OBJECT_RUNE_LIMIT,
    {
      malformed: "TUPLE-OBJECT-MALFORMED",
      wildcard: "TUPLE-OBJECT-WILDCARD",
      tooLong: "TUPLE-OBJECT-TOO-LONG",
    },
  );

  // The last of the string rules, and the only one that is not
  // upstream's. Same order as the two above it -- subject, then
  // object -- and ahead of every question about the model. See
  // `validateIdDomain`.
  validateSubjectIdDomain(store, request.subjectType, request.subjectId);
  validateIdDomain(store, "object", request.objectType, request.objectId);

  if (!admitsSubjectShape(config, shape)) {
    throw new InvalidSubjectTypeError(
      shape,
      request.objectType,
      request.relation,
      config.directlyAssignable,
      undefined,
      undefined,
      "TUPLE-SUBJECT-NOT-ADMITTED",
    );
  }

  const ref = directSubjectRef(
    request.subjectType,
    request.subjectId,
    request.subjectRelation,
    request.conditionName,
  );
  // Explicitly typed so TypeScript treats it as never-returning
  // and narrows after each call.
  const refuse: (
    ruleId: WriteRuleId,
    cause: ConditionalTupleCause,
    detail?: string,
  ) => never = (ruleId, cause, detail) => {
    throw new InvalidConditionalTupleError(
      cause,
      ref,
      request.objectType,
      request.relation,
      config.directlyAssignable,
      detail,
      ruleId,
    );
  };

  // Upstream measures the context last, after every validation
  // above has passed (`validateWriteRequest` sizes it only once
  // `ValidateTupleForWrite` has returned,
  // `pkg/server/commands/write.go:150-165`), so a context that is
  // both oversized and malformed reports the malformation.
  const enforceContextSize = (): void => {
    const limit = options?.contextByteLimit;
    if (limit === undefined) return;
    const context = request.conditionContext;
    if (context === null || context === undefined) return;
    const size = protoStructSize(context);
    if (size > limit) {
      refuse(
        "TUPLE-CONTEXT-TOO-LARGE",
        "context size limit exceeded",
        `${size} bytes exceeds ${limit}`,
      );
    }
  };

  // An unconditioned tuple needs a matching restriction that names
  // no condition. There is nothing further to check for it — no
  // definition to look up, no context to read — so it costs no
  // extra round-trip.
  if (ref.condition === undefined) {
    if (!admitsSubjectRef(config, ref)) {
      refuse("TUPLE-CONDITION-MISSING", "condition is missing");
    }
    enforceContextSize();
    return;
  }

  // The name is scanned before the definition is looked up, which
  // is upstream's order (`validateCondition`,
  // `internal/validation/validation.go:232-244`): a name holding a
  // control character reports *that*, not "undefined condition",
  // even though no such condition can be defined.
  if (hasControlChar(ref.condition)) {
    refuse(
      "TUPLE-CONDITION-NAME-FORBIDDEN-CHARS",
      "context contains forbidden characters",
      "condition name",
    );
  }

  // Upstream's order, and it is observable: a name that is not
  // defined reports *that*, even when the restriction would not
  // have admitted it either. Probed against v1.18.2 — a defined
  // condition the restriction omits reports "invalid condition for
  // type restriction"; an undefined one reports "undefined
  // condition" whatever the restriction says.
  const definition = await store.findConditionDefinition(ref.condition);
  if (!definition) refuse("TUPLE-CONDITION-UNDEFINED", "undefined condition");

  if (!admitsSubjectRef(config, ref)) {
    refuse(
      "TUPLE-CONDITION-NOT-ADMITTED",
      "invalid condition for type restriction",
    );
  }

  const context = request.conditionContext;
  if (!context) return;

  // `ValidateStruct` runs before the parameters are cast
  // (`internal/validation/validation.go:266-272`), so a context
  // that is both mistyped and dirty reports the characters.
  const offending = forbiddenChars(context);
  if (offending !== null) {
    refuse(
      "TUPLE-CONTEXT-FORBIDDEN-CHARS",
      "context contains forbidden characters",
      JSON.stringify(offending),
    );
  }

  // Only the keys actually present are validated. A conditioned
  // tuple with no context at all, or with a partial one, is
  // accepted — probed — because the rest can still arrive with the
  // check request.
  try {
    coerceContext(definition.parameters, context);
  } catch (error) {
    refuse(
      "TUPLE-CONTEXT-PARAMETER-TYPE",
      "parameter type error",
      error instanceof Error ? error.message : String(error),
    );
  }

  // A key the condition does not declare can never be read, so it
  // is a mistake rather than spare data. Checked after the type
  // pass, which is upstream's order when a context has both
  // problems.
  const declared = definition.parameters ?? {};
  for (const key of Object.keys(context)) {
    if (!(key in declared)) {
      refuse(
        "TUPLE-CONTEXT-PARAMETER-UNDECLARED",
        "invalid context parameter",
        key,
      );
    }
  }

  enforceContextSize();
}

/**
 * `IsValidObject` — a whole `type:id` string with exactly one
 * `:`, not at index 0, a non-empty id, no `#`, no space and no
 * control character (`pkg/tuple/tuple.go:417-438`).
 *
 * Written over the rendered string rather than over the two
 * fields, because that is what upstream walks: it is what makes
 * `user:a:b` and `:alice` refusals, and both of those are shapes
 * tsfga can render out of a well-formed-looking pair of fields.
 */
function isValidObjectString(value: string): boolean {
  let state = 0;
  let idLength = 0;
  let index = 0;
  for (const char of value) {
    if (hasControlChar(char)) return false;
    if (char === "#" || char === " ") return false;
    if (char === ":") {
      if (state > 0 || index === 0) return false;
      state = 1;
    } else {
      idLength += state;
    }
    index += 1;
  }
  return idLength > 0;
}

/**
 * `IsValidUserset` — `type:id#relation`
 * (`pkg/tuple/tuple.go:476-508`).
 *
 * The `*` arm is the one that matters here: a `*` is admitted
 * only before the `:`, so `user:*#member` fails this and
 * `IsValidObject` both, which is how upstream refuses the issue
 * 040 shape on a delete without running any model rule.
 */
function isValidUsersetString(value: string): boolean {
  let state = 0;
  let idLength = 0;
  let relationLength = 0;
  let index = 0;
  for (const char of value) {
    if (hasControlChar(char)) return false;
    if (char === ":") {
      if (state > 0 || index === 0) return false;
      state = 1;
    } else if (char === "#") {
      if (state > 1 || idLength === 0) return false;
      state = 2;
    } else if (char === " ") {
      return false;
    } else if (char === "*") {
      if (state > 0) return false;
    } else if (state === 1) {
      idLength += 1;
    } else if (state === 2) {
      relationLength += 1;
    }
    index += 1;
  }
  return relationLength > 0;
}

/**
 * `IsValidUser` — the union upstream applies to the `user` field
 * of a delete (`pkg/tuple/tuple.go:511-513`).
 *
 * Deliberately **not** `requestSubjectDefect`. The union admits
 * anything the three predicates admit, so `user:a#b` passes as a
 * userset where the write path's `IsValidUserID` on the id alone
 * would refuse the `#`. The delete path is not the write path
 * narrowed; it is a different predicate.
 */
function isValidUserString(value: string): boolean {
  return (
    value === "*" ||
    isWellFormedId(value, SUBJECT_ID_RESERVED) ||
    isValidObjectString(value) ||
    isValidUsersetString(value)
  );
}

/**
 * `TupleKey.relation`'s protovalidate pattern, `^[^:#@\s]{1,50}$`.
 *
 * Applied only to a non-empty relation. protovalidate patterns do
 * not run on an empty field, which is why an empty relation on a
 * delete falls through to "does not exist" rather than being
 * refused — measured, and asserted in the fixture.
 */
const DELETE_RELATION_RESERVED: readonly string[] = [":", "#", "@"];
const DELETE_RELATION_MAX_LENGTH = 50;

/**
 * Validate a delete the way upstream validates one — which is
 * **not** the way it validates a write.
 *
 * `pkg/server/commands/write.go:169-178` is the entire delete
 * validation loop: one `IsValidUser` call and a `TODO`. There is
 * no model validation on a delete at all. An undefined relation,
 * an undefined type, a subject type the relation does not admit —
 * every one of them falls through to "the tuple does not exist",
 * measured on nine probes against v1.18.2 including one across a
 * model change that dropped both the relation and the type. That
 * is what makes a bad model change recoverable: the rows written
 * under the old model can still be deleted under the new one.
 *
 * Everything else here is protovalidate on the rendered fields,
 * which the API applies before the command runs.
 *
 * So this reads no store and consults no relation config. Reusing
 * the write gate would refuse deletes upstream performs, and
 * would make a model change a trap.
 *
 * @throws InvalidSubjectTypeError when the rendered subject fails
 *   `IsValidUser` or the 512-byte bound. `allowed` is `[]`: the
 *   restrictions were never consulted, because there are none to
 *   consult on this path.
 * @throws InvalidObjectError when the rendered object fails the
 *   `^[^\s]{2,256}$` bound.
 */
export function validateTupleDelete(request: RemoveTupleRequest): void {
  const subject =
    request.subjectRelation === null || request.subjectRelation === undefined
      ? `${request.subjectType}:${request.subjectId}`
      : `${request.subjectType}:${request.subjectId}#${request.subjectRelation}`;
  const shape = subjectShape(
    request.subjectType,
    request.subjectId,
    request.subjectRelation,
  );

  if (!isValidUserString(subject)) {
    throw new InvalidSubjectTypeError(
      shape,
      request.objectType,
      request.relation,
      [],
      "malformed subject",
      "the 'user' field is malformed",
      "DELETE-SUBJECT-MALFORMED",
    );
  }

  const bytes = utf8Length(subject);
  if (bytes > WRITE_SUBJECT_BYTE_LIMIT) {
    throw new InvalidSubjectTypeError(
      shape,
      request.objectType,
      request.relation,
      [],
      "malformed subject",
      `${bytes} bytes exceeds ${WRITE_SUBJECT_BYTE_LIMIT}`,
      "DELETE-SUBJECT-TOO-LONG",
    );
  }

  // `^[^\s]{2,256}$` on the rendered object. Only the whitespace
  // class and the bounds -- `:`, `#`, `@` and a control character
  // are all legal in an object id on a delete, and every one of
  // them is a shape the write path refuses.
  const object = `${request.objectType}:${request.objectId}`;
  const runes = [...object];
  if (runes.length < 2 || runes.length > WRITE_OBJECT_RUNE_LIMIT) {
    throw new InvalidObjectError(
      "object too long",
      request.objectType,
      request.objectId,
      `${runes.length} characters is outside 2..${WRITE_OBJECT_RUNE_LIMIT}`,
      "DELETE-OBJECT-MALFORMED",
    );
  }
  if (runes.some(isRe2Space)) {
    throw new InvalidObjectError(
      "malformed object id",
      request.objectType,
      request.objectId,
      "an object may hold no whitespace",
      "DELETE-OBJECT-MALFORMED",
    );
  }

  if (request.relation.length === 0) return;
  const relation = [...request.relation];
  if (
    relation.length > DELETE_RELATION_MAX_LENGTH ||
    relation.some(
      (char) => DELETE_RELATION_RESERVED.includes(char) || isRe2Space(char),
    )
  ) {
    throw new InvalidObjectError(
      "malformed object id",
      request.objectType,
      request.objectId,
      `relation '${request.relation}' does not match ^[^:#@\\s]{1,50}$`,
      "DELETE-RELATION-MALFORMED",
    );
  }
}
