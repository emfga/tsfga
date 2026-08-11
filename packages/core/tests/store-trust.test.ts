import { describe, expect, test } from "bun:test";
import { check } from "../src/check.ts";
import type {
  CheckTuples,
  CheckTuplesQuery,
  RelationConfig,
  Tuple,
} from "../src/types.ts";
import { MockTupleStore } from "./helpers/mock-store.ts";

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

function makeConfig(overrides: Partial<RelationConfig> = {}): RelationConfig {
  return {
    objectType: "",
    relation: "",
    directlyAssignable: [
      { type: "user" },
      { type: "user", wildcard: true },
      { type: "team" },
      { type: "team", wildcard: true },
    ],
    impliedBy: null,
    computedUserset: null,
    tupleToUserset: null,
    excludedBy: null,
    intersection: null,
    ...overrides,
  };
}

const request = {
  objectType: "doc",
  objectId: "1",
  relation: "viewer",
  subjectType: "user",
  subjectId: "alice",
};

/**
 * A store that answers whatever it likes, ignoring the query's
 * `include*` flags and filing rows wherever it wants.
 *
 * This is the adapter bug the merged read made possible. Under the
 * old interface these cases were unreachable: the relation config
 * was enforced by core *not calling* the method, so a store had no
 * opportunity to return a row the model forbids. Sending the gates
 * as flags moved that enforcement onto the store — unless core
 * re-clamps the reply, which is what these tests exist to pin.
 *
 * Every case here must DENY. A grant is a fail-open: a tuple the
 * model does not admit would be granting access.
 */
class RogueStore extends MockTupleStore {
  constructor(private readonly reply: Partial<CheckTuples>) {
    super();
  }

  /** The last query core actually sent, for gate assertions. */
  lastQuery: CheckTuplesQuery | null = null;

  override async findCheckTuples(
    query: CheckTuplesQuery,
  ): Promise<CheckTuples> {
    // Only `doc:1#viewer` misbehaves. Nodes the check dispatches
    // to — the team behind a userset row — answer honestly from
    // the seeded tuples, so a grant there is a real grant and the
    // tests below can tell "the clamp worked" apart from "the
    // rogue reply happened to deny".
    if (query.objectType !== "doc" || query.relation !== "viewer") {
      return super.findCheckTuples(query);
    }
    this.lastQuery = query;
    return {
      direct: null,
      wildcard: null,
      usersets: [],
      ...this.reply,
    };
  }
}

