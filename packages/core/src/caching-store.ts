import type { IdDomain, TupleStore } from "./store-interface.ts";
import type {
  CheckTuples,
  CheckTuplesQuery,
  ConditionDefinition,
  RelationConfig,
  RemoveTupleRequest,
  Tuple,
} from "./types.ts";
import type { GatedRelationConfig, GatedTuple } from "./write-gate.ts";

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
  /**
   * Type definitions, keyed by type name. The subject-type gate
   * runs once per check, so a `listObjects` over a thousand
   * candidates would otherwise issue a thousand identical reads.
   */
  private typeCache = new Map<string, Promise<boolean>>();

  constructor(private inner: TupleStore) {}

  /** The wrapped store's; a cache holds no ids of its own. */
  get idDomain(): IdDomain {
    return this.inner.idDomain;
  }

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

  hasTypeDefinition(type: string): Promise<boolean> {
    let cached = this.typeCache.get(type);
    if (!cached) {
      cached = this.inner.hasTypeDefinition(type);
      this.typeCache.set(type, cached);
      this.evictOnRejection(cached, this.typeCache, type);
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

  findCheckTuples(query: CheckTuplesQuery): Promise<CheckTuples> {
    return this.inner.findCheckTuples(query);
  }

  findTuplesByRelation(
    objectType: string,
    objectId: string,
    relation: string,
  ): Promise<Tuple[]> {
    return this.inner.findTuplesByRelation(objectType, objectId, relation);
  }

  insertTuple(tuple: GatedTuple): Promise<boolean> {
    return this.inner.insertTuple(tuple);
  }

  deleteTuple(tuple: RemoveTupleRequest): Promise<boolean> {
    return this.inner.deleteTuple(tuple);
  }

  listCandidateObjectIds(objectType: string): Promise<string[]> {
    return this.inner.listCandidateObjectIds(objectType);
  }

  // Both config writes clear the *whole* type cache rather than one
  // entry: a config defines its own object type and every type its
  // `directlyAssignable` names, and deleting one can undefine a
  // type only the deleted config mentioned. The invalidation is
  // per-key nowhere because the key set is not derivable from the
  // write alone.
  upsertRelationConfig(config: GatedRelationConfig): Promise<void> {
    this.configCache.get(config.objectType)?.delete(config.relation);
    this.typeCache.clear();
    return this.inner.upsertRelationConfig(config);
  }

  deleteRelationConfig(objectType: string, relation: string): Promise<boolean> {
    this.configCache.get(objectType)?.delete(relation);
    this.typeCache.clear();
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
