import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ErrorCode, FgaApiValidationError, OpenFgaClient } from "@openfga/sdk";
import {
  type AddTupleRequest,
  type ConditionDefinition,
  createTsfga,
  type RemoveTupleRequest,
  type TsfgaClient,
} from "@tsfga/core";
import type { DB } from "@tsfga/kysely";
import { KyselyTupleStore } from "@tsfga/kysely";
import type { Kysely } from "kysely";
import { fgaBatchCheck } from "./batch/upstream.ts";
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
 * A learning-management system: course -> section -> assignment ->
 * submission, with TA delegation and peer review.
 *
 * The seam is **peer review, which is a cycle by construction**.
 * Two submissions review each other, and `submission_d4l.can_view`
 * has a `can_view from peer_of` arm, so every check on a stranger
 * walks s1 -> s2 -> s1 and has to be truncated rather than
 * exhausted. That cycle then sits under an exclusion
 * (`can_comment: can_view but not muted`), which is the shape
 * where collapsing a cycle-truncated `false` into a plain one
 * fails *open* — the reason tsfga carries `cycleDetected` beside
 * `allowed` at all. A real LMS produces this model without anybody
 * setting out to write a cycle.
 *
 * Beside it: a **conditioned wildcard** publishing an assignment
 * at a release time (`[user_d4l:* with after_release_d4l]`), which
 * is how "visible from Monday" is actually modelled and puts a
 * condition on the one row that matches every subject; an
 * intersection of a rewrite with a TTU (`visible and can_view from
 * section`); a wildcard block closing a whole section; a
 * withdrawal at the course flowing down into the section's
 * subtrahend; and an enrolment code matched with RE2.
 */

const CONDITIONS: ConditionDefinition[] = [
  {
    name: "enrollment_code_d4l",
    expression: 'size(code) == 7 && code.startsWith("ABC-")',
    parameters: { code: "string" },
  },
  {
    name: "after_release_d4l",
    expression: "now >= release_at",
    parameters: { now: "timestamp", release_at: "timestamp" },
  },
  {
    name: "review_window_d4l",
    expression: "now >= opens_at && now < closes_at",
    parameters: {
      now: "timestamp",
      opens_at: "timestamp",
      closes_at: "timestamp",
    },
  },
];

const RELEASE_AT = "2026-03-01T00:00:00Z";
const REVIEW_WINDOW = {
  opens_at: "2026-03-05T00:00:00Z",
  closes_at: "2026-03-10T00:00:00Z",
};
const BEFORE_RELEASE = { now: "2026-02-01T00:00:00Z" };
const IN_REVIEW = { now: "2026-03-07T00:00:00Z" };
const AFTER_REVIEW = { now: "2026-03-20T00:00:00Z" };
const GOOD_CODE = { code: "ABC-123" };
const BAD_CODE = { code: "abc-123" };

const uuidMap = new Map<string, string>([
  ["tina", "00000000-0000-4000-d582-000000000001"],
  ["g_ta", "00000000-0000-4000-d582-000000000002"],
  ["prof", "00000000-0000-4000-d582-000000000003"],
  ["c1", "00000000-0000-4000-d582-000000000004"],
  ["sam", "00000000-0000-4000-d582-000000000005"],
  ["sue", "00000000-0000-4000-d582-000000000006"],
  ["sec1", "00000000-0000-4000-d582-000000000007"],
  ["zoe", "00000000-0000-4000-d582-000000000008"],
  ["sec2", "00000000-0000-4000-d582-000000000009"],
  ["a1", "00000000-0000-4000-d582-000000000010"],
  ["a2", "00000000-0000-4000-d582-000000000011"],
  ["s1", "00000000-0000-4000-d582-000000000012"],
  ["s2", "00000000-0000-4000-d582-000000000013"],
  ["s3", "00000000-0000-4000-d582-000000000014"],
  ["zed", "00000000-0000-4000-d582-000000000015"],
  ["yara", "00000000-0000-4000-d582-000000000016"],
]);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

