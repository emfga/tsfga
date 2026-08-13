import {
  CANONICAL_UUID_IDS,
  type CheckTuples,
  type CheckTuplesQuery,
  type ConditionDefinition,
  type ConditionParameterType,
  type GatedRelationConfig,
  type GatedTuple,
  type IdDomain,
  type IntersectionOperand,
  InvalidStoredDataError,
  type RelationConfig,
  type RemoveTupleRequest,
  type Tuple,
  type TupleStore,
  type TypeRestriction,
} from "@tsfga/core";
import { type Kysely, sql } from "kysely";
import type { DB, Json } from "./schema.ts";

/**
 * The public wildcard subject, as `@tsfga/core` spells it.
 *
 * It is not an id and it is not stored as one. Since migration
 * `006` the shape lives in `subject_wildcard boolean` and
 * `subject_id` is NULL on those rows, so no id value is reserved
 * and a grant to `user:00000000-0000-0000-0000-000000000000` names
 * that one subject. This constant is what `insertTuple` recognises
 * and `rowToTuple` renders; nothing writes it to a column.
 */
const WILDCARD = "*";

const SCALAR_PARAMETER_TYPES: ReadonlySet<string> = new Set([
  "string",
  "int",
  "uint",
  "bool",
  "double",
  "duration",
  "timestamp",
  "any",
]);

/** `list<…>` and `map<…>`, which hold one scalar type. */
const CONTAINER_PARAMETER_TYPE = /^(?:list|map)<(.+)>$/;

function isConditionParameterType(
  value: string,
): value is ConditionParameterType {
  if (SCALAR_PARAMETER_TYPES.has(value)) return true;
  const element = CONTAINER_PARAMETER_TYPE.exec(value)?.[1];
  return element !== undefined && SCALAR_PARAMETER_TYPES.has(element);
}

export class KyselyTupleStore implements TupleStore {
  private db: Kysely<DB>;

  /**
   * Canonical lower-case hyphenated UUIDs, and nothing else.
   *
   * `object_id` and `subject_id` are going back to `uuid` columns,
   * and this is narrower than what that column's own input grammar
   * accepts -- deliberately. The grammar is many-to-one: the
   * uppercase, hyphenless, braced, braced-hyphenless and
   * odd-hyphen spellings of one value all store as the same row,
   * while OpenFGA holds them apart as distinct ids. Admitting more
   * than the canonical spelling would let a grant written for one
   * answer `true` for another.
   *
   * **`user:alice` is an ordinary subject upstream and this store
   * refuses it, permanently.** See the id-domain section of the
   * README; it is a declared limitation, not a bug awaiting a fix.
   */
  readonly idDomain: IdDomain = CANONICAL_UUID_IDS;

  /**
   * Takes a `Kysely<DB>` it does not own — including a
   * `Transaction<DB>`, which Kysely declares as a subtype, so
   * `new KyselyTupleStore(trx)` scopes every method to that
   * transaction.
   *
   * The instance's plugins are stripped. `tsfga.*` is the adapter's
   * own schema and `schema.ts` names its columns as the database
   * does, so a plugin installed for the consumer's tables has no
   * business rewriting these queries or their results — and a
   * result-transforming one is not merely unhelpful but silently
   * wrong. `CamelCasePlugin.transformResult` renames every result
   * key regardless of how the query was built, which turns
   * `row.subject_relation` into `undefined`; `undefined !== null`,
   * so every row would file as a userset and no direct grant would
   * ever be found. Kysely's own transaction is preserved:
   * `Transaction#withoutPlugins` returns a `Transaction`, sharing
   * the connection.
   */
  constructor(db: Kysely<DB>) {
    this.db = db.withoutPlugins();
  }

