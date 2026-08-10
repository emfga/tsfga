import { afterAll, beforeAll, describe, test } from "bun:test";
import { createTsfga, type TsfgaClient } from "@tsfga/core";
import type { DB } from "@tsfga/kysely";
import { KyselyTupleStore } from "@tsfga/kysely";
import type { Kysely } from "kysely";
import { expectConformance } from "./helpers/conformance.ts";
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

// Which operand gets to decide an intersection.
//
// An intersection denies as soon as one operand fails to hold.
// Two kinds of operand fail to hold and they are not equivalent: a
// definitive `false`, and a branch truncated by a cycle. The
// denial is the same; what differs is whether it carries the
// indeterminacy flag, and one level up that flag is the whole
// answer — on the subtract side of a `but not`, a cycle denies and
// a plain `false` does not.
//
// OpenFGA takes the *first* of the two to arrive
// (`internal/graph/check.go`, `intersection`: the outcome loop
// short-circuits on `CycleDetected || !Allowed` and propagates
// that outcome's flag). So its answer tracks which operand is
// cheaper to resolve. tsfga's combinator races the operands the
// same way and therefore lands in the same place — but only as
// long as it keeps racing. Preferring one kind of failure over the
// other, however tempting it is to call the definitive one
// "better", diverges the moment the other operand is the cheap
// one, and diverges in the fail-open direction.
//
// This fixture pins both halves of that, on a model OpenFGA
// accepts. It was written after a change that preferred the
// definitive `false` shipped on a branch, made this exact check
// answer `true` where OpenFGA answers `false`, and was caught only
// because it was probed against the running container.
//
// Two constraints are inherited from the `cycles` fixture and are
// load-bearing here too: the cycle has to come from tuples,
// because OpenFGA's typesystem rejects a model-level one; and it
// has to alternate two relations, because a single
// self-referencing relation is served by the recursive resolver,
// which returns a definitive `false` and never sets the flag.
//
// The race is decided by a deliberate cost asymmetry: `chain9` is
// nine sequential tuple-to-userset dispatches, `cyclic` is three
// reads. That gap is what makes the cycle win reproducibly on both
// systems rather than sometimes.
//
// Ref: https://github.com/openfga/openfga/blob/560d5d3dd46b5adda9ecfb29efeb4f4f70c96327/internal/graph/check.go#L277

const uuidMap = new Map<string, string>([
  ["anne", "00000000-0000-4000-c800-000000000001"],
  ["loopa", "00000000-0000-4000-c800-000000000002"],
  ["loopb", "00000000-0000-4000-c800-000000000003"],
  ...Array.from({ length: 11 }, (_, i): [string, string] => [
    `${i + 1}`,
    `00000000-0000-4000-c800-0000000001${String(i + 1).padStart(2, "0")}`,
  ]),
]);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

const CHAIN_LENGTH = 9;

