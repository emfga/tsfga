import { afterAll, beforeAll, describe, test } from "bun:test";
import type { WriteAuthorizationModelRequest } from "@openfga/sdk";
import {
  createTsfga,
  type RelationConfig,
  type RemoveTupleRequest,
  type TsfgaClient,
} from "@tsfga/core";
import type { DB } from "@tsfga/kysely";
import { KyselyTupleStore } from "@tsfga/kysely";
import type { Kysely } from "kysely";
import {
  expectDeleteConformance,
  expectPinnedDeleteDivergence,
} from "./helpers/conformance.ts";
import {
  beginTransaction,
  destroyDb,
  getDb,
  rollbackTransaction,
} from "./helpers/db.ts";
import {
  fgaCreateStore,
  fgaWriteModelJson,
  fgaWriteTuplesRaw,
} from "./helpers/openfga.ts";

/**
 * What OpenFGA validates on a **delete**, which is much less than
 * what it validates on a write.
 *
 * `pkg/server/commands/write.go` runs one `IsValidUser` call over
 * the deletes and a `TODO`. There is no model validation: an
 * undefined relation, an undefined type, a subject type the
 * relation does not admit — every one falls through to "the tuple
 * does not exist". Everything else is protovalidate on the
 * rendered fields.
 *
 * tsfga applied *nothing* until this suite: `removeTuple` handed
 * its argument straight to the store and answered `false`.
 *
 * **The fall-through rows are the more important half.** Refusing
 * too much here is worse than refusing too little, because a
 * delete is how a bad write is undone: if the gate reused the
 * write validators, a model change that dropped a relation would
 * strand every row written under the old one, permanently. That
 * property is asserted at the end, across a real model change.
 *
 * **What `@tsfga/kysely`'s id domain did to this fixture, and what
 * it did not.** Six of the fall-through rows are about characters
 * — `:`, `#`, `@`, a control character, `*`, empty — that a
 * canonical UUID cannot express at all, and a seventh is a subject
 * id holding `#`. Every one of those is now refused by the id
 * domain, one rule later than the delete gate. Rewriting them as
 * UUIDs would leave the negative assertion vacuously true forever,
 * which is the failure this fixture exists to avoid, so they are
 * **pinned capability divergences** instead: still two-sided,
 * still red if tsfga's refusal moves, and red the day upstream
 * starts refusing them too. The guard is retired by the
 * capability, not satisfied by it.
 *
 * Everything whose defect lives outside the id keeps its full
 * meaning under a mechanical UUID substitution: the empty
 * relation, `self`, an undefined relation, an undefined type, an
 * unadmitted subject type, a userset naming a relation the type
 * lacks, and the wildcard subject. Those are the rows that carry
 * the property — a model change that drops a relation must not
 * strand the rows written under it — and none of them moved.
 *
 * Two rows retired rather than converting. The 512-byte subject
 * pair cannot be expressed at all here: the longest subject a
 * canonical UUID renders is `user_e1d:` plus 36 characters, 45
 * bytes. A pin would record tsfga refusing a non-UUID id for a
 * reason unrelated to the bound. The bound is asserted at the
 * core level, in `packages/core/tests/tuple-validation.test.ts`.
 * The 256-rune object survives, because a delete runs no model
 * validation at all and the length can move into the type name:
 * 219 characters, a `:` and a 36-character UUID is exactly 256.
 */

const TYPE = "doc_e1d";
const SUBJECT = "user_e1d";
const TEAM = "team_e1d";

const MODEL: WriteAuthorizationModelRequest = {
  schema_version: "1.1",
  type_definitions: [
    { type: SUBJECT, relations: {}, metadata: { relations: {} } },
    {
      type: TEAM,
      relations: { member: { this: {} } },
      metadata: {
        relations: {
          member: { directly_related_user_types: [{ type: SUBJECT }] },
        },
      },
    },
    {
      type: TYPE,
      relations: { viewer: { this: {} }, editor: { this: {} } },
      metadata: {
        relations: {
          viewer: {
            directly_related_user_types: [
              { type: SUBJECT },
              { type: SUBJECT, wildcard: {} },
              { type: TEAM, relation: "member" },
            ],
          },
          editor: { directly_related_user_types: [{ type: SUBJECT }] },
        },
      },
    },
  ],
};

