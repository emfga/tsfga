import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type AddTupleRequest,
  createTsfga,
  type TsfgaClient,
  TsfgaError,
} from "@tsfga/core";
import type { DB } from "@tsfga/kysely";
import { KyselyTupleStore } from "@tsfga/kysely";
import type { Kysely } from "kysely";
import {
  expectConfigsMatchModel,
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
  fgaWriteOutcome,
} from "./helpers/openfga.ts";

/**
 * The write gate, probed dimension by dimension.
 *
 * OpenFGA validates a write in a fixed order —
 * `ValidateUser` / `ValidateObject` / `ValidateRelation`, then the
 * tupleset restrictions, then the type restrictions, then the
 * condition, then `validateNotImplicit`, then the context byte
 * limit — and each stage has its own refusal. Only the *outcome*
 * is asserted here: whether the row may exist at all.
 *
 * Ref: internal/validation/validation.go,
 *      pkg/server/commands/write.go (v1.18.2)
 */

const uuidMap = new Map<string, string>([
  ["alice", "00000000-0000-4000-d420-000000000001"],
  ["team1", "00000000-0000-4000-d420-000000000002"],
  ["folder1", "00000000-0000-4000-d420-000000000003"],
  ["doc2", "00000000-0000-4000-d420-000000000004"],
]);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

/**
 * A Unicode control character, written as an escape so it survives
 * a copy-paste and shows up in a diff.
 */
const BACKSPACE = String.fromCharCode(8);

/**
 * Each case writes its own object, so an accepted write can never
 * collide with a later one and be reported as a duplicate.
 */
let nextObject = 0;
function objectId(): string {
  nextObject++;
  return `00000000-0000-4000-d420-1${String(nextObject).padStart(11, "0")}`;
}