  /**
   * All three per-node check reads in one round-trip.
   *
   * The parts share `(object_type, object_id, relation)` and
   * differ only in their subject predicate, so they are one scan
   * with an OR of the requested predicates rather than three
   * queries. Only the requested disjuncts are emitted: an
   * excluded part cannot match, so the planner never widens the
   * scan for it, and nothing has to be filtered back out
   * afterwards.
   */
  async findCheckTuples(query: CheckTuplesQuery): Promise<CheckTuples> {
    const { directRefs, wildcardRefs, usersetRefs } = query;
    // `null` declines to narrow; `[]` excludes the part. The two
    // must not be conflated — reading `[]` as "no filter" turns a
    // query that asked for nothing into a full scan.
    const wanted = (refs: readonly TypeRestriction[] | null): boolean =>
      refs === null || refs.length > 0;
    // Every part excluded means no row could be used. Return the
    // empty result rather than a `WHERE false` round-trip.
    if (!wanted(directRefs) && !wanted(wildcardRefs) && !wanted(usersetRefs)) {
      return { direct: null, wildcard: [], usersets: [] };
    }

    const rows = await this.db
      .selectFrom("tsfga.tuples")
      .selectAll()
      .where("object_type", "=", query.objectType)
      .where("object_id", "=", query.objectId)
      .where("relation", "=", query.relation)
      .where((eb) => {
        // A restriction admits a row only if the row's condition is
        // the one it names — or if it names none and the row
        // carries none. That is a column predicate, so the scan
        // narrows on it like any other rather than filtering after.
        const condition = (restriction: TypeRestriction) =>
          restriction.condition === undefined
            ? eb("condition_name", "is", null)
            : eb("condition_name", "=", restriction.condition);

        // One disjunct per admitted restriction. A relation
        // admitting `[user, user with weekday_only]` produces two,
        // and a row matching either qualifies.
        const probe = (
          refs: readonly TypeRestriction[] | null,
          subjectId: string,
        ) => {
          if (!wanted(refs)) return [];
          const slot = [
            eb("subject_type", "=", query.subjectType),
            eb("subject_id", "=", subjectId),
            eb("subject_relation", "is", null),
          ];
          if (refs === null) return [eb.and(slot)];
          return refs.map((r) => eb.and([...slot, condition(r)]));
        };

        /**
         * The wildcard slot, written out rather than passed
         * through `probe`, so all three of its conditions stay
         * visible at the call site.
         *
         * `subject_id IS NULL AND subject_wildcard` rather than
         * `subject_wildcard` alone. The check constraint makes the
         * two equivalent, and the planner does not know that.
         * Measured on PG 18 with one object carrying 5000
         * subjects: the bare boolean has nothing indexed to
         * descend on, falls to a sequential scan at 77 buffers and
         * discards 5000 rows; the `IS NULL` conjunct extends the
         * `idx_tuples_unique` index condition to five columns and
         * costs 3. Zero cost to write, no new index.
         *
         * `subject_relation IS NULL` stays for a different reason:
         * dropping it files a `user:*#member` row into the
         * wildcard bucket.
         */
        const wildcardProbe = (
          refs: readonly TypeRestriction[] | null,
          subjectType: string,
        ) => {
          if (!wanted(refs)) return [];
          const slot = [
            eb("subject_type", "=", subjectType),
            eb("subject_id", "is", null),
            eb("subject_wildcard", "=", true),
            eb("subject_relation", "is", null),
          ];
          if (refs === null) return [eb.and(slot)];
          return refs.map((r) => eb.and([...slot, condition(r)]));
        };

        return eb.or([
          // A check *for* `user:*` asks about the wildcard row, so
          // the direct slot is the wildcard predicate. `"*"` is
          // not an id and there is no id column value to compare
          // it against -- it used to be one, while the column was
          // `text`, and reaching a `uuid` column with it now would
          // be a driver error rather than a miss.
          ...(query.subjectId === WILDCARD
            ? wildcardProbe(directRefs, query.subjectType)
            : probe(directRefs, query.subjectId)),
          ...wildcardProbe(wildcardRefs, query.subjectType),
          ...(!wanted(usersetRefs)
            ? []
            : usersetRefs === null
              ? [eb("subject_relation", "is not", null)]
              : usersetRefs.flatMap((r) =>
                  // A userset ref without a relation names no
                  // userset, so it contributes no disjunct rather
                  // than a predicate on `undefined`.
                  r.relation === undefined
                    ? []
                    : [
                        eb.and([
                          eb("subject_type", "=", r.type),
                          eb("subject_relation", "=", r.relation),
                          condition(r),
                        ]),
                      ],
                )),
        ]);
      })
      .execute();

    let direct: Tuple | null = null;
    // A list, because the slot is one: `idx_tuples_unique`'s
    // `NULLS NOT DISTINCT` means this scan can return at most one
    // wildcard row per key, so what is wrapped here is 0 or 1
    // rows. The shape exists for
    // `ContextualTupleStore`, which adds the request's own wildcard
    // rows to whatever the store found instead of replacing them.
    const wildcard: Tuple[] = [];
    const usersets: Tuple[] = [];

    // What the request asked for, in the row's own terms: the
    // wildcard is a flag rather than an id, so the comparison is
    // against the flag when the request names it.
    const requested = (row: {
      subject_id: string | null;
      subject_wildcard: boolean;
    }) =>
      query.subjectId === WILDCARD
        ? row.subject_wildcard
        : row.subject_id === query.subjectId;

    for (const row of rows) {
      const tuple = this.rowToTuple(row);
      if (row.subject_relation !== null) {
        usersets.push(tuple);
      } else if (wanted(directRefs) && requested(row)) {
        // Checked first, so a check *for* the wildcard subject —
        // where both disjuncts are the same query — lands in
        // `direct` rather than being reported twice.
        direct = tuple;
      } else if (wanted(wildcardRefs) && row.subject_wildcard) {
        wildcard.push(tuple);
      }
      // Both arms are positively matched rather than falling
      // through to `wildcard`, so a row the query did not ask for
      // is dropped instead of being filed under whichever slot is
      // left.
    }

    return { direct, wildcard, usersets };
  }

