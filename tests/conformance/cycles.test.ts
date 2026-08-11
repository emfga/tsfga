import { afterAll, beforeAll, describe, test } from "bun:test";
import { createTsfga, type TsfgaClient } from "@tsfga/core";
import type { DB } from "@tsfga/kysely";
import { KyselyTupleStore } from "@tsfga/kysely";
import type { Kysely } from "kysely";
import {
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
  fgaCreateStore,
  fgaWriteModel,
  fgaWriteTuples,
} from "./helpers/openfga.ts";

// Cycles in the resolution path.
//
// OpenFGA does not treat a cycle as an error. `ResolveCheck`
// errors only when the depth budget is exhausted; revisiting a
// node returns `Allowed:false` with `CycleDetected:true` and a nil
// error. tsfga used to throw DepthExceededError for both, so every
// case below except the plain union grant failed before this
// fixture existed.
//
// The flag is not merely a `false`, which is why it has to be
// carried rather than collapsed into one:
//
//   union       a cycle among losing branches keeps the `false`;
//               a granting sibling wins outright
//   intersect   a cycled operand short-circuits to deny — it could
//               not be shown to hold
//   base of     behaves like `false`
//   `but not`
//   subtract    behaves like `true` — the exclusion could not be
//   of          ruled out, so access is DENIED. Implementing "a
//   `but not`   cycle is just false" grants here: a fail-open.
//
// Two things had to be discovered against the running container
// rather than read off the Go source, and both shape this fixture.
//
// First, the cycle is built from tuples, not from the model.
// OpenFGA's typesystem rejects a relation whose rewrite is
// self-referencing through computed usersets — writing
// `define x: y` / `define y: x` to a store fails with "an
// authorization model cannot contain a cycle". The Go unit test
// that resolves such a model builds the typesystem directly and
// never runs relation validation.
//
// Second, the loop alternates two relations (member -> owner ->
// member). A loop on one self-referencing relation
// (`member: [user, group#member]`), or a looping TTU parent
// chain, is served by OpenFGA's recursive-relation resolvers,
// which walk the reachable set iteratively and return a
// definitive `false` with no cycle flag. Only shapes that fall
// through to the ordinary resolver set it. `recursive_group`
// below keeps the recursive shape in the suite for the cases
// where the two engines agree either way — see the divergence
// note in packages/core/README.md for the one case they do not.
//
// Ref: https://github.com/openfga/openfga/blob/560d5d3dd46b5adda9ecfb29efeb4f4f70c96327/internal/graph/check.go#L419
// Ref: https://github.com/openfga/openfga/blob/560d5d3dd46b5adda9ecfb29efeb4f4f70c96327/internal/graph/check.go#L358
// Ref: https://github.com/openfga/openfga/blob/560d5d3dd46b5adda9ecfb29efeb4f4f70c96327/pkg/typesystem/typesystem.go#L1448

const uuidMap = new Map<string, string>([
  ["anne", "00000000-0000-4000-c700-000000000001"],
  ["carl", "00000000-0000-4000-c700-000000000002"],
  ["dave", "00000000-0000-4000-c700-000000000003"],
  ["1", "00000000-0000-4000-c700-000000000004"],
  ["loopa", "00000000-0000-4000-c700-000000000005"],
  ["loopb", "00000000-0000-4000-c700-000000000006"],
  ["ra", "00000000-0000-4000-c700-000000000007"],
  ["rb", "00000000-0000-4000-c700-000000000008"],
]);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

