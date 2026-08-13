import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type CheckRequest, type TsfgaClient, TsfgaError } from "@tsfga/core";
import type { DB } from "@tsfga/kysely";
import type { Kysely } from "kysely";
import { setupBatch, teardownBatch, uuid } from "./batch/setup.ts";
import { type BatchItem, fgaBatchCheck } from "./batch/upstream.ts";
import { expectConfigsMatchModel } from "./helpers/conformance.ts";

/**
 * `checkMany` against upstream's BatchCheck.
 *
 * The two are the same operation with different plumbing: upstream
 * correlates by a caller-supplied id and tsfga by array position,
 * and both promise that one item's failure does not take the batch
 * down with it. What has to agree is the *answers* — every item's
 * boolean, and which items answered at all.
 *
 * A batch is also the only place tsfga shares a resolution scope
 * across requests, so a wrong answer here that is right from a
 * single `check` would be memo contamination. Several tests below
 * exist only to look for that: they mix contexts, contextual
 * tuples and subjects that resolve over the same nodes.
 */

/** One outcome, in a shape both engines can be reduced to. */
type Outcome = { allowed: boolean; failed: boolean };

describe("checkMany vs. BatchCheck", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let authorizationModelId: string;
  let tsfgaClient: TsfgaClient;
  let fixture: Awaited<ReturnType<typeof setupBatch>>["fixture"];

  beforeAll(async () => {
    ({ db, storeId, authorizationModelId, tsfgaClient, fixture } =
      await setupBatch());
  });

  afterAll(async () => {
    await teardownBatch(db);
  });

  async function mine(requests: CheckRequest[]): Promise<Outcome[]> {
    const outcomes = await tsfgaClient.checkMany(requests);
    return outcomes.map((outcome) => {
      if (
        outcome.error !== undefined &&
        !(outcome.error instanceof TsfgaError)
      ) {
        throw outcome.error;
      }
      return {
        allowed: outcome.allowed,
        failed: outcome.error !== undefined,
      };
    });
  }

  async function theirs(items: BatchItem[]): Promise<Outcome[]> {
    const outcomes = await fgaBatchCheck(storeId, authorizationModelId, items);
    return outcomes.map((outcome) => ({
      allowed: outcome.allowed,
      failed: "error" in outcome,
    }));
  }

  /** A request both engines can be asked, since the fields align. */
  function request(
    object: string,
    relation: string,
    subject: string,
    extra: Partial<CheckRequest> = {},
  ): CheckRequest & BatchItem {
    const hashIdx = subject.indexOf("#");
    const base = hashIdx >= 0 ? subject.slice(0, hashIdx) : subject;
    const subjectRelation = hashIdx >= 0 ? subject.slice(hashIdx + 1) : null;
    const colonIdx = base.indexOf(":");
    const subjectName = base.slice(colonIdx + 1);
    return {
      objectType: "doc_c4",
      objectId: uuid(object),
      relation,
      subjectType: base.slice(0, colonIdx),
      subjectId: subjectName === "*" ? "*" : uuid(subjectName),
      subjectRelation,
      ...extra,
    };
  }

  /** Assert both engines answer a batch the same way, and as expected. */
  async function expectBatch(
    items: Array<CheckRequest & BatchItem>,
    expected: Array<boolean | "refused">,
  ): Promise<void> {
    const [ours, upstream] = await Promise.all([mine(items), theirs(items)]);
    expect(ours).toEqual(upstream);
    expect(
      ours.map((outcome) => (outcome.failed ? "refused" : outcome.allowed)),
    ).toEqual(expected);
  }

  describe("a batch mixing every subject shape", () => {
    test("bare, wildcard, nested userset, TTU, owner and exclusion", async () => {
      await expectBatch(
        [
          // Nested group userset: alice ∈ g1 ⊂ g2, and g2#member is
          // a direct_viewer of d1.
          request("d1", "viewer", "user_c4:alice"),
          // Through the folder, by TTU.
          request("d1", "viewer", "user_c4:bob"),
          // Owner, and blocked — so a viewer but not an editor.
          request("d1", "viewer", "user_c4:carol"),
          request("d1", "editor", "user_c4:carol"),
          // Nobody's path to d1.
          request("d1", "viewer", "user_c4:dave"),
          // Wildcard, and the one subject the exclusion removes.
          request("d2", "viewer", "user_c4:dave"),
          request("d2", "editor", "user_c4:dave"),
          request("d2", "editor", "user_c4:alice"),
          // No tuple names d4 at all.
          request("d4", "viewer", "user_c4:alice"),
        ],
        [true, true, true, false, false, true, false, true, false],
      );
    });

    test("a userset subject in a batch beside a bare one", async () => {
      await expectBatch(
        [
          request("d1", "viewer", "group_c4:g1#member"),
          request("d1", "viewer", "group_c4:g2#member"),
          request("d1", "viewer", "user_c4:alice"),
        ],
        [true, true, true],
      );
    });
  });

  describe("contexts", () => {
    test("two contexts over the same node in one batch", async () => {
      // The memo-contamination probe: both items resolve
      // `doc_c4:d3#direct_viewer` for alice, and only the context
      // separates them. A shared memo would answer them alike.
      const monday = { day: "mon" };
      const tuesday = { day: "tue" };
      await expectBatch(
        [
          request("d3", "viewer", "user_c4:alice", { context: monday }),
          request("d3", "viewer", "user_c4:alice", { context: tuesday }),
          request("d3", "viewer", "user_c4:alice", { context: monday }),
        ],
        [true, false, true],
      );
    });

    test("one item's context does not reach an item without one", async () => {
      // bob's grant on d3 carries no condition, so he answers the
      // same either way; alice's needs the context and must not
      // borrow it from the sibling.
      await expectBatch(
        [
          request("d3", "viewer", "user_c4:alice", { context: { day: "mon" } }),
          request("d3", "viewer", "user_c4:bob"),
        ],
        [true, true],
      );
    });

    test("a batch where one item's condition cannot be evaluated", async () => {
      // No context at all for a conditioned grant. Whatever each
      // engine does with it, the *other* items must still answer.
      await expectBatch(
        [
          request("d1", "viewer", "user_c4:alice"),
          request("d3", "viewer", "user_c4:alice"),
          request("d2", "viewer", "user_c4:dave"),
        ],
        [true, "refused", true],
      );
    });
  });

  describe("contextual tuples", () => {
    /** The same tuple in both engines' spellings. */
    function overlay(
      object: string,
      relation: string,
      subject: string,
    ): Partial<CheckRequest & BatchItem> {
      return {
        contextualTuples: [
          {
            objectType: "doc_c4",
            objectId: uuid(object),
            relation,
            subjectType: "user_c4",
            subjectId: uuid(subject),
          },
        ],
        upstreamContextualTuples: [
          {
            user: `user_c4:${uuid(subject)}`,
            relation,
            object: `doc_c4:${uuid(object)}`,
          },
        ],
      };
    }

    test("one item's contextual tuple does not reach its siblings", async () => {
      await expectBatch(
        [
          request(
            "d4",
            "viewer",
            "user_c4:alice",
            overlay("d4", "direct_viewer", "alice"),
          ),
          request("d4", "viewer", "user_c4:alice"),
          request("d4", "viewer", "user_c4:bob"),
        ],
        [true, false, false],
      );
    });

    test("a contextual tuple beside a stored grant on the same node", async () => {
      await expectBatch(
        [
          request(
            "d1",
            "editor",
            "user_c4:alice",
            overlay("d1", "blocked", "alice"),
          ),
          request("d1", "editor", "user_c4:alice"),
        ],
        [false, true],
      );
    });
  });

  describe("failure isolation", () => {
    test("an item naming a relation the model does not define", async () => {
      await expectBatch(
        [
          request("d1", "viewer", "user_c4:alice"),
          request("d1", "no_such_relation_c4", "user_c4:alice"),
          request("d2", "viewer", "user_c4:dave"),
        ],
        [true, "refused", true],
      );
    });

    test("an item naming a type the model does not define", async () => {
      await expectBatch(
        [
          request("d1", "viewer", "user_c4:alice"),
          {
            ...request("d1", "viewer", "user_c4:alice"),
            subjectType: "ghost_c4",
          },
          request("d2", "viewer", "user_c4:dave"),
        ],
        [true, "refused", true],
      );
    });

    test("every item failing does not change how any of them fails", async () => {
      await expectBatch(
        [
          request("d1", "no_such_relation_c4", "user_c4:alice"),
          request("d2", "no_such_relation_c4", "user_c4:alice"),
        ],
        ["refused", "refused"],
      );
    });
  });

  describe("batch size", () => {
    test("an empty batch", async () => {
      expect(await tsfgaClient.checkMany([])).toEqual([]);
    });

    test("the same request repeated resolves alike", async () => {
      const repeated = Array.from({ length: 20 }, () =>
        request("d1", "viewer", "user_c4:alice"),
      );
      await expectBatch(
        repeated,
        repeated.map(() => true),
      );
    });

    test("a batch past maxConcurrentChecks answers every item", async () => {
      // 120 items over a default limit of 50, alternating between a
      // granting and a denying question so a lost or mis-slotted
      // answer shows up as a wrong boolean rather than as a
      // uniform one.
      const items = Array.from({ length: 120 }, (_, index) =>
        index % 2 === 0
          ? request("d1", "viewer", "user_c4:alice")
          : request("d1", "viewer", "user_c4:dave"),
      );
      await expectBatch(
        items,
        items.map((_, index) => index % 2 === 0),
      );
    });
  });

  test("configs match the model", () => {
    expectConfigsMatchModel("./batch/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
