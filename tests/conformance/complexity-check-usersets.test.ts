import { afterAll, beforeAll, describe, test } from "bun:test";
import type { TsfgaClient } from "@tsfga/core";
import type { DB } from "@tsfga/kysely";
import type { Kysely } from "kysely";
import { MATRIX_HELPERS, MATRIX_MOVED } from "./complexity-matrix/configs.ts";
import {
  assertionExpectation,
  assertionRequest,
  checkRequest,
  createCaseStore,
  INVALID_CONTEXT,
  type MatrixCase,
  removeCaseTuples,
  setupMatrix,
  teardownMatrix,
  VALID_CONTEXT,
  writeCaseTuples,
} from "./complexity-matrix/harness.ts";
import {
  expectConfigsMatchModel,
  expectConformance,
  expectListObjectsConformance,
  type FixtureRecord,
} from "./helpers/conformance.ts";

/**
 * `complexity3` / `complexity4` asked with **userset subjects**.
 *
 * `userset-matrix` ports upstream's userset corpus and
 * `complexity` ports the complexity corpus; neither crosses them. The crossing is where
 * a resolver's shortcuts show, because a userset subject is
 * matched by *ref comparison* and never expands, so every rewrite
 * kind between the object and the subject has to carry the ref
 * through unchanged:
 *
 * - `complexity4.ttu_userset_ttu` — a TTU whose computed relation
 *   is itself a userset relation over a TTU relation.
 * - `complexity4.userset_ttu_userset` — a userset whose referenced
 *   relation is a TTU over a userset.
 * - `complexity4.or_complex4` — a union of a userset arm and a
 *   TTU arm, where the userset arm's leaf admits `user:*`. A
 *   userset subject must not be granted by a wildcard.
 * - `complexity4.alg_combined_complex4` — an intersection whose
 *   right operand is a TTU onto an exclusion.
 * - `complexity3.tuple_cycle_len3` — the three-type cycle, asked
 *   as a check rather than as a listObjects.
 *
 * The model is upstream's `tests/listobjects/matrix.go` (v1.18.2),
 * `_c1`-suffixed. The tuples and expectations are not upstream's —
 * upstream never asks these — so every expectation was derived
 * from the model and then settled by the running v1.18.2
 * container, which `expectConformance` asserts against on every
 * line.
 */

const U = "user_c1";
const D = "directs_c1";
const S = "usersets_user_c1";
const T = "ttus_c1";
const C3 = "complexity3_c1";
const C4 = "complexity4_c1";