  async findTuplesByRelation(
    objectType: string,
    objectId: string,
    relation: string,
  ): Promise<Tuple[]> {
    const rows = await this.db
      .selectFrom("tsfga.tuples")
      .selectAll()
      .where("object_type", "=", objectType)
      .where("object_id", "=", objectId)
      .where("relation", "=", relation)
      .execute();

    return rows.map((r) => this.rowToTuple(r));
  }

  async findRelationConfig(
    objectType: string,
    relation: string,
  ): Promise<RelationConfig | null> {
    const row = await this.db
      .selectFrom("tsfga.relation_configs")
      .selectAll()
      .where("object_type", "=", objectType)
      .where("relation", "=", relation)
      .executeTakeFirst();

    if (!row) return null;

    return {
      objectType: row.object_type,
      relation: row.relation,
      directlyAssignable: this.parseDirectlyAssignable(row.directly_assignable),
      impliedBy: row.implied_by,
      computedUserset: row.computed_userset,
      tupleToUserset: this.parseTupleToUserset(row.tuple_to_userset),
      excludedBy: row.excluded_by,
      intersection: this.parseIntersection(row.intersection),
    };
  }

  async findConditionDefinition(
    name: string,
  ): Promise<ConditionDefinition | null> {
    const row = await this.db
      .selectFrom("tsfga.condition_definitions")
      .selectAll()
      .where("name", "=", name)
      .executeTakeFirst();

    if (!row) return null;

    return {
      name: row.name,
      expression: row.expression,
      parameters: this.parseConditionParameters(row.parameters),
    };
  }

  /**
   * Whether any relation config defines this type.
   *
   * Two arms, one scan: the type is an object type of some config,
   * or some config's `directly_assignable` admits it. The second
   * arm is a jsonb containment probe — `[{"type": "user"}]` is
   * contained by `[{"type": "user", "wildcard": true}]` and by
   * every other restriction shape naming that type, so a single
   * `@>` covers direct, wildcard, userset and conditioned
   * restrictions alike.
   *
   * `tsfga.tuples` is deliberately not consulted: a row can outlive
   * the config that admitted it, and reading definedness off the
   * data would make a dropped type look defined for exactly as long
   * as its rows survive.
   *
   * No index is added for it. `tsfga.relation_configs` holds one
   * row per relation of the model — hundreds at most — and the
   * scope's caching store asks once per type per call, so the
   * sequential scan an `EXPLAIN` shows is cheaper than a GIN index
   * to maintain on every config write.
   */
  async hasTypeDefinition(type: string): Promise<boolean> {
    const row = await this.db
      .selectFrom("tsfga.relation_configs")
      .select("id")
      .where((eb) =>
        eb.or([
          eb("object_type", "=", type),
          eb(
            "directly_assignable",
            "@>",
            sql<Json>`${JSON.stringify([{ type }])}::jsonb`,
          ),
        ]),
      )
      .limit(1)
      .executeTakeFirst();

    return row !== undefined;
  }