describe("a store cannot widen what the model admits", () => {
  let store: RogueStore;

  /** Push a `doc.viewer` config and check alice against it. */
  function checkWith(config: Partial<RelationConfig>) {
    store.relationConfigs.push(
      makeConfig({ objectType: "doc", relation: "viewer", ...config }),
    );
    return check(store, request);
  }

  describe("ignoring an include flag loses the row", () => {
    test("a direct tuple on a relation that forbids the type denies", async () => {
      // The model says only `team` may hold viewer directly, so
      // core sends includeDirect: false. The store answers anyway.
      store = new RogueStore({ direct: makeTuple({ ...request }) });

      expect(
        await checkWith({
          directlyAssignable: [
            { type: "team" },
            { type: "team", relation: "member" },
          ],
        }),
      ).toBe(false);
      expect(store.lastQuery?.directRefs).toEqual([]);
    });

    test("a wildcard tuple on a relation without `type:*` denies", async () => {
      store = new RogueStore({
        wildcard: makeTuple({ ...request, subjectId: "*" }),
      });

      expect(
        await checkWith({
          directlyAssignable: [
            { type: "user" },
            { type: "team", relation: "member" },
          ],
        }),
      ).toBe(false);
      expect(store.lastQuery?.wildcardRefs).toEqual([]);
    });

    test("a userset row on a relation that forbids usersets denies", async () => {
      // The dangerous one: an expanded userset dispatches to
      // another node, so a grant here is reachable from a tuple
      // the model never admitted.
      store = new RogueStore({
        usersets: [
          makeTuple({
            ...request,
            subjectType: "team",
            subjectId: "eng",
            subjectRelation: "member",
          }),
        ],
      });
      store.relationConfigs.push(
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
          relation: "member",
          subjectType: "user",
          subjectId: "alice",
        }),
      );

      expect(
        await checkWith({
          directlyAssignable: [{ type: "user" }],
        }),
      ).toBe(false);
      expect(store.lastQuery?.usersetRefs).toEqual([]);
    });
  });

  describe("a misfiled row loses its slot", () => {
    test("another subject's tuple in the wildcard slot denies", async () => {
      // The classifier bug the reference adapter's shape invites:
      // alice's tuple filed as the wildcard would grant everyone.
      store = new RogueStore({
        wildcard: makeTuple({ ...request, subjectId: "alice" }),
      });
      store.relationConfigs.push(
        makeConfig({
          objectType: "doc",
          relation: "viewer",
          directlyAssignable: [
            { type: "user" },
            { type: "user", wildcard: true },
          ],
        }),
      );

      // bob, not alice — a wildcard grant would apply to him.
      expect(await check(store, { ...request, subjectId: "bob" })).toBe(false);
    });

    test("a tuple for another object denies", async () => {
      store = new RogueStore({
        direct: makeTuple({ ...request, objectId: "2" }),
      });

      expect(await checkWith({ directlyAssignable: [{ type: "user" }] })).toBe(
        false,
      );
    });

    test("a tuple for another relation denies", async () => {
      store = new RogueStore({
        direct: makeTuple({ ...request, relation: "editor" }),
      });

      expect(await checkWith({ directlyAssignable: [{ type: "user" }] })).toBe(
        false,
      );
    });

    test("a subject-relation row in the direct slot denies", async () => {
      // A userset row is not a direct grant. Accepting it here
      // would grant without ever resolving the userset.
      store = new RogueStore({
        direct: makeTuple({ ...request, subjectRelation: "member" }),
      });

      expect(await checkWith({ directlyAssignable: [{ type: "user" }] })).toBe(
        false,
      );
    });

    test("a direct row in the userset slot is not expanded", async () => {
      store = new RogueStore({
        usersets: [makeTuple({ ...request, subjectRelation: null })],
      });

      expect(
        await checkWith({
          directlyAssignable: [
            { type: "user" },
            { type: "team", relation: "member" },
          ],
        }),
      ).toBe(false);
    });
  });

  describe("clamping does not disturb an honest store", () => {
    test("the admitted rows still grant", async () => {
      // The control: the clamp must reject only what is invalid.
      store = new RogueStore({ direct: makeTuple({ ...request }) });

      expect(await checkWith({ directlyAssignable: [{ type: "user" }] })).toBe(
        true,
      );
    });

    test("an absent subject relation still grants", async () => {
      // `Tuple.subjectRelation` is required, so shipped code
      // cannot reach this — but `TupleStore` is the documented
      // extension point, and a hand-written or JavaScript adapter
      // that simply omits the field has nothing stopping it. The
      // row is a valid direct grant; an omitted field must read as
      // the null it stands for, not as a third state that falls
      // through every slot.
      const loose = makeTuple({ ...request });
      Reflect.deleteProperty(loose, "subjectRelation");
      store = new RogueStore({ direct: loose });

      expect(await checkWith({ directlyAssignable: [{ type: "user" }] })).toBe(
        true,
      );
    });

    test("a valid userset row is still expanded", async () => {
      store = new RogueStore({
        usersets: [
          makeTuple({
            ...request,
            subjectType: "team",
            subjectId: "eng",
            subjectRelation: "member",
          }),
        ],
      });
      store.relationConfigs.push(
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
          relation: "member",
          subjectType: "user",
          subjectId: "alice",
        }),
      );

      expect(
        await checkWith({
          directlyAssignable: [
            { type: "user" },
            { type: "team" },
            { type: "team", relation: "member" },
          ],
        }),
      ).toBe(true);
    });

    test("a wildcard grant still grants", async () => {
      store = new RogueStore({
        wildcard: makeTuple({ ...request, subjectId: "*" }),
      });

      expect(
        await checkWith({
          directlyAssignable: [
            { type: "user" },
            { type: "user", wildcard: true },
          ],
        }),
      ).toBe(true);
    });
  });
});

