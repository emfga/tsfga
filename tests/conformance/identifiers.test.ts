import { afterAll, beforeAll, describe, test } from "bun:test";
import {
  type AddTupleRequest,
  createTsfga,
  type TsfgaClient,
} from "@tsfga/core";
import type { DB } from "@tsfga/kysely";
import { KyselyTupleStore } from "@tsfga/kysely";
import type { Kysely } from "kysely";
import {
  expectConfigsMatchModel,
  expectConformance,
  expectPinnedWriteDivergence,
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
import { fgaCreateStore, fgaWriteModel } from "./helpers/openfga.ts";

/**
 * Identifier validity, on the write path and on the check path.
 *
 * Upstream spells a subject as one string and validates it with
 * `tuple.IsValidUser` before anything else looks at it
 * (`pkg/tuple/tuple.go:459-518`, `internal/validation/
 * validation.go:362`). tsfga spells it as three fields, which
 * removes some ways to malform it and keeps others: `subjectId`
 * is a field of its own, so a caller can put a `:`, a `#`, a space
 * or a control character in it and upstream's regex never runs
 * over the rendered string.
 *
 * The check path applies the rule in `validateCheckSubject`, and
 * the write path applies the same one in `validateTupleWrite`, so
 * a row tsfga would refuse to answer questions about cannot be
 * stored in the first place.
 *
 * The object id is a `uuid` column, a known scoped limitation, so
 * ids upstream admits and tsfga cannot represent are out of
 * scope here. Ids **both** engines can represent are not: an id
 * differing only in hex case, or written without hyphens, is one
 * object to PostgreSQL and two to OpenFGA.
 */

const uuidMap = new Map<string, string>([
  ["alice", "00000000-0000-4000-d4c0-000000000001"],
  ["bob", "00000000-0000-4000-d4c0-000000000002"],
  ["team1", "00000000-0000-4000-d4c0-000000000003"],
]);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

/** Each case writes its own object, so no write is a duplicate. */
let nextObject = 0;
function objectId(): string {
  nextObject++;
  return `00000000-0000-4000-d4c0-1${String(nextObject).padStart(11, "0")}`;
}

const NEWLINE = String.fromCharCode(10);

describe("Identifier validity conformance", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let authorizationModelId: string;
  let tsfgaClient: TsfgaClient;
  let fixture: FixtureRecord;

  beforeAll(async () => {
    db = getDb();
    await beginTransaction(db);

    tsfgaClient = createTsfga(new KyselyTupleStore(db));
    fixture = recordFixture(tsfgaClient);

    const plain = {
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    } as const;

    await tsfgaClient.writeRelationConfig({
      objectType: "team_b5",
      relation: "member",
      directlyAssignable: [{ type: "user_b5" }],
      ...plain,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "doc_b5",
      relation: "viewer",
      directlyAssignable: [{ type: "user_b5" }],
      ...plain,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "doc_b5",
      relation: "userset_only",
      directlyAssignable: [{ type: "team_b5", relation: "member" }],
      ...plain,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "doc_b5",
      relation: "public",
      directlyAssignable: [{ type: "user_b5", wildcard: true }],
      ...plain,
    });

    storeId = await fgaCreateStore("identifiers-conformance");
    authorizationModelId = await fgaWriteModel(
      storeId,
      "./identifiers/model.dsl",
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  function tuple(overrides: Partial<AddTupleRequest>): AddTupleRequest {
    return {
      objectType: "doc_b5",
      objectId: objectId(),
      relation: "viewer",
      subjectType: "user_b5",
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

  describe("the subject id, on the write path", () => {
    test("control: a well-formed subject id is written", async () => {
      await expectWrite({}, "accepted");
    });

    test("a subject id containing ':'", async () => {
      // `user_b5:al:ice` carries two colons, so it is neither a
      // user id, nor an object, nor a userset: `IsValidUser` is
      // false and `ValidateUser` refuses before any type
      // restriction is read.
      await expectWrite({ subjectId: `${uuid("alice")}:x` }, "refused");
    });

    test("a subject id containing '#'", async () => {
      // `user_b5:<id>#ghost` parses as a userset upstream, and
      // `user_b5` defines no relation at all, so `ValidateUser`
      // refuses with `relation not found`.
      await expectWrite({ subjectId: `${uuid("alice")}#ghost` }, "refused");
    });

    test("a subject id containing a space", async () => {
      // `IsValidUserID` refuses a space outright.
      await expectWrite({ subjectId: `${uuid("alice")} x` }, "refused");
    });

    test("a subject id containing a control character", async () => {
      // `unicode.IsControl` is checked first in every one of the
      // four id predicates.
      await expectWrite({ subjectId: `${uuid("alice")}${NEWLINE}` }, "refused");
    });

    test("an empty subject id", async () => {
      // `user_b5:` has an id of length zero, which `IsValidObject`
      // refuses (`idLen > 0`).
      await expectWrite({ subjectId: "" }, "refused");
    });

    test("a subject id past the wire length limit", async () => {
      await expectWrite({ subjectId: "a".repeat(600) }, "refused");
    });
  });

  describe("the subject id, on the check path", () => {
    test("a check for a ':' subject id is refused by both", async () => {
      await expectConformance(
        storeId,
        authorizationModelId,
        tsfgaClient,
        {
          objectType: "doc_b5",
          objectId: objectId(),
          relation: "viewer",
          subjectType: "user_b5",
          subjectId: `${uuid("alice")}:x`,
        },
        "refused",
      );
    });

    test("a check for a '#' subject id is refused by both", async () => {
      await expectConformance(
        storeId,
        authorizationModelId,
        tsfgaClient,
        {
          objectType: "doc_b5",
          objectId: objectId(),
          relation: "viewer",
          subjectType: "user_b5",
          subjectId: `${uuid("alice")}#ghost`,
        },
        "refused",
      );
    });
  });

  describe("a '#' in the subject id that upstream reads as a userset", () => {
    test("ISSUE-282: '<id>#member' where the relation exists", async () => {
      // `team_b5:<id>#member` is a well-formed userset upstream, so
      // the write lands as the userset `userset_only` admits. tsfga
      // reads `subjectId` verbatim and sees the bare type
      // `team_b5`, which the relation does not admit.
      //
      // **Asserted as a divergence rather than a gap.** tsfga
      // spells a userset with `subjectRelation`, and the test below
      // shows that spelling agreeing with upstream. Closing this by
      // *parsing* a `#` out of `subjectId` would contradict the
      // check path, which refuses exactly this shape in
      // `validateCheckSubject`, and would make the field mean two
      // things. It belongs in `packages/core/README.md` as a
      // documented consequence of the three-field subject, pinned
      // here so a change on either side fails.
      await expectPinnedWriteDivergence(
        storeId,
        authorizationModelId,
        tsfgaClient,
        tuple({
          relation: "userset_only",
          subjectType: "team_b5",
          subjectId: `${uuid("team1")}#member`,
        }),
        { openfga: "accepted", tsfga: "refused" },
      );
    });

    test("control: the same edge spelled with subjectRelation", async () => {
      await expectWrite(
        {
          relation: "userset_only",
          subjectType: "team_b5",
          subjectId: uuid("team1"),
          subjectRelation: "member",
        },
        "accepted",
      );
    });
  });

  describe("the object id, where both engines can represent it", () => {
    test("control: an id is written and checked as itself", async () => {
      const id = objectId();
      await expectWriteConformance(
        storeId,
        authorizationModelId,
        tsfgaClient,
        {
          objectType: "doc_b5",
          objectId: id,
          relation: "viewer",
          subjectType: "user_b5",
          subjectId: uuid("alice"),
        },
        "accepted",
      );
      await expectConformance(
        storeId,
        authorizationModelId,
        tsfgaClient,
        {
          objectType: "doc_b5",
          objectId: id,
          relation: "viewer",
          subjectType: "user_b5",
          subjectId: uuid("alice"),
        },
        true,
      );
    });

    test("an object id differing only in hex case", async () => {
      const lower = objectId();
      const upper = lower.toUpperCase();
      await expectPinnedWriteDivergence(
        storeId,
        authorizationModelId,
        tsfgaClient,
        {
          objectType: "doc_b5",
          objectId: upper,
          relation: "viewer",
          subjectType: "user_b5",
          subjectId: uuid("alice"),
        },
        { openfga: "accepted", tsfga: "refused" },
      );
      // `doc_b5:0000...D4C0...` and `doc_b5:0000...d4c0...` are two
      // objects upstream. They are one row to a `uuid` column,
      // which is why the store refuses the uppercase spelling
      // outright rather than storing it and answering for both.
      await expectConformance(
        storeId,
        authorizationModelId,
        tsfgaClient,
        {
          objectType: "doc_b5",
          objectId: lower,
          relation: "viewer",
          subjectType: "user_b5",
          subjectId: uuid("alice"),
        },
        false,
      );
    });

    test("an object id written without hyphens", async () => {
      const hyphenated = objectId();
      const bare = hyphenated.replaceAll("-", "");
      await expectPinnedWriteDivergence(
        storeId,
        authorizationModelId,
        tsfgaClient,
        {
          objectType: "doc_b5",
          objectId: bare,
          relation: "viewer",
          subjectType: "user_b5",
          subjectId: uuid("alice"),
        },
        { openfga: "accepted", tsfga: "refused" },
      );
      await expectConformance(
        storeId,
        authorizationModelId,
        tsfgaClient,
        {
          objectType: "doc_b5",
          objectId: hyphenated,
          relation: "viewer",
          subjectType: "user_b5",
          subjectId: uuid("alice"),
        },
        false,
      );
    });

    test("a subject id differing only in hex case is two subjects", async () => {
      // The subject-side counterpart of the two object cases
      // above, and it is refused for the same reason: the
      // uppercase spelling is a distinct subject upstream and the
      // same row here.
      const id = objectId();
      await expectPinnedWriteDivergence(
        storeId,
        authorizationModelId,
        tsfgaClient,
        {
          objectType: "doc_b5",
          objectId: id,
          relation: "viewer",
          subjectType: "user_b5",
          subjectId: uuid("bob").toUpperCase(),
        },
        { openfga: "accepted", tsfga: "refused" },
      );
      await expectConformance(
        storeId,
        authorizationModelId,
        tsfgaClient,
        {
          objectType: "doc_b5",
          objectId: id,
          relation: "viewer",
          subjectType: "user_b5",
          subjectId: uuid("bob"),
        },
        false,
      );
    });
  });

  describe("the wildcard", () => {
    test("'*' as the relation is refused by both", async () => {
      await expectWrite({ relation: "*" }, "refused");
    });

    test("'*' as the object type is refused by both", async () => {
      await expectWrite({ objectType: "*" }, "refused");
    });

    test("'*' as the subject type is refused by both", async () => {
      await expectWrite({ subjectType: "*" }, "refused");
    });

    test("a wildcard grant answers a check for the wildcard", async () => {
      const id = objectId();
      await expectWriteConformance(
        storeId,
        authorizationModelId,
        tsfgaClient,
        {
          objectType: "doc_b5",
          objectId: id,
          relation: "public",
          subjectType: "user_b5",
          subjectId: "*",
        },
        "accepted",
      );
      await expectConformance(
        storeId,
        authorizationModelId,
        tsfgaClient,
        {
          objectType: "doc_b5",
          objectId: id,
          relation: "public",
          subjectType: "user_b5",
          subjectId: "*",
        },
        true,
      );
    });

    test("a concrete grant does not answer a check for '*'", async () => {
      const id = objectId();
      await expectWriteConformance(
        storeId,
        authorizationModelId,
        tsfgaClient,
        {
          objectType: "doc_b5",
          objectId: id,
          relation: "viewer",
          subjectType: "user_b5",
          subjectId: uuid("alice"),
        },
        "accepted",
      );
      await expectConformance(
        storeId,
        authorizationModelId,
        tsfgaClient,
        {
          objectType: "doc_b5",
          objectId: id,
          relation: "viewer",
          subjectType: "user_b5",
          subjectId: "*",
        },
        false,
      );
    });

    test("a check whose relation does not exist is refused by both", async () => {
      await expectConformance(
        storeId,
        authorizationModelId,
        tsfgaClient,
        {
          objectType: "doc_b5",
          objectId: objectId(),
          relation: "*",
          subjectType: "user_b5",
          subjectId: uuid("alice"),
        },
        "refused",
      );
    });
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./identifiers/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