  /**
   * Insert a tuple, reporting whether it was new.
   *
   * `doNothing()` rather than `doUpdateSet()`: the natural key
   * excludes the condition, so an update here would rewrite a live
   * grant's condition — in the widening direction as readily as the
   * narrowing one — and report nothing. `numInsertedOrUpdatedRows`
   * is `0` exactly when the conflict fired, which is the signal
   * `addTuple` turns into a `DuplicateTupleError`.
   */
  async insertTuple(tuple: GatedTuple): Promise<boolean> {
    const condCtx = tuple.conditionContext
      ? JSON.stringify(tuple.conditionContext)
      : null;
    const now = new Date();

    const result = await this.db
      .insertInto("tsfga.tuples")
      .values({
        object_type: tuple.objectType,
        object_id: tuple.objectId,
        relation: tuple.relation,
        subject_type: tuple.subjectType,
        // The wildcard leaves the id namespace here. Everything
        // else is an id and the column holds it as one.
        subject_id: tuple.subjectId === WILDCARD ? null : tuple.subjectId,
        subject_wildcard: tuple.subjectId === WILDCARD,
        subject_relation: tuple.subjectRelation ?? null,
        condition_name: tuple.conditionName ?? null,
        condition_context: condCtx,
        created_at: now,
        updated_at: now,
      })
      .onConflict((oc) =>
        oc
          .expression(
            sql`object_type, object_id, relation, subject_type, subject_id, COALESCE(subject_relation, '')`,
          )
          .doNothing(),
      )
      .executeTakeFirst();

    return (result.numInsertedOrUpdatedRows ?? 0n) > 0n;
  }

  async deleteTuple(tuple: RemoveTupleRequest): Promise<boolean> {
    const result = await this.db
      .deleteFrom("tsfga.tuples")
      .where("object_type", "=", tuple.objectType)
      .where("object_id", "=", tuple.objectId)
      .where("relation", "=", tuple.relation)
      .where("subject_type", "=", tuple.subjectType)
      // The same branch the subject relation takes below, for the
      // same reason: a NULL is not a value to compare against.
      .$call((qb) =>
        tuple.subjectId === WILDCARD
          ? qb
              .where("subject_id", "is", null)
              .where("subject_wildcard", "=", true)
          : qb.where("subject_id", "=", tuple.subjectId),
      )
      .$call((qb) => {
        if (
          tuple.subjectRelation !== null &&
          tuple.subjectRelation !== undefined
        ) {
          return qb.where("subject_relation", "=", tuple.subjectRelation);
        }
        return qb.where("subject_relation", "is", null);
      })
      .executeTakeFirst();

    return BigInt(result.numDeletedRows) > 0n;
  }

  /**
   * The distinct object ids of one type, in no particular order —
   * `listObjects` re-checks every candidate and returns the ones
   * that hold, so the order carries no meaning and no `ORDER BY`
   * is paid for.
   *
   * `object_id` is a `uuid` column, so an id reaching it is
   * already canonical: the store declares `CANONICAL_UUID_IDS` and
   * core refuses every other spelling at the request boundary, so
   * PostgreSQL never gets the chance to fold two ids upstream
   * holds apart into one candidate.
   */
  async listCandidateObjectIds(objectType: string): Promise<string[]> {
    const rows = await this.db
      .selectFrom("tsfga.tuples")
      .select("object_id")
      .distinct()
      .where("object_type", "=", objectType)
      .execute();

    return rows.map((r) => r.object_id);
  }

  async upsertRelationConfig(config: GatedRelationConfig): Promise<void> {
    const ttuJson = config.tupleToUserset
      ? JSON.stringify(config.tupleToUserset)
      : null;
    const intersectionJson = config.intersection
      ? JSON.stringify(config.intersection)
      : null;
    const directlyAssignable = JSON.stringify(config.directlyAssignable);

    await this.db
      .insertInto("tsfga.relation_configs")
      .values({
        object_type: config.objectType,
        relation: config.relation,
        directly_assignable: directlyAssignable,
        implied_by: config.impliedBy ?? null,
        computed_userset: config.computedUserset ?? null,
        tuple_to_userset: ttuJson,
        excluded_by: config.excludedBy ?? null,
        intersection: intersectionJson,
      })
      .onConflict((oc) =>
        oc.columns(["object_type", "relation"]).doUpdateSet({
          directly_assignable: directlyAssignable,
          implied_by: config.impliedBy ?? null,
          computed_userset: config.computedUserset ?? null,
          tuple_to_userset: ttuJson,
          excluded_by: config.excludedBy ?? null,
          intersection: intersectionJson,
        }),
      )
      .execute();
  }

