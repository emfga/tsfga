import { describe, expect, test } from "bun:test";
import { check } from "../src/check.ts";
import { createTsfga } from "../src/index.ts";
import { listObjects } from "../src/list-objects.ts";
import type { RelationConfig, Tuple } from "../src/types.ts";
import { MockTupleStore } from "./helpers/mock-store.ts";

/**
 * The clamp, on the reads `store-trust.test.ts` does not cover.
 *
 * That file pins `findCheckTuples` — the three per-node reads — and
 * proves a store cannot smuggle a row past `clampToQuery`. Every
 * other method of `TupleStore` is a read the check path also
 * trusts, and rounds 1 and 2 added two more (`hasTypeDefinition`,
 * and `insertTuple`'s new boolean). This asks the same question of
 * them: can a store that answers wrongly make core **grant**?
 *
 * Deliberately kept apart from `store-trust.test.ts`, which is
 * another agent's file.
 */

function makeTuple(overrides: Partial<Tuple> = {}): Tuple {
  return {
    objectType: "",
    objectId: "",
    relation: "",
    subjectType: "",
    subjectId: "",
    subjectRelation: null,
    conditionName: null,
    conditionContext: null,
    ...overrides,
  };
}

function makeConfig(overrides: Partial<RelationConfig>): RelationConfig {
  return {
    objectType: "",
    relation: "",
    directlyAssignable: [],
    impliedBy: null,
    computedUserset: null,
    tupleToUserset: null,
    excludedBy: null,
    intersection: null,
    ...overrides,
  };
}

/**
 * doc#viewer inherits folder#viewer through doc#parent, and alice
 * is a viewer of folder:f1. Nothing links doc:1 to any folder, so
 * every honest answer below is `false`.
 */
function ttuStore(): MockTupleStore {
  const store = new MockTupleStore();
  store.relationConfigs.push(
    makeConfig({
      objectType: "folder",
      relation: "viewer",
      directlyAssignable: [{ type: "user" }],
    }),
    makeConfig({
      objectType: "doc",
      relation: "parent",
      directlyAssignable: [{ type: "folder" }],
    }),
    makeConfig({
      objectType: "doc",
      relation: "viewer",
      directlyAssignable: [{ type: "user" }],
      tupleToUserset: [{ tupleset: "parent", computedUserset: "viewer" }],
    }),
  );
  store.tuples.push(
    makeTuple({
      objectType: "folder",
      objectId: "f1",
      relation: "viewer",
      subjectType: "user",
      subjectId: "alice",
    }),
  );
  return store;
}

const ttuRequest = {
  objectType: "doc",
  objectId: "1",
  relation: "viewer",
  subjectType: "user",
  subjectId: "alice",
};

