import {
  type IdDomain,
  OPAQUE_IDS,
  type TupleStore,
} from "../../src/store-interface.ts";
import { directSubjectRef, refsAdmit } from "../../src/tuple-validation.ts";
import type {
  AddTupleRequest,
  CheckTuples,
  CheckTuplesQuery,
  ConditionDefinition,
  RelationConfig,
  RemoveTupleRequest,
  Tuple,
  TypeRestriction,
} from "../../src/types.ts";

/**
 * In-memory TupleStore for unit tests.
 * Stores tuples, relation configs, and condition definitions in arrays.
 */
export class MockTupleStore implements TupleStore {
  /**
   * Opaque, and overridable per test. The mock keeps its tuples in
   * an array, so it can hold any string an OpenFGA id can be — a
   * test about a *narrow* domain assigns its own.
   */
  idDomain: IdDomain = OPAQUE_IDS;

  tuples: Tuple[] = [];
  relationConfigs: RelationConfig[] = [];
  conditionDefinitions: ConditionDefinition[] = [];

  /** Store-call counts per method name, for round-trip assertions. */
  counts: Record<string, number> = {};

  /**
   * Ordered log of every store call with its arguments. `counts`
   * is per-method only, so it cannot say *which* node was read —
   * assertions about memoization need the identity, not the total.
   */
  calls: Array<{ method: string; args: unknown[] }> = [];

  /**
   * Every `findCheckTuples` query, in call order. The call log
   * above records a node's identity; this records which of the
   * three reads the relation config let it ask for.
   */
  checkQueries: CheckTuplesQuery[] = [];

  /** Reset all call counts and the call log (data is untouched). */
  resetCounts(): void {
    this.counts = {};
    this.calls = [];
    this.checkQueries = [];
  }

  /** Recorded check queries against one node, in call order. */
  queriesFor(
    objectType: string,
    objectId: string,
    relation: string,
  ): CheckTuplesQuery[] {
    return this.checkQueries.filter(
      (q) =>
        q.objectType === objectType &&
        q.objectId === objectId &&
        q.relation === relation,
    );
  }

  /** Count calls to `method` whose arguments start with `args`. */
  callsWith(method: string, ...args: unknown[]): number {
    return this.calls.filter(
      (call) =>
        call.method === method && args.every((arg, i) => call.args[i] === arg),
    ).length;
  }

  private tally(method: string, ...args: unknown[]): void {
    this.counts[method] = (this.counts[method] ?? 0) + 1;
    this.calls.push({ method, args });
  }

  async findCheckTuples(query: CheckTuplesQuery): Promise<CheckTuples> {
    // Tallied with the node's five identifying strings ahead of
    // the query object, so `callsWith` can match a node by prefix
    // the way it could when this was three separate methods.
    this.tally(
      "findCheckTuples",
      query.objectType,
      query.objectId,
      query.relation,
      query.subjectType,
      query.subjectId,
      query,
    );
    this.checkQueries.push(query);

    const onRelation = this.tuples.filter(
      (t) =>
        t.objectType === query.objectType &&
        t.objectId === query.objectId &&
        t.relation === query.relation,
    );
    const findDirect = (subjectId: string) =>
      onRelation.find(
        (t) =>
          t.subjectType === query.subjectType &&
          t.subjectId === subjectId &&
          t.subjectRelation == null,
      ) ?? null;

    // Narrowed to the admitted refs, as a real adapter would.
    // `null` declines to narrow, `[]` excludes the part. Matching
    // is on all four fields, the condition included.
    const admits = (
      refs: readonly TypeRestriction[] | null,
      tuple: Tuple,
    ): boolean =>
      refsAdmit(
        refs,
        directSubjectRef(
          tuple.subjectType,
          tuple.subjectId,
          tuple.subjectRelation,
          tuple.conditionName,
        ),
      );

    const probe = (
      refs: readonly TypeRestriction[] | null,
      subjectId: string,
    ): Tuple | null => {
      if (refs !== null && refs.length === 0) return null;
      const tuple = findDirect(subjectId);
      return tuple !== null && admits(refs, tuple) ? tuple : null;
    };

    // The wildcard slot is a list. This store keeps one row per
    // natural key, so it holds 0 or 1 — the list is there because
    // the contextual overlay concatenates onto it.
    const wildcardRow = probe(query.wildcardRefs, "*");

    return {
      direct: probe(query.directRefs, query.subjectId),
      wildcard: wildcardRow === null ? [] : [wildcardRow],
      usersets: onRelation.filter(
        (t) =>
          t.subjectRelation !== null &&
          t.subjectRelation !== undefined &&
          admits(query.usersetRefs, t),
      ),
    };
  }

  async findTuplesByRelation(
    objectType: string,
    objectId: string,
    relation: string,
  ): Promise<Tuple[]> {
    this.tally("findTuplesByRelation", objectType, objectId, relation);
    return this.tuples.filter(
      (t) =>
        t.objectType === objectType &&
        t.objectId === objectId &&
        t.relation === relation,
    );
  }