  async deleteRelationConfig(
    objectType: string,
    relation: string,
  ): Promise<boolean> {
    const result = await this.db
      .deleteFrom("tsfga.relation_configs")
      .where("object_type", "=", objectType)
      .where("relation", "=", relation)
      .executeTakeFirst();

    return BigInt(result.numDeletedRows) > 0n;
  }

  async upsertConditionDefinition(
    condition: ConditionDefinition,
  ): Promise<void> {
    const parameters = condition.parameters
      ? JSON.stringify(condition.parameters)
      : null;

    await this.db
      .insertInto("tsfga.condition_definitions")
      .values({
        name: condition.name,
        expression: condition.expression,
        parameters,
      })
      .onConflict((oc) =>
        oc.column("name").doUpdateSet({
          expression: condition.expression,
          parameters,
        }),
      )
      .execute();
  }

  async deleteConditionDefinition(name: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom("tsfga.condition_definitions")
      .where("name", "=", name)
      .executeTakeFirst();

    return BigInt(result.numDeletedRows) > 0n;
  }

  /**
   * A row becomes a `Tuple`, with the wildcard rendered back into
   * the id position `@tsfga/core` reads it from.
   *
   * The two impossible shapes are checked rather than assumed.
   * `tuples_wildcard_shape` forbids both at the column level and
   * `insertTuple` produces neither, so a row carrying one came
   * from outside the library — and this is the same
   * validate-at-the-boundary rule the JSON columns follow,
   * generalised from one column to a pair. A store's reply is a
   * hint; a wildcard row silently read as the id `null`, or an id
   * row read as the wildcard, is the nil-UUID-as-wildcard bug
   * arriving from the other direction.
   */
  private rowToTuple(row: {
    object_type: string;
    object_id: string;
    relation: string;
    subject_type: string;
    subject_id: string | null;
    subject_wildcard: boolean;
    subject_relation: string | null;
    condition_name: string | null;
    condition_context: Json | null;
  }): Tuple {
    let subjectId: string;
    if (row.subject_wildcard) {
      if (row.subject_id !== null) {
        throw new InvalidStoredDataError(
          "tsfga.tuples",
          "subject_wildcard",
          "a wildcard row carries a subject id",
        );
      }
      subjectId = WILDCARD;
    } else {
      if (row.subject_id === null) {
        throw new InvalidStoredDataError(
          "tsfga.tuples",
          "subject_id",
          "a row with no subject id is not marked as the wildcard",
        );
      }
      subjectId = row.subject_id;
    }
    return {
      objectType: row.object_type,
      objectId: row.object_id,
      relation: row.relation,
      subjectType: row.subject_type,
      subjectId,
      subjectRelation: row.subject_relation,
      conditionName: row.condition_name,
      conditionContext: this.parseConditionContext(row.condition_context),
    };
  }