/** The model after `editor` and `team_e1d` are dropped. */
const NARROWED_MODEL: WriteAuthorizationModelRequest = {
  schema_version: "1.1",
  type_definitions: [
    { type: SUBJECT, relations: {}, metadata: { relations: {} } },
    {
      type: TYPE,
      relations: { viewer: { this: {} } },
      metadata: {
        relations: {
          viewer: { directly_related_user_types: [{ type: SUBJECT }] },
        },
      },
    },
  ],
};

const CONFIGS: RelationConfig[] = [
  {
    objectType: TEAM,
    relation: "member",
    directlyAssignable: [{ type: SUBJECT }],
    impliedBy: null,
    computedUserset: null,
    tupleToUserset: null,
    excludedBy: null,
    intersection: null,
  },
  {
    objectType: TYPE,
    relation: "viewer",
    directlyAssignable: [
      { type: SUBJECT },
      { type: SUBJECT, wildcard: true },
      { type: TEAM, relation: "member" },
    ],
    impliedBy: null,
    computedUserset: null,
    tupleToUserset: null,
    excludedBy: null,
    intersection: null,
  },
  {
    objectType: TYPE,
    relation: "editor",
    directlyAssignable: [{ type: SUBJECT }],
    impliedBy: null,
    computedUserset: null,
    tupleToUserset: null,
    excludedBy: null,
    intersection: null,
  },
];

const BELL = "";

/** The fixture's well-formed ids. */
const DOC1 = "00000000-0000-4000-e130-000000000001";
const DOC2 = "00000000-0000-4000-e130-000000000002";
const ALICE = "00000000-0000-4000-e130-000000000011";
const BEA = "00000000-0000-4000-e130-000000000012";
const ABSENT = "00000000-0000-4000-e130-000000000013";
const TEAM1 = "00000000-0000-4000-e130-000000000021";

function key(overrides: Partial<RemoveTupleRequest>): RemoveTupleRequest {
  return {
    objectType: TYPE,
    objectId: DOC1,
    relation: "viewer",
    subjectType: SUBJECT,
    subjectId: ABSENT,
    ...overrides,
  };
}

