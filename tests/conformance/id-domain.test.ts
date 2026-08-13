import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTsfga, type TsfgaClient } from "@tsfga/core";
import type { DB } from "@tsfga/kysely";
import { KyselyTupleStore } from "@tsfga/kysely";
import type { Kysely } from "kysely";
import {
  expectConformance,
  expectPinnedDeleteDivergence,
  expectPinnedDivergence,
  expectPinnedListObjectsDivergence,
  expectPinnedWriteDivergence,
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
import { fgaListUsers } from "./rewrites/listusers.ts";

/**
 * The one divergence `@tsfga/kysely` buys deliberately: an id
 * OpenFGA accepts and a `uuid` column cannot hold.
 *
 * **It is a class, not a list.** Every string upstream admits as
 * an id — non-empty, no control character, no `#`, `:` or space —
 * that is not a canonical lower-case hyphenated UUID is refused
 * here, permanently. The rows below are representatives of that
 * class, not an enumeration of it.
 *
 * Two groups, and the second is the one that carries the safety
 * argument. The first is ids that are not UUIDs at all: `alice`,
 * `café`, a 300-character id. The second is ids that *are* the
 * same UUID as far as PostgreSQL is concerned and are distinct ids
 * as far as OpenFGA is concerned — the uppercase, hyphenless,
 * braced and odd-hyphen spellings. Admitting any of those would
 * let a grant written for one answer `true` for another, which is
 * the only granting-direction hole this design could have. They
 * are refused for a stronger reason than the first group, and the
 * pins say so.
 *
 * The positive control is the nil UUID. It used to *be* the typed
 * wildcard in this store, so a subject that happened to carry it
 * read back as everyone. It is an ordinary id now, admitted by
 * both engines, answering `true` for itself and nothing else.
 */

const uuidMap = new Map<string, string>([
  ["alice", "00000000-0000-4000-d590-000000000001"],
  ["bob", "00000000-0000-4000-d590-000000000002"],
  ["doc1", "00000000-0000-4000-d590-000000000101"],
  ["doc2", "00000000-0000-4000-d590-000000000102"],
]);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

/** The nil UUID: an ordinary id, and the point of the whole move. */
const NIL = "00000000-0000-0000-0000-000000000000";

/**
 * A slug the pinned writes above never use.
 *
 * The path rows below assert what upstream answers for an
 * out-of-domain id, and every id in `OUT_OF_DOMAIN` has by then
 * been *granted* upstream by the write pins — so reusing one would
 * have upstream answer `true` and the pin would be measuring the
 * fixture rather than the rule.
 */
const UNWRITTEN = "no-such-subject";

/** A fresh object per write, so no write is refused as a duplicate. */
let nextObject = 0;
function objectId(): string {
  nextObject++;
  return `00000000-0000-4000-d590-2${String(nextObject).padStart(11, "0")}`;
}

const TYPE = "doc_b6";
const SUBJECT = "user_b6";

/**
 * Ids upstream accepts and this store cannot hold, each with what
 * makes it inadmissible.
 *
 * The five UUID spellings are measured: PostgreSQL's `uuid_in`
 * accepts each one and stores it as the same row as the canonical
 * spelling, while OpenFGA v1.18.2 treats each as a distinct id.
 */
const CANONICAL = uuid("alice");
const OUT_OF_DOMAIN: ReadonlyArray<[string, string]> = [
  ["a slug", "alice"],
  ["a non-ASCII id", "café"],
  // 200 rather than 300, measured: `TupleKey.object` is
  // `^[^\s]{2,256}$` on the *rendered* `doc_b6:<id>`, so a
  // 300-character object id is refused upstream too and would be
  // a parity row rather than a divergence. 200 is inside
  // upstream's bound in both positions and outside this store's
  // domain in both. The 300-character *subject* is pinned in
  // `write-limits.test.ts`, where the bound is 512 bytes.
  ["a 200-character id", "x".repeat(200)],
  ["the uppercase spelling of a UUID", CANONICAL.toUpperCase()],
  ["the hyphenless spelling of a UUID", CANONICAL.replaceAll("-", "")],
  ["the braced spelling of a UUID", `{${CANONICAL}}`],
  ["an oddly hyphenated UUID", "0000-0000-0000-4000-d590-0000-00000001"],
  ["36 non-hex characters", "zzzzzzzz-zzzz-4000-d590-zzzzzzzzzzzz"],
];

describe("The store's id domain", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let modelId: string;
  let tsfgaClient: TsfgaClient;

  beforeAll(async () => {
    db = getDb();
    await beginTransaction(db);
    tsfgaClient = createTsfga(new KyselyTupleStore(db));

    await tsfgaClient.writeRelationConfig({
      objectType: TYPE,
      relation: "viewer",
      directlyAssignable: [
        { type: SUBJECT },
        { type: SUBJECT, wildcard: true },
      ],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });

    storeId = await fgaCreateStore("id-domain");
    modelId = await fgaWriteModel(storeId, "./id-domain/model.dsl");
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  describe("a slug upstream accepts and a uuid column cannot hold", () => {
    for (const [name, id] of OUT_OF_DOMAIN) {
      test(`${name}, as a subject id`, async () => {
        await expectPinnedWriteDivergence(
          storeId,
          modelId,
          tsfgaClient,
          {
            objectType: TYPE,
            objectId: objectId(),
            relation: "viewer",
            subjectType: SUBJECT,
            subjectId: id,
          },
          { openfga: "accepted", tsfga: "refused" },
        );
      });

      test(`${name}, as an object id`, async () => {
        await expectPinnedWriteDivergence(
          storeId,
          modelId,
          tsfgaClient,
          {
            objectType: TYPE,
            objectId: id,
            relation: "viewer",
            subjectType: SUBJECT,
            subjectId: uuid("bob"),
          },
          { openfga: "accepted", tsfga: "refused" },
        );
      });
    }
  });

  describe("the refusal reaches every entry point", () => {
    test("check, on the object id", async () => {
      await expectPinnedDivergence(
        storeId,
        modelId,
        tsfgaClient,
        {
          objectType: TYPE,
          objectId: "readme.md",
          relation: "viewer",
          subjectType: SUBJECT,
          subjectId: uuid("alice"),
        },
        { openfga: false, tsfga: "refused" },
      );
    });

    test("check, on the subject id", async () => {
      await expectPinnedDivergence(
        storeId,
        modelId,
        tsfgaClient,
        {
          objectType: TYPE,
          objectId: uuid("doc1"),
          relation: "viewer",
          subjectType: SUBJECT,
          subjectId: UNWRITTEN,
        },
        { openfga: false, tsfga: "refused" },
      );
    });

    test("check, on a contextual tuple's id", async () => {
      // Chosen, not forced. A contextual tuple is never written,
      // so an out-of-domain id in one could not reach the column
      // even ungated -- the refusal is honest (such a tuple could
      // never match a stored row) but the storage does not require
      // it, and `capability-refusals.json` says so rather than
      // passing it off as a consequence of the column type.
      await expectPinnedDivergence(
        storeId,
        modelId,
        tsfgaClient,
        {
          objectType: TYPE,
          objectId: uuid("doc2"),
          relation: "viewer",
          subjectType: SUBJECT,
          subjectId: uuid("alice"),
          contextualTuples: [
            {
              objectType: TYPE,
              objectId: uuid("doc2"),
              relation: "viewer",
              subjectType: SUBJECT,
              subjectId: "carol",
            },
          ],
        },
        { openfga: false, tsfga: "refused" },
      );
    });

    test("listObjects, on the subject id", async () => {
      await expectPinnedListObjectsDivergence(
        storeId,
        modelId,
        tsfgaClient,
        {
          objectType: TYPE,
          relation: "viewer",
          subjectType: SUBJECT,
          subjectId: UNWRITTEN,
        },
        { openfga: [], tsfga: "refused" },
      );
    });

    test("removeTuple, on the object id", async () => {
      await expectPinnedDeleteDivergence(
        storeId,
        modelId,
        tsfgaClient,
        {
          objectType: TYPE,
          objectId: "readme.md",
          relation: "viewer",
          subjectType: SUBJECT,
          subjectId: uuid("alice"),
        },
        { openfga: "missing", tsfga: "refused" },
      );
    });

    test("listSubjects, on the object id", async () => {
      // No upstream-comparing helper exists for `listSubjects`,
      // so this is `fgaListUsers` directly -- guarded by an
      // assertion that upstream *answered*, since a pin that
      // passes when upstream errors for an unrelated reason is
      // asserting nothing.
      const upstream = await fgaListUsers(storeId, modelId, {
        objectType: TYPE,
        objectId: "readme.md",
        relation: "viewer",
        filters: [{ type: SUBJECT }],
      });
      expect(upstream).toEqual([]);

      let refused = false;
      try {
        await tsfgaClient.listSubjects(TYPE, "readme.md", "viewer");
      } catch {
        refused = true;
      }
      expect(refused).toBe(true);
    });
  });

  describe("the nil UUID is an ordinary id", () => {
    // Not a pin: both engines agree. It is why the domain checks no
    // version nibble -- a v4 predicate would refuse the exact value
    // this design frees.
    test("both engines accept a grant to it", async () => {
      await fgaWriteTuplesRaw(storeId, modelId, [
        {
          user: `${SUBJECT}:${NIL}`,
          relation: "viewer",
          object: `${TYPE}:${uuid("doc1")}`,
        },
      ]);
      await tsfgaClient.addTuple({
        objectType: TYPE,
        objectId: uuid("doc1"),
        relation: "viewer",
        subjectType: SUBJECT,
        subjectId: NIL,
      });
      await expectConformance(
        storeId,
        modelId,
        tsfgaClient,
        {
          objectType: TYPE,
          objectId: uuid("doc1"),
          relation: "viewer",
          subjectType: SUBJECT,
          subjectId: NIL,
        },
        true,
      );
    });

    test("and it grants nobody else", async () => {
      // The half that used to fail. Under the nil-UUID wildcard
      // encoding this row read back as `user_b6:*` and answered
      // `true` for every subject of the type.
      await expectConformance(
        storeId,
        modelId,
        tsfgaClient,
        {
          objectType: TYPE,
          objectId: uuid("doc1"),
          relation: "viewer",
          subjectType: SUBJECT,
          subjectId: uuid("bob"),
        },
        false,
      );
    });
  });
});