describe("Write Gate Conformance", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let authorizationModelId: string;
  let tsfgaClient: TsfgaClient;
  let fixture: FixtureRecord;

  beforeAll(async () => {
    db = getDb();
    await beginTransaction(db);

    const store = new KyselyTupleStore(db);
    tsfgaClient = createTsfga(store);
    fixture = recordFixture(tsfgaClient);

    await tsfgaClient.writeConditionDefinition({
      name: "cond_a3",
      expression: "n > 5",
      parameters: { n: "int" },
    });
    await tsfgaClient.writeConditionDefinition({
      name: "other_a3",
      expression: "n > 1",
      parameters: { n: "int" },
    });
    await tsfgaClient.writeConditionDefinition({
      name: "bigstring_a3",
      expression: 's != ""',
      parameters: { s: "string" },
    });

    const plain = {
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    } as const;

    await tsfgaClient.writeRelationConfig({
      objectType: "team_a3",
      relation: "member",
      directlyAssignable: [{ type: "user_a3" }],
      ...plain,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "team_a3",
      relation: "secret",
      directlyAssignable: [{ type: "user_a3" }],
      ...plain,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "folder_a3",
      relation: "viewer",
      directlyAssignable: [{ type: "user_a3" }],
      ...plain,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "doc_a3",
      relation: "parent",
      directlyAssignable: [{ type: "folder_a3" }],
      ...plain,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "doc_a3",
      relation: "bare",
      directlyAssignable: [{ type: "user_a3" }],
      ...plain,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "doc_a3",
      relation: "cond_only",
      directlyAssignable: [{ type: "user_a3", condition: "cond_a3" }],
      ...plain,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "doc_a3",
      relation: "other_cond",
      directlyAssignable: [{ type: "user_a3", condition: "other_a3" }],
      ...plain,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "doc_a3",
      relation: "both",
      directlyAssignable: [
        { type: "user_a3" },
        { type: "user_a3", condition: "cond_a3" },
      ],
      ...plain,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "doc_a3",
      relation: "userset_only",
      directlyAssignable: [{ type: "team_a3", relation: "member" }],
      ...plain,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "doc_a3",
      relation: "wildcard_only",
      directlyAssignable: [{ type: "user_a3", wildcard: true }],
      ...plain,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "doc_a3",
      relation: "wildcard_cond",
      directlyAssignable: [
        { type: "user_a3", wildcard: true, condition: "cond_a3" },
      ],
      ...plain,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "doc_a3",
      relation: "big",
      directlyAssignable: [{ type: "user_a3", condition: "bigstring_a3" }],
      ...plain,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "doc_a3",
      relation: "computed",
      directlyAssignable: [],
      ...plain,
      computedUserset: "bare",
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "doc_a3",
      relation: "from_parent",
      directlyAssignable: [],
      ...plain,
      tupleToUserset: [{ tupleset: "parent", computedUserset: "viewer" }],
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "doc_a3",
      relation: "self_a",
      directlyAssignable: [
        { type: "doc_a3", relation: "self_a" },
        { type: "doc_a3", relation: "self_b" },
      ],
      ...plain,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "doc_a3",
      relation: "self_b",
      directlyAssignable: [
        { type: "user_a3" },
        { type: "doc_a3", relation: "self_a" },
      ],
      ...plain,
    });

    storeId = await fgaCreateStore("write-gate-conformance");
    authorizationModelId = await fgaWriteModel(
      storeId,
      "./write-gate/model.dsl",
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  function tuple(overrides: Partial<AddTupleRequest>): AddTupleRequest {
    return {
      objectType: "doc_a3",
      objectId: objectId(),
      relation: "bare",
      subjectType: "user_a3",
      subjectId: uuid("alice"),
      ...overrides,
    };
  }

  async function expectWrite(
    overrides: Partial<AddTupleRequest>,
    expected: "accepted" | "refused",
  ): Promise<void> {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      tuple(overrides),
      expected,
    );
  }

  /** What each engine did, for the shapes where they disagree. */
  async function bothSides(
    overrides: Partial<AddTupleRequest>,
  ): Promise<{ tsfga: string; openfga: string }> {
    const row = tuple(overrides);
    const [tsfgaOutcome, openFgaOutcome] = await Promise.all([
      tsfgaClient
        .addTuple(row)
        .then(() => "accepted")
        .catch((error: unknown) => {
          if (error instanceof TsfgaError) return "refused";
          throw error;
        }),
      fgaWriteOutcome(storeId, authorizationModelId, row).then((outcome) =>
        outcome === "accepted" ? "accepted" : "refused",
      ),
    ]);
    return { tsfga: tsfgaOutcome, openfga: openFgaOutcome };
  }

  describe("type restrictions", () => {
    test("an admitted concrete subject is written", async () => {
      await expectWrite({}, "accepted");
    });

    test("a subject type the relation does not admit", async () => {
      await expectWrite({ subjectType: "team_a3" }, "refused");
    });

    test("a userset where only a concrete subject is admitted", async () => {
      await expectWrite(
        {
          subjectType: "team_a3",
          subjectId: uuid("team1"),
          subjectRelation: "member",
        },
        "refused",
      );
    });

    test("an admitted userset is written", async () => {
      await expectWrite(
        {
          relation: "userset_only",
          subjectType: "team_a3",
          subjectId: uuid("team1"),
          subjectRelation: "member",
        },
        "accepted",
      );
    });

    test("a concrete subject where only a userset is admitted", async () => {
      await expectWrite(
        {
          relation: "userset_only",
          subjectType: "team_a3",
          subjectId: uuid("team1"),
        },
        "refused",
      );
    });

    test("a userset naming a relation the subject type lacks", async () => {
      await expectWrite(
        {
          relation: "userset_only",
          subjectType: "team_a3",
          subjectId: uuid("team1"),
          subjectRelation: "ghost",
        },
        "refused",
      );
    });

    test("a userset naming a relation that is not admitted", async () => {
      // `team_a3#secret` exists; `userset_only` admits only
      // `team_a3#member`.
      await expectWrite(
        {
          relation: "userset_only",
          subjectType: "team_a3",
          subjectId: uuid("team1"),
          subjectRelation: "secret",
        },
        "refused",
      );
    });

    test("a relation with no direct assignment refuses every write", async () => {
      await expectWrite({ relation: "computed" }, "refused");
    });

    test("a tuple-to-userset relation refuses every write", async () => {
      await expectWrite({ relation: "from_parent" }, "refused");
    });

    test("a relation the model does not define", async () => {
      await expectWrite({ relation: "ghost" }, "refused");
    });

    test("an object type the model does not define", async () => {
      await expectWrite({ objectType: "ghost_a3" }, "refused");
    });
  });

  describe("wildcards", () => {
    test("an admitted wildcard is written", async () => {
      await expectWrite(
        { relation: "wildcard_only", subjectId: "*" },
        "accepted",
      );
    });

    test("a wildcard where only the bare type is admitted", async () => {
      await expectWrite({ subjectId: "*" }, "refused");
    });

    test("a bare subject where only the wildcard is admitted", async () => {
      await expectWrite({ relation: "wildcard_only" }, "refused");
    });

    test("a conditioned wildcard the relation admits", async () => {
      await expectWrite(
        {
          relation: "wildcard_cond",
          subjectId: "*",
          conditionName: "cond_a3",
          conditionContext: { n: 9 },
        },
        "accepted",
      );
    });

    test("a wildcard missing the condition the restriction names", async () => {
      await expectWrite(
        { relation: "wildcard_cond", subjectId: "*" },
        "refused",
      );
    });

    test("a concrete subject under a wildcard-only condition", async () => {
      // The condition is bound to the wildcard facet, so it does
      // not admit `user_a3:alice with cond_a3`.
      await expectWrite(
        {
          relation: "wildcard_cond",
          conditionName: "cond_a3",
          conditionContext: { n: 9 },
        },
        "refused",
      );
    });

    test("a wildcard subject carrying a subject relation", async () => {
      // `team_a3:*#member` is not a well-formed user upstream:
      // `IsValidUserset` rejects a `*` id, and `IsValidObject`
      // rejects the `#`, so `ValidateUser` refuses the write.
      //
      // tsfga refuses it too, at three independent layers. The
      // core write gate refuses it as a malformed subject, because
      // a wildcard is a subject shape and not an id, so one
      // carrying a subject relation is a row no legal model has.
      // `clampToQuery` drops the same shape on the read side, so a
      // store that held one anyway could not make it grant. And
      // migration 006's `tuples_wildcard_shape` forbids it at the
      // column level: the wildcard lives in `subject_wildcard`
      // with `subject_id` NULL, and no id value is reserved for
      // it.
      const sides = await bothSides({
        relation: "userset_only",
        subjectType: "team_a3",
        subjectId: "*",
        subjectRelation: "member",
      });
      expect(sides.openfga).toBe("refused");
      expect(sides.tsfga).toBe("refused");
    });
  });

  describe("conditions", () => {
    test("an unconditioned tuple where the bare ref is admitted", async () => {
      await expectWrite({ relation: "both" }, "accepted");
    });

    test("a conditioned tuple naming an admitted condition", async () => {
      await expectWrite(
        {
          relation: "cond_only",
          conditionName: "cond_a3",
          conditionContext: { n: 9 },
        },
        "accepted",
      );
    });

    test("the condition omitted where the restriction requires one", async () => {
      await expectWrite({ relation: "cond_only" }, "refused");
    });

    test("a condition where the restriction names none", async () => {
      await expectWrite(
        {
          relation: "bare",
          conditionName: "cond_a3",
          conditionContext: { n: 9 },
        },
        "refused",
      );
    });

    test("a different, defined condition", async () => {
      await expectWrite(
        {
          relation: "cond_only",
          conditionName: "other_a3",
          conditionContext: { n: 9 },
        },
        "refused",
      );
    });

    test("a condition name the model does not define", async () => {
      await expectWrite(
        { relation: "cond_only", conditionName: "ghost_a3" },
        "refused",
      );
    });

    test("a context value that cannot be coerced", async () => {
      await expectWrite(
        {
          relation: "cond_only",
          conditionName: "cond_a3",
          conditionContext: { n: "not-a-number" },
        },
        "refused",
      );
    });

    test("a context key the condition does not declare", async () => {
      await expectWrite(
        {
          relation: "cond_only",
          conditionName: "cond_a3",
          conditionContext: { n: 9, stray: 1 },
        },
        "refused",
      );
    });

    test("a condition context over the byte limit", async () => {
      // `OPENFGA_WRITE_CONTEXT_BYTE_LIMIT` defaults to 32KB and is
      // enforced on the write, after validation
      // (pkg/server/commands/write.go). tsfga enforces no limit, so
      // it stores a row upstream would never have accepted.
      const sides = await bothSides({
        relation: "big",
        conditionName: "bigstring_a3",
        conditionContext: { s: "x".repeat(40_000) },
      });
      expect(sides.openfga).toBe("refused");
      expect(sides.tsfga).toBe("refused");
    });

    test("a control character in a context value", async () => {
      // `ValidateStruct` refuses any context key or value holding a
      // Unicode control character, before the parameters are cast
      // (internal/validation/validation.go). tsfga has no
      // equivalent pass.
      const sides = await bothSides({
        relation: "big",
        conditionName: "bigstring_a3",
        conditionContext: { s: `a${BACKSPACE}b` },
      });
      expect(sides.openfga).toBe("refused");
      expect(sides.tsfga).toBe("refused");
    });
  });

  describe("implicit tuples and their neighbours", () => {
    test("a tuple that says only what the model says is refused", async () => {
      const id = objectId();
      await expectWriteConformance(
        storeId,
        authorizationModelId,
        tsfgaClient,
        {
          objectType: "doc_a3",
          objectId: id,
          relation: "self_a",
          subjectType: "doc_a3",
          subjectId: id,
          subjectRelation: "self_a",
        },
        "refused",
      );
    });

    test("the same object under a different relation is written", async () => {
      const id = objectId();
      await expectWriteConformance(
        storeId,
        authorizationModelId,
        tsfgaClient,
        {
          objectType: "doc_a3",
          objectId: id,
          relation: "self_a",
          subjectType: "doc_a3",
          subjectId: id,
          subjectRelation: "self_b",
        },
        "accepted",
      );
    });

    test("the same relation on a different object is written", async () => {
      await expectWrite(
        {
          relation: "self_a",
          subjectType: "doc_a3",
          subjectId: uuid("doc2"),
          subjectRelation: "self_a",
        },
        "accepted",
      );
    });
  });

  describe("duplicate writes", () => {
    test("rewriting an existing tuple", async () => {
      const row: AddTupleRequest = {
        objectType: "doc_a3",
        objectId: objectId(),
        relation: "bare",
        subjectType: "user_a3",
        subjectId: uuid("alice"),
      };

      await expectWriteConformance(
        storeId,
        authorizationModelId,
        tsfgaClient,
        row,
        "accepted",
      );

      // `on_duplicate` defaults to `error`
      // (pkg/server/commands/write.go), so upstream refuses the
      // second write of a row that already exists —
      // `write_failed_due_to_invalid_input`, a refusal the model
      // owns. tsfga upserts and reports nothing.
      await expectWriteConformance(
        storeId,
        authorizationModelId,
        tsfgaClient,
        row,
        "refused",
      );
    });

    test("rewriting a tuple with a different condition", async () => {
      const row: AddTupleRequest = {
        objectType: "doc_a3",
        objectId: objectId(),
        relation: "both",
        subjectType: "user_a3",
        subjectId: uuid("alice"),
      };

      await expectWriteConformance(
        storeId,
        authorizationModelId,
        tsfgaClient,
        row,
        "accepted",
      );

      // The natural key upstream is (object, relation, user); the
      // condition is not part of it. So re-granting the same edge
      // *under a condition* is a duplicate upstream and a silent
      // narrowing of a live grant in tsfga.
      await expectWriteConformance(
        storeId,
        authorizationModelId,
        tsfgaClient,
        { ...row, conditionName: "cond_a3", conditionContext: { n: 9 } },
        "refused",
      );
    });
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./write-gate/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