/**
 * The condition dimension of the clamp, under *partial* admission.
 *
 * These are the cases a hand-written scenario is least likely to
 * contain and a store is most likely to produce: a relation that
 * admits a ref under one condition and not another, with a stored
 * row carrying the wrong one. The row passes the read gate — which
 * is condition-blind by necessity — and must die at the clamp.
 *
 * Every case must DENY. A grant means a row the model does not
 * admit granted access.
 */
describe("the clamp matches the condition, not just the shape", () => {
  let store: RogueStore;

  function checkWith(config: Partial<RelationConfig>) {
    store.relationConfigs.push(
      makeConfig({ objectType: "doc", relation: "viewer", ...config }),
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
        relation: "member",
        subjectType: "user",
        subjectId: "alice",
      }),
    );
    store.resetCounts();
    return check(store, request);
  }

  test("a conditioned direct row where only the bare ref is admitted", async () => {
    store = new RogueStore({
      direct: makeTuple({ ...request, conditionName: "weekday_only" }),
    });

    expect(await checkWith({ directlyAssignable: [{ type: "user" }] })).toBe(
      false,
    );
  });

  test("a bare direct row where only the conditioned ref is admitted", async () => {
    // The fail-open direction, and the unintuitive one: the row
    // carries no condition, so nothing evaluates and the old code
    // read it as unconditional access.
    store = new RogueStore({ direct: makeTuple({ ...request }) });

    expect(
      await checkWith({
        directlyAssignable: [{ type: "user", condition: "weekday_only" }],
      }),
    ).toBe(false);
  });

  test("a row carrying a different condition than the one admitted", async () => {
    store = new RogueStore({
      direct: makeTuple({ ...request, conditionName: "other_cond" }),
    });

    expect(
      await checkWith({
        directlyAssignable: [{ type: "user", condition: "weekday_only" }],
      }),
    ).toBe(false);
  });

  test("a conditioned wildcard row where only the bare wildcard is admitted", async () => {
    store = new RogueStore({
      wildcard: makeTuple({
        ...request,
        subjectId: "*",
        conditionName: "weekday_only",
      }),
    });

    expect(
      await checkWith({
        directlyAssignable: [{ type: "user", wildcard: true }],
      }),
    ).toBe(false);
  });

  test("a conditioned userset row where only the bare userset is admitted", async () => {
    // The dangerous one: a userset dispatches to another node, so
    // a grant here is reachable from a row the model refuses.
    store = new RogueStore({
      usersets: [
        makeTuple({
          objectType: "doc",
          objectId: "1",
          relation: "viewer",
          subjectType: "team",
          subjectId: "eng",
          subjectRelation: "member",
          conditionName: "weekday_only",
        }),
      ],
    });

    expect(
      await checkWith({
        directlyAssignable: [{ type: "team", relation: "member" }],
      }),
    ).toBe(false);
  });

  test("partial admission keeps the admitted half", async () => {
    // The control. A relation admitting the ref both bare and
    // conditioned still grants on the conditioned row — the clamp
    // narrows, it does not simply deny anything conditioned.
    store = new RogueStore({
      usersets: [
        makeTuple({
          objectType: "doc",
          objectId: "1",
          relation: "viewer",
          subjectType: "team",
          subjectId: "eng",
          subjectRelation: "member",
        }),
      ],
    });

    expect(
      await checkWith({
        directlyAssignable: [
          { type: "team", relation: "member" },
          { type: "team", relation: "member", condition: "weekday_only" },
        ],
      }),
    ).toBe(true);
  });
});
