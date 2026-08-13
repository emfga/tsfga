import { afterAll, beforeAll, describe, test } from "bun:test";
import type { TsfgaClient } from "@tsfga/core";
import type { DB } from "@tsfga/kysely";
import type { Kysely } from "kysely";
import { MATRIX_HELPERS, MATRIX_MOVED } from "./complexity-matrix/configs.ts";
import {
  type CheckAssertion,
  checkRequest,
  createCaseStore,
  type MatrixTuple,
  removeCaseTuples,
  setupMatrix,
  teardownMatrix,
  writeCaseTuples,
} from "./complexity-matrix/harness.ts";
import {
  expectConfigsMatchModel,
  expectConformance,
  type FixtureRecord,
} from "./helpers/conformance.ts";

/**
 * Where the self-defining userset stops holding.
 *
 * `group:eng#member` is a `member` of `group:eng` by definition,
 * whatever the model says — upstream answers it in `IsSelfDefining`
 * before it even looks the relation up
 * (`internal/graph/check.go:433-437`), and tsfga answers it at the
 * top of `checkNode`. The question this file asks is what happens
 * when that node is not the one the request names but one a
 * **rewrite** arrives at: `ttus:1 ttu_direct` for the subject
 * `directs:1#direct` walks its TTU onto `directs:1 direct`, where
 * the subject is the node.
 *
 * Every probe is one rewrite kind between the request and the
 * identity. The model is `complexity-matrix/model.dsl`, upstream's
 * listobjects matrix.
 */

const U = "user_c1";
const D = "directs_c1";
const S = "usersets_user_c1";
const T = "ttus_c1";
const C3 = "complexity3_c1";

const TUPLES: MatrixTuple[] = [
  // The only rows any probe needs: a TTU has to have a tupleset
  // row to walk, where a same-object rewrite does not.
  { object: `${T}:ident_1`, relation: "direct_parent", user: `${D}:ident_1` },
  {
    object: `${T}:ident_1`,
    relation: "mult_parent_types",
    user: `${D}:ident_1`,
  },
  { object: `${C3}:ident_1`, relation: "userset_parent", user: `${S}:ident_1` },
  // A concrete grant, so the negative controls are not vacuous.
  { object: `${D}:ident_1`, relation: "direct", user: `${U}:ident_alice` },
];

const PROBES: CheckAssertion[] = [
  {
    name: "no rewrite: the subject is the node the request names",
    object: `${S}:ident_1`,
    relation: "userset",
    user: `${S}:ident_1#userset`,
    expect: true,
  },
  {
    name: "one computedUserset between request and identity",
    object: `${S}:ident_1`,
    relation: "userset_computed",
    user: `${S}:ident_1#userset`,
    expect: true,
    issue: "300",
  },
  {
    name: "one union arm between request and identity",
    object: `${S}:ident_1`,
    relation: "or_userset",
    user: `${S}:ident_1#userset_computed`,
    expect: true,
    issue: "300",
  },
  {
    name: "union then computedUserset",
    object: `${S}:ident_1`,
    relation: "or_userset",
    user: `${S}:ident_1#userset`,
    expect: true,
    issue: "300",
  },
  {
    name: "union whose other arm is an intersection",
    object: `${S}:ident_1`,
    relation: "user_rel4",
    user: `${S}:ident_1#user_rel1`,
    expect: true,
    issue: "300",
  },
  {
    name: "an exclusion's minuend",
    object: `${S}:ident_1`,
    relation: "alg_combined",
    user: `${S}:ident_1#and_userset`,
    expect: true,
    issue: "300",
  },
  {
    name: "one tuple-to-userset between request and identity",
    object: `${T}:ident_1`,
    relation: "ttu_direct",
    user: `${D}:ident_1#direct`,
    expect: true,
    issue: "300",
  },
  {
    name: "tuple-to-userset then computedUserset",
    object: `${T}:ident_1`,
    relation: "ttu_computed",
    user: `${D}:ident_1#direct`,
    expect: true,
    issue: "300",
  },
  {
    name: "a tuple-to-userset whose computed relation is a userset",
    object: `${C3}:ident_1`,
    relation: "ttu_userset",
    user: `${S}:ident_1#userset`,
    expect: true,
    issue: "300",
  },
  {
    name: "negative control: a different object",
    object: `${S}:ident_2`,
    relation: "userset_computed",
    user: `${S}:ident_1#userset`,
    expect: false,
  },
  {
    name: "negative control: a different relation",
    object: `${S}:ident_1`,
    relation: "userset_computed",
    user: `${S}:ident_1#user_rel1`,
    expect: false,
  },
  {
    name: "negative control: no tupleset row to walk",
    object: `${T}:ident_2`,
    relation: "ttu_direct",
    user: `${D}:ident_1#direct`,
    expect: false,
  },
  {
    name: "a concrete subject still reaches through the same TTU",
    object: `${T}:ident_1`,
    relation: "ttu_direct",
    user: `${U}:ident_alice`,
    expect: true,
  },
];

describe("c1: the self-defining userset behind a rewrite", () => {
  let db: Kysely<DB>;
  let tsfgaClient: TsfgaClient;
  let fixture: FixtureRecord;
  let storeId: string;
  let authorizationModelId: string;

  beforeAll(async () => {
    ({ db, tsfgaClient, fixture } = await setupMatrix());
    ({ storeId, authorizationModelId } = await createCaseStore("identity"));
    await writeCaseTuples(tsfgaClient, storeId, authorizationModelId, TUPLES);
  });

  afterAll(async () => {
    await removeCaseTuples(tsfgaClient, TUPLES);
    await teardownMatrix(db);
  });

  for (const [index, probe] of PROBES.entries()) {
    const label = `${probe.issue ? `GAP-${probe.issue}: ` : ""}#${index} ${probe.name}`;
    test(label, async () => {
      await expectConformance(
        storeId,
        authorizationModelId,
        tsfgaClient,
        checkRequest(probe),
        probe.expect,
      );
    });
  }

  test("configs match the model", () => {
    expectConfigsMatchModel("./complexity-matrix/model.dsl", fixture, {
      coverage: "complete",
      tsfgaOnlyHelpers: MATRIX_HELPERS,
      moved: MATRIX_MOVED,
    });
  });
});