describe("Cycle Conformance", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let authorizationModelId: string;
  let tsfgaClient: TsfgaClient;
  let fixture: FixtureRecord;

  async function expectCycle(
    relation: string,
    subject: string,
    expected: boolean,
  ): Promise<void> {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "document",
        objectId: uuid("1"),
        relation,
        subjectType: "user",
        subjectId: uuid(subject),
      },
      expected,
    );
  }

  beforeAll(async () => {
    db = getDb();
    await beginTransaction(db);

    const store = new KyselyTupleStore(db);
    tsfgaClient = createTsfga(store);
    fixture = recordFixture(tsfgaClient);

    // === Relation configs ===
    // The two mutually reference each other, so each admits the
    // *other's* userset — the model's cycle, and not symmetric.
    for (const [relation, other] of [
      ["member", "owner"],
      ["owner", "member"],
    ]) {
      await tsfgaClient.writeRelationConfig({
        objectType: "group",
        relation,
        directlyAssignable: ["user", `group#${other}`],
        impliedBy: null,
        computedUserset: null,
        tupleToUserset: null,
        excludedBy: null,
        intersection: null,
      });
    }
    await tsfgaClient.writeRelationConfig({
      objectType: "recursive_group",
      relation: "member",
      directlyAssignable: ["user", "recursive_group#member"],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "document",
      relation: "cyclic",
      directlyAssignable: ["group#member"],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "document",
      relation: "recursive_cyclic",
      directlyAssignable: ["recursive_group#member"],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    for (const relation of ["granted", "base", "blocked"]) {
      await tsfgaClient.writeRelationConfig({
        objectType: "document",
        relation,
        directlyAssignable: ["user"],
        impliedBy: null,
        computedUserset: null,
        tupleToUserset: null,
        excludedBy: null,
        intersection: null,
      });
    }
    await tsfgaClient.writeRelationConfig({
      objectType: "document",
      relation: "union_with_cycle",
      directlyAssignable: [],
      impliedBy: ["cyclic", "granted"],
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "document",
      relation: "subtract_cycle",
      directlyAssignable: [],
      impliedBy: ["base"],
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: "cyclic",
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "document",
      relation: "cyclic_base",
      directlyAssignable: [],
      impliedBy: ["cyclic"],
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: "blocked",
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "document",
      relation: "intersect_cycle",
      directlyAssignable: [],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: [
        { type: "computedUserset", relation: "granted" },
        { type: "computedUserset", relation: "cyclic" },
      ],
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "document",
      relation: "intersect_recursive",
      directlyAssignable: [],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: [
        { type: "computedUserset", relation: "granted" },
        { type: "computedUserset", relation: "recursive_cyclic" },
      ],
    });

    // === Tuples: the loops ===
    await tsfgaClient.addTuple({
      objectType: "document",
      objectId: uuid("1"),
      relation: "cyclic",
      subjectType: "group",
      subjectId: uuid("loopa"),
      subjectRelation: "member",
    });
    // loopa#member -> loopb#owner -> loopa#member
    await tsfgaClient.addTuple({
      objectType: "group",
      objectId: uuid("loopa"),
      relation: "member",
      subjectType: "group",
      subjectId: uuid("loopb"),
      subjectRelation: "owner",
    });
    await tsfgaClient.addTuple({
      objectType: "group",
      objectId: uuid("loopb"),
      relation: "owner",
      subjectType: "group",
      subjectId: uuid("loopa"),
      subjectRelation: "member",
    });

    // The recursive-shape loop.
    await tsfgaClient.addTuple({
      objectType: "document",
      objectId: uuid("1"),
      relation: "recursive_cyclic",
      subjectType: "recursive_group",
      subjectId: uuid("ra"),
      subjectRelation: "member",
    });
    for (const [object, subject] of [
      ["ra", "rb"],
      ["rb", "ra"],
    ] as const) {
      await tsfgaClient.addTuple({
        objectType: "recursive_group",
        objectId: uuid(object),
        relation: "member",
        subjectType: "recursive_group",
        subjectId: uuid(subject),
        subjectRelation: "member",
      });
    }

    // === Tuples: the users ===
    for (const [subject, relations] of [
      ["anne", ["granted", "base"]],
      ["carl", ["base"]],
    ] as const) {
      for (const relation of relations) {
        await tsfgaClient.addTuple({
          objectType: "document",
          objectId: uuid("1"),
          relation,
          subjectType: "user",
          subjectId: uuid(subject),
        });
      }
    }
    // carl is a real member of a looping group.
    await tsfgaClient.addTuple({
      objectType: "group",
      objectId: uuid("loopa"),
      relation: "member",
      subjectType: "user",
      subjectId: uuid("carl"),
    });

    // Setup OpenFGA
    storeId = await fgaCreateStore("cycles-conformance");
    authorizationModelId = await fgaWriteModel(storeId, "./cycles/model.dsl");
    await fgaWriteTuples(
      storeId,
      "./cycles/tuples.yaml",
      authorizationModelId,
      uuidMap,
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  test("1: a plain cycle denies rather than erroring", async () => {
    await expectCycle("cyclic", "anne", false);
  });

  test("2: a real path through the loop still resolves", async () => {
    await expectCycle("cyclic", "carl", true);
  });

  test("3: a granting sibling beats a cyclic union branch", async () => {
    await expectCycle("union_with_cycle", "anne", true);
  });

  test("4: a union of a cycle and a miss denies", async () => {
    await expectCycle("union_with_cycle", "dave", false);
  });

  test("5: a cycle on the subtract side of but-not denies", async () => {
    // The fail-open case. anne holds `base`, so the base side
    // grants; the subtract side cycles. Reading that cycle as a
    // plain `false` would mean "not excluded" and grant.
    await expectCycle("subtract_cycle", "anne", false);
  });

  test("6: a resolved subtract side still excludes normally", async () => {
    // Control for case 5: carl reaches the loop for real, so the
    // denial has an ordinary cause. Same answer, different reason.
    await expectCycle("subtract_cycle", "carl", false);
  });

  test("7: no base means but-not denies regardless of the cycle", async () => {
    await expectCycle("subtract_cycle", "dave", false);
  });

  test("8: a cycle on the base side of but-not denies", async () => {
    await expectCycle("cyclic_base", "anne", false);
  });

  test("9: a resolved base side still grants", async () => {
    await expectCycle("cyclic_base", "carl", true);
  });

  test("10: a cycled intersection operand denies", async () => {
    // anne satisfies `granted`; the `cyclic` operand cycles and so
    // cannot be shown to hold.
    await expectCycle("intersect_cycle", "anne", false);
  });

  test("11: intersection with a real cycle path is unaffected", async () => {
    // carl reaches the loop but lacks `granted`.
    await expectCycle("intersect_cycle", "carl", false);
  });

  test("12: a recursive-shape loop also denies", async () => {
    await expectCycle("recursive_cyclic", "anne", false);
  });

  test("13: a recursive-shape loop denies an intersection too", async () => {
    // Agrees whether or not the flag was set: a plain `false`
    // operand denies an intersection just as a cycled one does.
    // The subtract side of but-not is the only place the two
    // differ, and that case is the documented divergence.
    await expectCycle("intersect_recursive", "anne", false);
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./cycles/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
