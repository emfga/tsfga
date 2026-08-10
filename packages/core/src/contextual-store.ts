import type { TupleStore } from "./store-interface.ts";
import type {
  AddTupleRequest,
  CheckTuples,
  CheckTuplesQuery,
  ConditionDefinition,
  RelationConfig,
  RemoveTupleRequest,
  Tuple,
} from "./types.ts";

/**
 * Wraps a TupleStore, overlaying contextual tuples on read operations.
 * Contextual tuples are temporary tuples passed with the check request
 * that exist only for the duration of the check.
 */
export class ContextualTupleStore implements TupleStore {
  private contextualTuples: Tuple[];

  constructor(
    private inner: TupleStore,
    tuples: AddTupleRequest[],
  ) {
    this.contextualTuples = tuples.map((t) => ({
      objectType: t.objectType,
      objectId: t.objectId,
      relation: t.relation,
      subjectType: t.subjectType,
      subjectId: t.subjectId,
      subjectRelation: t.subjectRelation ?? null,
      conditionName: t.conditionName ?? null,
      conditionContext: t.conditionContext ?? null,
    }));
  }

  /**
   * The overlay is deliberately asymmetric, and merging the three
   * reads into one call must not quietly even it out.
   *
   * A direct or wildcard probe returns *one* tuple, so a
   * contextual tuple on that exact key **replaces** the stored one
   * — it is not unioned with it. That is what lets a caller
   * override a conditioned stored tuple with an unconditioned
   * contextual one. The userset scan returns a *set*, so there
   * contextual rows are **concatenated** with the stored ones.
   *
   * A part the overlay already answers is dropped from the inner
   * query, so a replaced probe still costs the store nothing.
   */
  async findCheckTuples(query: CheckTuplesQuery): Promise<CheckTuples> {
    const direct = query.includeDirect
      ? this.findContextualDirect(query, query.subjectId)
      : null;
    const wildcard = query.includeWildcard
      ? this.findContextualDirect(query, "*")
      : null;

    const stored = await this.inner.findCheckTuples({
      ...query,
      includeDirect: query.includeDirect && direct === null,
      includeWildcard: query.includeWildcard && wildcard === null,
    });

    return {
      direct: direct ?? stored.direct,
      wildcard: wildcard ?? stored.wildcard,
      usersets:
        query.usersetRefs === null || query.usersetRefs.length > 0
          ? [...this.findContextualUsersets(query), ...stored.usersets]
          : stored.usersets,
    };
  }

  private findContextualDirect(
    query: CheckTuplesQuery,
    subjectId: string,
  ): Tuple | null {
    return (
      this.contextualTuples.find(
        (t) =>
          t.objectType === query.objectType &&
          t.objectId === query.objectId &&
          t.relation === query.relation &&
          t.subjectType === query.subjectType &&
          t.subjectId === subjectId &&
          t.subjectRelation === null,
      ) ?? null
    );
  }

  private findContextualUsersets(query: CheckTuplesQuery): Tuple[] {
    return this.contextualTuples.filter(
      (t) =>
        t.objectType === query.objectType &&
        t.objectId === query.objectId &&
        t.relation === query.relation &&
        t.subjectRelation !== null,
    );
  }

  async findTuplesByRelation(
    objectType: string,
    objectId: string,
    relation: string,
  ): Promise<Tuple[]> {
    const contextual = this.contextualTuples.filter(
      (t) =>
        t.objectType === objectType &&
        t.objectId === objectId &&
        t.relation === relation,
    );
    const stored = await this.inner.findTuplesByRelation(
      objectType,
      objectId,
      relation,
    );
    return [...contextual, ...stored];
  }

  findRelationConfig(
    objectType: string,
    relation: string,
  ): Promise<RelationConfig | null> {
    return this.inner.findRelationConfig(objectType, relation);
  }

  findConditionDefinition(name: string): Promise<ConditionDefinition | null> {
    return this.inner.findConditionDefinition(name);
  }

  insertTuple(tuple: AddTupleRequest): Promise<void> {
    return this.inner.insertTuple(tuple);
  }

  deleteTuple(tuple: RemoveTupleRequest): Promise<boolean> {
    return this.inner.deleteTuple(tuple);
  }

  listCandidateObjectIds(objectType: string): Promise<string[]> {
    return this.inner.listCandidateObjectIds(objectType);
  }

  upsertRelationConfig(config: RelationConfig): Promise<void> {
    return this.inner.upsertRelationConfig(config);
  }

  deleteRelationConfig(objectType: string, relation: string): Promise<boolean> {
    return this.inner.deleteRelationConfig(objectType, relation);
  }

  upsertConditionDefinition(condition: ConditionDefinition): Promise<void> {
    return this.inner.upsertConditionDefinition(condition);
  }

  deleteConditionDefinition(name: string): Promise<boolean> {
    return this.inner.deleteConditionDefinition(name);
  }
}