  /**
   * `directly_assignable` is NOT NULL and every entry is a type
   * restriction object, so anything else in the column is a row no
   * tsfga write could have produced. Validated rather than cast:
   * the value gates both the write path and the check read gate,
   * so a malformed one must stop the request, not widen it.
   *
   * `wildcard` is normalized to `true` or absent rather than being
   * kept as whatever JSON held. `{"wildcard": false}` would
   * otherwise compare unequal to a restriction built in memory,
   * where the field is simply missing, and the mismatch would
   * silently drop rows at the clamp.
   */
  private parseDirectlyAssignable(value: Json): TypeRestriction[] {
    const invalid = (detail: string) =>
      new InvalidStoredDataError(
        "relation_configs",
        "directly_assignable",
        detail,
      );
    if (!Array.isArray(value)) throw invalid("expected array");

    const result: TypeRestriction[] = [];
    for (const item of value) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        throw invalid("each element must be a type restriction object");
      }
      const { type, relation, wildcard, condition } = item;
      if (typeof type !== "string" || type === "") {
        throw invalid("each element needs a non-empty string 'type'");
      }
      if (relation !== undefined && typeof relation !== "string") {
        throw invalid("'relation' must be a string when present");
      }
      if (condition !== undefined && typeof condition !== "string") {
        throw invalid("'condition' must be a string when present");
      }
      if (wildcard !== undefined && typeof wildcard !== "boolean") {
        throw invalid("'wildcard' must be a boolean when present");
      }
      if (relation !== undefined && wildcard === true) {
        throw invalid("'relation' and 'wildcard' are mutually exclusive");
      }
      const restriction: TypeRestriction = { type };
      if (relation !== undefined) restriction.relation = relation;
      if (wildcard === true) restriction.wildcard = true;
      if (condition !== undefined) restriction.condition = condition;
      result.push(restriction);
    }
    return result;
  }

  private parseTupleToUserset(
    value: Json | null,
  ): Array<{ tupleset: string; computedUserset: string }> | null {
    if (value === null) return null;
    if (!Array.isArray(value)) {
      throw new InvalidStoredDataError(
        "relation_configs",
        "tuple_to_userset",
        "expected array",
      );
    }
    const result: Array<{ tupleset: string; computedUserset: string }> = [];
    for (const item of value) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        throw new InvalidStoredDataError(
          "relation_configs",
          "tuple_to_userset",
          "each element must have string tupleset and computedUserset",
        );
      }
      const tupleset = item["tupleset"];
      const computedUserset = item["computedUserset"];
      if (typeof tupleset !== "string" || typeof computedUserset !== "string") {
        throw new InvalidStoredDataError(
          "relation_configs",
          "tuple_to_userset",
          "each element must have string tupleset and computedUserset",
        );
      }
      result.push({ tupleset, computedUserset });
    }
    return result;
  }

  private parseIntersection(value: Json | null): IntersectionOperand[] | null {
    if (value === null) return null;
    if (!Array.isArray(value)) {
      throw new InvalidStoredDataError(
        "relation_configs",
        "intersection",
        "expected array",
      );
    }
    const result: IntersectionOperand[] = [];
    for (const item of value) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        throw new InvalidStoredDataError(
          "relation_configs",
          "intersection",
          "each element must be an object with a type field",
        );
      }
      const type = item["type"];
      if (type === "direct") {
        result.push({ type: "direct" });
        continue;
      }
      if (type === "computedUserset") {
        const relation = item["relation"];
        if (typeof relation !== "string") {
          throw new InvalidStoredDataError(
            "relation_configs",
            "intersection",
            "computedUserset operand must have string relation",
          );
        }
        result.push({ type: "computedUserset", relation });
        continue;
      }
      if (type === "tupleToUserset") {
        const tupleset = item["tupleset"];
        const computedUserset = item["computedUserset"];
        if (
          typeof tupleset !== "string" ||
          typeof computedUserset !== "string"
        ) {
          throw new InvalidStoredDataError(
            "relation_configs",
            "intersection",
            "tupleToUserset operand must have string tupleset and computedUserset",
          );
        }
        result.push({ type: "tupleToUserset", tupleset, computedUserset });
        continue;
      }
      throw new InvalidStoredDataError(
        "relation_configs",
        "intersection",
        `unknown operand type: ${String(type)}`,
      );
    }
    return result;
  }

  private parseConditionParameters(
    value: Json | null,
  ): Record<string, ConditionParameterType> | null {
    if (value === null) return null;
    if (typeof value !== "object" || Array.isArray(value)) {
      throw new InvalidStoredDataError(
        "condition_definitions",
        "parameters",
        "expected object",
      );
    }
    const result: Record<string, ConditionParameterType> = {};
    for (const [key, val] of Object.entries(value)) {
      if (typeof val !== "string" || !isConditionParameterType(val)) {
        throw new InvalidStoredDataError(
          "condition_definitions",
          "parameters",
          `invalid parameter type for "${key}": ${String(val)}`,
        );
      }
      result[key] = val;
    }
    return result;
  }

  private parseConditionContext(
    value: Json | null,
  ): Record<string, unknown> | null {
    if (value === null) return null;
    if (typeof value !== "object" || Array.isArray(value)) {
      throw new InvalidStoredDataError(
        "tuples",
        "condition_context",
        "expected object",
      );
    }
    return value;
  }
}
