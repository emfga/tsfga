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
  constructor(private db: Kysely<DB>) {}

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
    const { includeDirect, includeWildcard, includeUsersets } = query;
    // Every part excluded means no row could be used. Return the
    // empty result rather than a `WHERE false` round-trip.
    if (!includeDirect && !includeWildcard && !includeUsersets) {
      return { direct: null, wildcard: null, usersets: [] };
    }

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
          ...(includeUsersets ? [eb("subject_relation", "is not", null)] : []),
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
      directlyAssignableTypes: row.directly_assignable_types,
      impliedBy: row.implied_by,
      computedUserset: row.computed_userset,
      tupleToUserset: this.parseTupleToUserset(row.tuple_to_userset),
      excludedBy: row.excluded_by,
      intersection: this.parseIntersection(row.intersection),
      allowsUsersetSubjects: row.allows_userset_subjects,
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

  async listDirectSubjects(
    objectType: string,
    objectId: string,
    relation: string,
  ): Promise<
    Array<{
      subjectType: string;
      subjectId: string;
      subjectRelation: string | null;
    }>
  > {
    const rows = await this.db
      .selectFrom("tsfga.tuples")
      .select(["subject_type", "subject_id", "subject_relation"])
      .where("object_type", "=", objectType)
      .where("object_id", "=", objectId)
      .where("relation", "=", relation)
      .execute();

    return rows.map((r) => ({
      subjectType: r.subject_type,
      subjectId: r.subject_id === WILDCARD_SENTINEL ? "*" : r.subject_id,
      subjectRelation: r.subject_relation,
    }));
  }

  async upsertRelationConfig(config: RelationConfig): Promise<void> {
    const ttuJson = config.tupleToUserset
      ? JSON.stringify(config.tupleToUserset)
      : null;
    const intersectionJson = config.intersection
      ? JSON.stringify(config.intersection)
      : null;

    await this.db
      .insertInto("tsfga.relation_configs")
      .values({
        object_type: config.objectType,
        relation: config.relation,
        directly_assignable_types: config.directlyAssignableTypes ?? null,
        implied_by: config.impliedBy ?? null,
        computed_userset: config.computedUserset ?? null,
        tuple_to_userset: ttuJson,
        excluded_by: config.excludedBy ?? null,
        intersection: intersectionJson,
        allows_userset_subjects: config.allowsUsersetSubjects,
      })
      .onConflict((oc) =>
        oc.columns(["object_type", "relation"]).doUpdateSet({
          directly_assignable_types: config.directlyAssignableTypes ?? null,
          implied_by: config.impliedBy ?? null,
          computed_userset: config.computedUserset ?? null,
          tuple_to_userset: ttuJson,
          excluded_by: config.excludedBy ?? null,
          intersection: intersectionJson,
          allows_userset_subjects: config.allowsUsersetSubjects,
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
