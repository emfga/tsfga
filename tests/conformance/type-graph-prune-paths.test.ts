import { afterAll, beforeAll, describe, test } from "bun:test";
import * as fs from "node:fs";
import {
  type CheckRequest,
  createTsfga,
  type RelationConfig,
  type TsfgaClient,
} from "@tsfga/core";
import type { DB } from "@tsfga/kysely";
import { KyselyTupleStore } from "@tsfga/kysely";
import type { Kysely } from "kysely";
import { parse as parseYaml } from "yaml";
import {
  type CheckOutcome,
  expectConfigsMatchModel,
  expectConformance,
  type FixtureRecord,
  recordFixture,
} from "./helpers/conformance.ts";
import {
  beginTransaction,
  destroyDb,
  getDb,
  rollbackTransaction,
} from "./helpers/db.ts";
import {
  type FgaTupleYaml,
  fgaCreateStore,
  fgaWriteModel,
  fgaWriteTuples,
} from "./helpers/openfga.ts";

// Deliberate probes of the type-graph reachability prune
// (`packages/core/src/type-graph.ts`), which answers
// `false` before resolving a rewrite when the subject's type
// cannot reach the node. The prune is an optimisation, so its only
// failure mode that matters is denying a grant: every model here
// puts the subject's type at the end of a path that is easy to
// miss — one arm of a union, a typed wildcard, one of three types
// a tupleset admits, the userset restriction of an intersection's
// direct operand, or the far side of a mutual recursion.

const FIXTURE = "./type-graph-prune-paths";
const MODEL = `${FIXTURE}/model.dsl`;
const TUPLES = `${FIXTURE}/tuples.yaml`;

const U = "user_b2p";
const AG = "agent_b2p";
const GRP = "grp_b2p";
const AL = "alpha_b2p";
const BE = "beta_b2p";
const BOX = "box_b2p";
const GATE = "gate_b2p";

const names = [
  "al1",
  "al2",
  "be1",
  "be2",
  "be3",
  "pu1",
  "pu2",
  "pu3",
  "pu4",
  "pu5",
  "pu6",
  "pa1",
  "pa2",
  "g1",
  "g2",
  "g3",
  "g4",
  "gw",
  "ga1",
  "gaw",
  "bi1",
  "sh1",
  "cr1",
  "bx1",
  "bx2",
  "gb1",
  "gb2",
  "gb3",
  "gn1",
  "ginv",
  // Contextual-only ids: nothing is stored for these.
  "cg1",
  "cg2",
  "cg3",
  "cg4",
  "cu1",
  "cga",
  "cgb",
  "cbx",
  "cbi",
  "cpa",
];

const uuidMap = new Map<string, string>();
for (const [i, name] of names.entries()) {
  uuidMap.set(
    name,
    `00000000-0000-4000-d490-${String(500 + i).padStart(12, "0")}`,
  );
}

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

const EMPTY = {
  directlyAssignable: [],
  impliedBy: null,
  computedUserset: null,
  tupleToUserset: null,
  excludedBy: null,
  intersection: null,
} satisfies Omit<RelationConfig, "objectType" | "relation">;

function parseRef(ref: string): {
  type: string;
  id: string;
  relation: string | null;
} {
  const hash = ref.indexOf("#");
  const base = hash >= 0 ? ref.slice(0, hash) : ref;
  const relation = hash >= 0 ? ref.slice(hash + 1) : null;
  const colon = base.indexOf(":");
  const type = base.slice(0, colon);
  const name = base.slice(colon + 1);
  return { type, id: name === "*" ? "*" : uuid(name), relation };
}

