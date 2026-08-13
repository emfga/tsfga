import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { OpenFgaClient } from "@openfga/sdk";
import { createTsfga, type TsfgaClient, TsfgaError } from "@tsfga/core";
import type { DB } from "@tsfga/kysely";
import { KyselyTupleStore } from "@tsfga/kysely";
import type { Kysely } from "kysely";
import {
  expectConfigsMatchModel,
  expectConformance,
  expectPinnedDivergence,
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
  fgaWriteTuplesRaw,
} from "./helpers/openfga.ts";

/**
 * What a request may *say*, as opposed to what the model may
 * answer.
 *
 * Upstream validates a check's three strings before it resolves
 * anything, through two gates:
 *
 * 1. the protobuf patterns on `CheckRequestTupleKey` —
 *    `^[^:#@\s]{1,50}$` for the relation, `^[^\s]{2,256}$` for the
 *    object and `^[^\s]{2,512}$` for the user — which catch the
 *    whitespace class and the length bounds; and
 * 2. `validateCheckCommandParams` →
 *    `tuple.ValidateTupleKey`/`IsValidObject`/`IsValidUser`, whose
 *    id predicates begin with `unicode.IsControl`, which catches
 *    `U+0001`, `U+007F`, `U+0085` and `U+000B`.
 *
 * tsfga spells the same request as five fields and gates one of
 * them: `validateCheckSubject` refuses a `:` or a `#` in
 * `subjectId`, and nothing looks at `objectId` at all. The rest of
 * the surface is covered by accident — a relation, an object type
 * or a subject type carrying a control character names no relation
 * config, so the check refuses with
 * `RelationConfigNotFoundError`, and both engines land on
 * "refused". The two fields that carry an **id** are not covered:
 * an id whose bytes upstream rejects is a perfectly good text
 * column value, so tsfga reads no row and answers `false`.
 *
 * The direction is answering where upstream refuses. That is not
 * the granting direction and it is not an outage — but a caller
 * whose id arrived from an untrusted source gets `false` from
 * tsfga and a 400 from OpenFGA, so the two engines disagree about
 * whether the request was ever a question, and the shape survives
 * into `listObjects`, `listSubjects` and `checkMany`.
 *
 * `listSubjects` and `checkMany` have no helper in
 * `tests/conformance/helpers/`, and this file may not add one, so
 * the two comparisons at the bottom drive the SDK directly. Their
 * upstream counterparts are `ListUsers` and `BatchCheck`.
 *
 * Measured against v1.18.2. The character classes are the two
 * upstream gates and nothing wider: a non-breaking space is an
 * ordinary character to both engines, which the controls assert.
 */

const uuidMap = new Map<string, string>([
  ["alice", "00000000-0000-4000-d530-000000000011"],
  ["doc", "00000000-0000-4000-d530-000000000012"],
  ["team", "00000000-0000-4000-d530-000000000013"],
]);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

/** `unicode.IsControl`, plus the whitespace the pattern catches. */
const MALFORMED: ReadonlyArray<readonly [string, string]> = [
  ["U+0001", String.fromCharCode(1)],
  ["U+007F", String.fromCharCode(127)],
  ["U+0085", String.fromCharCode(133)],
  ["U+000B", String.fromCharCode(11)],
  ["a newline", String.fromCharCode(10)],
  ["a tab", String.fromCharCode(9)],
  ["a space", " "],
];

const NBSP = String.fromCharCode(160);

