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
  expectListObjectsConformance,
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

// A port of upstream's deep-composition matrices,
// `tests/check/complexity_three.go` and
// `tests/check/check_complexity4.go` (v1.18.2). Every `expected`
// below is upstream's own `Expectation:` value, transcribed.
//
// The model is upstream's, reduced to the relations the two
// matrices reach and suffixed `_b2`. Three and four levels of
// composition is where a resolver's shortcuts show: each stage
// walks one chain of userset / tuple-to-userset / computed hops
// and then removes exactly one edge at a time, from the leaf
// upward, so a resolver that skips a level answers differently
// from one that walks it.

const FIXTURE = "./complexity";
const MODEL = `${FIXTURE}/model.dsl`;
// Three files, not one: OpenFGA caps a write at 100 tuple keys
// and the SDK does not chunk, so the fixture is split at stage
// boundaries. Both engines load all three.
const TUPLES = [
  `${FIXTURE}/tuples.yaml`,
  `${FIXTURE}/tuples-2.yaml`,
  `${FIXTURE}/tuples-3.yaml`,
];

const U = "user_b2";
const E = "employee_b2";
const DU = "directs_user_b2";
const DE = "directs_employee_b2";
const US = "usersets_user_b2";
const TT = "ttus_b2";
const C3 = "complexity3_b2";
const C4 = "complexity4_b2";

const names = [
  // Stage A — ttu_userset_ttu
  "a1",
  "aud",
  "aut",
  "auu",
  "acu",
  "act",
  "acd",
  "acd2",
  "ainv",
  // Stage B — ttu_ttu_userset
  "b1",
  "bud",
  "buu",
  "but",
  "bct",
  "bcu",
  "bcd",
  "bcd2",
  "binv",
  // Stage C — userset_ttu_userset
  "c1",
  "cud",
  "cuu",
  "cut",
  "cct",
  "ccu",
  "ccd",
  "ccd2",
  "cinv",
  // Stage D — userset_userset_ttu
  "d1",
  "dud",
  "dut",
  "duu",
  "dcu",
  "dct",
  "dcd",
  "dcd2",
  "dinv",
  // Stage E — and_nested_complex3
  "e1",
  "emf",
  "emft",
  "ems",
  // Stage F — cycle_nested
  "fnc",
  "fcy",
  "fud",
  "finv",
  // Stage G — or_userset_mix_public_complex3
  "g1",
  "gpub",
  "gspec",
  "g2",
  "g3",
  "gdpub",
  "ginv",
  "gany",
  "gother",
  "g3inv",
  // Stage H — complexity4 userset_ttu_userset_ttu
  "hx",
  "hy",
  "hz",
  "ha",
  "hb",
  "hc",
  "hvalid",
  "hinvalid",
  "hevalid",
  "heinvalid",
  "h1",
  "h2",
  "h3",
  "h4",
  // Stage I — complexity4 ttu_ttu_ttu_userset
  "icar",
  "icarp",
  "itruck",
  "ivan",
  "ivanu",
  "ivane",
  "ivalid",
  "iinvalid",
  "ievalid",
  "ieinvalid",
  "i1",
  "i2",
  "i3",
  "i4",
  // Stage J — complexity4 userset_or_compute_complex3
  "jps1",
  "jps2",
  "jps3",
  "jps4",
  "jvalid",
  "jvalid2",
  "jinvalid",
  "jinvalid2",
  "jevalid",
  "jevalid2",
  // Stage K — complexity4 ttu_and_nested_complex3 / or_complex4
  "kpe1",
  "kpe2",
  "kpe3",
  "kpe4",
  "kpe1x",
  "kvalid",
  "kvalidcond",
  "keinvalid",
];