describe("b2: reachability the prune could lose", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let authorizationModelId: string;
  let tsfgaClient: TsfgaClient;
  let fixture: FixtureRecord;

  async function check(
    request: CheckRequest,
    expected: CheckOutcome,
  ): Promise<void> {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      request,
      expected,
    );
  }

  function on(object: string, relation: string, subject: string): CheckRequest {
    const target = parseRef(object);
    const who = parseRef(subject);
    return {
      objectType: target.type,
      objectId: target.id,
      relation,
      subjectType: who.type,
      subjectId: who.id,
      subjectRelation: who.relation,
    };
  }

  beforeAll(async () => {
    db = getDb();
    await beginTransaction(db);

    tsfgaClient = createTsfga(new KyselyTupleStore(db));
    fixture = recordFixture(tsfgaClient);

    const configs: RelationConfig[] = [
      {
        ...EMPTY,
        objectType: GRP,
        relation: "member",
        directlyAssignable: [{ type: U }, { type: GRP, relation: "member" }],
      },
      {
        ...EMPTY,
        objectType: GRP,
        relation: "open_member",
        directlyAssignable: [{ type: U, wildcard: true }],
      },
      {
        ...EMPTY,
        objectType: GRP,
        relation: "any_member",
        impliedBy: ["member", "open_member"],
      },
      {
        ...EMPTY,
        objectType: AL,
        relation: "rel",
        directlyAssignable: [{ type: BE, relation: "rel" }],
      },
      {
        ...EMPTY,
        objectType: BE,
        relation: "rel",
        directlyAssignable: [{ type: AL, relation: "rel" }, { type: U }],
      },
      {
        ...EMPTY,
        objectType: "bin_b2p",
        relation: "keeper",
        directlyAssignable: [{ type: AG }],
      },
      {
        ...EMPTY,
        objectType: "shelf_b2p",
        relation: "keeper",
        directlyAssignable: [{ type: U }],
      },
      {
        ...EMPTY,
        objectType: "crate_b2p",
        relation: "holder",
        directlyAssignable: [{ type: U }],
      },
      {
        ...EMPTY,
        objectType: BOX,
        relation: "slot",
        directlyAssignable: [
          { type: "bin_b2p" },
          { type: "shelf_b2p" },
          { type: "crate_b2p" },
        ],
      },
      {
        ...EMPTY,
        objectType: BOX,
        relation: "reach",
        tupleToUserset: [{ tupleset: "slot", computedUserset: "keeper" }],
      },
      {
        ...EMPTY,
        objectType: GATE,
        relation: "parent",
        directlyAssignable: [{ type: GRP }],
      },
      {
        ...EMPTY,
        objectType: GATE,
        relation: "assigned",
        directlyAssignable: [{ type: U }],
      },
      {
        ...EMPTY,
        objectType: GATE,
        relation: "via_parent",
        tupleToUserset: [{ tupleset: "parent", computedUserset: "any_member" }],
      },
      {
        ...EMPTY,
        objectType: GATE,
        relation: "both",
        intersection: [
          { type: "computedUserset", relation: "assigned" },
          { type: "computedUserset", relation: "via_parent" },
        ],
      },
      {
        ...EMPTY,
        objectType: GATE,
        relation: "lifted",
        computedUserset: "both",
      },
      {
        ...EMPTY,
        objectType: GATE,
        relation: "lifted2",
        computedUserset: "lifted",
      },
      {
        ...EMPTY,
        objectType: GATE,
        relation: "narrow",
        directlyAssignable: [{ type: GRP, relation: "member" }],
        intersection: [
          { type: "direct" },
          { type: "computedUserset", relation: "via_parent" },
        ],
      },
    ];
    for (const config of configs) {
      await tsfgaClient.writeRelationConfig(config);
    }

    const yamlTuples = parseYaml(
      fs.readFileSync(TUPLES, "utf-8"),
    ) as FgaTupleYaml[];
    for (const tuple of yamlTuples) {
      const object = parseRef(tuple.object);
      const subject = parseRef(tuple.user);
      await tsfgaClient.addTuple({
        objectType: object.type,
        objectId: object.id,
        relation: tuple.relation,
        subjectType: subject.type,
        subjectId: subject.id,
        subjectRelation: subject.relation,
      });
    }

    storeId = await fgaCreateStore("type-graph-prune-paths");
    authorizationModelId = await fgaWriteModel(storeId, MODEL);
    await fgaWriteTuples(storeId, TUPLES, authorizationModelId, uuidMap);
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  // === mutual recursion: `user` enters only through beta ======

  test("mutual recursion: the far end still grants", async () => {
    await check(on(`${AL}:al1`, "rel", `${U}:pu1`), true);
    await check(on(`${AL}:al1`, "rel", `${BE}:be1#rel`), true);
    await check(on(`${BE}:be3`, "rel", `${U}:pu1`), true);
    await check(on(`${BE}:be3`, "rel", `${AL}:al1#rel`), true);
  });

  test("mutual recursion: a loop with no user on it denies", async () => {
    await check(on(`${AL}:al2`, "rel", `${U}:pu1`), false);
    await check(on(`${BE}:be2`, "rel", `${U}:pu1`), false);
  });

  test("mutual recursion: a type the component never admits", async () => {
    await check(on(`${AL}:al1`, "rel", `${AG}:pa1`), false);
    await check(on(`${BE}:be1`, "rel", `${AG}:pa1`), false);
  });

  test("mutual recursion: usersets that do not match", async () => {
    await check(on(`${BE}:be1`, "rel", `${AL}:al1#rel`), false);
    // A userset naming the very node under check holds it by
    // definition, cycle or no cycle, on both engines.
    await check(on(`${AL}:al1`, "rel", `${AL}:al1#rel`), true);
    await check(on(`${AL}:al2`, "rel", `${AL}:al2#rel`), true);
    await check(on(`${AL}:al2`, "rel", `${BE}:be2#rel`), true);
  });

  // === a TTU onto a union whose arms are a chain and a wildcard ===

  test("via_parent: four userset hops behind a TTU", async () => {
    await check(on(`${GATE}:ga1`, "via_parent", `${U}:pu2`), true);
    await check(on(`${GATE}:ga1`, "via_parent", `${U}:pu1`), false);
  });

  test("via_parent: reached only through the wildcard arm", async () => {
    // `gw` has no `member` row at all: the union's other arm is
    // the only path, and it is a typed wildcard.
    await check(on(`${GATE}:gaw`, "via_parent", `${U}:pu1`), true);
    await check(on(`${GATE}:gaw`, "via_parent", `${U}:pu4`), true);
    // The wildcard is about `user_b2p`, so it reaches no other
    // type and no userset of its own type.
    await check(on(`${GATE}:gaw`, "via_parent", `${AG}:pa1`), false);
  });

  test("via_parent: usersets along the chain", async () => {
    await check(on(`${GATE}:ga1`, "via_parent", `${GRP}:g2#member`), true);
    await check(on(`${GATE}:ga1`, "via_parent", `${GRP}:g4#member`), true);
    // `grp:g1#member` reaches `grp:g1`'s own `member` by
    // definition, so the TTU lands on a node the subject holds
    // trivially.
    await check(on(`${GATE}:ga1`, "via_parent", `${GRP}:g1#member`), true);
    await check(on(`${GATE}:gaw`, "via_parent", `${GRP}:g1#member`), false);
  });

  test("the chain itself, at each hop", async () => {
    await check(on(`${GRP}:g1`, "member", `${U}:pu2`), true);
    await check(on(`${GRP}:g2`, "member", `${U}:pu2`), true);
    await check(on(`${GRP}:g3`, "member", `${U}:pu2`), true);
    await check(on(`${GRP}:g4`, "member", `${U}:pu2`), true);
    await check(on(`${GRP}:g1`, "any_member", `${U}:pu2`), true);
    await check(on(`${GRP}:gw`, "any_member", `${U}:pu2`), true);
    await check(on(`${GRP}:gw`, "member", `${U}:pu2`), false);
  });

  // === a tupleset admitting three types ========================

  test("reach: the subject type sits on one tupleset type only", async () => {
    // `agent_b2p` reaches `box#reach` through `bin` and nothing
    // else; `user_b2p` through `shelf` and nothing else.
    await check(on(`${BOX}:bx1`, "reach", `${AG}:pa1`), true);
    await check(on(`${BOX}:bx1`, "reach", `${U}:pu3`), true);
    await check(on(`${BOX}:bx1`, "reach", `${AG}:pa2`), false);
    // pu4 holds `holder` on the crate, which is not the computed
    // relation, and the crate's type defines no `keeper` at all.
    await check(on(`${BOX}:bx1`, "reach", `${U}:pu4`), false);
  });

  test("reach: only the type with no such relation is linked", async () => {
    await check(on(`${BOX}:bx2`, "reach", `${U}:pu4`), false);
    await check(on(`${BOX}:bx2`, "reach", `${AG}:pa1`), false);
  });

  // === an intersection over a deep operand, then rewrites ======

  for (const relation of ["both", "lifted", "lifted2"]) {
    test(`${relation}: both operands hold four hops down`, async () => {
      await check(on(`${GATE}:gb1`, relation, `${U}:pu2`), true);
      // Assigned, but the group side has no parent row.
      await check(on(`${GATE}:gb2`, relation, `${U}:pu5`), false);
      // The group side holds, the assignment names someone else.
      await check(on(`${GATE}:gb3`, relation, `${U}:pu2`), false);
      await check(on(`${GATE}:gb3`, relation, `${U}:pu6`), false);
      await check(on(`${GATE}:gb1`, relation, `${AG}:pa1`), false);
    });
  }

  // === an intersection whose direct operand admits a userset ===

  test("narrow: the user type reaches only through the userset", async () => {
    // `gate#narrow` admits `grp#member` and nothing else
    // directly, so a `user_b2p` subject arrives only by descending
    // into `grp#member` — the descent an over-eager prune skips.
    await check(on(`${GATE}:gn1`, "narrow", `${U}:pu2`), true);
    await check(on(`${GATE}:gn1`, "narrow", `${U}:pu1`), false);
    await check(on(`${GATE}:gn1`, "narrow", `${AG}:pa1`), false);
  });

  test("narrow: both operands, asked about a userset", async () => {
    // g2#member is admitted by the direct operand through g1's
    // own chain, and holds `any_member` on the parent.
    await check(on(`${GATE}:gn1`, "narrow", `${GRP}:g2#member`), true);
    await check(on(`${GATE}:gn1`, "narrow", `${GRP}:g1#member`), true);
    await check(on(`${GATE}:gn1`, "narrow", `${GRP}:gw#member`), false);
  });

  // === the same chains, supplied as contextual tuples ==========
  //
  // Upstream runs its whole check matrix twice — once with the
  // stage's tuples written, once with the identical set passed as
  // `ContextualTuples` (`tests/check/check.go`, `params.contextual`
  // sets `assertion.ContextualTuples = stage.Tuples`). tsfga
  // overlays contextual tuples by wrapping the store, so a chain
  // that only resolves through rows several dispatches down is
  // where an overlay scoped to the first read would show.

  /** `ctx("grp_b2p:cg1", "member", "grp_b2p:cg2#member")` */
  function ctx(object: string, relation: string, subject: string) {
    const target = parseRef(object);
    const who = parseRef(subject);
    return {
      objectType: target.type,
      objectId: target.id,
      relation,
      subjectType: who.type,
      subjectId: who.id,
      subjectRelation: who.relation,
    };
  }

  const CONTEXTUAL_CHAIN = [
    ["gate_b2p:cga", "parent", "grp_b2p:cg1"],
    ["grp_b2p:cg1", "member", "grp_b2p:cg2#member"],
    ["grp_b2p:cg2", "member", "grp_b2p:cg3#member"],
    ["grp_b2p:cg3", "member", "grp_b2p:cg4#member"],
    ["grp_b2p:cg4", "member", "user_b2p:cu1"],
  ] as const;

  test("a four-hop chain that exists only as contextual tuples", async () => {
    const contextualTuples = CONTEXTUAL_CHAIN.map(([o, r, s]) => ctx(o, r, s));
    await check(
      { ...on(`${GATE}:cga`, "via_parent", `${U}:cu1`), contextualTuples },
      true,
    );
    await check(
      { ...on(`${GATE}:cga`, "via_parent", `${U}:pu1`), contextualTuples },
      false,
    );
    // Without them nothing resolves at all.
    await check(on(`${GATE}:cga`, "via_parent", `${U}:cu1`), false);
  });

  test("the chain is cut when its deepest contextual row is dropped", async () => {
    const contextualTuples = CONTEXTUAL_CHAIN.slice(0, 4).map(([o, r, s]) =>
      ctx(o, r, s),
    );
    await check(
      { ...on(`${GATE}:cga`, "via_parent", `${U}:cu1`), contextualTuples },
      false,
    );
  });

  test("a contextual row completes a chain whose top is stored", async () => {
    // `gate:ga1 -> grp:g1 -> g2 -> g3 -> g4` is stored; only the
    // leaf membership is contextual, four dispatches down.
    const contextualTuples = [ctx(`${GRP}:g4`, "member", `${U}:cu1`)];
    await check(
      { ...on(`${GATE}:ga1`, "via_parent", `${U}:cu1`), contextualTuples },
      true,
    );
    await check(on(`${GATE}:ga1`, "via_parent", `${U}:cu1`), false);
  });

  test("a contextual row completes a TTU onto a second type", async () => {
    const contextualTuples = [
      ctx(`${BOX}:cbx`, "slot", "bin_b2p:cbi"),
      ctx("bin_b2p:cbi", "keeper", `${AG}:cpa`),
    ];
    await check(
      { ...on(`${BOX}:cbx`, "reach", `${AG}:cpa`), contextualTuples },
      true,
    );
    await check(
      { ...on(`${BOX}:cbx`, "reach", `${U}:cu1`), contextualTuples },
      false,
    );
  });

  test("an intersection with one stored operand and one contextual", async () => {
    // gb3's parent chain is stored and grants pu2; the assignment
    // that the intersection also needs arrives contextually.
    const contextualTuples = [ctx(`${GATE}:gb3`, "assigned", `${U}:pu2`)];
    for (const relation of ["both", "lifted", "lifted2"]) {
      await check(
        { ...on(`${GATE}:gb3`, relation, `${U}:pu2`), contextualTuples },
        true,
      );
    }
    // Same row on gb2, whose parent side is missing entirely.
    await check(
      {
        ...on(`${GATE}:gb2`, "both", `${U}:pu2`),
        contextualTuples: [ctx(`${GATE}:gb2`, "assigned", `${U}:pu2`)],
      },
      false,
    );
  });

  test("a contextual row on the far side of the narrow intersection", async () => {
    const contextualTuples = [
      ctx(`${GATE}:cgb`, "narrow", `${GRP}:cg1#member`),
      ...CONTEXTUAL_CHAIN.filter(([o]) => o !== "gate_b2p:cga").map(
        ([o, r, s]) => ctx(o, r, s),
      ),
      ctx(`${GATE}:cgb`, "parent", `${GRP}:cg1`),
    ];
    await check(
      { ...on(`${GATE}:cgb`, "narrow", `${U}:cu1`), contextualTuples },
      true,
    );
    await check(
      { ...on(`${GATE}:cgb`, "narrow", `${U}:pu2`), contextualTuples },
      false,
    );
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel(MODEL, fixture, { coverage: "complete" });
  });
});