describe("LMS Model Conformance", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let authorizationModelId: string;
  let tsfga: TsfgaClient;
  let fgaClient: OpenFgaClient;
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
        subjectType: "user_d4l",
        subjectId: uuid(subject),
        ...(extra?.context ? { context: extra.context } : {}),
        ...(extra?.contextualTuples
          ? { contextualTuples: extra.contextualTuples }
          : {}),
      },
      expected,
    );
  }

  function userRef(tuple: {
    subjectType: string;
    subjectId: string;
    subjectRelation?: string | null;
  }): string {
    return tuple.subjectRelation
      ? `${tuple.subjectType}:${tuple.subjectId}#${tuple.subjectRelation}`
      : `${tuple.subjectType}:${tuple.subjectId}`;
  }

  /** Take a row out of both engines, asserting both had it. */
  async function revoke(tuple: RemoveTupleRequest): Promise<void> {
    await Promise.all([
      tsfga.removeTuple(tuple),
      fgaClient
        .deleteTuples(
          [
            {
              user: userRef(tuple),
              relation: tuple.relation,
              object: `${tuple.objectType}:${tuple.objectId}`,
            },
          ],
          { authorizationModelId },
        )
        .then(() => "deleted")
        .catch((error: unknown) => {
          if (
            error instanceof FgaApiValidationError &&
            error.apiErrorCode === ErrorCode.WriteFailedDueToInvalidInput
          ) {
            return "missing";
          }
          throw error;
        })
        .then((outcome) => expect(outcome).toBe("deleted")),
    ]);
  }

  beforeAll(async () => {
    assertUuidMapInjective(uuidMap);
    assertUuidMapCovers("./lms/tuples.yaml", uuidMap);

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
    const person = { type: "user_d4l" } as const;
    const anyone = { type: "user_d4l", wildcard: true } as const;
    const groupMember = { type: "group_d4l", relation: "member" } as const;

    await tsfga.writeRelationConfig({
      objectType: "group_d4l",
      relation: "member",
      directlyAssignable: [person, groupMember],
      ...plain,
    });

    // --- course ---
    for (const relation of ["instructor", "ta", "student"]) {
      await tsfga.writeRelationConfig({
        objectType: "course_d4l",
        relation,
        directlyAssignable: [person, groupMember],
        ...plain,
      });
    }
    await tsfga.writeRelationConfig({
      objectType: "course_d4l",
      relation: "withdrawn",
      directlyAssignable: [person, anyone],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "course_d4l",
      relation: "staff",
      directlyAssignable: [],
      ...plain,
      impliedBy: ["instructor", "ta"],
    });
    await tsfga.writeRelationConfig({
      objectType: "course_d4l",
      relation: "participant",
      directlyAssignable: [],
      ...plain,
      impliedBy: ["staff", "student"],
      excludedBy: "withdrawn",
    });

    // --- section ---
    await tsfga.writeRelationConfig({
      objectType: "section_d4l",
      relation: "course",
      directlyAssignable: [{ type: "course_d4l" }],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "section_d4l",
      relation: "ta",
      directlyAssignable: [person],
      ...plain,
      tupleToUserset: [{ tupleset: "course", computedUserset: "ta" }],
    });
    await tsfga.writeRelationConfig({
      objectType: "section_d4l",
      relation: "student",
      directlyAssignable: [
        person,
        { type: "user_d4l", condition: "enrollment_code_d4l" },
      ],
      ...plain,
      tupleToUserset: [{ tupleset: "course", computedUserset: "student" }],
    });
    await tsfga.writeRelationConfig({
      objectType: "section_d4l",
      relation: "staff",
      directlyAssignable: [person],
      ...plain,
      tupleToUserset: [{ tupleset: "course", computedUserset: "staff" }],
    });
    await tsfga.writeRelationConfig({
      objectType: "section_d4l",
      relation: "blocked",
      directlyAssignable: [person, anyone],
      ...plain,
      tupleToUserset: [{ tupleset: "course", computedUserset: "withdrawn" }],
    });
    await tsfga.writeRelationConfig({
      objectType: "section_d4l",
      relation: "can_view",
      directlyAssignable: [],
      ...plain,
      impliedBy: ["staff", "student"],
      excludedBy: "blocked",
    });

    // --- assignment ---
    await tsfga.writeRelationConfig({
      objectType: "assignment_d4l",
      relation: "section",
      directlyAssignable: [{ type: "section_d4l" }],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "assignment_d4l",
      relation: "published",
      directlyAssignable: [
        { type: "user_d4l", wildcard: true, condition: "after_release_d4l" },
      ],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "assignment_d4l",
      relation: "conflicted",
      directlyAssignable: [person],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "assignment_d4l",
      relation: "visible",
      directlyAssignable: [],
      ...plain,
      impliedBy: ["published"],
      tupleToUserset: [{ tupleset: "section", computedUserset: "staff" }],
    });
    await tsfga.writeRelationConfig({
      objectType: "assignment_d4l",
      relation: "can_view",
      directlyAssignable: [],
      ...plain,
      intersection: [
        { type: "computedUserset", relation: "visible" },
        {
          type: "tupleToUserset",
          tupleset: "section",
          computedUserset: "can_view",
        },
      ],
    });
    await tsfga.writeRelationConfig({
      objectType: "assignment_d4l",
      relation: "can_grade",
      directlyAssignable: [],
      ...plain,
      tupleToUserset: [{ tupleset: "section", computedUserset: "ta" }],
      excludedBy: "conflicted",
    });

    // --- submission ---
    await tsfga.writeRelationConfig({
      objectType: "submission_d4l",
      relation: "assignment",
      directlyAssignable: [{ type: "assignment_d4l" }],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "submission_d4l",
      relation: "peer_of",
      directlyAssignable: [{ type: "submission_d4l" }],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "submission_d4l",
      relation: "author",
      directlyAssignable: [person],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "submission_d4l",
      relation: "peer_reviewer",
      directlyAssignable: [
        { type: "user_d4l", condition: "review_window_d4l" },
      ],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "submission_d4l",
      relation: "muted",
      directlyAssignable: [person, anyone],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "submission_d4l",
      relation: "can_view",
      directlyAssignable: [],
      ...plain,
      impliedBy: ["author", "peer_reviewer"],
      tupleToUserset: [
        { tupleset: "assignment", computedUserset: "can_grade" },
        { tupleset: "peer_of", computedUserset: "can_view" },
      ],
    });
    await tsfga.writeRelationConfig({
      objectType: "submission_d4l",
      relation: "can_comment",
      directlyAssignable: [],
      ...plain,
      computedUserset: "can_view",
      excludedBy: "muted",
    });

    // === Tuples (mirroring ./lms/tuples.yaml) ===
    const tuples: AddTupleRequest[] = [
      {
        objectType: "group_d4l",
        objectId: uuid("g_ta"),
        relation: "member",
        subjectType: "user_d4l",
        subjectId: uuid("tina"),
      },
      {
        objectType: "course_d4l",
        objectId: uuid("c1"),
        relation: "instructor",
        subjectType: "user_d4l",
        subjectId: uuid("prof"),
      },
      {
        objectType: "course_d4l",
        objectId: uuid("c1"),
        relation: "ta",
        subjectType: "group_d4l",
        subjectId: uuid("g_ta"),
        subjectRelation: "member",
      },
      {
        objectType: "course_d4l",
        objectId: uuid("c1"),
        relation: "student",
        subjectType: "user_d4l",
        subjectId: uuid("sam"),
      },
      {
        objectType: "course_d4l",
        objectId: uuid("c1"),
        relation: "student",
        subjectType: "user_d4l",
        subjectId: uuid("sue"),
      },
      {
        objectType: "course_d4l",
        objectId: uuid("c1"),
        relation: "withdrawn",
        subjectType: "user_d4l",
        subjectId: uuid("sue"),
      },
      {
        objectType: "section_d4l",
        objectId: uuid("sec1"),
        relation: "course",
        subjectType: "course_d4l",
        subjectId: uuid("c1"),
      },
      {
        objectType: "section_d4l",
        objectId: uuid("sec1"),
        relation: "student",
        subjectType: "user_d4l",
        subjectId: uuid("zoe"),
        conditionName: "enrollment_code_d4l",
      },
      {
        objectType: "section_d4l",
        objectId: uuid("sec2"),
        relation: "course",
        subjectType: "course_d4l",
        subjectId: uuid("c1"),
      },
      {
        objectType: "section_d4l",
        objectId: uuid("sec2"),
        relation: "blocked",
        subjectType: "user_d4l",
        subjectId: "*",
      },
      {
        objectType: "assignment_d4l",
        objectId: uuid("a1"),
        relation: "section",
        subjectType: "section_d4l",
        subjectId: uuid("sec1"),
      },
      {
        objectType: "assignment_d4l",
        objectId: uuid("a1"),
        relation: "published",
        subjectType: "user_d4l",
        subjectId: "*",
        conditionName: "after_release_d4l",
        conditionContext: { release_at: RELEASE_AT },
      },
      {
        objectType: "assignment_d4l",
        objectId: uuid("a2"),
        relation: "section",
        subjectType: "section_d4l",
        subjectId: uuid("sec1"),
      },
      {
        objectType: "assignment_d4l",
        objectId: uuid("a2"),
        relation: "conflicted",
        subjectType: "user_d4l",
        subjectId: uuid("tina"),
      },
      {
        objectType: "submission_d4l",
        objectId: uuid("s1"),
        relation: "assignment",
        subjectType: "assignment_d4l",
        subjectId: uuid("a1"),
      },
      {
        objectType: "submission_d4l",
        objectId: uuid("s1"),
        relation: "author",
        subjectType: "user_d4l",
        subjectId: uuid("sam"),
      },
      {
        objectType: "submission_d4l",
        objectId: uuid("s1"),
        relation: "peer_reviewer",
        subjectType: "user_d4l",
        subjectId: uuid("sue"),
        conditionName: "review_window_d4l",
        conditionContext: REVIEW_WINDOW,
      },
      {
        objectType: "submission_d4l",
        objectId: uuid("s1"),
        relation: "peer_of",
        subjectType: "submission_d4l",
        subjectId: uuid("s2"),
      },
      {
        objectType: "submission_d4l",
        objectId: uuid("s2"),
        relation: "assignment",
        subjectType: "assignment_d4l",
        subjectId: uuid("a1"),
      },
      {
        objectType: "submission_d4l",
        objectId: uuid("s2"),
        relation: "author",
        subjectType: "user_d4l",
        subjectId: uuid("zoe"),
      },
      {
        objectType: "submission_d4l",
        objectId: uuid("s2"),
        relation: "peer_of",
        subjectType: "submission_d4l",
        subjectId: uuid("s1"),
      },
      {
        objectType: "submission_d4l",
        objectId: uuid("s3"),
        relation: "assignment",
        subjectType: "assignment_d4l",
        subjectId: uuid("a2"),
      },
      {
        objectType: "submission_d4l",
        objectId: uuid("s3"),
        relation: "author",
        subjectType: "user_d4l",
        subjectId: uuid("sam"),
      },
      {
        objectType: "submission_d4l",
        objectId: uuid("s3"),
        relation: "muted",
        subjectType: "user_d4l",
        subjectId: "*",
      },
    ];
    for (const tuple of tuples) await tsfga.addTuple(tuple);

    storeId = await fgaCreateStore("lms");
    fgaClient = new OpenFgaClient({ apiUrl: process.env.FGA_API_URL, storeId });
    authorizationModelId = await fgaWriteModel(storeId, "./lms/model.dsl");
    await fgaWriteTuples(
      storeId,
      "./lms/tuples.yaml",
      authorizationModelId,
      uuidMap,
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  // --- The course roll ---

  test("1: the instructor and the TA are staff", async () => {
    await can("course_d4l", "c1", "staff", "prof", true);
    await can("course_d4l", "c1", "staff", "tina", true);
    await can("course_d4l", "c1", "participant", "tina", true);
  });

  test("2: a student is a participant, not staff", async () => {
    await can("course_d4l", "c1", "staff", "sam", false);
    await can("course_d4l", "c1", "participant", "sam", true);
  });

  test("3: a withdrawal takes the participation back", async () => {
    await can("course_d4l", "c1", "student", "sue", true);
    await can("course_d4l", "c1", "participant", "sue", false);
  });

  test("4: a stranger participates in nothing", async () => {
    await can("course_d4l", "c1", "participant", "zed", false);
  });

  // --- The section, and what the course sends down to it ---

  test("5: course staff view the section", async () => {
    await can("section_d4l", "sec1", "can_view", "prof", true);
    await can("section_d4l", "sec1", "can_view", "tina", true);
  });

  test("6: course students view it too", async () => {
    await can("section_d4l", "sec1", "can_view", "sam", true);
  });

  test("7: the withdrawal flows into the section's subtrahend", async () => {
    await can("section_d4l", "sec1", "student", "sue", true);
    await can("section_d4l", "sec1", "blocked", "sue", true);
    await can("section_d4l", "sec1", "can_view", "sue", false);
  });

  test("8: a wildcard block closes the other section to everyone", async () => {
    await can("section_d4l", "sec2", "staff", "prof", true);
    await can("section_d4l", "sec2", "can_view", "prof", false);
    await can("section_d4l", "sec2", "can_view", "sam", false);
  });

  // --- The enrolment code ---

  test("9: a section-local enrolment needs its code", async () => {
    await can("section_d4l", "sec1", "can_view", "zoe", true, {
      context: GOOD_CODE,
    });
  });

  test("10: the pattern is case-sensitive and anchored", async () => {
    await can("section_d4l", "sec1", "can_view", "zoe", false, {
      context: BAD_CODE,
    });
    await can("section_d4l", "sec1", "can_view", "zoe", false, {
      context: { code: "xABC-123x" },
    });
  });

  test("11: the length is exact", async () => {
    await can("section_d4l", "sec1", "can_view", "zoe", false, {
      context: { code: "ABCD-123" },
    });
    await can("section_d4l", "sec1", "can_view", "zoe", false, {
      context: { code: "ABC-12" },
    });
    // Added negative: the right length with the wrong prefix. The
    // size test alone would admit it, so this cell is what proves
    // both halves of the rewrite are load-bearing.
    await can("section_d4l", "sec1", "can_view", "zoe", false, {
      context: { code: "XYZ-123" },
    });
  });

  test("12: a missing code refuses rather than denying", async () => {
    await can("section_d4l", "sec1", "can_view", "zoe", "refused");
  });

  // --- The conditioned wildcard that publishes an assignment ---

  test("13: the assignment is visible from its release time", async () => {
    await can("assignment_d4l", "a1", "published", "sam", true, {
      context: IN_REVIEW,
    });
    await can("assignment_d4l", "a1", "published", "sam", false, {
      context: BEFORE_RELEASE,
    });
  });

  test("14: the wildcard publishes to a stranger as well", async () => {
    await can("assignment_d4l", "a1", "published", "zed", true, {
      context: IN_REVIEW,
    });
  });

  test("15: but the intersection still requires the section", async () => {
    await can("assignment_d4l", "a1", "can_view", "zed", false, {
      context: IN_REVIEW,
    });
    await can("assignment_d4l", "a1", "can_view", "sam", true, {
      context: IN_REVIEW,
    });
  });

  test("16: before release nobody but staff sees it", async () => {
    await can("assignment_d4l", "a1", "can_view", "sam", false, {
      context: BEFORE_RELEASE,
    });
    await can("assignment_d4l", "a1", "can_view", "prof", true, {
      context: BEFORE_RELEASE,
    });
  });

  test("17: the unpublished assignment is staff-only at any time", async () => {
    await can("assignment_d4l", "a2", "can_view", "sam", false, {
      context: IN_REVIEW,
    });
    await can("assignment_d4l", "a2", "can_view", "prof", true, {
      context: IN_REVIEW,
    });
  });

  test("18: the staff arm survives the clock the wildcard needs", async () => {
    // `visible` is `published or staff from section`. For prof the
    // staff arm answers without ever needing `now`; for sam only
    // the conditioned wildcard can answer, so the missing
    // parameter is the whole result.
    await can("assignment_d4l", "a2", "can_view", "prof", true);
    await can("assignment_d4l", "a1", "visible", "prof", true);
  });

  // --- Grading, and the conflict of interest ---

  test("19: the TA grades through the section", async () => {
    await can("assignment_d4l", "a1", "can_grade", "tina", true);
  });

  test("20: a conflict of interest cuts it for one assignment", async () => {
    await can("section_d4l", "sec1", "ta", "tina", true);
    await can("assignment_d4l", "a2", "can_grade", "tina", false);
  });

  test("21: the instructor is not a TA and does not grade", async () => {
    await can("assignment_d4l", "a1", "can_grade", "prof", false);
  });

  // --- Peer review, which is a cycle ---

  test("22: the author views her own submission", async () => {
    await can("submission_d4l", "s1", "can_view", "sam", true);
  });

  test("23: the peer reviewer views it inside the window", async () => {
    await can("submission_d4l", "s1", "can_view", "sue", true, {
      context: IN_REVIEW,
    });
    await can("submission_d4l", "s1", "can_view", "sue", false, {
      context: AFTER_REVIEW,
    });
  });

  test("24: the grader reaches it through the assignment", async () => {
    await can("submission_d4l", "s1", "can_view", "tina", true);
    await can("submission_d4l", "s3", "can_view", "tina", false);
  });

  test("25: the peer link carries each author into the other", async () => {
    await can("submission_d4l", "s1", "can_view", "zoe", true);
    await can("submission_d4l", "s2", "can_view", "sam", true);
  });

  test("26: and a stranger walks the cycle and is denied, not errored", async () => {
    await can("submission_d4l", "s1", "can_view", "zed", false);
    await can("submission_d4l", "s2", "can_view", "zed", false);
  });

  test("27: the cycle under an exclusion still denies", async () => {
    await can("submission_d4l", "s1", "can_comment", "zed", false);
    await can("submission_d4l", "s2", "can_comment", "zed", false);
  });

  test("28: a wildcard mute takes commenting from the author", async () => {
    await can("submission_d4l", "s3", "can_view", "sam", true);
    await can("submission_d4l", "s3", "can_comment", "sam", false);
  });

  test("29: and leaves the unmuted submissions alone", async () => {
    await can("submission_d4l", "s1", "can_comment", "sam", true);
    await can("submission_d4l", "s1", "can_comment", "zoe", true);
  });

  // --- Contextual tuples in every shape ---

  test("30: a bare contextual enrolment grants", async () => {
    await can("section_d4l", "sec1", "can_view", "zed", false);
    await can("section_d4l", "sec1", "can_view", "zed", true, {
      contextualTuples: [
        {
          objectType: "section_d4l",
          objectId: uuid("sec1"),
          relation: "student",
          subjectType: "user_d4l",
          subjectId: uuid("zed"),
        },
      ],
    });
  });

  test("31: a contextual userset row grants through the group", async () => {
    await can("course_d4l", "c1", "staff", "zed", false);
    await can("course_d4l", "c1", "staff", "zed", true, {
      contextualTuples: [
        {
          objectType: "group_d4l",
          objectId: uuid("g_ta"),
          relation: "member",
          subjectType: "user_d4l",
          subjectId: uuid("zed"),
        },
      ],
    });
  });

  test("32: a conditioned contextual review row answers on the clock", async () => {
    const tuple: AddTupleRequest = {
      objectType: "submission_d4l",
      objectId: uuid("s3"),
      relation: "peer_reviewer",
      subjectType: "user_d4l",
      subjectId: uuid("zed"),
      conditionName: "review_window_d4l",
      conditionContext: REVIEW_WINDOW,
    };
    await can("submission_d4l", "s3", "can_view", "zed", true, {
      context: IN_REVIEW,
      contextualTuples: [tuple],
    });
    await can("submission_d4l", "s3", "can_view", "zed", false, {
      context: AFTER_REVIEW,
      contextualTuples: [tuple],
    });
  });

  test("33: a contextual wildcard block closes a live section", async () => {
    await can("section_d4l", "sec1", "can_view", "sam", false, {
      contextualTuples: [
        {
          objectType: "section_d4l",
          objectId: uuid("sec1"),
          relation: "blocked",
          subjectType: "user_d4l",
          subjectId: "*",
        },
      ],
    });
  });

  test("34: a contextual wildcard shadowing a stored one still blocks", async () => {
    // s3 already carries `muted: user_d4l:*`; the request sends the
    // same key again. Whether the reader joins or replaces, the
    // answer must not change — and must not change differently on
    // the two engines.
    await can("submission_d4l", "s3", "can_comment", "sam", false, {
      contextualTuples: [
        {
          objectType: "submission_d4l",
          objectId: uuid("s3"),
          relation: "muted",
          subjectType: "user_d4l",
          subjectId: "*",
        },
      ],
    });
  });

  test("35: a contextual peer link extends the cycle by one hop", async () => {
    await can("submission_d4l", "s3", "can_view", "zoe", false);
    await can("submission_d4l", "s3", "can_view", "zoe", true, {
      contextualTuples: [
        {
          objectType: "submission_d4l",
          objectId: uuid("s3"),
          relation: "peer_of",
          subjectType: "submission_d4l",
          subjectId: uuid("s2"),
        },
      ],
    });
    // And the stranger still walks the longer cycle to a denial.
    await can("submission_d4l", "s3", "can_view", "zed", false, {
      contextualTuples: [
        {
          objectType: "submission_d4l",
          objectId: uuid("s3"),
          relation: "peer_of",
          subjectType: "submission_d4l",
          subjectId: uuid("s2"),
        },
      ],
    });
  });

  test("36: a contextual row the model does not admit refuses", async () => {
    await can("submission_d4l", "s1", "can_view", "zed", "refused", {
      contextualTuples: [
        {
          objectType: "submission_d4l",
          objectId: uuid("s1"),
          relation: "author",
          subjectType: "user_d4l",
          subjectId: "*",
        },
      ],
    });
  });

  // --- listObjects ---

  test("37: the submissions the TA may view", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "submission_d4l",
        relation: "can_view",
        subjectType: "user_d4l",
        subjectId: uuid("tina"),
      },
      [uuid("s1"), uuid("s2")],
    );
  });

  test("38: the submissions each author reaches through the peer link", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "submission_d4l",
        relation: "can_view",
        subjectType: "user_d4l",
        subjectId: uuid("zoe"),
      },
      [uuid("s1"), uuid("s2")],
    );
  });

  test("39: the submissions a stranger reaches, walking the cycle", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "submission_d4l",
        relation: "can_view",
        subjectType: "user_d4l",
        subjectId: uuid("zed"),
      },
      [],
    );
  });

  test("40: the assignments a student sees, by the clock", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "assignment_d4l",
        relation: "can_view",
        subjectType: "user_d4l",
        subjectId: uuid("sam"),
        context: IN_REVIEW,
      },
      [uuid("a1")],
    );
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "assignment_d4l",
        relation: "can_view",
        subjectType: "user_d4l",
        subjectId: uuid("sam"),
        context: BEFORE_RELEASE,
      },
      [],
    );
  });

  test("41: the sections zoe reaches, by her code", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "section_d4l",
        relation: "can_view",
        subjectType: "user_d4l",
        subjectId: uuid("zoe"),
        context: GOOD_CODE,
      },
      [uuid("sec1")],
    );
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "section_d4l",
        relation: "can_view",
        subjectType: "user_d4l",
        subjectId: uuid("zoe"),
        context: BAD_CODE,
      },
      [],
    );
  });

  test("42: a contextual enrolment widens the section list", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "section_d4l",
        relation: "can_view",
        subjectType: "user_d4l",
        subjectId: uuid("zed"),
        contextualTuples: [
          {
            objectType: "section_d4l",
            objectId: uuid("sec1"),
            relation: "student",
            subjectType: "user_d4l",
            subjectId: uuid("zed"),
          },
          {
            objectType: "section_d4l",
            objectId: uuid("sec2"),
            relation: "student",
            subjectType: "user_d4l",
            subjectId: uuid("zed"),
          },
        ],
      },
      [uuid("sec1")],
    );
  });

  test("43: the submissions open to comment for the author", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "submission_d4l",
        relation: "can_comment",
        subjectType: "user_d4l",
        subjectId: uuid("sam"),
      },
      [uuid("s1"), uuid("s2")],
    );
  });

  // --- checkMany over one scope ---

  test("44: a batch mixing arms, clocks and a refusal", async () => {
    const items = [
      {
        objectType: "submission_d4l",
        objectId: uuid("s1"),
        relation: "can_view",
        subjectType: "user_d4l",
        subjectId: uuid("zed"),
      },
      {
        objectType: "submission_d4l",
        objectId: uuid("s1"),
        relation: "can_view",
        subjectType: "user_d4l",
        subjectId: uuid("sue"),
        context: IN_REVIEW,
      },
      {
        objectType: "submission_d4l",
        objectId: uuid("s1"),
        relation: "can_view",
        subjectType: "user_d4l",
        subjectId: uuid("sue"),
        context: AFTER_REVIEW,
      },
      {
        objectType: "assignment_d4l",
        objectId: uuid("a1"),
        relation: "can_view",
        subjectType: "user_d4l",
        subjectId: uuid("sam"),
        context: BEFORE_RELEASE,
      },
      {
        objectType: "section_d4l",
        objectId: uuid("sec1"),
        relation: "can_view",
        subjectType: "user_d4l",
        subjectId: uuid("zoe"),
        context: GOOD_CODE,
      },
      {
        objectType: "section_d4l",
        objectId: uuid("sec1"),
        relation: "can_view",
        subjectType: "user_d4l",
        subjectId: uuid("zoe"),
      },
      {
        objectType: "submission_d4l",
        objectId: uuid("s3"),
        relation: "can_comment",
        subjectType: "user_d4l",
        subjectId: uuid("sam"),
      },
      {
        objectType: "assignment_d4l",
        objectId: uuid("a2"),
        relation: "can_grade",
        subjectType: "user_d4l",
        subjectId: uuid("tina"),
      },
    ];
    const [ours, theirs] = await Promise.all([
      tsfga.checkMany(items),
      fgaBatchCheck(storeId, authorizationModelId, items),
    ]);
    const mine = ours.map((outcome) =>
      outcome.error === undefined ? outcome.allowed : "refused",
    );
    const upstream = theirs.map((outcome) =>
      "error" in outcome ? "refused" : outcome.allowed,
    );
    expect(mine).toEqual(upstream);
    expect(mine).toEqual([
      false,
      true,
      false,
      false,
      true,
      "refused",
      false,
      false,
    ]);
  });

  // --- The write gate ---

  test("45: publishing is a conditioned wildcard, nothing else", async () => {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "assignment_d4l",
        objectId: uuid("a2"),
        relation: "published",
        subjectType: "user_d4l",
        subjectId: "*",
      },
      "refused",
    );
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "assignment_d4l",
        objectId: uuid("a2"),
        relation: "published",
        subjectType: "user_d4l",
        subjectId: uuid("zed"),
        conditionName: "after_release_d4l",
        conditionContext: { release_at: RELEASE_AT },
      },
      "refused",
    );
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "assignment_d4l",
        objectId: uuid("a2"),
        relation: "published",
        subjectType: "user_d4l",
        subjectId: "*",
        conditionName: "after_release_d4l",
        conditionContext: { release_at: RELEASE_AT },
      },
      "accepted",
    );
  });

  test("46: an enrolment may be bare or carry the code condition", async () => {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "section_d4l",
        objectId: uuid("sec1"),
        relation: "student",
        subjectType: "user_d4l",
        subjectId: uuid("yara"),
      },
      "accepted",
    );
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "section_d4l",
        objectId: uuid("sec1"),
        relation: "student",
        subjectType: "user_d4l",
        subjectId: uuid("yara"),
        conditionName: "review_window_d4l",
        conditionContext: REVIEW_WINDOW,
      },
      "refused",
    );
  });

  test("47: a peer review row must carry its window", async () => {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "submission_d4l",
        objectId: uuid("s3"),
        relation: "peer_reviewer",
        subjectType: "user_d4l",
        subjectId: uuid("yara"),
      },
      "refused",
    );
  });

  test("48: a section's course may not be a section", async () => {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "assignment_d4l",
        objectId: uuid("a2"),
        relation: "section",
        subjectType: "course_d4l",
        subjectId: uuid("c1"),
      },
      "refused",
    );
  });

  test("49: a course role may name a userset, a section role may not", async () => {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "course_d4l",
        objectId: uuid("c1"),
        relation: "student",
        subjectType: "group_d4l",
        subjectId: uuid("g_ta"),
        subjectRelation: "member",
      },
      "accepted",
    );
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "section_d4l",
        objectId: uuid("sec1"),
        relation: "ta",
        subjectType: "group_d4l",
        subjectId: uuid("g_ta"),
        subjectRelation: "member",
      },
      "refused",
    );
  });

  test("50: nothing may be written on a computed relation", async () => {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "course_d4l",
        objectId: uuid("c1"),
        relation: "participant",
        subjectType: "user_d4l",
        subjectId: uuid("yara"),
      },
      "refused",
    );
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "submission_d4l",
        objectId: uuid("s1"),
        relation: "can_comment",
        subjectType: "user_d4l",
        subjectId: uuid("yara"),
      },
      "refused",
    );
  });

  test("51: the writes just made are visible to a check", async () => {
    await can("section_d4l", "sec1", "can_view", "yara", true);
    await can("assignment_d4l", "a2", "published", "yara", true, {
      context: IN_REVIEW,
    });
    await can("course_d4l", "c1", "participant", "tina", true);
  });

  // --- Revocation ---

  test("52: revoking the withdrawal gives sue the section back", async () => {
    await revoke({
      objectType: "course_d4l",
      objectId: uuid("c1"),
      relation: "withdrawn",
      subjectType: "user_d4l",
      subjectId: uuid("sue"),
    });
    await can("course_d4l", "c1", "participant", "sue", true);
    await can("section_d4l", "sec1", "can_view", "sue", true);
  });

  test("53: revoking the peer link breaks the cycle in one direction", async () => {
    await revoke({
      objectType: "submission_d4l",
      objectId: uuid("s1"),
      relation: "peer_of",
      subjectType: "submission_d4l",
      subjectId: uuid("s2"),
    });
    await can("submission_d4l", "s1", "can_view", "zoe", false);
    await can("submission_d4l", "s2", "can_view", "sam", true);
  });

  test("54: revoking the conflict lets the TA grade again", async () => {
    await revoke({
      objectType: "assignment_d4l",
      objectId: uuid("a2"),
      relation: "conflicted",
      subjectType: "user_d4l",
      subjectId: uuid("tina"),
    });
    await can("assignment_d4l", "a2", "can_grade", "tina", true);
    await can("submission_d4l", "s3", "can_view", "tina", true);
  });

  test("55: revoking the userset edge cuts the TA off the course", async () => {
    await revoke({
      objectType: "course_d4l",
      objectId: uuid("c1"),
      relation: "ta",
      subjectType: "group_d4l",
      subjectId: uuid("g_ta"),
      subjectRelation: "member",
    });
    await can("section_d4l", "sec1", "ta", "tina", false);
    await can("assignment_d4l", "a1", "can_grade", "tina", false);
    await can("submission_d4l", "s1", "can_view", "tina", false);
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./lms/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