describe("Request identifier conformance", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let modelId: string;
  let tsfgaClient: TsfgaClient;
  let fixture: FixtureRecord;
  let fga: OpenFgaClient;

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
      objectType: "doc_d2i",
      relation: "viewer",
      directlyAssignable: [
        { type: "user_d2i" },
        { type: "team_d2i", relation: "member" },
      ],
      ...plain,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "team_d2i",
      relation: "member",
      directlyAssignable: [{ type: "user_d2i" }],
      ...plain,
    });
    await tsfgaClient.addTuple({
      objectType: "doc_d2i",
      objectId: uuid("doc"),
      relation: "viewer",
      subjectType: "user_d2i",
      subjectId: uuid("alice"),
    });

    storeId = await fgaCreateStore("request-idents");
    modelId = await fgaWriteModel(storeId, "./request-idents/model.dsl");
    await fgaWriteTuplesRaw(storeId, modelId, [
      {
        user: `user_d2i:${uuid("alice")}`,
        relation: "viewer",
        object: `doc_d2i:${uuid("doc")}`,
      },
    ]);
    fga = new OpenFgaClient({ apiUrl: process.env.FGA_API_URL, storeId });
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  const check = (
    overrides: {
      objectType?: string;
      objectId?: string;
      relation?: string;
      subjectType?: string;
      subjectId?: string;
      subjectRelation?: string | null;
    },
    expected: boolean | "refused",
  ) =>
    expectConformance(
      storeId,
      modelId,
      tsfgaClient,
      {
        objectType: "doc_d2i",
        objectId: uuid("doc"),
        relation: "viewer",
        subjectType: "user_d2i",
        subjectId: uuid("alice"),
        ...overrides,
      },
      expected,
    );

  /**
   * A check whose id upstream admits and this store cannot hold.
   *
   * Not a hole and not a hedge: `@tsfga/kysely` declares a
   * canonical-UUID id domain, so every id upstream accepts that is
   * not one is refused here. Pinned two-sidedly, so it fails the
   * day either engine moves.
   */
  const pinned = (overrides: {
    objectId?: string;
    subjectId?: string;
  }): Promise<void> =>
    expectPinnedDivergence(
      storeId,
      modelId,
      tsfgaClient,
      {
        objectType: "doc_d2i",
        objectId: uuid("doc"),
        relation: "viewer",
        subjectType: "user_d2i",
        subjectId: uuid("alice"),
        ...overrides,
      },
      { openfga: false, tsfga: "refused" },
    );

  /**
   * `listObjects` parity where **both** calls are expected to
   * refuse.
   *
   * `expectListObjectsConformance` compares two object sets and
   * `fgaListObjects` raises rather than reporting a refusal, so
   * neither can express "upstream declines the request". Written
   * here rather than in the shared helper because this file may
   * not touch `helpers/`; a refusal-aware `listObjects` assertion
   * belongs there, and the round log says so.
   */
  async function expectListObjectsRefusal(params: {
    objectType: string;
    relation: string;
    subjectType: string;
    subjectId: string;
  }): Promise<void> {
    const tsfga = await tsfgaClient
      .listObjects(params)
      .then((objects) => JSON.stringify([...objects].sort()))
      .catch((error: unknown) => {
        if (error instanceof TsfgaError) return "refused";
        throw error;
      });
    const openfga = await fga
      .listObjects(
        {
          user: `${params.subjectType}:${params.subjectId}`,
          relation: params.relation,
          type: params.objectType,
        },
        { authorizationModelId: modelId },
      )
      .then((response) => JSON.stringify([...(response.objects ?? [])].sort()))
      .catch(() => "refused");

    expect(openfga).toBe("refused");
    expect(tsfga).toBe(openfga);
  }

  describe("the object id is not validated", () => {
    for (const [name, char] of MALFORMED) {
      test(`an object id containing ${name}`, async () => {
        await check({ objectId: `${uuid("doc")}${char}` }, "refused");
      });
    }

    test("an empty object id", async () => {
      // `doc_d2i:` has an id of length zero, which `IsValidObject`
      // refuses.
      await check({ objectId: "" }, "refused");
    });

    test("an object id past the wire length limit", async () => {
      await check({ objectId: "a".repeat(300) }, "refused");
    });

    test("a non-breaking space in an object id is refused here", async () => {
      // The control for the character class: `NBSP` is an ordinary
      // character to both engines, so upstream answers `false`
      // rather than 400 and neither `IsValidObject` nor
      // `unicode.IsControl` is involved. What refuses it here is
      // the store's id domain — an id upstream admits and a `uuid`
      // column cannot hold — one rule after the request gate.
      await pinned({ objectId: `${uuid("doc")}${NBSP}` });
    });
  });

  describe("the subject id is validated only for ':' and '#'", () => {
    for (const [name, char] of MALFORMED) {
      test(`a subject id containing ${name}`, async () => {
        await check({ subjectId: `${uuid("alice")}${char}` }, "refused");
      });
    }

    test("an empty subject id", async () => {
      await check({ subjectId: "" }, "refused");
    });

    test("a subject id past the wire length limit", async () => {
      await check({ subjectId: "a".repeat(600) }, "refused");
    });

    test("a non-breaking space in a subject id is refused here", async () => {
      // The subject-side control, refused for the same reason.
      await pinned({ subjectId: `${uuid("alice")}${NBSP}` });
    });

    test("the two characters tsfga does gate are refused by both", async () => {
      await check({ subjectId: `${uuid("alice")}:x` }, "refused");
      await check({ subjectId: `${uuid("alice")}#ghost` }, "refused");
    });
  });

  describe("listObjects carries the same hole", () => {
    test("a subject id containing a control character", async () => {
      await expectListObjectsRefusal({
        objectType: "doc_d2i",
        relation: "viewer",
        subjectType: "user_d2i",
        subjectId: `${uuid("alice")}${String.fromCharCode(1)}`,
      });
    });

    test("a subject id containing a space", async () => {
      await expectListObjectsRefusal({
        objectType: "doc_d2i",
        relation: "viewer",
        subjectType: "user_d2i",
        subjectId: `${uuid("alice")} `,
      });
    });

    test("an empty subject id", async () => {
      await expectListObjectsRefusal({
        objectType: "doc_d2i",
        relation: "viewer",
        subjectType: "user_d2i",
        subjectId: "",
      });
    });
  });

  /**
   * `listSubjects` against upstream's `ListUsers`.
   *
   * Only the whitespace class is asserted here, because that is
   * the only one that diverges: `ListUsers` validates its object
   * through the protobuf pattern and **not** through
   * `unicode.IsControl`, so a `U+0001` in the object id is a
   * question upstream answers (with no users) rather than
   * refusing. tsfga also answers it with no subjects, so that cell
   * agrees and is asserted as agreement.
   */
  describe("listSubjects carries the same hole", () => {
    async function outcomes(objectId: string): Promise<[string, string]> {
      const tsfga = await tsfgaClient
        .listSubjects("doc_d2i", objectId, "viewer")
        .then((subjects) => JSON.stringify(subjects.map((s) => s.subjectId)))
        .catch((error: unknown) => {
          if (error instanceof TsfgaError) return "refused";
          throw error;
        });
      const openfga = await fga
        .listUsers(
          {
            object: { type: "doc_d2i", id: objectId },
            relation: "viewer",
            user_filters: [{ type: "user_d2i" }],
          },
          { authorizationModelId: modelId },
        )
        .then((response) =>
          JSON.stringify(
            (response.users ?? []).map((user) => user.object?.id ?? ""),
          ),
        )
        .catch(() => "refused");
      return [tsfga, openfga];
    }

    test("control: both report the subject of a well-formed id", async () => {
      const [tsfga, openfga] = await outcomes(uuid("doc"));
      expect(tsfga).toBe(JSON.stringify([uuid("alice")]));
      expect(openfga).toBe(tsfga);
    });

    test("an object id containing a space", async () => {
      const [tsfga, openfga] = await outcomes(`${uuid("doc")} `);
      expect(openfga).toBe("refused");
      expect(tsfga).toBe(openfga);
    });

    test("an empty object id", async () => {
      const [tsfga, openfga] = await outcomes("");
      expect(openfga).toBe("refused");
      expect(tsfga).toBe(openfga);
    });

    test("a control character in a ListUsers object id diverges", async () => {
      // Upstream's ListUsers does not run `unicode.IsControl` over
      // its object, so it answers — which is why `listSubjects`
      // keeps a narrower object rule than `check` and the fix was
      // never "apply the check rule everywhere". The store's id
      // domain is what refuses it, behind that narrower rule.
      const [tsfga, openfga] = await outcomes(
        `${uuid("doc")}${String.fromCharCode(1)}`,
      );
      expect(openfga).toBe("[]");
      expect(tsfga).toBe("refused");
    });
  });

  /**
   * `checkMany` against upstream's `BatchCheck`, where a malformed
   * item is a **per-item** failure on both sides: upstream reports
   * `error.input_error = validation_error` beside
   * `allowed: false`, and tsfga's `CheckOutcome` has the same
   * shape. So the comparison is not "does the batch fail" but
   * "does the item that upstream could not resolve carry an
   * error", and today tsfga's does not — it carries a plain
   * `false`, which is a *decision*.
   */
  describe("checkMany reports a decision, not a failure", () => {
    async function outcomes(
      objectId: string,
      subjectId: string,
    ): Promise<[boolean, boolean]> {
      const [outcome] = await tsfgaClient.checkMany([
        {
          objectType: "doc_d2i",
          objectId,
          relation: "viewer",
          subjectType: "user_d2i",
          subjectId,
        },
      ]);
      if (!outcome) throw new Error("checkMany returned no outcome");
      const response = await fga.batchCheck(
        {
          checks: [
            {
              user: `user_d2i:${subjectId}`,
              relation: "viewer",
              object: `doc_d2i:${objectId}`,
              correlationId: "d2000000",
            },
          ],
        },
        { authorizationModelId: modelId },
      );
      const item = response.result[0];
      if (!item) throw new Error("BatchCheck returned no item");
      return [outcome.error !== undefined, item.error !== undefined];
    }

    test("control: a well-formed item carries no error on either", async () => {
      const [tsfga, openfga] = await outcomes(uuid("doc"), uuid("alice"));
      expect(tsfga).toBe(false);
      expect(openfga).toBe(tsfga);
    });

    test("an item whose object id holds a control char", async () => {
      const [tsfga, openfga] = await outcomes(
        `${uuid("doc")}${String.fromCharCode(1)}`,
        uuid("alice"),
      );
      expect(openfga).toBe(true);
      expect(tsfga).toBe(openfga);
    });

    test("an item whose subject id holds a control char", async () => {
      const [tsfga, openfga] = await outcomes(
        uuid("doc"),
        `${uuid("alice")}${String.fromCharCode(1)}`,
      );
      expect(openfga).toBe(true);
      expect(tsfga).toBe(openfga);
    });
  });

  /**
   * The rest of the request, which agrees — by coincidence rather
   * than by rule, since tsfga refuses these as "no such relation
   * config" and upstream as "malformed field". Asserted so a fix
   * for the ids above does not quietly change them.
   */
  describe("the fields that are not ids already refuse", () => {
    for (const [name, char] of MALFORMED) {
      test(`a relation containing ${name} is refused by both`, async () => {
        await check({ relation: `viewer${char}` }, "refused");
      });
    }

    test("an object type containing a control character", async () => {
      await check(
        { objectType: `doc_d2i${String.fromCharCode(1)}` },
        "refused",
      );
    });

    test("a subject type containing a control character", async () => {
      await check(
        { subjectType: `user_d2i${String.fromCharCode(1)}` },
        "refused",
      );
    });

    test("a subject relation containing a control character", async () => {
      await check(
        {
          subjectType: "team_d2i",
          subjectId: uuid("team"),
          subjectRelation: `member${String.fromCharCode(1)}`,
        },
        "refused",
      );
    });

    test("an empty relation or object type is refused by both", async () => {
      await check({ relation: "" }, "refused");
      await check({ objectType: "" }, "refused");
    });

    test("the well-formed request answers on both", async () => {
      await check({}, true);
    });
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./request-idents/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