describe("Intersection Cycle Precedence Conformance", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let authorizationModelId: string;
  let tsfgaClient: TsfgaClient;

  async function expectCheck(
    relation: string,
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
        subjectId: uuid("anne"),
      },
      expected,
    );
  }

  beforeAll(async () => {
    db = getDb();
    await beginTransaction(db);

    const store = new KyselyTupleStore(db);
    tsfgaClient = createTsfga(store);

    const base = {
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    } as const;

    await tsfgaClient.writeConditionDefinition({
      name: "valid_ip",
      expression: 'user_ip == "192.168.0.1"',
      parameters: { user_ip: "string" },
    });

    // === group: the two-relation loop ===
    for (const relation of ["member", "owner"]) {
      await tsfgaClient.writeRelationConfig({
        ...base,
        objectType: "group",
        relation,
        directlyAssignableTypes: ["user", "group"],
        allowsUsersetSubjects: true,
      });
    }

    // === document ===
    await tsfgaClient.writeRelationConfig({
      ...base,
      objectType: "document",
      relation: "parent",
      directlyAssignableTypes: ["document"],
      allowsUsersetSubjects: false,
    });
    for (const relation of ["base", "chain0"]) {
      await tsfgaClient.writeRelationConfig({
        ...base,
        objectType: "document",
        relation,
        directlyAssignableTypes: ["user"],
        allowsUsersetSubjects: false,
      });
    }
    await tsfgaClient.writeRelationConfig({
      ...base,
      objectType: "document",
      relation: "conditioned",
      directlyAssignableTypes: ["user"],
      allowsUsersetSubjects: false,
    });
    await tsfgaClient.writeRelationConfig({
      ...base,
      objectType: "document",
      relation: "cyclic",
      directlyAssignableTypes: ["group"],
      allowsUsersetSubjects: true,
    });
    // The slow operand: nine sequential TTU hops that find nothing.
    for (let k = 1; k <= CHAIN_LENGTH; k++) {
      await tsfgaClient.writeRelationConfig({
        ...base,
        objectType: "document",
        relation: `chain${k}`,
        directlyAssignableTypes: null,
        tupleToUserset: [
          { tupleset: "parent", computedUserset: `chain${k - 1}` },
        ],
        allowsUsersetSubjects: false,
      });
    }
    await tsfgaClient.writeRelationConfig({
      ...base,
      objectType: "document",
      relation: "slow_and_cycle",
      directlyAssignableTypes: null,
      intersection: [
        { type: "computedUserset", relation: `chain${CHAIN_LENGTH}` },
        { type: "computedUserset", relation: "cyclic" },
      ],
      allowsUsersetSubjects: false,
    });
    await tsfgaClient.writeRelationConfig({
      ...base,
      objectType: "document",
      relation: "blocked",
      directlyAssignableTypes: null,
      impliedBy: ["slow_and_cycle"],
      allowsUsersetSubjects: false,
    });
    await tsfgaClient.writeRelationConfig({
      ...base,
      objectType: "document",
      relation: "guarded",
      directlyAssignableTypes: null,
      impliedBy: ["base"],
      excludedBy: "blocked",
      allowsUsersetSubjects: false,
    });
    await tsfgaClient.writeRelationConfig({
      ...base,
      objectType: "document",
      relation: "errored_and_cycle",
      directlyAssignableTypes: null,
      intersection: [
        { type: "computedUserset", relation: "conditioned" },
        { type: "computedUserset", relation: "cyclic" },
      ],
      allowsUsersetSubjects: false,
    });

    // === Tuples ===
    await tsfgaClient.addTuple({
      objectType: "document",
      objectId: uuid("1"),
      relation: "cyclic",
      subjectType: "group",
      subjectId: uuid("loopa"),
      subjectRelation: "member",
    });
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

    // The parent chain the slow operand walks. No `chain0` tuple
    // exists anywhere on it, so `chain9` is definitively false.
    for (let k = 1; k <= 10; k++) {
      await tsfgaClient.addTuple({
        objectType: "document",
        objectId: uuid(`${k}`),
        relation: "parent",
        subjectType: "document",
        subjectId: uuid(`${k + 1}`),
      });
    }

    await tsfgaClient.addTuple({
      objectType: "document",
      objectId: uuid("1"),
      relation: "base",
      subjectType: "user",
      subjectId: uuid("anne"),
    });
    // No stored context, and the checks below send none, so
    // evaluating this condition fails.
    await tsfgaClient.addTuple({
      objectType: "document",
      objectId: uuid("1"),
      relation: "conditioned",
      subjectType: "user",
      subjectId: uuid("anne"),
      conditionName: "valid_ip",
    });

    storeId = await fgaCreateStore("intersection-cycle-precedence");
    authorizationModelId = await fgaWriteModel(
      storeId,
      "./intersection-cycle-precedence/model.dsl",
    );
    await fgaWriteTuples(
      storeId,
      "./intersection-cycle-precedence/tuples.yaml",
      authorizationModelId,
      uuidMap,
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  test("1: the slow operand is definitively false on its own", async () => {
    // Control. Nothing on the parent chain holds `chain0`, and the
    // walk terminates rather than erroring, so this is an ordinary
    // denial with no indeterminacy anywhere in it.
    await expectCheck(`chain${CHAIN_LENGTH}`, false);
  });

  test("2: the cycle operand denies on its own", async () => {
    // Control. Same denial, different kind: the subtree looped
    // back on itself and was truncated.
    await expectCheck("cyclic", false);
  });

  test("3: the intersection of the two denies", async () => {
    // Control. Whichever operand decides, an intersection missing
    // one operand denies. The flag is invisible from here — which
    // is exactly why the next case is needed.
    await expectCheck("slow_and_cycle", false);
  });

  test("4: the cheaper operand's cycle survives into the subtraction", async () => {
    // The case that matters, and the only place the two denials
    // are distinguishable. `base` grants, so `guarded` hinges
    // entirely on what `blocked` carries: a cycle-flagged denial
    // means the exclusion could not be ruled out and access is
    // denied; a plain `false` means nothing is excluded and access
    // is granted.
    //
    // The cycle operand is three reads and the definitive one is
    // nine dispatches, so the cycle arrives first and OpenFGA
    // propagates its flag. Answering `true` here means the
    // intersection preferred the definitive `false` over the
    // cheaper cycle — a divergence, and a fail-open one.
    await expectCheck("guarded", false);
  });

  test("5: an errored operand does not outrank a cycled one", async () => {
    // `conditioned` raises a condition-evaluation error (the tuple
    // stores no context and the check sends none); `cyclic` is
    // truncated. Upstream records the error, keeps reading
    // outcomes, and short-circuits `false` on the cycle — so an
    // error alongside a cycle is a denial, not a failure. Letting
    // the error win instead turns a deny into a thrown error and
    // fails this check rather than answering it.
    await expectCheck("errored_and_cycle", false);
  });
});
