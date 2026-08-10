import {
  type AddTupleRequest,
  type CheckTuples,
  type CheckTuplesQuery,
  type ConditionDefinition,
  type ConditionParameterType,
  type IntersectionOperand,
  InvalidStoredDataError,
  type RelationConfig,
  type RemoveTupleRequest,
  type Tuple,
  type TupleStore,
} from "@tsfga/core";
import { type Kysely, sql } from "kysely";
import type { DB, Json } from "./schema.ts";

/**
 * Storage representation of the public wildcard subject `"*"`.
 *
 * The `subject_id` column is `uuid`-typed, so the wildcard is stored
 * as the nil UUID and mapped back to `"*"` on every read path. This
 * reserves the nil UUID: a tuple written for a real subject with id
 * `00000000-0000-0000-0000-000000000000` would be indistinguishable
 * from a wildcard grant and would read back as `"*"`. Callers must
 * never use the nil UUID as a real subject id.
 */
const WILDCARD_SENTINEL = "00000000-0000-0000-0000-000000000000";

const VALID_PARAMETER_TYPES: ReadonlySet<string> = new Set([
  "string",
  "int",
  "uint",
  "bool",
  "double",
  "duration",
  "timestamp",
  "list",
  "map",
  "any",
]);

function isConditionParameterType(
  value: string,
): value is ConditionParameterType {
  return VALID_PARAMETER_TYPES.has(value);
}

export class KyselyTupleStore implements TupleStore {
  private db: Kysely<DB>;

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
    const { includeDirect, includeWildcard, usersetRefs } = query;
    // `null` declines to narrow the userset scan; `[]` excludes it.
    const includeUsersets = usersetRefs === null || usersetRefs.length > 0;
    // Every part excluded means no row could be used. Return the
    // empty result rather than a `WHERE false` round-trip.
    if (!includeDirect && !includeWildcard && !includeUsersets) {
      return { direct: null, wildcard: null, usersets: [] };
    }
    // The admitted refs are `type#relation` pairs, so the scan
    // narrows to exactly the (subject_type, subject_relation)
    // combinations the model can use. Core re-clamps the reply
    // against the same list, so this stays an optimization.
    const usersetPairs = (usersetRefs ?? []).map((ref) => {
      const hash = ref.indexOf("#");
      return { type: ref.slice(0, hash), relation: ref.slice(hash + 1) };
    });

    const dbSubjectId =
      query.subjectId === "*" ? WILDCARD_SENTINEL : query.subjectId;

    const rows = await this.db
      .selectFrom("tsfga.tuples")
      .selectAll()
      .where("object_type", "=", query.objectType)
      .where("object_id", "=", query.objectId)
      .where("relation", "=", query.relation)
      .where((eb) =>
        eb.or([
          ...(includeDirect
            ? [
                eb.and([
                  eb("subject_type", "=", query.subjectType),
                  eb("subject_id", "=", dbSubjectId),
                  eb("subject_relation", "is", null),
                ]),
              ]
            : []),
          ...(includeWildcard
            ? [
                eb.and([
                  eb("subject_type", "=", query.subjectType),
                  eb("subject_id", "=", WILDCARD_SENTINEL),
                  eb("subject_relation", "is", null),
                ]),
              ]
            : []),
          ...(includeUsersets
            ? usersetRefs === null
              ? [eb("subject_relation", "is not", null)]
              : usersetPairs.map((pair) =>
                  eb.and([
                    eb("subject_type", "=", pair.type),
                    eb("subject_relation", "=", pair.relation),
                  ]),
                )
            : []),
        ]),
      )
      .execute();

    let direct: Tuple | null = null;
    let wildcard: Tuple | null = null;
    const usersets: Tuple[] = [];

    for (const row of rows) {
      const tuple = this.rowToTuple(row);
      if (row.subject_relation !== null) {
        usersets.push(tuple);
      } else if (includeDirect && row.subject_id === dbSubjectId) {
        // Checked first, so a check *for* the wildcard subject —
        // where both disjuncts are the same query — lands in
        // `direct` rather than being reported twice.
        direct = tuple;
      } else if (includeWildcard && row.subject_id === WILDCARD_SENTINEL) {
        wildcard = tuple;
      }
      // Partitioned on the raw column, never on the round-tripped
      // tuple: `rowToTuple` maps the sentinel to `"*"`, so a real
      // subject whose id happens to be the nil UUID would look
      // like a wildcard here. Both arms are also positively
      // matched rather than falling through to `wildcard`, so a
      // row the query did not ask for is dropped instead of being
      // filed under whichever slot is left.
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

  async insertTuple(tuple: AddTupleRequest): Promise<void> {
    const condCtx = tuple.conditionContext
      ? JSON.stringify(tuple.conditionContext)
      : null;
    const now = new Date();
    const dbSubjectId =
      tuple.subjectId === "*" ? WILDCARD_SENTINEL : tuple.subjectId;

    await this.db
      .insertInto("tsfga.tuples")
      .values({
        object_type: tuple.objectType,
        object_id: tuple.objectId,
        relation: tuple.relation,
        subject_type: tuple.subjectType,
        subject_id: dbSubjectId,
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
          .doUpdateSet({
            condition_name: tuple.conditionName ?? null,
            condition_context: condCtx,
            updated_at: now,
          }),
      )
      .execute();
  }

  async deleteTuple(tuple: RemoveTupleRequest): Promise<boolean> {
    const dbSubjectId =
      tuple.subjectId === "*" ? WILDCARD_SENTINEL : tuple.subjectId;
    const result = await this.db
      .deleteFrom("tsfga.tuples")
      .where("object_type", "=", tuple.objectType)
      .where("object_id", "=", tuple.objectId)
      .where("relation", "=", tuple.relation)
      .where("subject_type", "=", tuple.subjectType)
      .where("subject_id", "=", dbSubjectId)
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

  async listCandidateObjectIds(objectType: string): Promise<string[]> {
    const rows = await this.db
      .selectFrom("tsfga.tuples")
      .select("object_id")
      .distinct()
      .where("object_type", "=", objectType)
      .execute();

    return rows.map((r) => r.object_id);
  }

  async upsertRelationConfig(config: RelationConfig): Promise<void> {
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

  private rowToTuple(row: {
    object_type: string;
    object_id: string;
    relation: string;
    subject_type: string;
    subject_id: string;
    subject_relation: string | null;
    condition_name: string | null;
    condition_context: Json | null;
  }): Tuple {
    return {
      objectType: row.object_type,
      objectId: row.object_id,
      relation: row.relation,
      subjectType: row.subject_type,
      subjectId: row.subject_id === WILDCARD_SENTINEL ? "*" : row.subject_id,
      subjectRelation: row.subject_relation,
      conditionName: row.condition_name,
      conditionContext: this.parseConditionContext(row.condition_context),
    };
  }

  /**
   * `directly_assignable` is NOT NULL and every entry is a type
   * restriction string, so anything else in the column is a row no
   * tsfga write could have produced. Validated rather than cast:
   * the value gates both the write path and the check read gate,
   * so a malformed one must stop the request, not widen it.
   */
  private parseDirectlyAssignable(value: Json): string[] {
    if (!Array.isArray(value)) {
      throw new InvalidStoredDataError(
        "relation_configs",
        "directly_assignable",
        "expected array",
      );
    }
    const result: string[] = [];
    for (const item of value) {
      if (typeof item !== "string") {
        throw new InvalidStoredDataError(
          "relation_configs",
          "directly_assignable",
          "each element must be a type restriction string",
        );
      }
      result.push(item);
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
