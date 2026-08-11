import { afterAll, beforeAll, describe, test } from "bun:test";
import type { AddTupleRequest, TsfgaClient } from "@tsfga/core";
import type { DB } from "@tsfga/kysely";
import type { Kysely } from "kysely";
import { setupGdrive, teardownGdrive, uuid } from "./gdrive/setup.ts";
import { expectListObjectsConformance } from "./helpers/conformance.ts";

/**
 * `listObjects` against OpenFGA's ListObjects.
 *
 * Nothing under this directory referenced the operation before, so
 * it had never been compared to upstream at all — every conformance
 * assertion in the suite was a single-object `check`.
 *
 * The gdrive fixture is used because the shapes are what decide
 * whether this suite is worth anything. A subject reaches
 * `doc:private` only through a userset, `doc:public` only through a
 * tuple-to-userset onto a wildcard, and `doc:design` through a
 * tuple-to-userset onto an implied relation. An implementation that
 * expanded nothing and returned the objects the subject is written
 * on would satisfy a direct-tuple suite and fail this one — with
 * `group.member` below as the control that such an implementation
 * would still pass, so the difference is the expansion and not the
 * fixture.
 */

describe("listObjects Conformance", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let authorizationModelId: string;
  let tsfgaClient: TsfgaClient;

  beforeAll(async () => {
    ({ db, storeId, authorizationModelId, tsfgaClient } = await setupGdrive());
  });

  afterAll(async () => {
    await teardownGdrive(db);
  });

  /** Objects of `objectType` the named subject must reach. */
  async function expectObjects(
    objectType: string,
    relation: string,
    subject: string,
    expected: string[],
  ): Promise<void> {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType,
        relation,
        subjectType: "user",
        subjectId: uuid(subject),
      },
      expected.map(uuid),
    );
  }

  describe("the shapes an unexpanded implementation would miss", () => {
    test("a userset reaches doc:private", async () => {
      // alice is written on group:engineering, not on doc:private.
      await expectObjects("doc", "viewer", "alice", ["private"]);
    });

    test("a wildcard through a TTU reaches doc:public", async () => {
      // charlie is written on nothing at all.
      await expectObjects("doc", "can_read", "charlie", ["public"]);
    });

    test("a TTU onto an implied relation reaches doc:design", async () => {
      // alice owns folder:root, which implies viewer on it, which
      // doc:design inherits through its parent.
      await expectObjects("doc", "can_share", "alice", ["design"]);
    });
  });

  describe("every route to a doc at once", () => {
    test("alice reads all three", async () => {
      await expectObjects("doc", "can_read", "alice", [
        "design",
        "public",
        "private",
      ]);
    });

    test("bob reads all three, one of them directly", async () => {
      await expectObjects("doc", "can_read", "bob", [
        "design",
        "public",
        "private",
      ]);
    });

    test("charlie writes none", async () => {
      await expectObjects("doc", "can_write", "charlie", []);
    });

    test("only the owner may change the owner", async () => {
      await expectObjects("doc", "can_change_owner", "bob", ["design"]);
      await expectObjects("doc", "can_change_owner", "alice", []);
    });
  });

  describe("folders", () => {
    test("owning one folder and seeing two", async () => {
      // folder:shared is reached by the wildcard, folder:root by
      // ownership implying viewer.
      await expectObjects("folder", "viewer", "alice", ["root", "shared"]);
    });

    test("the wildcard alone reaches folder:shared", async () => {
      await expectObjects("folder", "viewer", "charlie", ["shared"]);
    });

    test("a computed userset reaches folder:root", async () => {
      await expectObjects("folder", "can_create_file", "alice", ["root"]);
      await expectObjects("folder", "can_create_file", "bob", []);
    });
  });

  test("the control: a direct relation needs no expansion", async () => {
    await expectObjects("group", "member", "alice", ["engineering"]);
  });

  /**
   * `ListObjectsRequest` carries `contextual_tuples` upstream. The
   * tsfga signature had nowhere to put them, so none of this could
   * be written at all before the request object replaced the flat
   * arguments.
   */
  describe("contextual tuples", () => {
    /** As `expectObjects`, with tuples that exist for the call. */
    async function expectObjectsWith(
      objectType: string,
      relation: string,
      subject: string,
      contextualTuples: AddTupleRequest[],
      expected: string[],
    ): Promise<void> {
      await expectListObjectsConformance(
        storeId,
        authorizationModelId,
        tsfgaClient,
        {
          objectType,
          relation,
          subjectType: "user",
          subjectId: uuid(subject),
          contextualTuples,
        },
        expected.map(uuid),
      );
    }

    test("a contextual direct tuple adds an object", async () => {
      // charlie writes nothing; owning doc:private makes him a
      // writer of it and of nothing else.
      await expectObjectsWith(
        "doc",
        "can_write",
        "charlie",
        [
          {
            objectType: "doc",
            objectId: uuid("private"),
            relation: "owner",
            subjectType: "user",
            subjectId: uuid("charlie"),
          },
        ],
        ["private"],
      );
    });

    test("a contextual userset tuple expands", async () => {
      // The tuple grants group:engineering#member on doc:design,
      // and alice is a member, so the object must appear through an
      // expansion rather than through the row itself.
      await expectObjectsWith(
        "doc",
        "viewer",
        "alice",
        [
          {
            objectType: "doc",
            objectId: uuid("design"),
            relation: "viewer",
            subjectType: "group",
            subjectId: uuid("engineering"),
            subjectRelation: "member",
          },
        ],
        ["design", "private"],
      );
    });

    test("an object only a contextual tuple names is still an answer", async () => {
      // doc:extra has no stored tuple at all, so it is not in the
      // candidate pool the store reports. Upstream returns it, and
      // passing the pool straight through would have left it out
      // with no error.
      await expectObjectsWith(
        "doc",
        "can_write",
        "charlie",
        [
          {
            objectType: "doc",
            objectId: uuid("extra"),
            relation: "owner",
            subjectType: "user",
            subjectId: uuid("charlie"),
          },
        ],
        ["extra"],
      );
    });

    test("the control: no contextual tuples, no objects", async () => {
      await expectObjects("doc", "can_write", "charlie", []);
    });
  });
});