describe("Delete gate conformance", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let modelId: string;
  let tsfgaClient: TsfgaClient;

  beforeAll(async () => {
    db = getDb();
    await beginTransaction(db);
    tsfgaClient = createTsfga(new KyselyTupleStore(db));
    storeId = await fgaCreateStore("delete-gate");
    modelId = await fgaWriteModelJson(storeId, MODEL);
    for (const config of CONFIGS) {
      await tsfgaClient.writeRelationConfig(config);
    }
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  /**
   * Refused syntactically -- the request never reaches the row.
   *
   * Every subject shape below fails `IsValidUser`'s three-way
   * union, or one of the three proto bounds. None of them is a
   * model question.
   */
  describe("refused before the row is looked for", () => {
    test("a subject holding a space", async () => {
      await expectDeleteConformance(
        storeId,
        modelId,
        tsfgaClient,
        key({ subjectId: "al ice" }),
        "refused",
      );
    });

    test("a subject holding a control character", async () => {
      await expectDeleteConformance(
        storeId,
        modelId,
        tsfgaClient,
        key({ subjectId: `al${BELL}ice` }),
        "refused",
      );
    });

    test("a subject holding a second colon", async () => {
      await expectDeleteConformance(
        storeId,
        modelId,
        tsfgaClient,
        key({ subjectId: "a:b" }),
        "refused",
      );
    });

    test("an empty subject id", async () => {
      await expectDeleteConformance(
        storeId,
        modelId,
        tsfgaClient,
        key({ subjectId: "" }),
        "refused",
      );
    });

    test("an empty subject type", async () => {
      await expectDeleteConformance(
        storeId,
        modelId,
        tsfgaClient,
        key({ subjectType: "", subjectId: ALICE }),
        "refused",
      );
    });

    test("an empty subject relation", async () => {
      // `user:a#` -- a `#` with nothing after it is neither a
      // userset nor an id.
      await expectDeleteConformance(
        storeId,
        modelId,
        tsfgaClient,
        key({ subjectId: ALICE, subjectRelation: "" }),
        "refused",
      );
    });

    test("a wildcard carrying a subject relation", async () => {
      // The wildcard-with-a-subject-relation shape, refused on the
      // delete path with no model rule involved at all: a `*` after the `:` fails
      // `IsValidUserset`, and the `#` fails `IsValidObject`.
      await expectDeleteConformance(
        storeId,
        modelId,
        tsfgaClient,
        key({ subjectId: "*", subjectRelation: "member" }),
        "refused",
      );
    });

    test("a subject relation holding a colon", async () => {
      await expectDeleteConformance(
        storeId,
        modelId,
        tsfgaClient,
        key({
          subjectType: TEAM,
          subjectId: TEAM1,
          subjectRelation: "mem:ber",
        }),
        "refused",
      );
    });

    test("a subject relation holding a hash", async () => {
      await expectDeleteConformance(
        storeId,
        modelId,
        tsfgaClient,
        key({
          subjectType: TEAM,
          subjectId: TEAM1,
          subjectRelation: "mem#ber",
        }),
        "refused",
      );
    });

    test("a subject relation holding a space", async () => {
      await expectDeleteConformance(
        storeId,
        modelId,
        tsfgaClient,
        key({
          subjectType: TEAM,
          subjectId: TEAM1,
          subjectRelation: "mem ber",
        }),
        "refused",
      );
    });

    test("a subject relation holding a control character", async () => {
      await expectDeleteConformance(
        storeId,
        modelId,
        tsfgaClient,
        key({
          subjectType: TEAM,
          subjectId: TEAM1,
          subjectRelation: `mem${BELL}ber`,
        }),
        "refused",
      );
    });

    test("a rendered object of 257 runes", async () => {
      await expectDeleteConformance(
        storeId,
        modelId,
        tsfgaClient,
        key({ objectType: "t".repeat(220), objectId: DOC1 }),
        "refused",
      );
    });

    test("a relation holding a space", async () => {
      await expectDeleteConformance(
        storeId,
        modelId,
        tsfgaClient,
        key({ relation: "vie wer" }),
        "refused",
      );
    });

    test("a relation of 51 characters", async () => {
      await expectDeleteConformance(
        storeId,
        modelId,
        tsfgaClient,
        key({ relation: "v".repeat(51) }),
        "refused",
      );
    });
  });

  /**
   * Accepted syntactically, and then simply not there.
   *
   * These are the guard. Every one is a shape the *write* gate
   * refuses, and refusing any of them here would be over-gating a
   * request upstream performs.
   */
  describe("falls through to the row, and the row is absent", () => {
    test("an empty relation", async () => {
      // protovalidate patterns do not run on an empty field, so
      // the relation pattern does not apply and this falls
      // through.
      await expectDeleteConformance(
        storeId,
        modelId,
        tsfgaClient,
        key({ relation: "" }),
        "missing",
      );
    });

    test("the reserved relation name 'self'", async () => {
      await expectDeleteConformance(
        storeId,
        modelId,
        tsfgaClient,
        key({ relation: "self" }),
        "missing",
      );
    });

    test("a relation the model does not define", async () => {
      await expectDeleteConformance(
        storeId,
        modelId,
        tsfgaClient,
        key({ relation: "nosuchrel" }),
        "missing",
      );
    });

    test("a relation of 50 characters the model does not define", async () => {
      await expectDeleteConformance(
        storeId,
        modelId,
        tsfgaClient,
        key({ relation: "v".repeat(50) }),
        "missing",
      );
    });

    test("an object type the model does not define", async () => {
      await expectDeleteConformance(
        storeId,
        modelId,
        tsfgaClient,
        key({ objectType: "nosuchtype_e1d" }),
        "missing",
      );
    });

    test("a subject type the relation does not admit", async () => {
      await expectDeleteConformance(
        storeId,
        modelId,
        tsfgaClient,
        key({ objectType: TYPE, relation: "editor", subjectType: TEAM }),
        "missing",
      );
    });

    test("a wildcard subject that was never written", async () => {
      await expectDeleteConformance(
        storeId,
        modelId,
        tsfgaClient,
        key({ subjectId: "*" }),
        "missing",
      );
    });

    test("a userset naming a relation the subject type lacks", async () => {
      await expectDeleteConformance(
        storeId,
        modelId,
        tsfgaClient,
        key({ subjectType: TEAM, subjectId: TEAM1, subjectRelation: "nosuch" }),
        "missing",
      );
    });

    test("a rendered object of exactly 256 runes", async () => {
      // The bound stays exercisable with the length carried by the
      // type name rather than the id.
      await expectDeleteConformance(
        storeId,
        modelId,
        tsfgaClient,
        key({ objectType: "t".repeat(219), objectId: DOC1 }),
        "missing",
      );
    });
  });

  /**
   * Upstream reaches the row; this store refuses the id.
   *
   * These seven were fall-through rows — the guard that the delete
   * gate is not the write gate — and every one of them is built on
   * an id a canonical UUID cannot express, which is exactly what
   * made them test anything. Under `@tsfga/kysely`'s id domain
   * tsfga refuses them, one rule *after* the delete gate rather
   * than inside it.
   *
   * So the guard changes shape and does not disappear. It still
   * fails if someone re-widens the delete gate to the write
   * validators, because the refusal would then arrive from the
   * wrong rule and upstream's side of the pin would still say
   * `missing`. And a pin refuses to pass on agreement: the day
   * upstream starts refusing one of these too, this goes red and
   * the row belongs back in the parity set above.
   *
   * Registered under `ID-DOMAIN-OUT-OF-DOMAIN` in
   * `packages/core/capability-refusals.json`.
   */
  describe("upstream reaches the row and the id domain refuses", () => {
    const idShaped: ReadonlyArray<[string, Partial<RemoveTupleRequest>]> = [
      ["an object id holding a colon", { objectId: "a:b" }],
      ["an object id holding a hash", { objectId: "a#b" }],
      ["an object id holding an at sign", { objectId: "a@b" }],
      ["an object id holding a control character", { objectId: `a${BELL}b` }],
      ["an object id that is a typed wildcard", { objectId: "*" }],
      ["an empty object id", { objectId: "" }],
      ["a subject id holding a hash", { subjectId: "a#b" }],
    ];

    for (const [name, overrides] of idShaped) {
      test(name, async () => {
        await expectPinnedDeleteDivergence(
          storeId,
          modelId,
          tsfgaClient,
          key(overrides),
          { openfga: "missing", tsfga: "refused" },
        );
      });
    }
  });

  test("a delete that is both malformed and absent reports the refusal", async () => {
    // Structurally it must: protovalidate at the boundary,
    // `IsValidUser` in the request validation, the missing-row
    // check inside `Execute` afterwards. Asserted rather than
    // inherited from statement order.
    await expectDeleteConformance(
      storeId,
      modelId,
      tsfgaClient,
      key({
        objectType: "nosuchtype_e1d",
        objectId: DOC1,
        relation: "nosuchrel",
        subjectId: "al ice",
      }),
      "refused",
    );
  });

  test("the control: a row that is there is deleted", async () => {
    await fgaWriteTuplesRaw(storeId, modelId, [
      {
        user: `${SUBJECT}:${ALICE}`,
        relation: "viewer",
        object: `${TYPE}:${DOC1}`,
      },
    ]);
    await tsfgaClient.addTuple({
      objectType: TYPE,
      objectId: DOC1,
      relation: "viewer",
      subjectType: SUBJECT,
      subjectId: ALICE,
    });
    await expectDeleteConformance(
      storeId,
      modelId,
      tsfgaClient,
      key({ objectId: DOC1, subjectId: ALICE }),
      "accepted",
    );
  });

  test("a row survives the model that defined it being dropped", async () => {
    // The property the whole fall-through set exists for. A tuple
    // written under a model that defines `editor` and `team_e1d`
    // is deleted under a model that defines neither -- so a bad
    // model change is recoverable rather than a trap.
    await fgaWriteTuplesRaw(storeId, modelId, [
      {
        user: `${SUBJECT}:${BEA}`,
        relation: "editor",
        object: `${TYPE}:${DOC2}`,
      },
    ]);
    await tsfgaClient.addTuple({
      objectType: TYPE,
      objectId: DOC2,
      relation: "editor",
      subjectType: SUBJECT,
      subjectId: BEA,
    });

    const narrowedId = await fgaWriteModelJson(storeId, NARROWED_MODEL);
    await tsfgaClient.deleteRelationConfig(TYPE, "editor");
    await tsfgaClient.deleteRelationConfig(TEAM, "member");

    await expectDeleteConformance(
      storeId,
      narrowedId,
      tsfgaClient,
      key({ objectId: DOC2, relation: "editor", subjectId: BEA }),
      "accepted",
    );
  });
});