  async findRelationConfig(
    objectType: string,
    relation: string,
  ): Promise<RelationConfig | null> {
    this.tally("findRelationConfig", objectType, relation);
    return (
      this.relationConfigs.find(
        (c) => c.objectType === objectType && c.relation === relation,
      ) ?? null
    );
  }

  async findConditionDefinition(
    name: string,
  ): Promise<ConditionDefinition | null> {
    this.tally("findConditionDefinition", name);
    return this.conditionDefinitions.find((c) => c.name === name) ?? null;
  }

  /**
   * A type is defined when a config names it as its object type or
   * when any config's `directlyAssignable` admits it — the second
   * half being what makes a relationless `user` a defined type.
   * Tuples say nothing: a row can outlive the config that admitted
   * it, and a store full of rows for a type the model dropped must
   * not report that type as defined.
   */
  async hasTypeDefinition(type: string): Promise<boolean> {
    this.tally("hasTypeDefinition", type);
    return this.relationConfigs.some(
      (c) =>
        c.objectType === type ||
        c.directlyAssignable.some((r) => r.type === type),
    );
  }

  async insertTuple(tuple: AddTupleRequest): Promise<boolean> {
    this.tally("insertTuple");
    const idx = this.tuples.findIndex(
      (t) =>
        t.objectType === tuple.objectType &&
        t.objectId === tuple.objectId &&
        t.relation === tuple.relation &&
        t.subjectType === tuple.subjectType &&
        t.subjectId === tuple.subjectId &&
        (t.subjectRelation ?? "") === (tuple.subjectRelation ?? ""),
    );
    const newTuple: Tuple = {
      objectType: tuple.objectType,
      objectId: tuple.objectId,
      relation: tuple.relation,
      subjectType: tuple.subjectType,
      subjectId: tuple.subjectId,
      subjectRelation: tuple.subjectRelation ?? null,
      conditionName: tuple.conditionName ?? null,
      conditionContext: tuple.conditionContext ?? null,
    };
    // The natural key excludes the condition, so an existing row is
    // reported rather than replaced — the store never edits a live
    // grant, and `addTuple` turns the `false` into a
    // `DuplicateTupleError`.
    if (idx >= 0) return false;
    this.tuples.push(newTuple);
    return true;
  }

  async deleteTuple(tuple: RemoveTupleRequest): Promise<boolean> {
    this.tally("deleteTuple");
    const idx = this.tuples.findIndex(
      (t) =>
        t.objectType === tuple.objectType &&
        t.objectId === tuple.objectId &&
        t.relation === tuple.relation &&
        t.subjectType === tuple.subjectType &&
        t.subjectId === tuple.subjectId &&
        (t.subjectRelation ?? "") === (tuple.subjectRelation ?? ""),
    );
    if (idx >= 0) {
      this.tuples.splice(idx, 1);
      return true;
    }
    return false;
  }

  async listCandidateObjectIds(objectType: string): Promise<string[]> {
    this.tally("listCandidateObjectIds", objectType);
    const ids = new Set<string>();
    for (const t of this.tuples) {
      if (t.objectType === objectType) {
        ids.add(t.objectId);
      }
    }
    return [...ids];
  }

  async upsertRelationConfig(config: RelationConfig): Promise<void> {
    this.tally("upsertRelationConfig");
    const idx = this.relationConfigs.findIndex(
      (c) =>
        c.objectType === config.objectType && c.relation === config.relation,
    );
    if (idx >= 0) {
      this.relationConfigs[idx] = config;
    } else {
      this.relationConfigs.push(config);
    }
  }

  async deleteRelationConfig(
    objectType: string,
    relation: string,
  ): Promise<boolean> {
    this.tally("deleteRelationConfig", objectType, relation);
    const idx = this.relationConfigs.findIndex(
      (c) => c.objectType === objectType && c.relation === relation,
    );
    if (idx >= 0) {
      this.relationConfigs.splice(idx, 1);
      return true;
    }
    return false;
  }

  async upsertConditionDefinition(
    condition: ConditionDefinition,
  ): Promise<void> {
    this.tally("upsertConditionDefinition");
    const idx = this.conditionDefinitions.findIndex(
      (c) => c.name === condition.name,
    );
    if (idx >= 0) {
      this.conditionDefinitions[idx] = condition;
    } else {
      this.conditionDefinitions.push(condition);
    }
  }

  async deleteConditionDefinition(name: string): Promise<boolean> {
    this.tally("deleteConditionDefinition", name);
    const idx = this.conditionDefinitions.findIndex((c) => c.name === name);
    if (idx >= 0) {
      this.conditionDefinitions.splice(idx, 1);
      return true;
    }
    return false;
  }
}