describe("the tupleset read (step 5)", () => {
  test("a control: no parent row, so the TTU denies", async () => {
    expect(await check(ttuStore(), ttuRequest)).toBe(false);
  });

  test("a tupleset row of a type the tupleset relation forbids denies", async () => {
    // `doc#parent` admits `[folder]`. A store handing back a
    // `group:eng` row would dispatch onto `group:eng#viewer`.
    const store = ttuStore();
    store.relationConfigs.push(
      makeConfig({
        objectType: "group",
        relation: "viewer",
        directlyAssignable: [{ type: "user" }],
      }),
    );
    store.tuples.push(
      makeTuple({
        objectType: "group",
        objectId: "eng",
        relation: "viewer",
        subjectType: "user",
        subjectId: "alice",
      }),
    );
    const honest = store.findTuplesByRelation.bind(store);
    store.findTuplesByRelation = async (objectType, objectId, relation) => {
      const rows = await honest(objectType, objectId, relation);
      if (objectType === "doc" && relation === "parent") {
        return [
          ...rows,
          makeTuple({
            objectType: "doc",
            objectId: "1",
            relation: "parent",
            subjectType: "group",
            subjectId: "eng",
          }),
        ];
      }
      return rows;
    };

    expect(await check(store, ttuRequest)).toBe(false);
  });

  test("a conditioned tupleset row where only the bare ref is admitted denies", async () => {
    const store = ttuStore();
    const honest = store.findTuplesByRelation.bind(store);
    store.findTuplesByRelation = async (objectType, objectId, relation) => {
      const rows = await honest(objectType, objectId, relation);
      if (objectType === "doc" && relation === "parent") {
        return [
          ...rows,
          makeTuple({
            objectType: "doc",
            objectId: "1",
            relation: "parent",
            subjectType: "folder",
            subjectId: "f1",
            conditionName: "weekday_only",
          }),
        ];
      }
      return rows;
    };

    expect(await check(store, ttuRequest)).toBe(false);
  });

  test("a tupleset row carrying a userset subject denies", async () => {
    // `[folder]` does not admit `folder#viewer`, and upstream
    // refuses the model outright if a tupleset relation admits one.
    const store = ttuStore();
    const honest = store.findTuplesByRelation.bind(store);
    store.findTuplesByRelation = async (objectType, objectId, relation) => {
      const rows = await honest(objectType, objectId, relation);
      if (objectType === "doc" && relation === "parent") {
        return [
          ...rows,
          makeTuple({
            objectType: "doc",
            objectId: "1",
            relation: "parent",
            subjectType: "folder",
            subjectId: "f1",
            subjectRelation: "viewer",
          }),
        ];
      }
      return rows;
    };

    expect(await check(store, ttuRequest)).toBe(false);
  });

  test("a tupleset row for another object grants", async () => {
    // The adapter bug this stands in for is a `WHERE` clause that
    // forgot `object_id` — a shape `findCheckTuples` is clamped
    // against (`clampToQuery`'s `onNode`) and this read is not.
    // Every row below is one the model admits; none of them is on
    // the object asked about.
    const store = ttuStore();
    store.tuples.push(
      makeTuple({
        objectType: "doc",
        objectId: "OTHER",
        relation: "parent",
        subjectType: "folder",
        subjectId: "f1",
      }),
    );
    store.findTuplesByRelation = async (objectType, _objectId, relation) =>
      store.tuples.filter(
        (t) => t.objectType === objectType && t.relation === relation,
      );

    expect(await check(store, ttuRequest)).toBe(false);
  });

  test("a tupleset row for another relation grants", async () => {
    const store = ttuStore();
    store.relationConfigs.push(
      makeConfig({
        objectType: "doc",
        relation: "unrelated",
        directlyAssignable: [{ type: "folder" }],
      }),
    );
    store.tuples.push(
      makeTuple({
        objectType: "doc",
        objectId: "1",
        relation: "unrelated",
        subjectType: "folder",
        subjectId: "f1",
      }),
    );
    store.findTuplesByRelation = async (objectType, objectId) =>
      store.tuples.filter(
        (t) => t.objectType === objectType && t.objectId === objectId,
      );

    expect(await check(store, ttuRequest)).toBe(false);
  });
});

describe("hasTypeDefinition", () => {
  function directStore(): MockTupleStore {
    const store = new MockTupleStore();
    store.relationConfigs.push(
      makeConfig({
        objectType: "doc",
        relation: "viewer",
        directlyAssignable: [{ type: "user" }],
      }),
    );
    return store;
  }

  test("claiming an undefined type is defined still denies", async () => {
    // The documented tolerance: the wrong `true` loses one refusal.
    // What it may not do is answer anything but `false`.
    const store = directStore();
    store.hasTypeDefinition = async () => true;

    expect(
      await check(store, {
        objectType: "doc",
        objectId: "1",
        relation: "viewer",
        subjectType: "ghost",
        subjectId: "alice",
      }),
    ).toBe(false);
  });

  test("claiming a defined type is undefined refuses rather than grants", async () => {
    const store = directStore();
    store.tuples.push(
      makeTuple({
        objectType: "doc",
        objectId: "1",
        relation: "viewer",
        subjectType: "user",
        subjectId: "alice",
      }),
    );
    store.hasTypeDefinition = async () => false;

    expect(
      check(store, {
        objectType: "doc",
        objectId: "1",
        relation: "viewer",
        subjectType: "user",
        subjectId: "alice",
      }),
    ).rejects.toBeInstanceOf(Error);
  });
});