const uuidMap = new Map<string, string>();
for (const [i, name] of names.entries()) {
  uuidMap.set(name, `00000000-0000-4000-d490-${String(i).padStart(12, "0")}`);
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

/** `type:name` or `type:name#relation`, as the fixture spells it. */
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

describe("b2: three- and four-level compositions", () => {
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

  /** `on("complexity3_b2:a1", "ttu_userset_ttu", "user_b2:a1")` */
  function on(
    object: string,
    relation: string,
    subject: string,
    context?: Record<string, unknown>,
  ): CheckRequest {
    const target = parseRef(object);
    const who = parseRef(subject);
    return {
      objectType: target.type,
      objectId: target.id,
      relation,
      subjectType: who.type,
      subjectId: who.id,
      subjectRelation: who.relation,
      ...(context ? { context } : {}),
    };
  }

  beforeAll(async () => {
    db = getDb();
    await beginTransaction(db);

    tsfgaClient = createTsfga(new KyselyTupleStore(db));
    fixture = recordFixture(tsfgaClient);

    await tsfgaClient.writeConditionDefinition({
      name: "xcond_b2",
      expression: "x == '1'",
      parameters: { x: "string" },
    });

    const configs: RelationConfig[] = [
      // --- directs_user_b2 ---
      {
        ...EMPTY,
        objectType: DU,
        relation: "direct",
        directlyAssignable: [{ type: U }],
      },
      {
        ...EMPTY,
        objectType: DU,
        relation: "direct_cond",
        directlyAssignable: [{ type: U, condition: "xcond_b2" }],
      },
      {
        ...EMPTY,
        objectType: DU,
        relation: "direct_wild",
        directlyAssignable: [{ type: U, wildcard: true }],
      },
      {
        ...EMPTY,
        objectType: DU,
        relation: "computed",
        computedUserset: "direct",
      },
      {
        ...EMPTY,
        objectType: DU,
        relation: "computed_cond",
        computedUserset: "direct_cond",
      },
      {
        ...EMPTY,
        objectType: DU,
        relation: "or_computed",
        impliedBy: ["computed", "computed_cond", "direct_wild"],
      },
      {
        ...EMPTY,
        objectType: DU,
        relation: "tuple_cycle3",
        directlyAssignable: [
          { type: U },
          { type: C3, relation: "cycle_nested" },
        ],
      },
      {
        ...EMPTY,
        objectType: DU,
        relation: "compute_tuple_cycle3",
        computedUserset: "tuple_cycle3",
      },
      // --- directs_employee_b2 ---
      {
        ...EMPTY,
        objectType: DE,
        relation: "direct",
        directlyAssignable: [{ type: E }],
      },
      // --- usersets_user_b2 ---
      {
        ...EMPTY,
        objectType: US,
        relation: "userset",
        directlyAssignable: [
          { type: DU, relation: "direct" },
          { type: DE, relation: "direct" },
        ],
      },
      {
        ...EMPTY,
        objectType: US,
        relation: "ttu_direct_userset",
        directlyAssignable: [{ type: TT, relation: "direct_pa_direct_ch" }],
      },
      {
        ...EMPTY,
        objectType: US,
        relation: "tuple_cycle3",
        directlyAssignable: [{ type: DU, relation: "compute_tuple_cycle3" }],
      },
      {
        ...EMPTY,
        objectType: US,
        relation: "userset_mix_public",
        directlyAssignable: [
          { type: DU, relation: "direct" },
          { type: DU, wildcard: true },
          { type: U },
          { type: U, wildcard: true },
        ],
      },
      {
        ...EMPTY,
        objectType: US,
        relation: "or_userset_mix_public",
        directlyAssignable: [{ type: U }, { type: U, wildcard: true }],
        computedUserset: "userset_mix_public",
      },
      // --- ttus_b2 ---
      {
        ...EMPTY,
        objectType: TT,
        relation: "direct_parent",
        directlyAssignable: [{ type: DU }],
      },
      {
        ...EMPTY,
        objectType: TT,
        relation: "mult_parent_types",
        directlyAssignable: [{ type: DU }, { type: DE }],
      },
      {
        ...EMPTY,
        objectType: TT,
        relation: "userset_parent",
        directlyAssignable: [{ type: US }],
      },
      {
        ...EMPTY,
        objectType: TT,
        relation: "direct_pa_direct_ch",
        tupleToUserset: [
          { tupleset: "mult_parent_types", computedUserset: "direct" },
        ],
      },
      {
        ...EMPTY,
        objectType: TT,
        relation: "or_comp_from_direct_parent",
        tupleToUserset: [
          { tupleset: "direct_parent", computedUserset: "or_computed" },
        ],
      },
      {
        ...EMPTY,
        objectType: TT,
        relation: "and_ttu",
        intersection: [
          {
            type: "computedUserset",
            relation: "or_comp_from_direct_parent",
          },
          { type: "computedUserset", relation: "direct_pa_direct_ch" },
        ],
      },
      {
        ...EMPTY,
        objectType: TT,
        relation: "userset_pa_userset_ch",
        tupleToUserset: [
          { tupleset: "userset_parent", computedUserset: "userset" },
        ],
      },
      {
        ...EMPTY,
        objectType: TT,
        relation: "tuple_cycle3",
        tupleToUserset: [
          { tupleset: "userset_parent", computedUserset: "tuple_cycle3" },
        ],
      },
      // --- complexity3_b2 ---
      {
        ...EMPTY,
        objectType: C3,
        relation: "ttu_parent",
        directlyAssignable: [{ type: TT }],
      },
      {
        ...EMPTY,
        objectType: C3,
        relation: "userset_parent",
        directlyAssignable: [{ type: US }],
      },
      {
        ...EMPTY,
        objectType: C3,
        relation: "ttu_userset_ttu",
        tupleToUserset: [
          {
            tupleset: "userset_parent",
            computedUserset: "ttu_direct_userset",
          },
        ],
      },
      {
        ...EMPTY,
        objectType: C3,
        relation: "ttu_ttu_userset",
        tupleToUserset: [
          {
            tupleset: "ttu_parent",
            computedUserset: "userset_pa_userset_ch",
          },
        ],
      },
      {
        ...EMPTY,
        objectType: C3,
        relation: "userset_ttu_userset",
        directlyAssignable: [{ type: TT, relation: "userset_pa_userset_ch" }],
      },
      {
        ...EMPTY,
        objectType: C3,
        relation: "userset_userset_ttu",
        directlyAssignable: [{ type: US, relation: "ttu_direct_userset" }],
      },
      {
        ...EMPTY,
        objectType: C3,
        relation: "compute_ttu_userset_ttu",
        computedUserset: "ttu_userset_ttu",
      },
      {
        ...EMPTY,
        objectType: C3,
        relation: "compute_userset_ttu_userset",
        computedUserset: "userset_ttu_userset",
      },
      {
        ...EMPTY,
        objectType: C3,
        relation: "or_compute_complex3",
        impliedBy: ["compute_ttu_userset_ttu", "compute_userset_ttu_userset"],
      },
      {
        ...EMPTY,
        objectType: C3,
        relation: "and_nested_complex3",
        directlyAssignable: [{ type: TT, relation: "and_ttu" }],
        intersection: [
          { type: "direct" },
          {
            type: "computedUserset",
            relation: "compute_ttu_userset_ttu",
          },
        ],
      },
      {
        ...EMPTY,
        objectType: C3,
        relation: "cycle_nested",
        directlyAssignable: [{ type: TT, relation: "tuple_cycle3" }],
      },
      {
        ...EMPTY,
        objectType: C3,
        relation: "or_userset_mix_public_complex3",
        tupleToUserset: [
          {
            tupleset: "userset_parent",
            computedUserset: "or_userset_mix_public",
          },
        ],
      },
      // --- complexity4_b2 ---
      {
        ...EMPTY,
        objectType: C4,
        relation: "parent",
        directlyAssignable: [{ type: C3 }],
      },
      {
        ...EMPTY,
        objectType: C4,
        relation: "userset_ttu_userset_ttu",
        directlyAssignable: [{ type: C3, relation: "ttu_userset_ttu" }],
      },
      {
        ...EMPTY,
        objectType: C4,
        relation: "ttu_ttu_ttu_userset",
        tupleToUserset: [
          { tupleset: "parent", computedUserset: "ttu_ttu_userset" },
        ],
      },
      {
        ...EMPTY,
        objectType: C4,
        relation: "userset_or_compute_complex3",
        directlyAssignable: [{ type: C3, relation: "or_compute_complex3" }],
      },
      {
        ...EMPTY,
        objectType: C4,
        relation: "ttu_and_nested_complex3",
        tupleToUserset: [
          { tupleset: "parent", computedUserset: "and_nested_complex3" },
        ],
      },
      {
        ...EMPTY,
        objectType: C4,
        relation: "or_complex4",
        impliedBy: ["userset_or_compute_complex3", "ttu_and_nested_complex3"],
      },
    ];
    for (const config of configs) {
      await tsfgaClient.writeRelationConfig(config);
    }

    // One source for both engines: the same YAML the OpenFGA
    // fixture loads is replayed into tsfga, so the two stores
    // cannot drift.
    for (const path of TUPLES) {
      const yamlTuples = parseYaml(
        fs.readFileSync(path, "utf-8"),
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
          conditionName: tuple.condition?.name ?? null,
          conditionContext: tuple.condition?.context ?? null,
        });
      }
    }

    storeId = await fgaCreateStore("complexity");
    authorizationModelId = await fgaWriteModel(storeId, MODEL);
    for (const path of TUPLES) {
      await fgaWriteTuples(storeId, path, authorizationModelId, uuidMap);
    }
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  // === Stage A: TTU -> userset -> TTU =========================

  // The same eleven assertions hold for the relation itself, for
  // the relation that merely computes it, and for the union that
  // has it as one arm: upstream states all three, and a rewrite
  // that loses a level shows up on one of them and not the others.
  for (const relation of [
    "ttu_userset_ttu",
    "compute_ttu_userset_ttu",
    "or_compute_complex3",
  ]) {
    test(`${relation}: the whole three-level chain`, async () => {
      await check(on(`${C3}:a1`, relation, `${U}:a1`), true);
      await check(
        on(`${C3}:a1`, relation, `${TT}:a1#direct_pa_direct_ch`),
        true,
      );
      await check(on(`${C3}:a1`, relation, `${U}:ainv`), false);
    });

    test(`${relation}: one edge missing, from the leaf up`, async () => {
      // The subject sits on a chain that is cut at some level, so
      // it never reaches a1's object.
      await check(on(`${C3}:a1`, relation, `${U}:aud`), false);
      await check(on(`${C3}:a1`, relation, `${U}:aut`), false);
      await check(on(`${C3}:a1`, relation, `${U}:auu`), false);
    });

    test(`${relation}: the object's own chain is cut`, async () => {
      await check(on(`${C3}:ainv`, relation, `${U}:a1`), false);
      await check(on(`${C3}:acu`, relation, `${U}:a1`), false);
      await check(on(`${C3}:act`, relation, `${U}:a1`), false);
      await check(on(`${C3}:acd`, relation, `${U}:a1`), false);
      await check(on(`${C3}:acd2`, relation, `${U}:a1`), false);
    });
  }

  // === Stage B: TTU -> TTU -> userset =========================

  test("ttu_ttu_userset: the whole chain and its subjects", async () => {
    await check(on(`${C3}:b1`, "ttu_ttu_userset", `${U}:b1`), true);
    await check(on(`${C3}:b1`, "ttu_ttu_userset", `${DU}:b1#direct`), true);
    await check(on(`${C3}:b1`, "ttu_ttu_userset", `${U}:binv`), false);
  });

  test("ttu_ttu_userset: subject chains cut at each level", async () => {
    await check(on(`${C3}:b1`, "ttu_ttu_userset", `${U}:bud`), false);
    await check(on(`${C3}:b1`, "ttu_ttu_userset", `${U}:buu`), false);
    await check(on(`${C3}:b1`, "ttu_ttu_userset", `${U}:but`), false);
  });

  test("ttu_ttu_userset: object chains cut at each level", async () => {
    await check(on(`${C3}:binv`, "ttu_ttu_userset", `${U}:b1`), false);
    await check(on(`${C3}:bct`, "ttu_ttu_userset", `${U}:b1`), false);
    await check(on(`${C3}:bcu`, "ttu_ttu_userset", `${U}:b1`), false);
    await check(on(`${C3}:bcd`, "ttu_ttu_userset", `${U}:b1`), false);
    await check(on(`${C3}:bcd2`, "ttu_ttu_userset", `${U}:b1`), false);
  });

  // === Stage C: userset -> TTU -> userset =====================

  for (const relation of [
    "userset_ttu_userset",
    "compute_userset_ttu_userset",
    "or_compute_complex3",
  ]) {
    test(`${relation}: the whole chain and its three subjects`, async () => {
      await check(on(`${C3}:c1`, relation, `${U}:c1`), true);
      await check(
        on(`${C3}:c1`, relation, `${TT}:c1#userset_pa_userset_ch`),
        true,
      );
      await check(on(`${C3}:c1`, relation, `${DU}:c1#direct`), true);
      await check(on(`${C3}:c1`, relation, `${U}:cinv`), false);
    });

    test(`${relation}: subject chains cut at each level`, async () => {
      await check(on(`${C3}:c1`, relation, `${U}:cud`), false);
      await check(on(`${C3}:c1`, relation, `${U}:cuu`), false);
      await check(on(`${C3}:c1`, relation, `${U}:cut`), false);
    });

    test(`${relation}: object chains cut at each level`, async () => {
      await check(on(`${C3}:cinv`, relation, `${U}:c1`), false);
      await check(on(`${C3}:cct`, relation, `${U}:c1`), false);
      await check(on(`${C3}:ccu`, relation, `${U}:c1`), false);
      await check(on(`${C3}:ccd`, relation, `${U}:c1`), false);
      await check(on(`${C3}:ccd2`, relation, `${U}:c1`), false);
    });
  }

  // === Stage D: userset -> userset -> TTU =====================

  test("userset_userset_ttu: the whole chain and its subjects", async () => {
    await check(on(`${C3}:d1`, "userset_userset_ttu", `${U}:d1`), true);
    await check(
      on(`${C3}:d1`, "userset_userset_ttu", `${US}:d1#ttu_direct_userset`),
      true,
    );
    await check(
      on(`${C3}:d1`, "userset_userset_ttu", `${TT}:d1#direct_pa_direct_ch`),
      true,
    );
    await check(on(`${C3}:d1`, "userset_userset_ttu", `${U}:dinv`), false);
  });

  test("userset_userset_ttu: subject chains cut at each level", async () => {
    await check(on(`${C3}:d1`, "userset_userset_ttu", `${U}:dud`), false);
    await check(on(`${C3}:d1`, "userset_userset_ttu", `${U}:dut`), false);
    await check(on(`${C3}:d1`, "userset_userset_ttu", `${U}:duu`), false);
  });

  test("userset_userset_ttu: object chains cut at each level", async () => {
    await check(on(`${C3}:dinv`, "userset_userset_ttu", `${U}:d1`), false);
    await check(on(`${C3}:dcu`, "userset_userset_ttu", `${U}:d1`), false);
    await check(on(`${C3}:dct`, "userset_userset_ttu", `${U}:d1`), false);
    await check(on(`${C3}:dcd`, "userset_userset_ttu", `${U}:d1`), false);
    await check(on(`${C3}:dcd2`, "userset_userset_ttu", `${U}:d1`), false);
  });

  // === Stage E: an intersection whose operands are both deep ===

  test("and_nested_complex3: both operands hold", async () => {
    await check(on(`${C3}:e1`, "and_nested_complex3", `${U}:e1`), true);
  });

  test("and_nested_complex3: either operand missing denies", async () => {
    // The direct assignment is absent.
    await check(on(`${C3}:emf`, "and_nested_complex3", `${U}:e1`), false);
    // The assignment is there, but the userset it names —
    // itself an intersection two TTUs deep — does not hold.
    await check(on(`${C3}:emft`, "and_nested_complex3", `${U}:e1`), false);
    // The computed operand has nothing to walk.
    await check(on(`${C3}:ems`, "and_nested_complex3", `${U}:e1`), false);
  });

  // === Stage F: a cycle three types wide ======================

  test("cycle_nested: the user edge breaks the cycle", async () => {
    await check(on(`${C3}:fnc`, "cycle_nested", `${U}:fnc`), true);
    await check(
      on(`${C3}:fnc`, "cycle_nested", `${C3}:fnc#cycle_nested`),
      true,
    );
    await check(
      on(`${C3}:fnc`, "cycle_nested", `${TT}:fnc#tuple_cycle3`),
      true,
    );
    await check(
      on(`${C3}:fnc`, "cycle_nested", `${DU}:fnc#compute_tuple_cycle3`),
      true,
    );
  });

  test("cycle_nested: the same cycle entered from the other end", async () => {
    await check(
      on(`${DU}:fnc`, "tuple_cycle3", `${C3}:fnc#cycle_nested`),
      true,
    );
    await check(
      on(`${DU}:fnc`, "tuple_cycle3", `${TT}:fnc#tuple_cycle3`),
      true,
    );
  });

  test("cycle_nested: an unbroken cycle denies", async () => {
    await check(on(`${C3}:fnc`, "cycle_nested", `${U}:finv`), false);
    await check(on(`${C3}:finv`, "cycle_nested", `${U}:fnc`), false);
    await check(on(`${C3}:fcy`, "cycle_nested", `${U}:fnc`), false);
    await check(on(`${C3}:fud`, "cycle_nested", `${U}:fnc`), false);
  });

  // === Stage G: a TTU onto a relation mixing every subject kind ===

  test("or_userset_mix_public_complex3: userset and direct arms", async () => {
    await check(
      on(`${C3}:g1`, "or_userset_mix_public_complex3", `${DU}:g1#direct`),
      true,
    );
    await check(
      on(`${C3}:g1`, "or_userset_mix_public_complex3", `${U}:g1`),
      true,
    );
    await check(
      on(`${C3}:g1`, "or_userset_mix_public_complex3", `${DU}:ginv#direct`),
      false,
    );
    await check(
      on(`${C3}:g1`, "or_userset_mix_public_complex3", `${U}:ginv`),
      false,
    );
  });

  test("or_userset_mix_public_complex3: the wildcard arm", async () => {
    await check(
      on(`${C3}:gpub`, "or_userset_mix_public_complex3", `${U}:gany`),
      true,
    );
    await check(
      on(`${C3}:gspec`, "or_userset_mix_public_complex3", `${U}:gspec`),
      true,
    );
    await check(
      on(`${C3}:gspec`, "or_userset_mix_public_complex3", `${U}:gother`),
      false,
    );
  });

  test("or_userset_mix_public_complex3: assigned on the union itself", async () => {
    await check(
      on(`${C3}:g2`, "or_userset_mix_public_complex3", `${U}:gany`),
      true,
    );
    await check(
      on(`${C3}:g3`, "or_userset_mix_public_complex3", `${U}:g3`),
      true,
    );
    await check(
      on(`${C3}:g3`, "or_userset_mix_public_complex3", `${U}:g3inv`),
      false,
    );
    await check(
      on(`${C3}:g3inv`, "or_userset_mix_public_complex3", `${U}:g3`),
      false,
    );
  });

  test("or_userset_mix_public_complex3: a wildcard grants no userset", async () => {
    // `directs_user_b2:*` reaches the bare object...
    await check(
      on(`${C3}:gdpub`, "or_userset_mix_public_complex3", `${DU}:gany`),
      true,
    );
    // ...but never a userset on it, whichever relation is named.
    await check(
      on(`${C3}:gdpub`, "or_userset_mix_public_complex3", `${DU}:gany#direct`),
      false,
    );
    await check(
      on(
        `${C3}:gdpub`,
        "or_userset_mix_public_complex3",
        `${DU}:gany#direct_wild`,
      ),
      false,
    );
  });

  // === Stage H: complexity4 userset -> TTU -> userset -> TTU ===

  test("userset_ttu_userset_ttu: four levels, both subject types", async () => {
    await check(on(`${C4}:hx`, "userset_ttu_userset_ttu", `${U}:hvalid`), true);
    await check(
      on(`${C4}:hx`, "userset_ttu_userset_ttu", `${U}:hinvalid`),
      false,
    );
    // The employee arrives through the other type the tupleset
    // admits — the arm a reachability prune is most likely to
    // discard.
    await check(
      on(`${C4}:hx`, "userset_ttu_userset_ttu", `${E}:hevalid`),
      true,
    );
    await check(
      on(`${C4}:hx`, "userset_ttu_userset_ttu", `${E}:heinvalid`),
      false,
    );
  });

  test("userset_ttu_userset_ttu: a condition off the path is ignored", async () => {
    await check(
      on(`${C4}:hx`, "userset_ttu_userset_ttu", `${U}:hvalid`, { x: "1" }),
      true,
    );
    await check(
      on(`${C4}:hx`, "userset_ttu_userset_ttu", `${U}:hvalid`, { x: "2" }),
      true,
    );
  });

  test("userset_ttu_userset_ttu: one edge removed per level", async () => {
    for (const object of ["h1", "h2", "h3", "h4"]) {
      await check(
        on(`${C4}:${object}`, "userset_ttu_userset_ttu", `${U}:hvalid`),
        false,
      );
    }
  });

  // === Stage I: complexity4 TTU -> TTU -> TTU -> userset ======

  test("ttu_ttu_ttu_userset: four levels, both subject types", async () => {
    await check(on(`${C4}:icar`, "ttu_ttu_ttu_userset", `${U}:ivalid`), true);
    await check(
      on(`${C4}:icar`, "ttu_ttu_ttu_userset", `${U}:iinvalid`),
      false,
    );
    await check(on(`${C4}:icar`, "ttu_ttu_ttu_userset", `${E}:ievalid`), true);
    await check(
      on(`${C4}:icar`, "ttu_ttu_ttu_userset", `${E}:ieinvalid`),
      false,
    );
  });

  test("ttu_ttu_ttu_userset: a condition off the path is ignored", async () => {
    await check(
      on(`${C4}:icar`, "ttu_ttu_ttu_userset", `${U}:ivalid`, { x: "1" }),
      true,
    );
    await check(
      on(`${C4}:icar`, "ttu_ttu_ttu_userset", `${U}:ivalid`, { x: "2" }),
      true,
    );
  });

  test("ttu_ttu_ttu_userset: one edge removed per level", async () => {
    for (const object of ["i1", "i2", "i3", "i4"]) {
      await check(
        on(`${C4}:${object}`, "ttu_ttu_ttu_userset", `${U}:ivalid`),
        false,
      );
    }
  });

  // === Stage J: complexity4 over a union of two deep arms ======

  test("userset_or_compute_complex3: the first arm", async () => {
    await check(
      on(`${C4}:jps1`, "userset_or_compute_complex3", `${U}:jvalid`),
      true,
    );
    await check(
      on(`${C4}:jps1`, "userset_or_compute_complex3", `${U}:jinvalid`),
      false,
    );
    await check(
      on(`${C4}:jps1`, "userset_or_compute_complex3", `${E}:jevalid`),
      true,
    );
    await check(
      on(`${C4}:jps1`, "userset_or_compute_complex3", `${E}:jinvalid`),
      false,
    );
  });

  test("userset_or_compute_complex3: the second arm", async () => {
    await check(
      on(`${C4}:jps1`, "userset_or_compute_complex3", `${U}:jvalid2`),
      true,
    );
    await check(
      on(`${C4}:jps1`, "userset_or_compute_complex3", `${U}:jinvalid2`),
      false,
    );
    await check(
      on(`${C4}:jps1`, "userset_or_compute_complex3", `${E}:jevalid2`),
      true,
    );
    await check(
      on(`${C4}:jps1`, "userset_or_compute_complex3", `${E}:jinvalid2`),
      false,
    );
  });

  // === Stage K: complexity4 over the nested intersection =======

  test("ttu_and_nested_complex3: the one path that holds", async () => {
    await check(
      on(`${C4}:kpe1`, "ttu_and_nested_complex3", `${U}:kvalid`),
      true,
    );
    // The condition holds, but the other side of the nested
    // intersection has no row for this user.
    await check(
      on(`${C4}:kpe1`, "ttu_and_nested_complex3", `${U}:kvalidcond`, {
        x: "1",
      }),
      false,
    );
    await check(
      on(`${C4}:kpe1`, "ttu_and_nested_complex3", `${E}:keinvalid`),
      false,
    );
  });

  test("or_complex4: each arm reaches its own subject", async () => {
    await check(on(`${C4}:kpe1`, "or_complex4", `${U}:kvalid`), true);
    await check(on(`${C4}:jps1`, "or_complex4", `${U}:jvalid`), true);
    await check(on(`${C4}:jps1`, "or_complex4", `${U}:jvalid2`), true);
  });

  test("or_complex4: neither arm reaches", async () => {
    await check(on(`${C4}:kpe1`, "or_complex4", `${U}:jvalid2`), false);
    await check(on(`${C4}:jps1`, "or_complex4", `${U}:jinvalid`), false);
    await check(on(`${C4}:kpe1x`, "or_complex4", `${U}:jinvalid`), false);
  });

  // === the same compositions, asked as listObjects =============
  //
  // Upstream runs `assertListObjects` beside every one of these
  // check assertions (`tests/check/check.go`). It only asserts
  // containment; comparing the whole set is stricter, and a deep
  // composition is where a candidate pool that skips a level
  // would show up as an extra object rather than a missing one.

  async function objects(
    objectType: string,
    relation: string,
    subject: string,
    expected: readonly string[],
  ): Promise<void> {
    const who = parseRef(subject);
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType,
        relation,
        subjectType: who.type,
        subjectId: who.id,
        subjectRelation: who.relation,
      },
      expected.map((name) => uuid(name)),
    );
  }

  test("listObjects over the three-level compositions", async () => {
    await objects(C3, "ttu_userset_ttu", `${U}:a1`, ["a1"]);
    await objects(C3, "compute_ttu_userset_ttu", `${U}:a1`, ["a1"]);
    await objects(C3, "userset_ttu_userset", `${U}:c1`, ["c1"]);
    await objects(C3, "userset_userset_ttu", `${U}:d1`, ["d1"]);
    await objects(C3, "ttu_ttu_userset", `${U}:b1`, ["b1"]);
  });

  test("listObjects over the union of two deep arms", async () => {
    await objects(C3, "or_compute_complex3", `${U}:a1`, ["a1"]);
    await objects(C3, "or_compute_complex3", `${U}:c1`, ["c1"]);
    await objects(C3, "or_compute_complex3", `${U}:ainv`, []);
  });

  test("listObjects over the nested intersection", async () => {
    await objects(C3, "and_nested_complex3", `${U}:e1`, ["e1"]);
  });

  test("listObjects over the mixed-subject union", async () => {
    await objects(C3, "or_userset_mix_public_complex3", `${U}:gany`, [
      "gpub",
      "g2",
    ]);
    await objects(C3, "or_userset_mix_public_complex3", `${U}:gspec`, [
      "gspec",
      "gpub",
      "g2",
    ]);
  });

  test("listObjects over the four-level compositions", async () => {
    await objects(C4, "userset_ttu_userset_ttu", `${U}:hvalid`, ["hx"]);
    await objects(C4, "userset_ttu_userset_ttu", `${E}:hevalid`, ["hx"]);
    await objects(C4, "ttu_ttu_ttu_userset", `${U}:ivalid`, ["icar"]);
    await objects(C4, "ttu_ttu_ttu_userset", `${E}:ievalid`, ["icar"]);
    await objects(C4, "userset_or_compute_complex3", `${U}:jvalid`, ["jps1"]);
    await objects(C4, "or_complex4", `${U}:kvalid`, ["kpe1"]);
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel(MODEL, fixture, { coverage: "complete" });
  });
});
