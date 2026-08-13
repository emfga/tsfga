/**
 * Runtime-agnostic smoke test for @tsfga/core.
 *
 * Validates that the built package can be imported and used from
 * Node.js and Deno (ESM resolution via package.json exports).
 *
 * Run after `bun run build`:
 *   node tests/smoke/smoke-test.mjs
 *   deno run --allow-all tests/smoke/smoke-test.mjs
 */

import {
  createTsfga,
  check,
  OPAQUE_IDS,
} from "../../packages/core/dist/index.js";

// Verify exports are functions
assert(typeof createTsfga === "function", "createTsfga should be a function");
assert(typeof check === "function", "check should be a function");

// Minimal mock store (only methods used by a simple direct-tuple
// check). `findCheckTuples` answers all three per-node reads at
// once; a store may use the query's *Refs lists to skip work, but
// core re-clamps the reply, so returning a slot that was not asked
// for just loses it. An empty list admits nothing; `null` is the
// store declining to narrow, not a permission to widen.
//
// The config is a real one because a check refuses a relation the
// model does not define. It used to answer `null` for everything,
// which read as "unrestricted" and quietly made this the widest
// model there is.
/** @type {import("../../packages/core/dist/index.js").TupleStore} */
const mockStore = {
  // Required, and deliberately with no default: a store that never
  // says what ids it can hold is one whose refusals arrive as a
  // driver error from three layers down.
  idDomain: OPAQUE_IDS,

  findCheckTuples: async (query) => ({
    direct:
      query.directRefs?.length === 0
        ? null
        : {
            objectType: query.objectType,
            objectId: query.objectId,
            relation: query.relation,
            subjectType: query.subjectType,
            subjectId: query.subjectId,
            subjectRelation: null,
            conditionName: null,
            conditionContext: null,
          },
    wildcard: [],
    usersets: [],
  }),
  findTuplesByRelation: async () => [],
  findRelationConfig: async (objectType, relation) => ({
    objectType,
    relation,
    directlyAssignable: [{ type: "user" }],
    impliedBy: null,
    computedUserset: null,
    tupleToUserset: null,
    excludedBy: null,
    intersection: null,
  }),
  findConditionDefinition: async () => null,
  // `true` is the interface's answer for a store that cannot
  // decide, which is what this stub is.
  hasTypeDefinition: async () => true,
  insertTuple: async () => true,
  deleteTuple: async () => false,
  listCandidateObjectIds: async () => [],
  upsertRelationConfig: async () => {},
  deleteRelationConfig: async () => false,
  upsertConditionDefinition: async () => {},
  deleteConditionDefinition: async () => false,
};

const client = createTsfga(mockStore);

// Direct tuple match — should return true
const allowed = await client.check({
  objectType: "doc",
  objectId: "1",
  relation: "viewer",
  subjectType: "user",
  subjectId: "alice",
});
assert(allowed === true, `expected true, got ${allowed}`);

// No matching tuple — should return false
const notAllowedStore = {
  ...mockStore,
  findCheckTuples: async () => ({
    direct: null,
    wildcard: [],
    usersets: [],
  }),
};
const notAllowedClient = createTsfga(notAllowedStore);
const denied = await notAllowedClient.check({
  objectType: "doc",
  objectId: "1",
  relation: "viewer",
  subjectType: "user",
  subjectId: "bob",
});
assert(denied === false, `expected false, got ${denied}`);

console.log("smoke test passed");

/**
 * @param {unknown} condition
 * @param {string} message
 */
function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}
