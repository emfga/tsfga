import type { TupleStore } from "./store-interface.ts";
import type {
  AddTupleRequest,
  ConditionDefinition,
  RelationConfig,
  RemoveTupleRequest,
  Tuple,
} from "./types.ts";

/**
 * Wraps a TupleStore, memoizing relation configs and condition
 * definitions. Both are static per authorization model but are
 * re-fetched at every node of the recursive check, so a
 * request-scoped cache removes most of those round-trips.
 *
 * The cache stores promises (not resolved values) so concurrent
 * branches asking for the same key coalesce on one in-flight
 * query. Misses (`null`) are cached too. Rejected promises are
 * evicted so a transient store error is not pinned for the rest
 * of the request: a later branch retries and the union-level
 * "true beats sibling error" semantics keep working.
 *
 * Intended lifetime is a single check request: create one
 * instance per top-level `check()` call and discard it. Writes
 * through this wrapper invalidate the affected entry, but
 * writes through the raw store while a check is in flight may
 * not be observed by that check (accepted staleness non-goal).
 *
 * Configs are keyed by a nested map, never a joined string:
 * tsfga does not restrict identifier charsets, so a joined
 * `type:relation` key would collide for names containing ":".
 */
export class CachingTupleStore implements TupleStore {
  private configCache = new Map<
    string,
    Map<string, Promise<RelationConfig | null>>
  >();
  private conditionCache = new Map<
    string,
    Promise<ConditionDefinition | null>
  >();

  constructor(private inner: TupleStore) {}

  findRelationConfig(
    objectType: string,
    relation: string,
  ): Promise<RelationConfig | null> {
    let byRelation = this.configCache.get(objectType);
    if (!byRelation) {
      byRelation = new Map();
      this.configCache.set(objectType, byRelation);
    }
    let cached = byRelation.get(relation);
    if (!cached) {
      cached = this.inner.findRelationConfig(objectType, relation);
      byRelation.set(relation, cached);
      this.evictOnRejection(cached, byRelation, relation);
    }
    return cached;
  }

  findConditionDefinition(name: string): Promise<ConditionDefinition | null> {
    let cached = this.conditionCache.get(name);
    if (!cached) {
      cached = this.inner.findConditionDefinition(name);
      this.conditionCache.set(name, cached);
      this.evictOnRejection(cached, this.conditionCache, name);
    }
    return cached;
  }

  /**
   * Drop a cache entry if its promise rejects, but only while it
   * is still the stored entry (a concurrent retry may have
   * replaced it). The `catch` chain is a side effect that
   * swallows the rejection on its own derived promise; callers
   * holding the original promise still observe the error.
   */
  private evictOnRejection<V>(
    promise: Promise<V>,
    cache: Map<string, Promise<V>>,
    key: string,
  ): void {
    promise.catch(() => {
      if (cache.get(key) === promise) {
        cache.delete(key);
      }
    });
  }

  findDirectTuple(
    objectType: string,
    objectId: string,
    relation: string,
    subjectType: string,
    subjectId: string,
  ): Promise<Tuple | null> {
    return this.inner.findDirectTuple(
      objectType,
      objectId,
      relation,
      subjectType,
      subjectId,
    );
  }

  findUsersetTuples(
    objectType: string,
    objectId: string,
    relation: string,
  ): Promise<Tuple[]> {
    return this.inner.findUsersetTuples(objectType, objectId, relation);
  }

  findTuplesByRelation(
    objectType: string,
    objectId: string,
    relation: string,
  ): Promise<Tuple[]> {
    return this.inner.findTuplesByRelation(objectType, objectId, relation);
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

  listDirectSubjects(
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
    return this.inner.listDirectSubjects(objectType, objectId, relation);
  }

  upsertRelationConfig(config: RelationConfig): Promise<void> {
    this.configCache.get(config.objectType)?.delete(config.relation);
    return this.inner.upsertRelationConfig(config);
  }

  deleteRelationConfig(objectType: string, relation: string): Promise<boolean> {
    this.configCache.get(objectType)?.delete(relation);
    return this.inner.deleteRelationConfig(objectType, relation);
  }

  upsertConditionDefinition(condition: ConditionDefinition): Promise<void> {
    this.conditionCache.delete(condition.name);
    return this.inner.upsertConditionDefinition(condition);
  }

  deleteConditionDefinition(name: string): Promise<boolean> {
    this.conditionCache.delete(name);
    return this.inner.deleteConditionDefinition(name);
  }
}
