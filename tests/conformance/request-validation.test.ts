import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTsfga, type TsfgaClient } from "@tsfga/core";
import type { DB } from "@tsfga/kysely";
import { KyselyTupleStore } from "@tsfga/kysely";
import type { Kysely } from "kysely";
import {
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
  fgaListObjects,
  fgaWriteModel,
} from "./helpers/openfga.ts";

/**
 * Request validation, walked rule by rule rather than by chance.
 *
 * `pkg/server/commands` gates three requests before it resolves
 * anything, and the three gates are **not** the same:
 *
 * | | Check | ListObjects | Write |
 * |---|---|---|---|
 * | `ValidateUserObjectRelation` on the request tuple | yes | partly — `ValidateUser` and `GetRelation` only | yes |
 * | `ValidateStruct` on the request context | **yes** | **no** | n/a |
 * | `ValidateTupleForWrite` on contextual tuples | yes | yes | n/a |
 *
 * The middle row is the one that matters here.
 * `CheckCommand.validateCheckRequest` calls
 * `validation.ValidateStruct(requestCtx)`
 * (`pkg/server/commands/check_command.go:197`);
 * `ListObjectsQuery.Execute` never does — it validates the
 * contextual tuples, the target relation and the user, and passes
 * `req.GetContext()` straight through
 * (`pkg/server/commands/list_objects.go:508-556`). So a control
 * character in a request context is a refusal on Check and no
 * refusal at all on ListObjects.
 *
 * The other rule probed here is `ValidateObject`'s: an object id
 * of `*` is refused outright — "the 'object' field cannot
 * reference a typed wildcard" — on both the check path and the
 * write path. `identifiers.test.ts` covers `*` as a type and as
 * a relation, and the wildcard *subject*; the object id is the
 * remaining position.
 */

/** A Unicode control character, as `unicode.IsControl` reads it. */
const DIRTY = "a\u0001b";

const ALICE = "00000000-0000-4000-d540-000000000001";
const DOC_A = "00000000-0000-4000-d540-000000000010";
const DOC_B = "00000000-0000-4000-d540-000000000011";

describe("Request-validation conformance", () => {
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

    await tsfgaClient.writeRelationConfig({
      objectType: "doc_d3r",
      relation: "viewer",
      directlyAssignable: [{ type: "user_d3r" }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });

    storeId = await fgaCreateStore("request-validation");
    authorizationModelId = await fgaWriteModel(
      storeId,
      "./request-validation/model.dsl",
    );

    for (const objectId of [DOC_A, DOC_B]) {
      await expectWriteConformance(
        storeId,
        authorizationModelId,
        tsfgaClient,
        {
          objectType: "doc_d3r",
          objectId,
          relation: "viewer",
          subjectType: "user_d3r",
          subjectId: ALICE,
        },
        "accepted",
      );
    }
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  describe("a control character in the request context", () => {
    test("control: a clean context changes nothing on either path", async () => {
      await expectConformance(
        storeId,
        authorizationModelId,
        tsfgaClient,
        {
          objectType: "doc_d3r",
          objectId: DOC_A,
          relation: "viewer",
          subjectType: "user_d3r",
          subjectId: ALICE,
          context: { unused: "clean" },
        },
        true,
      );
      await expectListObjectsConformance(
        storeId,
        authorizationModelId,
        tsfgaClient,
        {
          objectType: "doc_d3r",
          relation: "viewer",
          subjectType: "user_d3r",
          subjectId: ALICE,
          context: { unused: "clean" },
        },
        [DOC_A, DOC_B],
      );
    });

    test("control: a check with a dirty context is refused by both", async () => {
      await expectConformance(
        storeId,
        authorizationModelId,
        tsfgaClient,
        {
          objectType: "doc_d3r",
          objectId: DOC_A,
          relation: "viewer",
          subjectType: "user_d3r",
          subjectId: ALICE,
          context: { unused: DIRTY },
        },
        "refused",
      );
    });

    test("listObjects with a dirty context answers upstream", async () => {
      // Asserted on its own first: `expectListObjectsConformance`
      // runs both engines in one `Promise.all`, so tsfga's throw
      // would otherwise hide what upstream did with the same call.
      expect(
        (
          await fgaListObjects(storeId, authorizationModelId, {
            objectType: "doc_d3r",
            relation: "viewer",
            subjectType: "user_d3r",
            subjectId: ALICE,
            context: { unused: DIRTY },
          })
        ).sort(),
      ).toEqual([DOC_A, DOC_B].sort());
      await expectListObjectsConformance(
        storeId,
        authorizationModelId,
        tsfgaClient,
        {
          objectType: "doc_d3r",
          relation: "viewer",
          subjectType: "user_d3r",
          subjectId: ALICE,
          context: { unused: DIRTY },
        },
        [DOC_A, DOC_B],
      );
    });

    test("a dirty context key on listObjects answers upstream", async () => {
      await expectListObjectsConformance(
        storeId,
        authorizationModelId,
        tsfgaClient,
        {
          objectType: "doc_d3r",
          relation: "viewer",
          subjectType: "user_d3r",
          subjectId: ALICE,
          context: { [DIRTY]: "clean" },
        },
        [DOC_A, DOC_B],
      );
    });
  });

  describe("'*' as the object id", () => {
    test("a check whose object id is '*' is refused", async () => {
      await expectConformance(
        storeId,
        authorizationModelId,
        tsfgaClient,
        {
          objectType: "doc_d3r",
          objectId: "*",
          relation: "viewer",
          subjectType: "user_d3r",
          subjectId: ALICE,
        },
        "refused",
      );
    });

    test("a write whose object id is '*' is refused", async () => {
      await expectWriteConformance(
        storeId,
        authorizationModelId,
        tsfgaClient,
        {
          objectType: "doc_d3r",
          objectId: "*",
          relation: "viewer",
          subjectType: "user_d3r",
          subjectId: ALICE,
        },
        "refused",
      );
    });
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./request-validation/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
