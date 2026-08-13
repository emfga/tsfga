import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type TsfgaClient, TsfgaError } from "@tsfga/core";
import type { DB } from "@tsfga/kysely";
import type { Kysely } from "kysely";
import {
  expectConformance,
  expectListObjectsConformance,
  expectPinnedListObjectsDivergence,
  type ListObjectsParams,
} from "./helpers/conformance.ts";
import { fgaListObjects } from "./helpers/openfga.ts";
import {
  createCaseStore,
  type MatrixTuple,
  setupMatrix,
  teardownMatrix,
  uuid,
  VALID_CONTEXT,
  writeCaseTuples,
} from "./listobjects-matrix/harness.ts";

/**
 * Three `listObjects` properties, pushed on harder than the tests
 * that introduced them push:
 *
 * - it refuses an undefined relation or type before reading data,
 * - it drops a depth-exceeded candidate rather than aborting the
 *   call, while every *other* error still aborts,
 * - it accepts a userset subject.
 *
 * The model is the ported matrix model, which already carries a
 * userset-bearing relation behind each rewrite kind.
 */

const D = "directs_b4";
const DE = "directs_employee_b4";
const S = "usersets_user_b4";
const T = "ttus_b4";
const U = "user_b4";
const E = "employee_b4";
const COND = "xcond_b4";

const CHAIN = 30;

const TUPLES: MatrixTuple[] = [
  // `pa` satisfies directs#alg_combined but not alg_combined_oneline;
  // `pb` is the other way round.
  { object: `${D}:pa`, relation: "direct_mult_types", user: `${U}:pu` },
  { object: `${D}:pa`, relation: "other_rel", user: `${U}:pu` },
  { object: `${D}:pb`, relation: "direct", user: `${U}:pu` },
  { object: `${D}:pb`, relation: "other_rel", user: `${U}:pu` },

  {
    object: `${S}:o_plain`,
    relation: "userset_alg_combined",
    user: `${D}:pa#alg_combined`,
  },
  {
    object: `${S}:o_both`,
    relation: "userset_alg_combined",
    user: `${D}:pa#alg_combined`,
  },
  {
    object: `${S}:o_both`,
    relation: "probe_blocked",
    user: `${D}:pb#alg_combined_oneline`,
  },
  {
    object: `${S}:o_blockonly`,
    relation: "probe_blocked",
    user: `${D}:pb#alg_combined_oneline`,
  },
  { object: `${S}:o_child`, relation: "probe_parent", user: `${S}:o_plain` },
  { object: `${S}:o_child2`, relation: "probe_parent", user: `${S}:o_both` },

  // One `ttus_b4` candidate the subject reaches, and one it does
  // not whose tupleset row carries a condition. With no context
  // the condition cannot be evaluated at all.
  {
    object: `${T}:ok_parent`,
    relation: "mult_parent_types",
    user: `${D}:ok_child`,
  },
  { object: `${D}:ok_child`, relation: "other_rel", user: `${U}:pu` },
  {
    object: `${T}:err_parent`,
    relation: "mult_parent_types",
    user: `${D}:err_child`,
    condition: COND,
  },
  { object: `${D}:err_child`, relation: "other_rel", user: `${U}:stranger` },

  // A userset chain longer than the default depth budget.
  {
    object: `${S}:deep_0`,
    relation: "userset_recursive",
    user: `${U}:deep_user`,
  },
  ...Array.from({ length: CHAIN }, (_, index) => ({
    object: `${S}:deep_${index + 1}`,
    relation: "userset_recursive",
    user: `${S}:deep_${index}#userset_recursive`,
  })),
];

