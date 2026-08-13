import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ErrorCode, FgaApiValidationError, OpenFgaClient } from "@openfga/sdk";
import {
  type AddTupleRequest,
  createTsfga,
  MissingTupleError,
  type RemoveTupleRequest,
  type TsfgaClient,
} from "@tsfga/core";
import type { DB } from "@tsfga/kysely";
import { KyselyTupleStore } from "@tsfga/kysely";
import type { Kysely } from "kysely";
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
  fgaCreateStore,
  fgaWriteModel,
  fgaWriteOutcome,
} from "./helpers/openfga.ts";

/**
 * Revocation, path by path.
 *
 * Granting parity is only half of the contract: a grant that both
 * engines accept must also stop granting, in both, when it is
 * taken away — through a userset, a tuple-to-userset, an
 * intersection operand and an exclusion arm alike. A revocation
 * that leaves one engine still answering `true` is the failure
 * mode with the worst consequences, and it is invisible to a suite
 * that only ever writes.
 *
 * The delete key upstream is `TupleKeyWithoutCondition` — object,
 * relation and user, nothing else — and deletes are not validated
 * against the model at all (`pkg/server/commands/write.go`, only
 * `IsValidUser` runs). Both properties are asserted below.
 *
 * **Surface note.** Upstream's `on_missing` defaults to `error`, so
 * deleting a row that is not there is refused with
 * `write_failed_due_to_invalid_input`; tsfga's `removeTuple`
 * returns `false` for the same case. The information is the same
 * and `deleteOutcome` normalises both to `"missing"`, which is what
 * the parity claim here is about: whether the row went away.
 */

const uuidMap = new Map<string, string>([
  ["alice", "00000000-0000-4000-d420-200000000001"],
  ["bob", "00000000-0000-4000-d420-200000000002"],
  ["team1", "00000000-0000-4000-d420-200000000003"],
  ["team2", "00000000-0000-4000-d420-200000000004"],
  ["team3", "00000000-0000-4000-d420-200000000007"],
  ["folder1", "00000000-0000-4000-d420-200000000005"],
  ["folder2", "00000000-0000-4000-d420-200000000006"],
]);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

/** Each scenario owns one document, so none can disturb another. */
let nextDoc = 0;
function docId(): string {
  nextDoc++;
  return `00000000-0000-4000-d420-3${String(nextDoc).padStart(11, "0")}`;
}

