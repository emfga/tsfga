import { evaluateTupleCondition } from "src/core/conditions.ts";
import type { CheckOptions, CheckRequest } from "src/core/types.ts";
import type { TupleStore } from "src/store/interface.ts";

/**
 * 5-step recursive check algorithm.
 *
 * Steps:
 * 1. Direct tuple check
 * 2. Userset expansion
 * 3. Relation inheritance (implied_by)
 * 4. Computed userset
 * 5. Tuple-to-userset
 */
export async function check(
  store: TupleStore,
  request: CheckRequest,
  options: CheckOptions = {},
  depth: number = 0,
): Promise<boolean> {
  const maxDepth = options.maxDepth ?? 10;

  // Prevent infinite recursion
  if (depth > maxDepth) {
    return false;
  }

  // Step 1: Direct tuple check
  const directTuple = await store.findDirectTuple(
    request.objectType,
    request.objectId,
    request.relation,
    request.subjectType,
    request.subjectId,
  );
  if (directTuple) {
    if (await evaluateTupleCondition(store, directTuple, request.context)) {
      return true;
    }
  }

  // Step 1b: Wildcard check (e.g., user:*)
  const wildcardTuple = await store.findDirectTuple(
    request.objectType,
    request.objectId,
    request.relation,
    request.subjectType,
    "*",
  );
  if (wildcardTuple) {
    if (await evaluateTupleCondition(store, wildcardTuple, request.context)) {
      return true;
    }
  }

  // Step 2: Userset expansion
  const usersetTuples = await store.findUsersetTuples(
    request.objectType,
    request.objectId,
    request.relation,
  );
  for (const userset of usersetTuples) {
    if (!(await evaluateTupleCondition(store, userset, request.context))) {
      continue;
    }
    // subjectRelation is guaranteed non-null by findUsersetTuples
    const relation = userset.subjectRelation as string;
    const hasRelation = await check(
      store,
      {
        objectType: userset.subjectType,
        objectId: userset.subjectId,
        relation,
        subjectType: request.subjectType,
        subjectId: request.subjectId,
        context: request.context,
      },
      options,
      depth + 1,
    );
    if (hasRelation) {
      return true;
    }
  }

  // Fetch relation config ONCE for steps 3-5
  const config = await store.findRelationConfig(
    request.objectType,
    request.relation,
  );

  // Step 3: Relation inheritance (implied_by)
  if (config?.impliedBy) {
    for (const impliedRelation of config.impliedBy) {
      const hasRelation = await check(
        store,
        {
          ...request,
          relation: impliedRelation,
        },
        options,
        depth + 1,
      );
      if (hasRelation) {
        return true;
      }
    }
  }

  // Step 4: Computed userset
  if (config?.computedUserset) {
    const hasRelation = await check(
      store,
      {
        ...request,
        relation: config.computedUserset,
      },
      options,
      depth + 1,
    );
    if (hasRelation) {
      return true;
    }
  }

  // Step 5: Tuple-to-userset
  if (config?.tupleToUserset) {
    const { tupleset, computedUserset } = config.tupleToUserset;
    const linkedTuples = await store.findTuplesByRelation(
      request.objectType,
      request.objectId,
      tupleset,
    );
    for (const linked of linkedTuples) {
      const hasRelation = await check(
        store,
        {
          objectType: linked.subjectType,
          objectId: linked.subjectId,
          relation: computedUserset,
          subjectType: request.subjectType,
          subjectId: request.subjectId,
          context: request.context,
        },
        options,
        depth + 1,
      );
      if (hasRelation) {
        return true;
      }
    }
  }

  return false;
}