describe("listObjects probes", () => {
  let db: Kysely<DB>;
  let tsfgaClient: TsfgaClient;
  let storeId: string;
  let authorizationModelId: string;

  beforeAll(async () => {
    ({ db, tsfgaClient } = await setupMatrix());
    ({ storeId, authorizationModelId } = await createCaseStore("probes"));
    await writeCaseTuples(tsfgaClient, storeId, authorizationModelId, TUPLES);
  });

  afterAll(async () => {
    await teardownMatrix(db);
  });

  async function expectObjects(
    params: ListObjectsParams,
    expected: string[],
  ): Promise<void> {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      params,
      expected.map(uuid),
    );
  }

  /**
   * Both engines decline the call.
   *
   * `expectListObjectsConformance` cannot express this — it
   * compares two object sets and a tsfga refusal escapes as a
   * thrown error — and `expectPinnedListObjectsDivergence` refuses
   * to pass on agreement, which is exactly what these shapes are.
   */
  async function expectBothRefuse(
    params: Omit<ListObjectsParams, "contextualTuples">,
  ): Promise<void> {
    const tsfgaOutcome = await tsfgaClient
      .listObjects(params)
      .then((objects) => `answered ${JSON.stringify([...objects].sort())}`)
      .catch((error: unknown) => {
        if (error instanceof TsfgaError) return "refused";
        throw error;
      });
    const openFgaOutcome = await fgaListObjects(
      storeId,
      authorizationModelId,
      params,
    )
      .then((objects) => `answered ${JSON.stringify([...objects].sort())}`)
      .catch(() => "refused");
    expect(tsfgaOutcome).toBe("refused");
    expect(openFgaOutcome).toBe("refused");
  }

  describe("the relation gate", () => {
    test("an undefined relation is refused by both", async () => {
      await expectBothRefuse({
        objectType: D,
        relation: "no_such_relation",
        subjectType: U,
        subjectId: uuid("pu"),
      });
    });

    test("an undefined type is refused by both", async () => {
      await expectBothRefuse({
        objectType: "no_such_type_b4",
        relation: "direct",
        subjectType: U,
        subjectId: uuid("pu"),
      });
    });

    test("a defined relation on a type that has none is refused", async () => {
      await expectBothRefuse({
        objectType: U,
        relation: "direct",
        subjectType: U,
        subjectId: uuid("pu"),
      });
    });

    test("a subject type the relation does not admit answers empty", async () => {
      await expectObjects(
        {
          objectType: D,
          relation: "direct",
          subjectType: E,
          subjectId: uuid("pu"),
        },
        [],
      );
    });

    test("a userset subject on a relation admitting none is empty", async () => {
      await expectObjects(
        {
          objectType: D,
          relation: "direct",
          subjectType: S,
          subjectId: uuid("o_plain"),
          subjectRelation: "userset",
        },
        [],
      );
    });

    test("a userset relation the subject type lacks is refused", async () => {
      await expectBothRefuse({
        objectType: S,
        relation: "userset_alg_combined",
        subjectType: D,
        subjectId: uuid("pa"),
        subjectRelation: "no_such_relation",
      });
    });

    test("an undefined subject type answers instead of refusing", async () => {
      // The subject side of the gate that already covers the object
      // side. Upstream validates `user` against the type
      // definitions and refuses; tsfga reads the type as one no
      // tuple mentions and answers the empty set.
      await expectBothRefuse({
        objectType: D,
        relation: "direct",
        subjectType: "no_such_type_b4",
        subjectId: uuid("pu"),
      });
    });

    test("check answers false for an undefined subject type", async () => {
      // The same gap one layer down, so a fix has somewhere to go
      // that is not `listObjects` alone.
      await expectConformance(
        storeId,
        authorizationModelId,
        tsfgaClient,
        {
          objectType: D,
          objectId: uuid("pa"),
          relation: "direct",
          subjectType: "no_such_type_b4",
          subjectId: uuid("pu"),
        },
        "refused",
      );
    });

    test("a defined subject type the relation does not admit is not refused", async () => {
      // The boundary of 261: `employee_b4` exists, so neither
      // engine refuses -- they both answer `false`.
      await expectConformance(
        storeId,
        authorizationModelId,
        tsfgaClient,
        {
          objectType: D,
          objectId: uuid("pa"),
          relation: "direct",
          subjectType: E,
          subjectId: uuid("pu"),
        },
        false,
      );
    });
  });

  describe("a userset subject behind every rewrite kind", () => {
    const asUserset: Pick<
      ListObjectsParams,
      "subjectType" | "subjectId" | "subjectRelation"
    > = {
      subjectType: D,
      subjectId: uuid("pa"),
      subjectRelation: "alg_combined",
    };
    const asBlockingUserset: typeof asUserset = {
      subjectType: D,
      subjectId: uuid("pb"),
      subjectRelation: "alg_combined_oneline",
    };
    const asUser: Pick<ListObjectsParams, "subjectType" | "subjectId"> = {
      subjectType: U,
      subjectId: uuid("pu"),
    };

    test("direct", async () => {
      await expectObjects(
        { objectType: S, relation: "userset_alg_combined", ...asUserset },
        ["o_plain", "o_both"],
      );
    });

    test("computed userset", async () => {
      await expectObjects(
        { objectType: S, relation: "probe_computed", ...asUserset },
        ["o_plain", "o_both"],
      );
    });

    test("union", async () => {
      await expectObjects(
        { objectType: S, relation: "probe_union", ...asUserset },
        ["o_plain", "o_both"],
      );
    });

    test("union, reached through the other arm", async () => {
      await expectObjects(
        { objectType: S, relation: "probe_union", ...asBlockingUserset },
        ["o_both", "o_blockonly"],
      );
    });

    test("intersection", async () => {
      // The userset subject satisfies one arm and cannot satisfy
      // the other -- the second arm names a *different* userset.
      await expectObjects(
        { objectType: S, relation: "probe_intersect", ...asUserset },
        [],
      );
    });

    test("intersection, for the user behind both usersets", async () => {
      await expectObjects(
        { objectType: S, relation: "probe_intersect", ...asUser },
        ["o_both"],
      );
    });

    test("exclusion does not subtract for a userset subject", async () => {
      // `o_both` carries the excluding tuple, but it excludes the
      // *user*, not this userset, so the userset still reaches it.
      await expectObjects(
        { objectType: S, relation: "probe_excluded", ...asUserset },
        ["o_plain", "o_both"],
      );
    });

    test("exclusion subtracts for the user", async () => {
      await expectObjects(
        { objectType: S, relation: "probe_excluded", ...asUser },
        ["o_plain"],
      );
    });

    test("tuple to userset", async () => {
      await expectObjects(
        { objectType: S, relation: "probe_ttu", ...asUserset },
        ["o_child", "o_child2"],
      );
    });

    test("a userset the model admits but nothing grants is empty", async () => {
      await expectObjects(
        {
          objectType: S,
          relation: "userset_alg_combined",
          subjectType: DE,
          subjectId: uuid("pa"),
          subjectRelation: "alg_combined",
        },
        [],
      );
    });
  });

  describe("errors against the drop-on-depth rule", () => {
    test("a reachable candidate's condition error (pinned)", async () => {
      // The second half of the drop-on-depth pin, asserted here from
      // the side where the two engines used to agree.
      //
      // `stranger` really is reachable through the erroring row --
      // `ttus_b4:err_parent#mult_parent_types@directs_b4:err_child`
      // carries `xcond_b4`, and `err_child#other_rel` names him --
      // so upstream's reverse expansion arrives at that row,
      // cannot evaluate it without the context, and refuses the
      // whole call. tsfga meets the same row on a tupleset scan,
      // which is not a read naming the request subject, so it
      // drops the candidate and answers the empty list.
      //
      // It used to agree, but only by accident: nothing else
      // granted, and the old rule raised a dropped error when the
      // granted set came back empty. That rule is what made
      // `listObjects` refuse where upstream answers `[]` (issues
      // 301 and 341 row 1), and deleting it exposes this cell as
      // the divergence it always was.
      //
      // **No local predicate separates this from `vault`'s
      // `dan`, who must answer.** Both reach the identical branch
      // with identical local information: the erroring row is read
      // at the same point, `findCheckTuples` probes the subject
      // directly for both and returns nothing for both, and
      // "did the candidate's subtree reach the subject?" is
      // unknowable without evaluating the condition that just
      // failed. Telling them apart needs reverse reachability over
      // the stored rows, which tsfga has at the model level only.
      // So one of the two must diverge, and the direction chosen
      // is this one: under-reporting, never granting.
      await expectPinnedListObjectsDivergence(
        storeId,
        authorizationModelId,
        tsfgaClient,
        {
          objectType: T,
          relation: "ttu_other_rel",
          subjectType: U,
          subjectId: uuid("stranger"),
        },
        { openfga: "refused", tsfga: [] },
      );
    });

    test("supplying the context makes both agree again", async () => {
      // The boundary beside the pin: the divergence is the missing
      // context, not the shape. With `xcond_b4` evaluable, tsfga
      // drops nothing and upstream refuses nothing.
      await expectObjects(
        {
          objectType: T,
          relation: "ttu_other_rel",
          subjectType: U,
          subjectId: uuid("stranger"),
          context: VALID_CONTEXT,
        },
        ["err_parent"],
      );
    });

    test("with the context supplied, both list both parents", async () => {
      await expectObjects(
        {
          objectType: T,
          relation: "ttu_other_rel",
          subjectType: U,
          subjectId: uuid("pu"),
          context: VALID_CONTEXT,
        },
        ["ok_parent"],
      );
    });

    test("an unreachable candidate's condition error aborts the call", async () => {
      // `err_parent` grants nothing to `pu`; upstream never
      // evaluates its conditioned tupleset row because its reverse
      // expansion from `pu` never arrives there. tsfga checks every
      // candidate forward, so the error reaches the caller and
      // costs the whole answer -- `ok_parent` included.
      await expectObjects(
        {
          objectType: T,
          relation: "ttu_other_rel",
          subjectType: U,
          subjectId: uuid("pu"),
        },
        ["ok_parent"],
      );
    });

    test("a depth-exceeded candidate is dropped, not raised (pinned 061)", async () => {
      // The counterpart: this one is documented in
      // `packages/core/README.md` as a known divergence, so it is
      // pinned two-sided rather than filed. It is here because the
      // two rules meet -- depth drops the candidate, every other
      // error still takes the call with it.
      const all = Array.from({ length: CHAIN + 1 }, (_, index) =>
        uuid(`deep_${index}`),
      );
      await expectPinnedListObjectsDivergence(
        storeId,
        authorizationModelId,
        tsfgaClient,
        {
          objectType: S,
          relation: "userset_recursive",
          subjectType: U,
          subjectId: uuid("deep_user"),
        },
        { openfga: all, tsfga: all.slice(0, 25) },
      );
    });
  });
});