const CASES: MatrixCase[] = [
  {
    name: "c4_ttu_userset_ttu",
    tuples: [
      { object: `${C4}:tut_1`, relation: "parent", user: `${C3}:tut_1` },
      {
        object: `${C3}:tut_1`,
        relation: "userset_ttu",
        user: `${T}:tut_1#ttu_direct`,
      },
      { object: `${T}:tut_1`, relation: "direct_parent", user: `${D}:tut_1` },
      { object: `${D}:tut_1`, relation: "direct", user: `${U}:tut_alice` },
      // A conditioned `parent` edge.
      {
        object: `${C4}:tut_2`,
        relation: "parent",
        user: `${C3}:tut_1`,
        condition: "xcond_c1",
      },
      // A conditioned `userset_ttu` edge, one level down.
      {
        object: `${C3}:tut_3`,
        relation: "userset_ttu",
        user: `${T}:tut_1#ttu_direct`,
        condition: "xcond_c1",
      },
      { object: `${C4}:tut_3`, relation: "parent", user: `${C3}:tut_3` },
      // A parent that reaches nothing.
      { object: `${C4}:tut_4`, relation: "parent", user: `${C3}:tut_4` },
    ],
    checks: [
      {
        name: "user through four hops",
        object: `${C4}:tut_1`,
        relation: "ttu_userset_ttu",
        user: `${U}:tut_alice`,
        expect: true,
      },
      {
        name: "the userset the leaf row names",
        object: `${C4}:tut_1`,
        relation: "ttu_userset_ttu",
        user: `${T}:tut_1#ttu_direct`,
        expect: true,
      },
      {
        name: "a userset one level below the row",
        object: `${C4}:tut_1`,
        relation: "ttu_userset_ttu",
        user: `${D}:tut_1#direct`,
        // The TTU walks onto `directs_c1:tut_1 direct`, where the
        // subject *is* the node — self-defining, so `true`.
        expect: true,
        issue: "300",
      },
      {
        name: "an unrelated user",
        object: `${C4}:tut_1`,
        relation: "ttu_userset_ttu",
        user: `${U}:tut_bob`,
        expect: false,
      },
      {
        name: "conditioned parent, context true",
        object: `${C4}:tut_2`,
        relation: "ttu_userset_ttu",
        user: `${U}:tut_alice`,
        context: VALID_CONTEXT,
        expect: true,
      },
      {
        name: "conditioned parent, context false",
        object: `${C4}:tut_2`,
        relation: "ttu_userset_ttu",
        user: `${U}:tut_alice`,
        context: INVALID_CONTEXT,
        expect: false,
      },
      {
        name: "conditioned parent, userset subject, context true",
        object: `${C4}:tut_2`,
        relation: "ttu_userset_ttu",
        user: `${T}:tut_1#ttu_direct`,
        context: VALID_CONTEXT,
        expect: true,
      },
      {
        name: "conditioned parent, userset subject, context false",
        object: `${C4}:tut_2`,
        relation: "ttu_userset_ttu",
        user: `${T}:tut_1#ttu_direct`,
        context: INVALID_CONTEXT,
        expect: false,
      },
      {
        name: "conditioned inner userset, context true",
        object: `${C4}:tut_3`,
        relation: "ttu_userset_ttu",
        user: `${U}:tut_alice`,
        context: VALID_CONTEXT,
        expect: true,
      },
      {
        name: "conditioned inner userset, context false",
        object: `${C4}:tut_3`,
        relation: "ttu_userset_ttu",
        user: `${U}:tut_alice`,
        context: INVALID_CONTEXT,
        expect: false,
      },
      {
        name: "conditioned inner userset, userset subject, context true",
        object: `${C4}:tut_3`,
        relation: "ttu_userset_ttu",
        user: `${T}:tut_1#ttu_direct`,
        context: VALID_CONTEXT,
        expect: true,
      },
      {
        name: "conditioned inner userset, userset subject, context false",
        object: `${C4}:tut_3`,
        relation: "ttu_userset_ttu",
        user: `${T}:tut_1#ttu_direct`,
        context: INVALID_CONTEXT,
        expect: false,
      },
      {
        name: "a parent that reaches nothing",
        object: `${C4}:tut_4`,
        relation: "ttu_userset_ttu",
        user: `${U}:tut_alice`,
        expect: false,
      },
      {
        name: "the complexity3 relation on its own",
        object: `${C3}:tut_1`,
        relation: "userset_ttu",
        user: `${U}:tut_alice`,
        expect: true,
      },
      {
        name: "the complexity3 relation, userset subject",
        object: `${C3}:tut_1`,
        relation: "userset_ttu",
        user: `${T}:tut_1#ttu_direct`,
        expect: true,
      },
      {
        name: "the ttus relation on its own",
        object: `${T}:tut_1`,
        relation: "ttu_direct",
        user: `${U}:tut_alice`,
        expect: true,
      },
      {
        name: "the ttus relation asked for the directs userset",
        object: `${T}:tut_1`,
        relation: "ttu_direct",
        user: `${D}:tut_1#direct`,
        expect: true,
        issue: "300",
      },
    ],
    assertions: [
      {
        user: `${U}:tut_alice`,
        type: C4,
        relation: "ttu_userset_ttu",
        context: VALID_CONTEXT,
        expect: [`${C4}:tut_1`, `${C4}:tut_2`, `${C4}:tut_3`],
      },
      {
        user: `${U}:tut_alice`,
        type: C4,
        relation: "ttu_userset_ttu",
        context: INVALID_CONTEXT,
        expect: [`${C4}:tut_1`],
      },
      {
        user: `${T}:tut_1#ttu_direct`,
        type: C4,
        relation: "ttu_userset_ttu",
        context: VALID_CONTEXT,
        expect: [`${C4}:tut_1`, `${C4}:tut_2`, `${C4}:tut_3`],
      },
      {
        user: `${T}:tut_1#ttu_direct`,
        type: C4,
        relation: "ttu_userset_ttu",
        context: INVALID_CONTEXT,
        expect: [`${C4}:tut_1`],
      },
      {
        user: `${T}:tut_1#ttu_direct`,
        type: C3,
        relation: "userset_ttu",
        context: VALID_CONTEXT,
        expect: [`${C3}:tut_1`, `${C3}:tut_3`],
      },
      {
        user: `${D}:tut_1#direct`,
        type: C4,
        relation: "ttu_userset_ttu",
        context: VALID_CONTEXT,
        expect: [`${C4}:tut_1`, `${C4}:tut_2`, `${C4}:tut_3`],
        issue: "300",
      },
    ],
  },
  {
    name: "c4_userset_ttu_userset",
    tuples: [
      {
        object: `${C4}:utu_1`,
        relation: "userset_ttu_userset",
        user: `${C3}:utu_1#ttu_userset`,
      },
      { object: `${C3}:utu_1`, relation: "userset_parent", user: `${S}:utu_1` },
      {
        object: `${S}:utu_1`,
        relation: "userset",
        user: `${D}:utu_1#direct_comb`,
      },
      { object: `${D}:utu_1`, relation: "direct_comb", user: `${U}:utu_alice` },
      // The conditioned arm, onto `ttu_userset_other_rel`.
      {
        object: `${C4}:utu_2`,
        relation: "userset_ttu_userset",
        user: `${C3}:utu_2#ttu_userset_other_rel`,
        condition: "xcond_c1",
      },
      { object: `${C3}:utu_2`, relation: "userset_parent", user: `${S}:utu_2` },
      {
        object: `${S}:utu_2`,
        relation: "userset_other_rel",
        user: `${D}:utu_2#other_rel`,
      },
      { object: `${D}:utu_2`, relation: "other_rel", user: `${U}:utu_bob` },
      // A conditioned `userset_parent`, two levels down.
      {
        object: `${C4}:utu_3`,
        relation: "userset_ttu_userset",
        user: `${C3}:utu_3#ttu_userset`,
      },
      {
        object: `${C3}:utu_3`,
        relation: "userset_parent",
        user: `${S}:utu_1`,
        condition: "xcond_c1",
      },
    ],
    checks: [
      {
        name: "user through the unconditioned arm",
        object: `${C4}:utu_1`,
        relation: "userset_ttu_userset",
        user: `${U}:utu_alice`,
        expect: true,
      },
      {
        name: "the complexity3 userset the row names",
        object: `${C4}:utu_1`,
        relation: "userset_ttu_userset",
        user: `${C3}:utu_1#ttu_userset`,
        expect: true,
      },
      {
        name: "the leaf directs userset",
        object: `${C4}:utu_1`,
        relation: "userset_ttu_userset",
        user: `${D}:utu_1#direct_comb`,
        expect: true,
      },
      {
        name: "the intermediate usersets-user userset",
        object: `${C4}:utu_1`,
        relation: "userset_ttu_userset",
        user: `${S}:utu_1#userset`,
        // `ttu_userset` walks onto `usersets_user_c1:utu_1 userset`,
        // which the subject *is*.
        expect: true,
        issue: "300",
      },
      {
        name: "an unrelated user",
        object: `${C4}:utu_1`,
        relation: "userset_ttu_userset",
        user: `${U}:utu_bob`,
        expect: false,
      },
      {
        name: "conditioned arm, context true",
        object: `${C4}:utu_2`,
        relation: "userset_ttu_userset",
        user: `${U}:utu_bob`,
        context: VALID_CONTEXT,
        expect: true,
      },
      {
        name: "conditioned arm, context false",
        object: `${C4}:utu_2`,
        relation: "userset_ttu_userset",
        user: `${U}:utu_bob`,
        context: INVALID_CONTEXT,
        expect: false,
      },
      {
        name: "conditioned arm, its own userset, context true",
        object: `${C4}:utu_2`,
        relation: "userset_ttu_userset",
        user: `${C3}:utu_2#ttu_userset_other_rel`,
        context: VALID_CONTEXT,
        expect: true,
      },
      {
        name: "conditioned arm, its own userset, context false",
        object: `${C4}:utu_2`,
        relation: "userset_ttu_userset",
        user: `${C3}:utu_2#ttu_userset_other_rel`,
        context: INVALID_CONTEXT,
        expect: false,
      },
      {
        name: "the other arm's relation on the conditioned object",
        object: `${C4}:utu_2`,
        relation: "userset_ttu_userset",
        user: `${C3}:utu_2#ttu_userset`,
        context: VALID_CONTEXT,
        expect: false,
      },
      {
        name: "conditioned userset_parent, context true",
        object: `${C4}:utu_3`,
        relation: "userset_ttu_userset",
        user: `${U}:utu_alice`,
        context: VALID_CONTEXT,
        expect: true,
      },
      {
        name: "conditioned userset_parent, context false",
        object: `${C4}:utu_3`,
        relation: "userset_ttu_userset",
        user: `${U}:utu_alice`,
        context: INVALID_CONTEXT,
        expect: false,
      },
      {
        name: "conditioned userset_parent, leaf userset, context true",
        object: `${C4}:utu_3`,
        relation: "userset_ttu_userset",
        user: `${D}:utu_1#direct_comb`,
        context: VALID_CONTEXT,
        expect: true,
      },
      {
        name: "conditioned userset_parent, leaf userset, context false",
        object: `${C4}:utu_3`,
        relation: "userset_ttu_userset",
        user: `${D}:utu_1#direct_comb`,
        context: INVALID_CONTEXT,
        expect: false,
      },
    ],
    assertions: [
      {
        user: `${U}:utu_alice`,
        type: C4,
        relation: "userset_ttu_userset",
        context: VALID_CONTEXT,
        expect: [`${C4}:utu_1`, `${C4}:utu_3`],
      },
      {
        user: `${U}:utu_alice`,
        type: C4,
        relation: "userset_ttu_userset",
        context: INVALID_CONTEXT,
        expect: [`${C4}:utu_1`],
      },
      {
        user: `${D}:utu_1#direct_comb`,
        type: C4,
        relation: "userset_ttu_userset",
        context: VALID_CONTEXT,
        expect: [`${C4}:utu_1`, `${C4}:utu_3`],
      },
      {
        user: `${C3}:utu_1#ttu_userset`,
        type: C4,
        relation: "userset_ttu_userset",
        context: VALID_CONTEXT,
        expect: [`${C4}:utu_1`],
      },
      {
        user: `${S}:utu_1#userset`,
        type: C4,
        relation: "userset_ttu_userset",
        context: VALID_CONTEXT,
        expect: [`${C4}:utu_1`, `${C4}:utu_3`],
        issue: "300",
      },
      {
        user: `${U}:utu_bob`,
        type: C4,
        relation: "userset_ttu_userset",
        context: VALID_CONTEXT,
        expect: [`${C4}:utu_2`],
      },
      {
        user: `${U}:utu_bob`,
        type: C4,
        relation: "userset_ttu_userset",
        context: INVALID_CONTEXT,
        expect: [],
      },
    ],
  },
  {
    name: "c4_or_complex4",
    tuples: [
      // The userset arm, whose leaf admits `user:*`.
      {
        object: `${C4}:oc_1`,
        relation: "or_complex4",
        user: `${C3}:oc_1#userset_ttu_public`,
      },
      { object: `${C3}:oc_1`, relation: "userset_ttu_public", user: `${U}:*` },
      // The userset arm, whose leaf names a `ttus` userset.
      {
        object: `${C4}:oc_2`,
        relation: "or_complex4",
        user: `${C3}:oc_2#userset_ttu_public`,
      },
      {
        object: `${C3}:oc_2`,
        relation: "userset_ttu_public",
        user: `${T}:oc_1#ttu_direct`,
      },
      { object: `${T}:oc_1`, relation: "direct_parent", user: `${D}:oc_1` },
      { object: `${D}:oc_1`, relation: "direct", user: `${U}:oc_alice` },
      // The TTU arm.
      { object: `${C4}:oc_3`, relation: "parent", user: `${C3}:oc_3` },
      {
        object: `${C3}:oc_3`,
        relation: "userset_ttu",
        user: `${T}:oc_1#ttu_direct`,
      },
    ],
    checks: [
      {
        name: "wildcard leaf grants any user",
        object: `${C4}:oc_1`,
        relation: "or_complex4",
        user: `${U}:oc_anyone`,
        expect: true,
      },
      {
        name: "a wildcard never grants a userset subject",
        object: `${C4}:oc_1`,
        relation: "or_complex4",
        user: `${T}:oc_1#ttu_direct`,
        expect: false,
      },
      {
        name: "userset arm, user through the leaf ttus userset",
        object: `${C4}:oc_2`,
        relation: "or_complex4",
        user: `${U}:oc_alice`,
        expect: true,
      },
      {
        name: "userset arm, the leaf ttus userset itself",
        object: `${C4}:oc_2`,
        relation: "or_complex4",
        user: `${T}:oc_1#ttu_direct`,
        expect: true,
      },
      {
        name: "userset arm, a ttus userset the leaf does not name",
        object: `${C4}:oc_2`,
        relation: "or_complex4",
        user: `${T}:oc_2#ttu_direct`,
        expect: false,
      },
      {
        name: "TTU arm, user",
        object: `${C4}:oc_3`,
        relation: "or_complex4",
        user: `${U}:oc_alice`,
        expect: true,
      },
      {
        name: "TTU arm, userset subject",
        object: `${C4}:oc_3`,
        relation: "or_complex4",
        user: `${T}:oc_1#ttu_direct`,
        expect: true,
      },
      {
        name: "TTU arm, an unrelated user",
        object: `${C4}:oc_3`,
        relation: "or_complex4",
        user: `${U}:oc_bob`,
        expect: false,
      },
      {
        name: "complexity3 public relation, wildcard",
        object: `${C3}:oc_1`,
        relation: "userset_ttu_public",
        user: `${U}:oc_anyone`,
        expect: true,
      },
      {
        name: "complexity3 public relation, userset subject",
        object: `${C3}:oc_1`,
        relation: "userset_ttu_public",
        user: `${T}:oc_1#ttu_direct`,
        expect: false,
      },
    ],
    assertions: [
      {
        user: `${U}:oc_alice`,
        type: C4,
        relation: "or_complex4",
        context: VALID_CONTEXT,
        expect: [`${C4}:oc_1`, `${C4}:oc_2`, `${C4}:oc_3`],
      },
      {
        user: `${U}:oc_bob`,
        type: C4,
        relation: "or_complex4",
        context: VALID_CONTEXT,
        expect: [`${C4}:oc_1`],
      },
      {
        user: `${T}:oc_1#ttu_direct`,
        type: C4,
        relation: "or_complex4",
        context: VALID_CONTEXT,
        expect: [`${C4}:oc_2`, `${C4}:oc_3`],
      },
      {
        user: `${T}:oc_1#ttu_direct`,
        type: C3,
        relation: "userset_ttu_public",
        context: VALID_CONTEXT,
        expect: [`${C3}:oc_2`],
      },
      {
        user: `${U}:oc_alice`,
        type: C3,
        relation: "userset_ttu_public",
        context: VALID_CONTEXT,
        expect: [`${C3}:oc_1`, `${C3}:oc_2`],
      },
    ],
  },
  {
    name: "c4_alg_combined_complex4",
    tuples: [
      // `directs:ac_1#alg_combined` holds for `ac_alice`: the only
      // union arm that fires is `computed_mult_types`, and neither
      // `computed_comb` nor `computed_3_times` — the two subtracted
      // relations — does.
      {
        object: `${D}:ac_1`,
        relation: "direct_mult_types",
        user: `${U}:ac_alice`,
      },
      { object: `${D}:ac_1`, relation: "other_rel", user: `${U}:ac_alice` },
      {
        object: `${T}:ac_1`,
        relation: "mult_parent_types",
        user: `${D}:ac_1`,
      },
      {
        object: `${C3}:ac_1`,
        relation: "userset_ttu_inner_alg_combined",
        user: `${T}:ac_1#ttu_alg_combined_computed`,
      },
      {
        object: `${C3}:ac_1`,
        relation: "userset_ttu_other_rel",
        user: `${T}:ac_1#ttu_other_rel`,
      },
      // The `or_complex4` side, through the TTU arm.
      { object: `${C4}:ac_1`, relation: "parent", user: `${C3}:ac_1` },
      {
        object: `${C3}:ac_1`,
        relation: "userset_ttu",
        user: `${T}:ac_2#ttu_direct`,
      },
      { object: `${T}:ac_2`, relation: "direct_parent", user: `${D}:ac_2` },
      { object: `${D}:ac_2`, relation: "direct", user: `${U}:ac_alice` },
      // The same shape, plus a `userset_ttu_public` wildcard that
      // subtracts `alg_combined_userset_ttu` away again.
      {
        object: `${C3}:ac_2`,
        relation: "userset_ttu_inner_alg_combined",
        user: `${T}:ac_1#ttu_alg_combined_computed`,
      },
      {
        object: `${C3}:ac_2`,
        relation: "userset_ttu_other_rel",
        user: `${T}:ac_1#ttu_other_rel`,
      },
      { object: `${C3}:ac_2`, relation: "userset_ttu_public", user: `${U}:*` },
      { object: `${C4}:ac_2`, relation: "parent", user: `${C3}:ac_2` },
      {
        object: `${C4}:ac_2`,
        relation: "or_complex4",
        user: `${C3}:ac_2#userset_ttu_public`,
      },
    ],
    checks: [
      {
        name: "directs alg_combined holds",
        object: `${D}:ac_1`,
        relation: "alg_combined",
        user: `${U}:ac_alice`,
        expect: true,
      },
      {
        name: "ttus alg_combined_computed holds",
        object: `${T}:ac_1`,
        relation: "ttu_alg_combined_computed",
        user: `${U}:ac_alice`,
        expect: true,
      },
      {
        name: "complexity3 inner arm, userset subject",
        object: `${C3}:ac_1`,
        relation: "userset_ttu_inner_alg_combined",
        user: `${T}:ac_1#ttu_alg_combined_computed`,
        expect: true,
      },
      {
        name: "complexity3 and_userset_ttu",
        object: `${C3}:ac_1`,
        relation: "and_userset_ttu",
        user: `${U}:ac_alice`,
        expect: true,
      },
      {
        name: "complexity3 alg_combined_userset_ttu, nothing subtracted",
        object: `${C3}:ac_1`,
        relation: "alg_combined_userset_ttu",
        user: `${U}:ac_alice`,
        expect: true,
      },
      {
        name: "complexity3 alg_combined_userset_ttu, wildcard subtracts",
        object: `${C3}:ac_2`,
        relation: "alg_combined_userset_ttu",
        user: `${U}:ac_alice`,
        expect: false,
      },
      {
        name: "intersection over a TTU onto an exclusion",
        object: `${C4}:ac_1`,
        relation: "alg_combined_complex4",
        user: `${U}:ac_alice`,
        expect: true,
      },
      {
        name: "the same, once the exclusion fires",
        object: `${C4}:ac_2`,
        relation: "alg_combined_complex4",
        user: `${U}:ac_alice`,
        expect: false,
      },
      {
        name: "userset subject satisfying only the union side",
        object: `${C4}:ac_1`,
        relation: "alg_combined_complex4",
        user: `${T}:ac_2#ttu_direct`,
        expect: false,
      },
      {
        name: "userset subject satisfying only the intersect side",
        object: `${C4}:ac_1`,
        relation: "alg_combined_complex4",
        user: `${T}:ac_1#ttu_alg_combined_computed`,
        expect: false,
      },
      {
        name: "or_complex4 alone, for the union-side userset",
        object: `${C4}:ac_1`,
        relation: "or_complex4",
        user: `${T}:ac_2#ttu_direct`,
        expect: true,
      },
      {
        name: "an unrelated user",
        object: `${C4}:ac_1`,
        relation: "alg_combined_complex4",
        user: `${U}:ac_bob`,
        expect: false,
      },
    ],
    assertions: [
      {
        user: `${U}:ac_alice`,
        type: C4,
        relation: "alg_combined_complex4",
        context: VALID_CONTEXT,
        expect: [`${C4}:ac_1`],
      },
      {
        user: `${U}:ac_alice`,
        type: C3,
        relation: "alg_combined_userset_ttu",
        context: VALID_CONTEXT,
        expect: [`${C3}:ac_1`],
      },
      {
        user: `${T}:ac_1#ttu_alg_combined_computed`,
        type: C3,
        relation: "userset_ttu_inner_alg_combined",
        context: VALID_CONTEXT,
        expect: [`${C3}:ac_1`, `${C3}:ac_2`],
      },
      {
        user: `${T}:ac_2#ttu_direct`,
        type: C4,
        relation: "alg_combined_complex4",
        context: VALID_CONTEXT,
        expect: [],
      },
    ],
  },
  {
    name: "c3_tuple_cycle_len3_check",
    tuples: [
      {
        object: `${D}:tc_1`,
        relation: "tuple_cycle_len3",
        user: `${C3}:tc_1#tuple_cycle_len3`,
      },
      {
        object: `${S}:tc_1`,
        relation: "tuple_cycle_len3",
        user: `${D}:tc_1#tuple_cycle_len3`,
      },
      { object: `${C3}:tc_2`, relation: "userset_parent", user: `${S}:tc_1` },
      {
        object: `${D}:tc_2`,
        relation: "tuple_cycle_len3",
        user: `${C3}:tc_2#tuple_cycle_len3`,
      },
      {
        object: `${S}:tc_2`,
        relation: "tuple_cycle_len3",
        user: `${D}:tc_2#tuple_cycle_len3`,
      },
      {
        object: `${C3}:tc_1`,
        relation: "tuple_cycle_len3",
        user: `${U}:tc_alice`,
      },
      // A closed cycle with nothing granting inside it.
      {
        object: `${D}:tc_cycle`,
        relation: "tuple_cycle_len3",
        user: `${C3}:tc_cycle#tuple_cycle_len3`,
      },
      {
        object: `${S}:tc_cycle`,
        relation: "tuple_cycle_len3",
        user: `${D}:tc_cycle#tuple_cycle_len3`,
      },
      {
        object: `${C3}:tc_cycle`,
        relation: "userset_parent",
        user: `${S}:tc_cycle`,
      },
    ],
    checks: [
      {
        name: "user at the head of the chain",
        object: `${C3}:tc_1`,
        relation: "tuple_cycle_len3",
        user: `${U}:tc_alice`,
        expect: true,
      },
      {
        name: "one hop up the chain",
        object: `${D}:tc_1`,
        relation: "tuple_cycle_len3",
        user: `${U}:tc_alice`,
        expect: true,
      },
      {
        name: "two hops up the chain",
        object: `${S}:tc_1`,
        relation: "tuple_cycle_len3",
        user: `${U}:tc_alice`,
        expect: true,
      },
      {
        name: "three hops, back through userset_parent",
        object: `${C3}:tc_2`,
        relation: "tuple_cycle_len3",
        user: `${U}:tc_alice`,
        context: VALID_CONTEXT,
        expect: true,
      },
      {
        name: "five hops",
        object: `${S}:tc_2`,
        relation: "tuple_cycle_len3",
        user: `${U}:tc_alice`,
        context: VALID_CONTEXT,
        expect: true,
      },
      {
        name: "the complexity3 userset the directs row names",
        object: `${D}:tc_1`,
        relation: "tuple_cycle_len3",
        user: `${C3}:tc_1#tuple_cycle_len3`,
        expect: true,
      },
      {
        name: "the directs userset the usersets-user row names",
        object: `${S}:tc_1`,
        relation: "tuple_cycle_len3",
        user: `${D}:tc_1#tuple_cycle_len3`,
        expect: true,
      },
      {
        name: "the complexity3 userset, two hops up",
        object: `${S}:tc_1`,
        relation: "tuple_cycle_len3",
        user: `${C3}:tc_1#tuple_cycle_len3`,
        expect: true,
      },
      {
        name: "a userset from the far end of the chain",
        object: `${C3}:tc_2`,
        relation: "tuple_cycle_len3",
        user: `${D}:tc_1#tuple_cycle_len3`,
        context: VALID_CONTEXT,
        expect: true,
      },
      {
        name: "a closed cycle grants nobody",
        object: `${C3}:tc_cycle`,
        relation: "tuple_cycle_len3",
        user: `${U}:tc_alice`,
        context: VALID_CONTEXT,
        expect: false,
      },
      {
        name: "a closed cycle, asked for its own userset",
        object: `${C3}:tc_cycle`,
        relation: "tuple_cycle_len3",
        user: `${D}:tc_cycle#tuple_cycle_len3`,
        context: VALID_CONTEXT,
        expect: true,
      },
      {
        name: "a closed cycle, asked for a userset it does not reach",
        object: `${S}:tc_cycle`,
        relation: "tuple_cycle_len3",
        user: `${C3}:tc_1#tuple_cycle_len3`,
        context: VALID_CONTEXT,
        expect: false,
      },
    ],
    assertions: [
      {
        user: `${U}:tc_alice`,
        type: S,
        relation: "tuple_cycle_len3",
        context: VALID_CONTEXT,
        expect: [`${S}:tc_1`, `${S}:tc_2`],
      },
      {
        user: `${C3}:tc_1#tuple_cycle_len3`,
        type: S,
        relation: "tuple_cycle_len3",
        context: VALID_CONTEXT,
        expect: [`${S}:tc_1`, `${S}:tc_2`],
      },
      {
        user: `${D}:tc_1#tuple_cycle_len3`,
        type: C3,
        relation: "tuple_cycle_len3",
        context: VALID_CONTEXT,
        expect: [`${C3}:tc_2`],
      },
    ],
  },
];

