import { afterAll, beforeAll, describe, test } from "bun:test";
import {
  type AddTupleRequest,
  type ConditionDefinition,
  createTsfga,
  type TsfgaClient,
} from "@tsfga/core";
import type { DB } from "@tsfga/kysely";
import { KyselyTupleStore } from "@tsfga/kysely";
import type { Kysely } from "kysely";
import {
  type CheckOutcome,
  expectConfigsMatchModel,
  expectConformance,
  expectListObjectsConformance,
  expectWriteConformance,
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
import {
  assertUuidMapCovers,
  assertUuidMapInjective,
} from "./helpers/uuid-map.ts";

/**
 * An electronic health record with consent, clearance and
 * break-glass.
 *
 * The seam this fixture exists for is **break-glass as a
 * contextual tuple**. Emergency access is not a row anybody stores
 * — storing it would make it permanent, which is the opposite of
 * what it is for — so it arrives with the request, carrying its
 * own expiry in the tuple's condition context while the request
 * supplies the clock. That puts a conditioned contextual tuple on
 * the granting side of a relation whose stored arm is a *denial*
 * (`can_view_sensitive` is `can_view but not sensitivity_locked`,
 * and `r1` is locked to `user_c3h:*`), so the emergency path has
 * to grant something no stored row can.
 *
 * Around it: consent as an exclusion whose subtrahend is a
 * department userset (`p1` opted out of research, and `drc` is a
 * researcher who is also on the care team), an integer clearance
 * threshold whose `required` half lives in the tuple and whose
 * `clearance` half lives in the request, and an emergency flag
 * gated on a facility name matched with RE2.
 */

const CONDITIONS: ConditionDefinition[] = [
  {
    name: "active_emergency_c3h",
    expression: 'emergency && facility.startsWith("ward-")',
    parameters: { emergency: "bool", facility: "string" },
  },
  {
    name: "min_clearance_c3h",
    expression: "clearance >= required",
    parameters: { clearance: "int", required: "int" },
  },
  {
    name: "break_glass_window_c3h",
    expression: "now < expires_at",
    parameters: { now: "timestamp", expires_at: "timestamp" },
  },
];

const EMERGENCY = { emergency: true, facility: "ward-3" };
const EXPIRES_AT = "2026-03-01T12:00:00Z";
const BEFORE_EXPIRY = "2026-03-01T11:00:00Z";
const AFTER_EXPIRY = "2026-03-01T13:00:00Z";

/** The break-glass grant, as it arrives with a request. */
function breakGlass(subject: string): AddTupleRequest {
  return {
    objectType: "record_c3h",
    objectId: uuid("r1"),
    relation: "break_glass",
    subjectType: "user_c3h",
    subjectId: uuid(subject),
    conditionName: "break_glass_window_c3h",
    conditionContext: { expires_at: EXPIRES_AT },
  };
}

const uuidMap = new Map<string, string>([
  ["dra", "00000000-0000-4000-d573-000000000001"],
  ["cardiology", "00000000-0000-4000-d573-000000000002"],
  ["drb", "00000000-0000-4000-d573-000000000003"],
  ["drc", "00000000-0000-4000-d573-000000000004"],
  ["research", "00000000-0000-4000-d573-000000000005"],
  ["p1", "00000000-0000-4000-d573-000000000006"],
  ["dre", "00000000-0000-4000-d573-000000000007"],
  ["p2", "00000000-0000-4000-d573-000000000008"],
  ["r1", "00000000-0000-4000-d573-000000000009"],
  ["r2", "00000000-0000-4000-d573-000000000010"],
  ["drz", "00000000-0000-4000-d573-000000000011"],
]);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

describe("EHR Model Conformance", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let authorizationModelId: string;
  let tsfga: TsfgaClient;
  let fixture: FixtureRecord;

  function can(
    objectType: string,
    objectId: string,
    relation: string,
    subject: string,
    expected: CheckOutcome,
    extra?: {
      context?: Record<string, unknown>;
      contextualTuples?: AddTupleRequest[];
    },
  ): Promise<void> {
    return expectConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType,
        objectId: uuid(objectId),
        relation,
        subjectType: "user_c3h",
        subjectId: uuid(subject),
        ...(extra?.context ? { context: extra.context } : {}),
        ...(extra?.contextualTuples
          ? { contextualTuples: extra.contextualTuples }
          : {}),
      },
      expected,
    );
  }

  beforeAll(async () => {
    assertUuidMapInjective(uuidMap);
    assertUuidMapCovers("./ehr/tuples.yaml", uuidMap);

    db = getDb();
    await beginTransaction(db);

    tsfga = createTsfga(new KyselyTupleStore(db));
    fixture = recordFixture(tsfga);

    for (const condition of CONDITIONS) {
      await tsfga.writeConditionDefinition(condition);
    }

    const plain = {
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    } as const;
    const departmentMember = {
      type: "department_c3h",
      relation: "member",
    } as const;

    await tsfga.writeRelationConfig({
      objectType: "department_c3h",
      relation: "member",
      directlyAssignable: [{ type: "user_c3h" }],
      ...plain,
    });

    await tsfga.writeRelationConfig({
      objectType: "patient_c3h",
      relation: "primary_physician",
      directlyAssignable: [{ type: "user_c3h" }],
      ...plain,
    });
    for (const relation of ["care_team", "opted_out"]) {
      await tsfga.writeRelationConfig({
        objectType: "patient_c3h",
        relation,
        directlyAssignable: [{ type: "user_c3h" }, departmentMember],
        ...plain,
      });
    }
    await tsfga.writeRelationConfig({
      objectType: "patient_c3h",
      relation: "consented_viewer",
      directlyAssignable: [],
      ...plain,
      computedUserset: "care_team",
      excludedBy: "opted_out",
    });
    await tsfga.writeRelationConfig({
      objectType: "patient_c3h",
      relation: "emergency_responder",
      directlyAssignable: [
        { type: "user_c3h", condition: "active_emergency_c3h" },
      ],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "patient_c3h",
      relation: "can_view",
      directlyAssignable: [],
      ...plain,
      impliedBy: [
        "consented_viewer",
        "primary_physician",
        "emergency_responder",
      ],
    });

    await tsfga.writeRelationConfig({
      objectType: "record_c3h",
      relation: "patient",
      directlyAssignable: [{ type: "patient_c3h" }],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "record_c3h",
      relation: "author",
      directlyAssignable: [{ type: "user_c3h" }],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "record_c3h",
      relation: "sensitivity_locked",
      directlyAssignable: [{ type: "user_c3h", wildcard: true }],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "record_c3h",
      relation: "clearance_reader",
      directlyAssignable: [
        { type: "user_c3h", condition: "min_clearance_c3h" },
      ],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "record_c3h",
      relation: "break_glass",
      directlyAssignable: [
        { type: "user_c3h", condition: "break_glass_window_c3h" },
      ],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "record_c3h",
      relation: "can_view",
      directlyAssignable: [],
      ...plain,
      impliedBy: ["author"],
      tupleToUserset: [{ tupleset: "patient", computedUserset: "can_view" }],
    });
    await tsfga.writeRelationConfig({
      objectType: "record_c3h",
      relation: "can_view_sensitive",
      directlyAssignable: [],
      ...plain,
      computedUserset: "can_view",
      excludedBy: "sensitivity_locked",
    });
    await tsfga.writeRelationConfig({
      objectType: "record_c3h",
      relation: "can_view_restricted",
      directlyAssignable: [],
      ...plain,
      impliedBy: ["can_view_sensitive", "clearance_reader", "break_glass"],
    });
    await tsfga.writeRelationConfig({
      objectType: "record_c3h",
      relation: "can_amend",
      directlyAssignable: [],
      ...plain,
      intersection: [
        { type: "computedUserset", relation: "author" },
        {
          type: "tupleToUserset",
          tupleset: "patient",
          computedUserset: "can_view",
        },
      ],
    });

    // === Tuples (mirroring ./ehr/tuples.yaml) ===
    const departments: Array<[string, string]> = [
      ["cardiology", "dra"],
      ["cardiology", "drb"],
      ["research", "drc"],
    ];
    for (const [department, user] of departments) {
      await tsfga.addTuple({
        objectType: "department_c3h",
        objectId: uuid(department),
        relation: "member",
        subjectType: "user_c3h",
        subjectId: uuid(user),
      });
    }

    await tsfga.addTuple({
      objectType: "patient_c3h",
      objectId: uuid("p1"),
      relation: "primary_physician",
      subjectType: "user_c3h",
      subjectId: uuid("dra"),
    });
    for (const patient of ["p1", "p2"]) {
      await tsfga.addTuple({
        objectType: "patient_c3h",
        objectId: uuid(patient),
        relation: "care_team",
        subjectType: "department_c3h",
        subjectId: uuid("cardiology"),
        subjectRelation: "member",
      });
    }
    await tsfga.addTuple({
      objectType: "patient_c3h",
      objectId: uuid("p1"),
      relation: "care_team",
      subjectType: "user_c3h",
      subjectId: uuid("drc"),
    });
    await tsfga.addTuple({
      objectType: "patient_c3h",
      objectId: uuid("p1"),
      relation: "opted_out",
      subjectType: "department_c3h",
      subjectId: uuid("research"),
      subjectRelation: "member",
    });
    await tsfga.addTuple({
      objectType: "patient_c3h",
      objectId: uuid("p1"),
      relation: "emergency_responder",
      subjectType: "user_c3h",
      subjectId: uuid("dre"),
      conditionName: "active_emergency_c3h",
    });
    await tsfga.addTuple({
      objectType: "patient_c3h",
      objectId: uuid("p2"),
      relation: "primary_physician",
      subjectType: "user_c3h",
      subjectId: uuid("drb"),
    });

    await tsfga.addTuple({
      objectType: "record_c3h",
      objectId: uuid("r1"),
      relation: "patient",
      subjectType: "patient_c3h",
      subjectId: uuid("p1"),
    });
    await tsfga.addTuple({
      objectType: "record_c3h",
      objectId: uuid("r1"),
      relation: "author",
      subjectType: "user_c3h",
      subjectId: uuid("dra"),
    });
    await tsfga.addTuple({
      objectType: "record_c3h",
      objectId: uuid("r1"),
      relation: "sensitivity_locked",
      subjectType: "user_c3h",
      subjectId: "*",
    });
    await tsfga.addTuple({
      objectType: "record_c3h",
      objectId: uuid("r1"),
      relation: "clearance_reader",
      subjectType: "user_c3h",
      subjectId: uuid("drc"),
      conditionName: "min_clearance_c3h",
      conditionContext: { required: 5 },
    });
    await tsfga.addTuple({
      objectType: "record_c3h",
      objectId: uuid("r2"),
      relation: "patient",
      subjectType: "patient_c3h",
      subjectId: uuid("p2"),
    });
    await tsfga.addTuple({
      objectType: "record_c3h",
      objectId: uuid("r2"),
      relation: "author",
      subjectType: "user_c3h",
      subjectId: uuid("drb"),
    });

    storeId = await fgaCreateStore("ehr");
    authorizationModelId = await fgaWriteModel(storeId, "./ehr/model.dsl");
    await fgaWriteTuples(
      storeId,
      "./ehr/tuples.yaml",
      authorizationModelId,
      uuidMap,
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  // --- Consent as an exclusion by department ---

  test("1: the cardiology care team is consented", async () => {
    await can("patient_c3h", "p1", "consented_viewer", "dra", true);
    await can("patient_c3h", "p1", "consented_viewer", "drb", true);
  });

  test("2: the researcher is on the care team", async () => {
    await can("patient_c3h", "p1", "care_team", "drc", true);
  });

  test("3: and is opted out of it", async () => {
    await can("patient_c3h", "p1", "opted_out", "drc", true);
    await can("patient_c3h", "p1", "consented_viewer", "drc", false);
  });

  test("4: the opt-out is per patient", async () => {
    await can("patient_c3h", "p2", "opted_out", "drc", false);
    await can("patient_c3h", "p2", "consented_viewer", "drc", false);
  });

  test("5: a stranger consents to nothing", async () => {
    await can("patient_c3h", "p1", "can_view", "drz", false);
  });

  // --- The emergency flag, gated on a facility name ---

  test("6: the responder sees p1 in a real emergency", async () => {
    await can("patient_c3h", "p1", "can_view", "dre", true, {
      context: EMERGENCY,
    });
  });

  test("7: and not when the emergency is over", async () => {
    await can("patient_c3h", "p1", "can_view", "dre", false, {
      context: { emergency: false, facility: "ward-3" },
    });
  });

  test("8: nor from a facility the condition does not admit", async () => {
    await can("patient_c3h", "p1", "can_view", "dre", false, {
      context: { emergency: true, facility: "lab-3" },
    });
    // Added negative: the prefix is a prefix, not a substring. The
    // condition this replaced was anchored, so a facility carrying
    // `ward-` in the middle was rejected and must stay rejected —
    // without a cell like this one a rewrite to `true` would pass.
    await can("patient_c3h", "p1", "can_view", "dre", false, {
      context: { emergency: true, facility: "annex-ward-3" },
    });
  });

  test("9: nor with the facility left out", async () => {
    await can("patient_c3h", "p1", "can_view", "dre", "refused", {
      context: { emergency: true },
    });
  });

  test("10: the responder reaches no other patient", async () => {
    await can("patient_c3h", "p2", "can_view", "dre", false, {
      context: EMERGENCY,
    });
  });

  test("11: a consented viewer needs no emergency context", async () => {
    await can("patient_c3h", "p1", "can_view", "dra", true);
  });

  // --- The record, and the seal on it ---

  test("12: the author sees the record", async () => {
    await can("record_c3h", "r1", "can_view", "dra", true);
  });

  test("13: the care team sees it through the patient", async () => {
    await can("record_c3h", "r1", "can_view", "drb", true);
  });

  test("14: the opted-out researcher does not", async () => {
    await can("record_c3h", "r1", "can_view", "drc", false);
  });

  test("15: the seal takes it back from all of them", async () => {
    await can("record_c3h", "r1", "can_view_sensitive", "dra", false);
    await can("record_c3h", "r1", "can_view_sensitive", "drb", false);
  });

  test("16: the unsealed record keeps its viewers", async () => {
    await can("record_c3h", "r2", "can_view_sensitive", "drb", true);
    await can("record_c3h", "r2", "can_view_sensitive", "dra", true);
  });

  // --- The clearance threshold, split across tuple and request ---

  test("17: enough clearance reaches the restricted record", async () => {
    await can("record_c3h", "r1", "can_view_restricted", "drc", true, {
      context: { clearance: 7 },
    });
  });

  test("18: the threshold is inclusive", async () => {
    await can("record_c3h", "r1", "can_view_restricted", "drc", true, {
      context: { clearance: 5 },
    });
  });

  test("19: and below it, nothing", async () => {
    await can("record_c3h", "r1", "can_view_restricted", "drc", false, {
      context: { clearance: 4 },
    });
  });

  test("20: a missing clearance refuses rather than denying", async () => {
    await can("record_c3h", "r1", "can_view_restricted", "drc", "refused");
  });

  test("21: clearance does not grant the ordinary view", async () => {
    await can("record_c3h", "r1", "can_view", "drc", false, {
      context: { clearance: 7 },
    });
  });

  test("22: nobody else holds a clearance row", async () => {
    await can("record_c3h", "r1", "can_view_restricted", "dra", false);
  });

  // --- Break glass, as a contextual tuple ---

  test("23: break glass reaches the sealed record", async () => {
    await can("record_c3h", "r1", "can_view_restricted", "drb", true, {
      context: { now: BEFORE_EXPIRY },
      contextualTuples: [breakGlass("drb")],
    });
  });

  test("24: an expired grant does not", async () => {
    await can("record_c3h", "r1", "can_view_restricted", "drb", false, {
      context: { now: AFTER_EXPIRY },
      contextualTuples: [breakGlass("drb")],
    });
  });

  test("25: it grants nothing to anyone else", async () => {
    await can("record_c3h", "r1", "can_view_restricted", "dra", false, {
      context: { now: BEFORE_EXPIRY },
      contextualTuples: [breakGlass("drb")],
    });
  });

  test("26: it reaches someone the seal never let in", async () => {
    // drc is opted out of p1 entirely, so no stored path reaches
    // r1 for him at all — the contextual tuple is the whole grant.
    await can("record_c3h", "r1", "can_view_restricted", "drc", true, {
      context: { now: BEFORE_EXPIRY },
      contextualTuples: [breakGlass("drc")],
    });
  });

  test("27: and does not widen the plain view", async () => {
    await can("record_c3h", "r1", "can_view_sensitive", "drb", false, {
      context: { now: BEFORE_EXPIRY },
      contextualTuples: [breakGlass("drb")],
    });
  });

  test("28: without the clock it refuses", async () => {
    await can("record_c3h", "r1", "can_view_restricted", "drb", "refused", {
      contextualTuples: [breakGlass("drb")],
    });
  });

  test("29: a contextual tuple the model does not admit is refused", async () => {
    await can("record_c3h", "r1", "can_view_restricted", "drb", "refused", {
      context: { now: BEFORE_EXPIRY },
      contextualTuples: [
        {
          objectType: "record_c3h",
          objectId: uuid("r1"),
          relation: "break_glass",
          subjectType: "department_c3h",
          subjectId: uuid("cardiology"),
          subjectRelation: "member",
          conditionName: "break_glass_window_c3h",
          conditionContext: { expires_at: EXPIRES_AT },
        },
      ],
    });
  });

  test("30: a contextual care-team row grants the ordinary view", async () => {
    await can("record_c3h", "r2", "can_view", "drz", true, {
      contextualTuples: [
        {
          objectType: "patient_c3h",
          objectId: uuid("p2"),
          relation: "care_team",
          subjectType: "user_c3h",
          subjectId: uuid("drz"),
        },
      ],
    });
  });

  test("31: and a contextual opt-out takes it away again", async () => {
    await can("record_c3h", "r2", "can_view", "drz", false, {
      contextualTuples: [
        {
          objectType: "patient_c3h",
          objectId: uuid("p2"),
          relation: "care_team",
          subjectType: "user_c3h",
          subjectId: uuid("drz"),
        },
        {
          objectType: "patient_c3h",
          objectId: uuid("p2"),
          relation: "opted_out",
          subjectType: "user_c3h",
          subjectId: uuid("drz"),
        },
      ],
    });
  });

  // --- Amending is an intersection ---

  test("32: the author amends her own record", async () => {
    await can("record_c3h", "r1", "can_amend", "dra", true);
  });

  test("33: a viewer does not", async () => {
    await can("record_c3h", "r1", "can_amend", "drb", false);
  });

  test("34: nor does an author who lost the patient view", async () => {
    await can("record_c3h", "r2", "can_amend", "drb", true);
    await can("record_c3h", "r2", "can_amend", "drz", false);
  });

  // --- listObjects ---

  test("35: the records dra may view", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "record_c3h",
        relation: "can_view",
        subjectType: "user_c3h",
        subjectId: uuid("dra"),
      },
      [uuid("r1"), uuid("r2")],
    );
  });

  test("36: the records dra may view unsealed", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "record_c3h",
        relation: "can_view_sensitive",
        subjectType: "user_c3h",
        subjectId: uuid("dra"),
      },
      [uuid("r2")],
    );
  });

  test("37: the records drc may view", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "record_c3h",
        relation: "can_view",
        subjectType: "user_c3h",
        subjectId: uuid("drc"),
      },
      [],
    );
  });

  test("38: the patients the responder may view in an emergency", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "patient_c3h",
        relation: "can_view",
        subjectType: "user_c3h",
        subjectId: uuid("dre"),
        context: EMERGENCY,
      },
      [uuid("p1")],
    );
  });

  test("39: the records break glass reaches", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "record_c3h",
        relation: "can_view_restricted",
        subjectType: "user_c3h",
        subjectId: uuid("drb"),
        context: { now: BEFORE_EXPIRY },
        contextualTuples: [breakGlass("drb")],
      },
      [uuid("r1"), uuid("r2")],
    );
  });

  // --- The write gate ---

  test("40: a break-glass row must carry its window", async () => {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "record_c3h",
        objectId: uuid("r2"),
        relation: "break_glass",
        subjectType: "user_c3h",
        subjectId: uuid("drz"),
      },
      "refused",
    );
  });

  test("41: and with it, it may be stored after all", async () => {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "record_c3h",
        objectId: uuid("r2"),
        relation: "break_glass",
        subjectType: "user_c3h",
        subjectId: uuid("drz"),
        conditionName: "break_glass_window_c3h",
        conditionContext: { expires_at: EXPIRES_AT },
      },
      "accepted",
    );
  });

  test("42: a seal is a wildcard, never a person", async () => {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "record_c3h",
        objectId: uuid("r2"),
        relation: "sensitivity_locked",
        subjectType: "user_c3h",
        subjectId: uuid("drz"),
      },
      "refused",
    );
  });

  test("43: a clearance row may not borrow another condition", async () => {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "record_c3h",
        objectId: uuid("r2"),
        relation: "clearance_reader",
        subjectType: "user_c3h",
        subjectId: uuid("drz"),
        conditionName: "break_glass_window_c3h",
      },
      "refused",
    );
  });

  test("44: an opt-out may name a department", async () => {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "patient_c3h",
        objectId: uuid("p2"),
        relation: "opted_out",
        subjectType: "department_c3h",
        subjectId: uuid("research"),
        subjectRelation: "member",
      },
      "accepted",
    );
  });

  test("45: and the stored break glass now answers on the clock", async () => {
    await can("record_c3h", "r2", "can_view_restricted", "drz", true, {
      context: { now: BEFORE_EXPIRY },
    });
    await can("record_c3h", "r2", "can_view_restricted", "drz", false, {
      context: { now: AFTER_EXPIRY },
    });
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./ehr/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