describe("Revocation Conformance", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let authorizationModelId: string;
  let tsfgaClient: TsfgaClient;
  let fgaClient: OpenFgaClient;
  let fixture: FixtureRecord;

  beforeAll(async () => {
    db = getDb();
    await beginTransaction(db);

    const store = new KyselyTupleStore(db);
    tsfgaClient = createTsfga(store);
    fixture = recordFixture(tsfgaClient);

    await tsfgaClient.writeConditionDefinition({
      name: "when_a3r",
      expression: "n > 5",
      parameters: { n: "int" },
    });

    const plain = {
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    } as const;

    await tsfgaClient.writeRelationConfig({
      objectType: "team_a3r",
      relation: "member",
      directlyAssignable: [{ type: "user_a3r" }],
      ...plain,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "folder_a3r",
      relation: "viewer",
      directlyAssignable: [{ type: "user_a3r" }],
      ...plain,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "doc_a3r",
      relation: "parent",
      directlyAssignable: [{ type: "folder_a3r" }],
      ...plain,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "doc_a3r",
      relation: "blocked",
      directlyAssignable: [{ type: "user_a3r" }],
      ...plain,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "doc_a3r",
      relation: "gated",
      directlyAssignable: [{ type: "user_a3r" }],
      ...plain,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "doc_a3r",
      relation: "editor",
      directlyAssignable: [
        { type: "user_a3r" },
        { type: "team_a3r", relation: "member" },
        { type: "user_a3r", wildcard: true },
      ],
      ...plain,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "doc_a3r",
      relation: "timed",
      directlyAssignable: [{ type: "user_a3r", condition: "when_a3r" }],
      ...plain,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "doc_a3r",
      relation: "viewer",
      directlyAssignable: [],
      ...plain,
      impliedBy: ["editor"],
      tupleToUserset: [{ tupleset: "parent", computedUserset: "viewer" }],
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "doc_a3r",
      relation: "safe",
      directlyAssignable: [],
      ...plain,
      computedUserset: "editor",
      excludedBy: "blocked",
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "doc_a3r",
      relation: "both",
      directlyAssignable: [],
      ...plain,
      intersection: [
        { type: "computedUserset", relation: "editor" },
        { type: "computedUserset", relation: "gated" },
      ],
    });

    storeId = await fgaCreateStore("revocation-conformance");
    authorizationModelId = await fgaWriteModel(
      storeId,
      "./revocation/model.dsl",
    );
    fgaClient = new OpenFgaClient({
      apiUrl: process.env.FGA_API_URL,
      storeId,
    });
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  function userRef(tuple: {
    subjectType: string;
    subjectId: string;
    subjectRelation?: string | null;
  }): string {
    return tuple.subjectRelation
      ? `${tuple.subjectType}:${tuple.subjectId}#${tuple.subjectRelation}`
      : `${tuple.subjectType}:${tuple.subjectId}`;
  }

  /** Write one tuple to both engines, asserting both took it. */
  async function grant(tuple: AddTupleRequest): Promise<void> {
    const [, openFgaOutcome] = await Promise.all([
      tsfgaClient.addTuple(tuple),
      fgaWriteOutcome(storeId, authorizationModelId, tuple),
    ]);
    expect(openFgaOutcome).toBe("accepted");
  }

  /**
   * Whether the row went away, normalising upstream's refusal on a
   * missing row and tsfga's `false` to the same word.
   */
  async function deleteOutcome(
    tuple: RemoveTupleRequest,
  ): Promise<{ tsfga: string; openfga: string }> {
    const [tsfga, openfga] = await Promise.all([
      tsfgaClient
        .removeTuple(tuple)
        .then(() => "deleted")
        .catch((error: unknown) => {
          if (error instanceof MissingTupleError) return "missing";
          throw error;
        }),
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
        }),
    ]);
    return { tsfga, openfga };
  }

  async function expectRevoke(
    tuple: RemoveTupleRequest,
    expected: "deleted" | "missing",
  ): Promise<void> {
    const outcome = await deleteOutcome(tuple);
    expect(outcome.tsfga).toBe(outcome.openfga);
    expect(outcome.tsfga).toBe(expected);
  }

  async function expectCheck(
    objectId: string,
    relation: string,
    subjectId: string,
    expected: CheckOutcome,
    context?: Record<string, unknown>,
  ): Promise<void> {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "doc_a3r",
        objectId,
        relation,
        subjectType: "user_a3r",
        subjectId,
        context,
      },
      expected,
    );
  }

  describe("a revoked grant stops granting", () => {
    test("through a direct assignment", async () => {
      const doc = docId();
      const row: AddTupleRequest = {
        objectType: "doc_a3r",
        objectId: doc,
        relation: "editor",
        subjectType: "user_a3r",
        subjectId: uuid("alice"),
      };
      await grant(row);
      await expectCheck(doc, "viewer", uuid("alice"), true);

      await expectRevoke(row, "deleted");
      await expectCheck(doc, "viewer", uuid("alice"), false);
    });

    test("through a userset, revoked at the object", async () => {
      const doc = docId();
      await grant({
        objectType: "team_a3r",
        objectId: uuid("team1"),
        relation: "member",
        subjectType: "user_a3r",
        subjectId: uuid("alice"),
      });
      const row: AddTupleRequest = {
        objectType: "doc_a3r",
        objectId: doc,
        relation: "editor",
        subjectType: "team_a3r",
        subjectId: uuid("team1"),
        subjectRelation: "member",
      };
      await grant(row);
      await expectCheck(doc, "viewer", uuid("alice"), true);

      await expectRevoke(row, "deleted");
      await expectCheck(doc, "viewer", uuid("alice"), false);
    });

    test("through a userset, revoked at the member", async () => {
      const doc = docId();
      const membership: AddTupleRequest = {
        objectType: "team_a3r",
        objectId: uuid("team2"),
        relation: "member",
        subjectType: "user_a3r",
        subjectId: uuid("bob"),
      };
      await grant(membership);
      await grant({
        objectType: "doc_a3r",
        objectId: doc,
        relation: "editor",
        subjectType: "team_a3r",
        subjectId: uuid("team2"),
        subjectRelation: "member",
      });
      await expectCheck(doc, "viewer", uuid("bob"), true);

      await expectRevoke(membership, "deleted");
      await expectCheck(doc, "viewer", uuid("bob"), false);
    });

    test("through a wildcard", async () => {
      const doc = docId();
      const row: AddTupleRequest = {
        objectType: "doc_a3r",
        objectId: doc,
        relation: "editor",
        subjectType: "user_a3r",
        subjectId: "*",
      };
      await grant(row);
      await expectCheck(doc, "viewer", uuid("bob"), true);

      await expectRevoke(row, "deleted");
      await expectCheck(doc, "viewer", uuid("bob"), false);
    });

    test("through a tuple-to-userset, revoked at the edge", async () => {
      const doc = docId();
      await grant({
        objectType: "folder_a3r",
        objectId: uuid("folder1"),
        relation: "viewer",
        subjectType: "user_a3r",
        subjectId: uuid("alice"),
      });
      const edge: AddTupleRequest = {
        objectType: "doc_a3r",
        objectId: doc,
        relation: "parent",
        subjectType: "folder_a3r",
        subjectId: uuid("folder1"),
      };
      await grant(edge);
      await expectCheck(doc, "viewer", uuid("alice"), true);

      await expectRevoke(edge, "deleted");
      await expectCheck(doc, "viewer", uuid("alice"), false);
    });

    test("through a tuple-to-userset, revoked at the leaf", async () => {
      const doc = docId();
      const leaf: AddTupleRequest = {
        objectType: "folder_a3r",
        objectId: uuid("folder2"),
        relation: "viewer",
        subjectType: "user_a3r",
        subjectId: uuid("alice"),
      };
      await grant(leaf);
      await grant({
        objectType: "doc_a3r",
        objectId: doc,
        relation: "parent",
        subjectType: "folder_a3r",
        subjectId: uuid("folder2"),
      });
      await expectCheck(doc, "viewer", uuid("alice"), true);

      await expectRevoke(leaf, "deleted");
      await expectCheck(doc, "viewer", uuid("alice"), false);
    });

    test("through an intersection operand", async () => {
      const doc = docId();
      await grant({
        objectType: "doc_a3r",
        objectId: doc,
        relation: "editor",
        subjectType: "user_a3r",
        subjectId: uuid("alice"),
      });
      const gate: AddTupleRequest = {
        objectType: "doc_a3r",
        objectId: doc,
        relation: "gated",
        subjectType: "user_a3r",
        subjectId: uuid("alice"),
      };
      await grant(gate);
      await expectCheck(doc, "both", uuid("alice"), true);

      await expectRevoke(gate, "deleted");
      await expectCheck(doc, "both", uuid("alice"), false);
    });

    test("through a condition", async () => {
      const doc = docId();
      const row: AddTupleRequest = {
        objectType: "doc_a3r",
        objectId: doc,
        relation: "timed",
        subjectType: "user_a3r",
        subjectId: uuid("alice"),
        conditionName: "when_a3r",
        conditionContext: { n: 9 },
      };
      await grant(row);
      await expectCheck(doc, "timed", uuid("alice"), true);

      // The delete key carries no condition upstream, so the bare
      // key must remove a conditioned row.
      await expectRevoke(
        {
          objectType: row.objectType,
          objectId: row.objectId,
          relation: row.relation,
          subjectType: row.subjectType,
          subjectId: row.subjectId,
        },
        "deleted",
      );
      await expectCheck(doc, "timed", uuid("alice"), false);
    });
  });

  describe("revoking the subtract side restores the grant", () => {
    test("deleting the exclusion arm re-allows", async () => {
      const doc = docId();
      await grant({
        objectType: "doc_a3r",
        objectId: doc,
        relation: "editor",
        subjectType: "user_a3r",
        subjectId: uuid("alice"),
      });
      await expectCheck(doc, "safe", uuid("alice"), true);

      const block: AddTupleRequest = {
        objectType: "doc_a3r",
        objectId: doc,
        relation: "blocked",
        subjectType: "user_a3r",
        subjectId: uuid("alice"),
      };
      await grant(block);
      await expectCheck(doc, "safe", uuid("alice"), false);

      await expectRevoke(block, "deleted");
      await expectCheck(doc, "safe", uuid("alice"), true);
    });
  });

  describe("what a delete does not match", () => {
    test("a tuple that was never written", async () => {
      await expectRevoke(
        {
          objectType: "doc_a3r",
          objectId: docId(),
          relation: "editor",
          subjectType: "user_a3r",
          subjectId: uuid("alice"),
        },
        "missing",
      );
    });

    test("a mismatched subject relation leaves the grant standing", async () => {
      const doc = docId();
      await grant({
        objectType: "team_a3r",
        objectId: uuid("team3"),
        relation: "member",
        subjectType: "user_a3r",
        subjectId: uuid("alice"),
      });
      await grant({
        objectType: "doc_a3r",
        objectId: doc,
        relation: "editor",
        subjectType: "team_a3r",
        subjectId: uuid("team3"),
        subjectRelation: "member",
      });
      await expectCheck(doc, "viewer", uuid("alice"), true);

      // `team_a3r:team3` and `team_a3r:team3#member` are different
      // subjects, so this removes nothing.
      await expectRevoke(
        {
          objectType: "doc_a3r",
          objectId: doc,
          relation: "editor",
          subjectType: "team_a3r",
          subjectId: uuid("team3"),
        },
        "missing",
      );
      await expectCheck(doc, "viewer", uuid("alice"), true);
    });

    test("a mismatched relation leaves the grant standing", async () => {
      const doc = docId();
      await grant({
        objectType: "doc_a3r",
        objectId: doc,
        relation: "editor",
        subjectType: "user_a3r",
        subjectId: uuid("alice"),
      });

      await expectRevoke(
        {
          objectType: "doc_a3r",
          objectId: doc,
          relation: "gated",
          subjectType: "user_a3r",
          subjectId: uuid("alice"),
        },
        "missing",
      );
      await expectCheck(doc, "viewer", uuid("alice"), true);
    });

    test("a wildcard delete does not match a concrete row", async () => {
      const doc = docId();
      await grant({
        objectType: "doc_a3r",
        objectId: doc,
        relation: "editor",
        subjectType: "user_a3r",
        subjectId: uuid("alice"),
      });

      await expectRevoke(
        {
          objectType: "doc_a3r",
          objectId: doc,
          relation: "editor",
          subjectType: "user_a3r",
          subjectId: "*",
        },
        "missing",
      );
      await expectCheck(doc, "viewer", uuid("alice"), true);
    });

    test("a concrete delete does not match a wildcard row", async () => {
      const doc = docId();
      await grant({
        objectType: "doc_a3r",
        objectId: doc,
        relation: "editor",
        subjectType: "user_a3r",
        subjectId: "*",
      });

      await expectRevoke(
        {
          objectType: "doc_a3r",
          objectId: doc,
          relation: "editor",
          subjectType: "user_a3r",
          subjectId: uuid("alice"),
        },
        "missing",
      );
      await expectCheck(doc, "viewer", uuid("alice"), true);
    });
  });

  describe("re-granting after a revocation", () => {
    test("the same edge grants again", async () => {
      const doc = docId();
      const row: AddTupleRequest = {
        objectType: "doc_a3r",
        objectId: doc,
        relation: "editor",
        subjectType: "user_a3r",
        subjectId: uuid("alice"),
      };
      await grant(row);
      await expectRevoke(row, "deleted");
      await expectCheck(doc, "viewer", uuid("alice"), false);

      await grant(row);
      await expectCheck(doc, "viewer", uuid("alice"), true);
    });
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./revocation/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