describe("c1: complexity3 / complexity4 with userset subjects", () => {
  let db: Kysely<DB>;
  let tsfgaClient: TsfgaClient;
  let fixture: FixtureRecord;

  beforeAll(async () => {
    ({ db, tsfgaClient, fixture } = await setupMatrix());
  });

  afterAll(async () => {
    await teardownMatrix(db);
  });

  for (const testCase of CASES) {
    describe(testCase.name, () => {
      let storeId: string;
      let authorizationModelId: string;

      beforeAll(async () => {
        ({ storeId, authorizationModelId } = await createCaseStore(
          testCase.name,
        ));
        await writeCaseTuples(
          tsfgaClient,
          storeId,
          authorizationModelId,
          testCase.tuples,
        );
      });

      afterAll(async () => {
        await removeCaseTuples(tsfgaClient, testCase.tuples);
      });

      for (const [index, assertion] of (testCase.checks ?? []).entries()) {
        const label =
          (assertion.issue ? `GAP-${assertion.issue}: ` : "") +
          `check #${index} ${assertion.name}`;
        test(label, async () => {
          await expectConformance(
            storeId,
            authorizationModelId,
            tsfgaClient,
            checkRequest(assertion),
            assertion.expect,
          );
        });
      }

      for (const [index, assertion] of (testCase.assertions ?? []).entries()) {
        const label =
          (assertion.issue ? `GAP-${assertion.issue}: ` : "") +
          `listObjects #${index} ${assertion.user} ` +
          `${assertion.relation} ${assertion.type}` +
          (assertion.context ? ` x=${String(assertion.context.x)}` : "");
        test(label, async () => {
          await expectListObjectsConformance(
            storeId,
            authorizationModelId,
            tsfgaClient,
            assertionRequest(assertion),
            assertionExpectation(assertion),
          );
        });
      }
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