describe("duplicate and repeated rows", () => {
  test("a userset row returned three times resolves once and grants once", async () => {
    const store = new MockTupleStore();
    store.relationConfigs.push(
      makeConfig({
        objectType: "team",
        relation: "member",
        directlyAssignable: [{ type: "user" }],
      }),
      makeConfig({
        objectType: "doc",
        relation: "viewer",
        directlyAssignable: [{ type: "team", relation: "member" }],
      }),
    );
    store.tuples.push(
      makeTuple({
        objectType: "team",
        objectId: "eng",
        relation: "member",
        subjectType: "user",
        subjectId: "alice",
      }),
    );
    const row = makeTuple({
      objectType: "doc",
      objectId: "1",
      relation: "viewer",
      subjectType: "team",
      subjectId: "eng",
      subjectRelation: "member",
    });
    const honest = store.findCheckTuples.bind(store);
    store.findCheckTuples = async (query) =>
      query.objectType === "doc"
        ? { direct: null, wildcard: [], usersets: [row, row, row] }
        : honest(query);

    expect(
      await check(store, {
        objectType: "doc",
        objectId: "1",
        relation: "viewer",
        subjectType: "user",
        subjectId: "alice",
      }),
    ).toBe(true);
  });

  test("a duplicated inadmissible row is dropped every time", async () => {
    const store = new MockTupleStore();
    store.relationConfigs.push(
      makeConfig({
        objectType: "team",
        relation: "owner",
        directlyAssignable: [{ type: "user" }],
      }),
      makeConfig({
        objectType: "doc",
        relation: "viewer",
        directlyAssignable: [{ type: "team", relation: "member" }],
      }),
      makeConfig({
        objectType: "team",
        relation: "member",
        directlyAssignable: [{ type: "user" }],
      }),
    );
    store.tuples.push(
      makeTuple({
        objectType: "team",
        objectId: "eng",
        relation: "owner",
        subjectType: "user",
        subjectId: "alice",
      }),
    );
    const row = makeTuple({
      objectType: "doc",
      objectId: "1",
      relation: "viewer",
      subjectType: "team",
      subjectId: "eng",
      subjectRelation: "owner",
    });
    const honest = store.findCheckTuples.bind(store);
    store.findCheckTuples = async (query) =>
      query.objectType === "doc"
        ? { direct: null, wildcard: [], usersets: [row, row] }
        : honest(query);

    expect(
      await check(store, {
        objectType: "doc",
        objectId: "1",
        relation: "viewer",
        subjectType: "user",
        subjectId: "alice",
      }),
    ).toBe(false);
  });
});

describe("listCandidateObjectIds", () => {
  function candidateStore(): MockTupleStore {
    const store = new MockTupleStore();
    store.relationConfigs.push(
      makeConfig({
        objectType: "doc",
        relation: "viewer",
        directlyAssignable: [{ type: "user" }],
      }),
    );
    store.tuples.push(
      makeTuple({
        objectType: "doc",
        objectId: "1",
        relation: "viewer",
        subjectType: "user",
        subjectId: "alice",
      }),
    );
    return store;
  }

  const request = {
    objectType: "doc",
    relation: "viewer",
    subjectType: "user",
    subjectId: "alice",
  };

  test("candidates nothing is written on are re-checked away", async () => {
    const store = candidateStore();
    store.listCandidateObjectIds = async () => ["1", "2", "3", "4"];

    expect(await listObjects(store, request)).toEqual(["1"]);
  });

  test("a duplicated candidate is passed through, not de-duplicated", async () => {
    // Recorded rather than asserted as correct. De-duplication is
    // the store's job — `KyselyTupleStore` selects `distinct` and
    // `ContextualTupleStore` merges against a `Set` — so this is
    // unreachable from anything shipped. It is here so a future
    // store author reads it as a contract they have to keep, and
    // because it cannot grant: every id repeated was checked and
    // held.
    const store = candidateStore();
    store.listCandidateObjectIds = async () => ["1", "1", "1"];

    expect(await listObjects(store, request)).toEqual(["1", "1", "1"]);
  });
});

