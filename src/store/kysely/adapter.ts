import { type Kysely, sql } from "kysely";
import type {
  AddTupleRequest,
  ConditionDefinition,
  ConditionParameterType,
  RelationConfig,
  RemoveTupleRequest,
  Tuple,
} from "src/core/types.ts";
import type { TupleStore } from "src/store/interface.ts";
import type { DB } from "src/store/kysely/schema.ts";

export class KyselyTupleStore implements TupleStore {
  constructor(private db: Kysely<DB>) {}

  async findDirectTuple(
    objectType: string,
    objectId: string,
    relation: string,
    subjectType: string,
    subjectId: string,
  ): Promise<Tuple | null> {
    const row = await this.db
      .selectFrom("tsfga.tuples")
      .selectAll()
      .where("object_type", "=", objectType)
      .where("object_id", "=", objectId)
      .where("relation", "=", relation)
      .where("subject_type", "=", subjectType)
      .where("subject_id", "=", subjectId)
      .where("subject_relation", "is", null)
      .executeTakeFirst();

    if (!row) return null;
    return this.rowToTuple(row);
  }

  async findUsersetTuples(
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
      .where("subject_relation", "is not", null)
      .execute();

    return rows.map((r) => this.rowToTuple(r));
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

    const ttu = row.tuple_to_userset as {
      tupleset: string;
      computedUserset: string;
    } | null;

    return {
      objectType: row.object_type,
      relation: row.relation,
      directlyAssignableTypes: row.directly_assignable_types ?? undefined,
      impliedBy: row.implied_by ?? undefined,
      computedUserset: row.computed_userset ?? undefined,
      tupleToUserset: ttu ?? undefined,
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
      parameters:
        (row.parameters as Record<string, ConditionParameterType>) ?? undefined,
    };
  }

  async insertTuple(tuple: AddTupleRequest): Promise<void> {
    const condCtx = tuple.conditionContext
      ? JSON.stringify(tuple.conditionContext)
      : null;

    await sql`
			INSERT INTO tsfga.tuples (object_type, object_id, relation, subject_type, subject_id, subject_relation, condition_name, condition_context, created_at, updated_at)
			VALUES (
				${tuple.objectType},
				${tuple.objectId}::uuid,
				${tuple.relation},
				${tuple.subjectType},
				${tuple.subjectId}::uuid,
				${tuple.subjectRelation ?? null},
				${tuple.conditionName ?? null},
				${condCtx}::jsonb,
				now(),
				now()
			)
			ON CONFLICT (object_type, object_id, relation, subject_type, subject_id, COALESCE(subject_relation, ''))
			DO UPDATE SET
				condition_name = EXCLUDED.condition_name,
				condition_context = EXCLUDED.condition_context,
				updated_at = now()
		`.execute(this.db);
  }

  async deleteTuple(tuple: RemoveTupleRequest): Promise<boolean> {
    const result = await this.db
      .deleteFrom("tsfga.tuples")
      .where("object_type", "=", tuple.objectType)
      .where("object_id", "=", tuple.objectId)
      .where("relation", "=", tuple.relation)
      .where("subject_type", "=", tuple.subjectType)
      .where("subject_id", "=", tuple.subjectId)
      .$call((qb) => {
        if (tuple.subjectRelation) {
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
      subjectRelation?: string;
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
      subjectId: r.subject_id,
      subjectRelation: r.subject_relation ?? undefined,
    }));
  }

  async upsertRelationConfig(config: RelationConfig): Promise<void> {
    await this.db
      .insertInto("tsfga.relation_configs")
      .values({
        object_type: config.objectType,
        relation: config.relation,
        directly_assignable_types: config.directlyAssignableTypes ?? null,
        implied_by: config.impliedBy ?? null,
        computed_userset: config.computedUserset ?? null,
        tuple_to_userset: config.tupleToUserset
          ? JSON.stringify(config.tupleToUserset)
          : null,
        allows_userset_subjects: config.allowsUsersetSubjects,
      })
      .onConflict((oc) =>
        oc.columns(["object_type", "relation"]).doUpdateSet({
          directly_assignable_types: config.directlyAssignableTypes ?? null,
          implied_by: config.impliedBy ?? null,
          computed_userset: config.computedUserset ?? null,
          tuple_to_userset: config.tupleToUserset
            ? JSON.stringify(config.tupleToUserset)
            : null,
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
    condition_context: unknown;
  }): Tuple {
    return {
      objectType: row.object_type,
      objectId: row.object_id,
      relation: row.relation,
      subjectType: row.subject_type,
      subjectId: row.subject_id,
      subjectRelation: row.subject_relation ?? undefined,
      conditionName: row.condition_name ?? undefined,
      conditionContext:
        (row.condition_context as Record<string, unknown>) ?? undefined,
    };
  }
}