describe("insertTuple's boolean", () => {
  test("a store lying that it inserted reports success and still denies", async () => {
    // The lie loses the DuplicateTupleError, which is a report to
    // the caller. It must not become a grant: the check path reads
    // rows, not the write path's opinion of them.
    const store = new MockTupleStore();
    store.relationConfigs.push(
      makeConfig({
        objectType: "doc",
        relation: "viewer",
        directlyAssignable: [{ type: "user" }],
      }),
    );
    store.insertTuple = async () => true;
    const client = createTsfga(store);

    await client.addTuple({
      objectType: "doc",
      objectId: "1",
      relation: "viewer",
      subjectType: "user",
      subjectId: "alice",
    });

    expect(
      await client.check({
        objectType: "doc",
        objectId: "1",
        relation: "viewer",
        subjectType: "user",
        subjectId: "alice",
      }),
    ).toBe(false);
  });

  test("a store lying that it did not insert reports a duplicate", async () => {
    const store = new MockTupleStore();
    store.relationConfigs.push(
      makeConfig({
        objectType: "doc",
        relation: "viewer",
        directlyAssignable: [{ type: "user" }],
      }),
    );
    const honest = store.insertTuple.bind(store);
    store.insertTuple = async (tuple) => {
      await honest(tuple);
      return false;
    };
    const client = createTsfga(store);

    expect(
      client.addTuple({
        objectType: "doc",
        objectId: "1",
        relation: "viewer",
        subjectType: "user",
        subjectId: "alice",
      }),
    ).rejects.toBeInstanceOf(Error);
  });
});

describe("listSubjects reads through findTuplesByRelation", () => {
  function subjectStore(): MockTupleStore {
    const store = new MockTupleStore();
    store.relationConfigs.push(
      makeConfig({
        objectType: "doc",
        relation: "viewer",
        directlyAssignable: [{ type: "user" }],
      }),
      makeConfig({
        objectType: "doc",
        relation: "editor",
        directlyAssignable: [{ type: "user" }],
      }),
    );
    store.tuples.push(
      makeTuple({
        objectType: "doc",
        objectId: "1",
        relation: "viewer",
        subjectType: "user",
        subjectId: "alice",
      }),
      makeTuple({
        objectType: "doc",
        objectId: "2",
        relation: "viewer",
        subjectType: "user",
        subjectId: "bob",
      }),
      makeTuple({
        objectType: "doc",
        objectId: "1",
        relation: "editor",
        subjectType: "user",
        subjectId: "carol",
      }),
    );
    return store;
  }

  test("a control: only the object's own rows on the relation", async () => {
    const client = createTsfga(subjectStore());
    expect(await client.listSubjects("doc", "1", "viewer")).toEqual([
      { subjectType: "user", subjectId: "alice", subjectRelation: null },
    ]);
  });

  test("rows for another object are reported", async () => {
    const store = subjectStore();
    store.findTuplesByRelation = async (objectType, _objectId, relation) =>
      store.tuples.filter(
        (t) => t.objectType === objectType && t.relation === relation,
      );
    const client = createTsfga(store);

    expect(await client.listSubjects("doc", "1", "viewer")).toEqual([
      { subjectType: "user", subjectId: "alice", subjectRelation: null },
    ]);
  });

  test("rows on another relation are reported", async () => {
    const store = subjectStore();
    store.findTuplesByRelation = async (objectType, objectId) =>
      store.tuples.filter(
        (t) => t.objectType === objectType && t.objectId === objectId,
      );
    const client = createTsfga(store);

    expect(await client.listSubjects("doc", "1", "viewer")).toEqual([
      { subjectType: "user", subjectId: "alice", subjectRelation: null },
    ]);
  });
});
