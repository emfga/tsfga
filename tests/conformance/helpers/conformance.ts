import { expect } from "bun:test";
import * as fs from "node:fs";
import type { WriteAuthorizationModelRequest } from "@openfga/sdk";
import { transformer } from "@openfga/syntax-transformer";
import {
  type AddTupleRequest,
  type CheckRequest,
  formatRestriction,
  MissingTupleError,
  type RelationConfig,
  type RemoveTupleRequest,
  type TsfgaClient,
  TsfgaError,
  type TypeRestriction,
  type WriteRuleId,
} from "@tsfga/core";
import {
  type FgaContextualTuple,
  fgaCheck,
  fgaDeleteOutcome,
  fgaListObjects,
  fgaWriteModelOutcome,
  fgaWriteOutcome,
} from "./openfga.ts";
import { recordRefusal } from "./refusal-log.ts";

/**
 * What a check may do: answer, or decline to answer.
 *
 * "refused" is an outcome rather than a failure because several
 * parity shapes are ones where *both* engines refuse -- the
 * coercion matrix is largely "OpenFGA refuses and tsfga answers",
 * and a check on a relation the model does not define is a refusal
 * upstream. Collapsing that into a thrown error, as this helper
 * used to, made those cases unassertable: a refusal could only
 * ever fail a test, never satisfy one.
 */
export type CheckOutcome = boolean | "refused";

/**
 * Assert that tsfga and OpenFGA return the same result for a permission check.
 * Runs both checks in parallel for speed.
 */
export async function expectConformance(
  storeId: string,
  authorizationModelId: string,
  tsfgaClient: TsfgaClient,
  params: CheckRequest,
  expected: CheckOutcome,
): Promise<void> {
  const [tsfgaResult, openFgaResult] = await runBoth(
    storeId,
    authorizationModelId,
    tsfgaClient,
    params,
  );

  // Both systems must agree
  expect(tsfgaResult).toBe(openFgaResult);
  // And match expected value
  expect(tsfgaResult).toBe(expected);
}

/**
 * Pin a divergence: assert what **each** engine answers, knowing
 * they answer differently.
 *
 * The counterpart to `expectConformance`, for the shapes tsfga
 * documents as known divergences. A divergence nothing asserts is
 * indistinguishable from one nobody has noticed: the answers can
 * move — a dependency upgrade is enough — and the README goes on
 * describing the old ones. Pinning both sides means the day either
 * engine changes, a test says so.
 *
 * Refuses to pass on agreement. A pinned cell that has stopped
 * diverging is not a passing test, it is a README paragraph to
 * delete and an `expectConformance` to write.
 */
export async function expectPinnedDivergence(
  storeId: string,
  authorizationModelId: string,
  tsfgaClient: TsfgaClient,
  params: CheckRequest,
  expected: { openfga: CheckOutcome; tsfga: CheckOutcome },
): Promise<void> {
  expect(expected.openfga).not.toBe(expected.tsfga);

  const [tsfgaResult, openFgaResult] = await runBoth(
    storeId,
    authorizationModelId,
    tsfgaClient,
    params,
  );

  expect(openFgaResult).toBe(expected.openfga);
  expect(tsfgaResult).toBe(expected.tsfga);
}

/**
 * Assert tsfga's answer exactly, and accept any one of a stated
 * set of answers from OpenFGA.
 *
 * **For a shape where upstream is nondeterministic — nothing
 * else.** The one call this exists for is a condition error behind
 * a dispatch onto a wildcard-only relation.
 * Upstream's answer there is load-dependent: run
 * `wildcard-positions.test.ts` alone and OpenFGA answers `false` every
 * time; run it inside the full suite and it refuses, agreeing
 * with tsfga. The suspected cause is a race in
 * `internal/graph/weight_two_resolver.go` between the tuple
 * stream and the stashed condition error, so which answer comes
 * back is a function of how busy the container is, not of the
 * model. tsfga's `refused` never moves.
 *
 * Tolerating is correct *here* because the alternatives are all
 * worse: `expectConformance` fails on whichever load the suite
 * happens to run under, and `expectPinnedDivergence` pins one
 * half of a coin flip — a pin that flaps is worse than no pin,
 * because it trains everyone to re-run the suite instead of
 * reading it. Deleting the assertion would lose the only
 * coverage in the suite of that shape.
 *
 * **Do not reach for this because a divergence is inconvenient.**
 * A divergence that is stable, however unwelcome, is
 * `expectPinnedDivergence` with a README paragraph beside it; a
 * divergence tsfga can close is a bug to fix. This helper is only
 * for a shape measured to answer two ways *on the same input and
 * the same build*, and it buys nothing on tsfga's side: tsfga's
 * outcome is one value and is asserted as strictly as anywhere
 * else. The tolerance is on OpenFGA's side, and only over the
 * answers named here.
 *
 * Refuses to pass on a single tolerated answer. One entry is not
 * nondeterminism — it is an `expectConformance` or an
 * `expectPinnedDivergence`, and should be written as one.
 */
export async function expectToleratedNondeterminism(
  storeId: string,
  authorizationModelId: string,
  tsfgaClient: TsfgaClient,
  params: CheckRequest,
  expected: { tsfga: CheckOutcome; openfga: readonly CheckOutcome[] },
): Promise<void> {
  const tolerated = [...new Set(expected.openfga)].map(String).sort();
  expect(tolerated.length > 1).toBe(true);

  const [tsfgaResult, openFgaResult] = await runBoth(
    storeId,
    authorizationModelId,
    tsfgaClient,
    params,
  );

  expect(tsfgaResult).toBe(expected.tsfga);

  const seen = String(openFgaResult);
  expect(
    tolerated.includes(seen)
      ? "tolerated"
      : `OpenFGA answered ${seen}; tolerated: ${tolerated.join(", ")}`,
  ).toBe("tolerated");
}

/**
 * A tuple as OpenFGA's contextual-tuple field spells it.
 *
 * The condition travels with it. See `FgaContextualTuple` for why
 * dropping it fabricates agreements as readily as divergences.
 */
function asFgaTuple(tuple: AddTupleRequest): FgaContextualTuple {
  return {
    user: tuple.subjectRelation
      ? `${tuple.subjectType}:${tuple.subjectId}#${tuple.subjectRelation}`
      : `${tuple.subjectType}:${tuple.subjectId}`,
    relation: tuple.relation,
    object: `${tuple.objectType}:${tuple.objectId}`,
    ...(tuple.conditionName
      ? {
          condition: {
            name: tuple.conditionName,
            ...(tuple.conditionContext
              ? { context: tuple.conditionContext }
              : {}),
          },
        }
      : {}),
  };
}

/** Run one check on both engines, in parallel. */
async function runBoth(
  storeId: string,
  authorizationModelId: string,
  tsfgaClient: TsfgaClient,
  params: CheckRequest,
): Promise<[CheckOutcome, CheckOutcome]> {
  const contextualTuples = params.contextualTuples?.map(asFgaTuple);

  const [tsfgaResult, openFgaRaw] = await Promise.all([
    tsfgaClient
      .check(params)
      .then((allowed): CheckOutcome => allowed)
      .catch((error: unknown): CheckOutcome => {
        // Only tsfga's own refusals count as a refusal. Anything
        // else is a broken fixture masquerading as agreement.
        if (error instanceof TsfgaError) return "refused";
        throw error;
      }),
    fgaCheck(storeId, authorizationModelId, {
      objectType: params.objectType,
      objectId: params.objectId,
      relation: params.relation,
      subjectType: params.subjectType,
      subjectId: params.subjectId,
      subjectRelation: params.subjectRelation,
      context: params.context,
      contextualTuples,
    }),
  ]);

  if (openFgaRaw === null) {
    throw new Error("OpenFGA returned no answer and no refusal");
  }
  const openFgaResult: CheckOutcome =
    typeof openFgaRaw === "boolean" ? openFgaRaw : "refused";

  return [tsfgaResult, openFgaResult];
}

export interface ListObjectsParams {
  objectType: string;
  relation: string;
  subjectType: string;
  subjectId: string;
  /** Set to ask about a userset — `group:eng#member`. */
  subjectRelation?: string | null;
  context?: Record<string, unknown>;
  contextualTuples?: AddTupleRequest[];
}

/**
 * Assert that tsfga and OpenFGA reach the same objects.
 *
 * **Compared as sorted sets.** tsfga returns candidates in
 * candidate order and OpenFGA streams them in completion order
 * from a worker pool, so order carries no meaning on either side
 * and comparing it would make the suite flaky for a reason that
 * has nothing to do with parity.
 *
 * `expected` is asserted too, so a shape both engines get wrong in
 * the same direction — the reason a one-sided suite is not enough —
 * still fails.
 */
export async function expectListObjectsConformance(
  storeId: string,
  authorizationModelId: string,
  tsfgaClient: TsfgaClient,
  params: ListObjectsParams,
  expected: readonly string[],
): Promise<void> {
  const [tsfgaObjects, openFgaObjects] = await Promise.all([
    tsfgaClient.listObjects(params),
    fgaListObjects(storeId, authorizationModelId, {
      ...params,
      contextualTuples: params.contextualTuples?.map(asFgaTuple),
    }),
  ]);

  const tsfgaResult = [...tsfgaObjects].sort();
  expect(tsfgaResult).toEqual([...openFgaObjects].sort());
  expect(tsfgaResult).toEqual([...expected].sort());
}

/**
 * What a `listObjects` call may do: reach a set of objects, or
 * decline to answer.
 *
 * The refusal is not an error the caller can route around: both
 * engines abort the whole call rather than return a partial set,
 * so a refusal costs every object, including the ones inside the
 * budget that both engines agree on.
 */
export type ListObjectsOutcome = readonly string[] | "refused";

/**
 * Pin a `listObjects` divergence: assert what **each** engine
 * does, knowing they differ.
 *
 * The counterpart to `expectPinnedDivergence`, and it exists for
 * the same reason: the depth boundary is documented as a known
 * divergence, and a documented divergence nothing asserts is
 * indistinguishable from one nobody has noticed.
 *
 * Refuses to pass on agreement, so a pinned cell that has stopped
 * diverging fails and gets rewritten as `expectListObjects-
 * Conformance` rather than quietly passing forever.
 */
export async function expectPinnedListObjectsDivergence(
  storeId: string,
  authorizationModelId: string,
  tsfgaClient: TsfgaClient,
  params: ListObjectsParams,
  expected: { openfga: ListObjectsOutcome; tsfga: ListObjectsOutcome },
): Promise<void> {
  expect(describeOutcome(expected.openfga)).not.toBe(
    describeOutcome(expected.tsfga),
  );

  const [tsfgaOutcome, openFgaOutcome] = await Promise.all([
    tsfgaClient
      .listObjects(params)
      .then((objects): ListObjectsOutcome => [...objects].sort())
      .catch((error: unknown): ListObjectsOutcome => {
        // Only tsfga's own refusal counts. Anything else is a
        // broken fixture reported as a pinned divergence.
        if (error instanceof TsfgaError) return "refused";
        throw error;
      }),
    fgaListObjects(storeId, authorizationModelId, {
      ...params,
      contextualTuples: params.contextualTuples?.map(asFgaTuple),
    })
      .then((objects): ListObjectsOutcome => [...objects].sort())
      .catch((): ListObjectsOutcome => "refused"),
  ]);

  expect(describeOutcome(openFgaOutcome)).toBe(
    describeOutcome(normalise(expected.openfga)),
  );
  expect(describeOutcome(tsfgaOutcome)).toBe(
    describeOutcome(normalise(expected.tsfga)),
  );
}

function normalise(outcome: ListObjectsOutcome): ListObjectsOutcome {
  return outcome === "refused" ? outcome : [...outcome].sort();
}

/** Compared as one string so a set and a refusal are comparable. */
function describeOutcome(outcome: ListObjectsOutcome): string {
  return outcome === "refused" ? "refused" : JSON.stringify(outcome);
}

/**
 * Assert that tsfga and OpenFGA agree on whether a tuple may be
 * *written* at all.
 *
 * Type restrictions are enforced twice by OpenFGA — once when the
 * tuple is written, once when a check reads it — and the two must
 * be checked separately. A suite that only ever writes through the
 * validating path cannot observe a read-gate divergence, because
 * the rows that would expose it are the rows the write path
 * refuses to create.
 *
 * `expected` is what both systems must do, so a test that asserts
 * a *legal* write also fails if either side wrongly refuses it.
 */
export async function expectWriteConformance(
  storeId: string,
  authorizationModelId: string,
  tsfgaClient: TsfgaClient,
  tuple: AddTupleRequest,
  expected: "accepted" | "refused",
): Promise<void> {
  const [tsfga, openFgaOutcome] = await Promise.all([
    tsfgaWriteOutcome(tsfgaClient, tuple),
    upstreamWriteOutcome(storeId, authorizationModelId, tuple),
  ]);

  expect(tsfga.outcome).toBe(openFgaOutcome);
  expect(tsfga.outcome).toBe(expected);
}

/**
 * As `expectWriteConformance`, and additionally: assert **which**
 * tsfga rule refused.
 *
 * A tuple carrying two defects is refused by whichever rule runs
 * first, and that order is upstream's. `expectWriteConformance`
 * reduces both sides to a word, so it cannot tell one refusal from
 * another and a reordering reads as green.
 *
 * The rule is asserted on **tsfga's own** error and never across
 * engines, for the reason `expectPinnedModelWriteDivergence`
 * gives: the two engines' prose can never be equal, so comparing
 * it would pin OpenFGA's wording rather than its behaviour.
 *
 * Not for a case whose defect is the *identifier itself*. A rule
 * gating the id domain would take precedence over every rule
 * below it, so pinning one there pins a decision about where such
 * a rule belongs rather than upstream's order.
 */
export async function expectWriteConformanceWithCause(
  storeId: string,
  authorizationModelId: string,
  tsfgaClient: TsfgaClient,
  tuple: AddTupleRequest,
  expected: "accepted" | "refused",
  pin: { tsfga: WriteRuleId },
): Promise<void> {
  const [tsfga, openFgaOutcome] = await Promise.all([
    tsfgaWriteOutcome(tsfgaClient, tuple),
    upstreamWriteOutcome(storeId, authorizationModelId, tuple),
  ]);

  expect(tsfga.outcome).toBe(openFgaOutcome);
  expect(tsfga.outcome).toBe(expected);
  expect(tsfga.error?.ruleId ?? null).toBe(pin.tsfga);
}

/** What a tuple write may do. */
export type WriteOutcome = "accepted" | "refused";

/** What tsfga did with a write, and the error it did it with. */
interface TsfgaWriteOutcome {
  outcome: WriteOutcome;
  /** The refusal itself, so an assertion can be about *which* one. */
  error: TsfgaError | null;
}

async function tsfgaWriteOutcome(
  tsfgaClient: TsfgaClient,
  tuple: AddTupleRequest,
): Promise<TsfgaWriteOutcome> {
  try {
    await tsfgaClient.addTuple(tuple);
    return { outcome: "accepted", error: null };
  } catch (error: unknown) {
    // A TsfgaError is the model refusing. Anything else -- a
    // missing relation config from a mis-ordered fixture, a
    // dropped connection -- would otherwise be reported as a
    // refusal and satisfy the assertion it was meant to test.
    if (!(error instanceof TsfgaError)) throw error;
    return { outcome: "refused", error };
  }
}

/**
 * Upstream's side of a tuple write, reduced to an outcome after the
 * refusal has been recorded.
 *
 * `fgaWriteOutcome` rather than `fgaWrite`: the code and the
 * message are what the refusal recorder measures the cause
 * inventory's scope against, and `fgaWrite` discards both before
 * this file can see them.
 */
async function upstreamWriteOutcome(
  storeId: string,
  authorizationModelId: string,
  tuple: AddTupleRequest,
): Promise<WriteOutcome> {
  const outcome = await fgaWriteOutcome(storeId, authorizationModelId, tuple);
  if (outcome === "accepted") return "accepted";
  recordRefusal({
    helper: "expectWriteConformance",
    code: outcome.code,
    reason: outcome.reason,
  });
  return "refused";
}

/**
 * Pin a *write* divergence: assert what **each** engine does with
 * the same tuple, knowing they do different things.
 *
 * The write-path counterpart to `expectPinnedDivergence`, and it
 * exists for the same reason. `expectWriteConformance` can only
 * say the two engines agree; a shape where they do not — issue
 * 282's userset packed into `subjectId` — had to be written out by
 * hand, which is how a two-sided assertion quietly becomes a
 * one-sided one when somebody tidies it.
 *
 * Refuses to pass on agreement. A pinned write that has stopped
 * diverging is not a passing test, it is a README paragraph to
 * delete and an `expectWriteConformance` to write.
 *
 * A tsfga refusal counts only when it is a `TsfgaError`, as
 * everywhere else: a mis-ordered fixture or a dropped connection
 * reported as a refusal would satisfy the assertion it was meant
 * to test.
 */
export async function expectPinnedWriteDivergence(
  storeId: string,
  authorizationModelId: string,
  tsfgaClient: TsfgaClient,
  tuple: AddTupleRequest,
  expected: { openfga: WriteOutcome; tsfga: WriteOutcome },
): Promise<void> {
  expect(expected.openfga).not.toBe(expected.tsfga);

  const [tsfga, openFgaOutcome] = await Promise.all([
    tsfgaWriteOutcome(tsfgaClient, tuple),
    upstreamWriteOutcome(storeId, authorizationModelId, tuple),
  ]);

  expect(openFgaOutcome).toBe(expected.openfga);
  expect(tsfga.outcome).toBe(expected.tsfga);
}

/** What a model write may do. */
export type ModelWriteOutcome = "accepted" | "refused";

/**
 * Run a tsfga write and report whether tsfga took it.
 *
 * The tsfga side is a thunk rather than a typed payload because
 * OpenFGA validates a whole model in one call while tsfga
 * validates per relation config and per condition definition. The
 * caller passes whichever write carries the shape under test —
 * `writeConditionDefinition`, `writeRelationConfig`, or several of
 * them in sequence.
 *
 * A tsfga refusal counts only when it is a `TsfgaError`, as
 * everywhere else in this file: a mis-ordered fixture or a dropped
 * connection reported as a refusal would satisfy the assertion it
 * was meant to test.
 */
async function tsfgaModelWriteOutcome(
  tsfgaWrite: () => Promise<unknown>,
  cause?: string,
): Promise<ModelWriteOutcome> {
  try {
    await tsfgaWrite();
    return "accepted";
  } catch (error: unknown) {
    if (!(error instanceof TsfgaError)) throw error;
    // The cause is asserted on tsfga's own error and never across
    // engines: OpenFGA's message and tsfga's will never be equal,
    // so comparing them would be two independent assertions wearing
    // one, and asserting on upstream's text is the version rot pins
    // exist to prevent.
    if (cause !== undefined) expect(error.message).toContain(cause);
    return "refused";
  }
}

/**
 * Upstream's side of a model write, reduced to an outcome after the
 * refusal has been recorded — the model-write twin of
 * `upstreamWriteOutcome`, and recorded for the same reason.
 */
async function upstreamModelWriteOutcome(
  storeId: string,
  model: WriteAuthorizationModelRequest,
): Promise<ModelWriteOutcome> {
  const outcome = await fgaWriteModelOutcome(storeId, model);
  if (outcome === "accepted") return "accepted";
  recordRefusal({
    helper: "expectModelWriteConformance",
    code: outcome.code,
    reason: outcome.reason,
  });
  return "refused";
}

/**
 * Assert that tsfga and OpenFGA agree on whether a model may be
 * *written* at all.
 *
 * The model-write counterpart to `expectWriteConformance`. Model
 * validation is a moment of its own: OpenFGA compiles every
 * condition while it validates the model, so an expression that
 * cannot compile is refused at `WriteAuthorizationModel` and never
 * reaches a check. A suite that only asserts checks cannot see
 * that moment at all.
 *
 * `expected` is what both systems must do, so a test that asserts
 * a *legal* model also fails if either side wrongly refuses it.
 */
export async function expectModelWriteConformance(
  storeId: string,
  model: WriteAuthorizationModelRequest,
  tsfgaWrite: () => Promise<unknown>,
  expected: ModelWriteOutcome,
): Promise<void> {
  const [tsfgaOutcome, openFgaOutcome] = await Promise.all([
    tsfgaModelWriteOutcome(tsfgaWrite),
    upstreamModelWriteOutcome(storeId, model),
  ]);

  expect(tsfgaOutcome).toBe(openFgaOutcome);
  expect(tsfgaOutcome).toBe(expected);
}

/**
 * Pin a *model-write* divergence: assert what each engine does
 * with the same model, knowing they do different things.
 *
 * Refuses to pass on agreement, like its two siblings. A pinned
 * model write that has stopped diverging is not a passing test, it
 * is a README paragraph to delete and an
 * `expectModelWriteConformance` to write.
 *
 * `options.tsfgaCause` discriminates between competing refusals on
 * tsfga's own side. Three distinct write-time gates — the
 * declaration allow-list, the type check, and a parse failure —
 * all surface as `"refused"`, so a pin firing for the wrong one is
 * indistinguishable from one firing for the right one, and it
 * would keep passing after the gate it names was removed. It is
 * optional because most cells have no competing refusal: when both
 * engines refuse an unparseable expression, which parser
 * complained is not interesting.
 */
export async function expectPinnedModelWriteDivergence(
  storeId: string,
  model: WriteAuthorizationModelRequest,
  tsfgaWrite: () => Promise<unknown>,
  expected: { openfga: ModelWriteOutcome; tsfga: ModelWriteOutcome },
  options?: { tsfgaCause?: string },
): Promise<void> {
  expect(expected.openfga).not.toBe(expected.tsfga);

  const [tsfgaOutcome, openFgaOutcome] = await Promise.all([
    tsfgaModelWriteOutcome(tsfgaWrite, options?.tsfgaCause),
    upstreamModelWriteOutcome(storeId, model),
  ]);

  expect(openFgaOutcome).toBe(expected.openfga);
  expect(tsfgaOutcome).toBe(expected.tsfga);
}

/**
 * What a fixture told tsfga, captured as it said it.
 *
 * @see recordFixture
 */
export interface FixtureRecord {
  /** Every config the fixture wrote, in order. */
  configs: RelationConfig[];
  /** `objectType.relation` for every tuple the fixture wrote. */
  tupleRelations: Set<string>;
}

/**
 * Record what a fixture writes, by wrapping the client's write
 * methods in place.
 *
 * Deliberately not a refactor of the fixtures into arrays of
 * configs the suite hands over. This records the write path, so
 * what `expectConfigsMatchModel` compares is what tsfga was
 * actually told, and not a second list kept alongside the
 * writes it is meant to describe. Such a list drifts:
 * `condition-restrictions` builds its record by hand and states
 * `team.member` twice, once in the write and once in the
 * record, with nothing holding the two together. It has a
 * reason its own comment gives; nothing else here needs one.
 *
 * Not that an array could not hold them. `theopenlane/setup.ts`
 * keeps 225 configs in `RELATION_CONFIGS` and writes them in a
 * loop, and still wraps with this — the array is its source,
 * not its assertion. But eight `writeRelationConfig` sites
 * across four fixtures compute the relation name per iteration
 * — `intersection-cycle-precedence` (3), `cycles` (2),
 * `deep-rewrite` (2), `userset-restrictions` (1) — as do six
 * `addTuple` sites across five files. Written out as literals
 * they would unroll `DEPTH = 30` and `CHAIN_LENGTH = 9`, the
 * constants those fixtures exist to set.
 *
 * The asymmetry is why this is the general mechanism: a fixture
 * later rewritten as an array is still recorded correctly here,
 * while a hand-kept list has to be kept correct forever.
 *
 * Call it immediately after `createTsfga`, before the fixture
 * writes anything.
 *
 * The parameter names the two methods this replaces rather than
 * the whole client, so what it mutates is visible in the type.
 */
export function recordFixture(
  client: Pick<TsfgaClient, "writeRelationConfig" | "addTuple">,
): FixtureRecord {
  const record: FixtureRecord = { configs: [], tupleRelations: new Set() };
  const writeRelationConfig = client.writeRelationConfig.bind(client);
  const addTuple = client.addTuple.bind(client);

  client.writeRelationConfig = (config) => {
    record.configs.push(config);
    return writeRelationConfig(config);
  };
  client.addTuple = (tuple) => {
    record.tupleRelations.add(`${tuple.objectType}.${tuple.relation}`);
    return addTuple(tuple);
  };
  return record;
}

/** A relation whose admitted refs live on a helper relation instead. */
export interface MovedRelation {
  /** `objectType.relation`, as the model names it. */
  relation: string;
  /** `objectType.relation` of the helper that now carries the refs. */
  movedTo: string;
}

export interface ConfigDriftOptions {
  /**
   * `"complete"` — the fixture models the whole DSL, so every
   * relation it defines must have a config.
   *
   * `"subset"` — the fixture covers part of a larger model. Only
   * relations it does configure are compared, but every relation a
   * tuple targets must still have one: a forgotten config reads as
   * *unrestricted*, not as an error, so nothing else would notice.
   */
  coverage: "complete" | "subset";
  /**
   * Relations that exist only in tsfga — helpers that decompose a
   * pattern the check algorithm has no single form for.
   *
   * Self-verifying: each is asserted to have no DSL entry at all.
   * A relation the model does define cannot be excused this way.
   */
  tsfgaOnlyHelpers?: string[];
  /**
   * Relations whose direct assignments were moved onto a helper.
   *
   * Also self-verifying, and the reason this is not a free-text
   * "moved by decomposition" note: the destination is named, the
   * helper is asserted to admit everything the model gave the
   * original, and the original is asserted to admit nothing. A
   * decomposition that widens what is admitted still fails.
   */
  moved?: MovedRelation[];
}

/**
 * Assert that a fixture's relation configs say what its own model
 * says about direct assignment.
 *
 * **Exact, condition included.** `[user with weekday_only]` and
 * `[user]` are different restrictions, and a config claiming the
 * second where the model says the first admits a tuple OpenFGA
 * refuses. That is the drift this exists to catch — it is not a
 * cosmetic mismatch but the granting direction.
 *
 * **Set comparison, not multiset**, since a model may name the
 * same ref twice under different conditions and order carries no
 * meaning.
 */
export function expectConfigsMatchModel(
  modelPath: string,
  fixture: FixtureRecord,
  options: ConfigDriftOptions,
): void {
  const model = modelRestrictions(modelPath);
  const configs = new Map(
    fixture.configs.map((c) => [`${c.objectType}.${c.relation}`, c]),
  );
  const problems: string[] = [];
  const exempt = new Set<string>();

  // Helpers are cleared first. Everything after this — the moved
  // destinations, the coverage sweep — refers to relations the
  // model does not define, and would otherwise report them as
  // missing.
  for (const key of options.tsfgaOnlyHelpers ?? []) {
    if (model.has(key)) {
      problems.push(`${key}: exempted as tsfga-only, but the model defines it`);
    } else if (!configs.has(key)) {
      problems.push(`${key}: exempted as tsfga-only, but nothing writes it`);
    } else {
      exempt.add(key);
    }
  }

  for (const { relation, movedTo } of options.moved ?? []) {
    const admitted = model.get(relation);
    const destination = configs.get(movedTo);
    const original = configs.get(relation);
    if (!admitted) {
      problems.push(`${relation}: exempted as moved, but the model omits it`);
      continue;
    }
    if (!destination) {
      problems.push(`${relation}: moved to ${movedTo}, which nothing writes`);
      continue;
    }
    if (!original) {
      problems.push(`${relation}: exempted as moved, but nothing writes it`);
      continue;
    }
    const carried = new Set(
      destination.directlyAssignable.map(formatRestriction),
    );
    const dropped = [...admitted].filter((ref) => !carried.has(ref));
    if (dropped.length > 0) {
      problems.push(
        `${relation}: moved to ${movedTo}, which does not admit ` +
          `${dropped.join(", ")}`,
      );
    }
    if (original.directlyAssignable.length > 0) {
      problems.push(
        `${relation}: moved to ${movedTo}, so it must admit nothing, ` +
          `but admits ${original.directlyAssignable
            .map(formatRestriction)
            .join(", ")}`,
      );
    }
    exempt.add(relation);
  }

  for (const [key, config] of configs) {
    if (exempt.has(key)) continue;
    const admitted = model.get(key);
    if (!admitted) {
      problems.push(
        `${key}: configured, but the model defines no such relation`,
      );
      continue;
    }
    const actual = new Set(config.directlyAssignable.map(formatRestriction));
    const extra = [...actual].filter((ref) => !admitted.has(ref));
    const missing = [...admitted].filter((ref) => !actual.has(ref));
    if (extra.length > 0 || missing.length > 0) {
      problems.push(
        `${key}: admits [${[...actual].join(", ")}], ` +
          `model says [${[...admitted].join(", ")}]` +
          (extra.length > 0 ? ` — extra: ${extra.join(", ")}` : "") +
          (missing.length > 0 ? ` — missing: ${missing.join(", ")}` : ""),
      );
    }
  }

  if (options.coverage === "complete") {
    for (const key of model.keys()) {
      if (!configs.has(key)) {
        problems.push(
          `${key}: defined by the model, but nothing configures it`,
        );
      }
    }
  } else {
    for (const key of fixture.tupleRelations) {
      if (!configs.has(key) && !exempt.has(key)) {
        problems.push(`${key}: a tuple targets it, but nothing configures it`);
      }
    }
  }

  expect(problems).toEqual([]);
}

/**
 * `objectType.relation` to the set of refs the model admits, each
 * rendered by `formatRestriction` so that comparison is one string
 * equality rather than a hand-rolled structural compare that could
 * disagree with the one the library uses.
 *
 * Read through `@openfga/syntax-transformer`, never by pattern-
 * matching the DSL text. A `grep` for `with ` reports 24 hits in
 * `theopenlane/model.dsl`; 21 of them are the English word in a
 * prose comment and 3 are restrictions.
 */
function modelRestrictions(modelPath: string): Map<string, Set<string>> {
  const dsl = fs.readFileSync(modelPath, "utf-8");
  const model = transformer.transformDSLToJSONObject(dsl);
  const restrictions = new Map<string, Set<string>>();

  for (const type of model.type_definitions ?? []) {
    const metadata = type.metadata?.relations ?? {};
    for (const relation of Object.keys(type.relations ?? {})) {
      const refs = metadata[relation]?.directly_related_user_types ?? [];
      const admitted = new Set<string>();
      for (const ref of refs) {
        const restriction: TypeRestriction = { type: ref.type };
        if (ref.relation) restriction.relation = ref.relation;
        if (ref.wildcard) restriction.wildcard = true;
        if (ref.condition) restriction.condition = ref.condition;
        admitted.add(formatRestriction(restriction));
      }
      restrictions.set(`${type.type}.${relation}`, admitted);
    }
  }
  return restrictions;
}

/**
 * What a delete may do.
 *
 * `"missing"` is the outcome the delete gate exists to keep
 * separate from `"refused"`. Upstream refuses a *malformed*
 * delete at the request boundary and reports a *nonexistent* one
 * from inside the command, and it runs **no model validation** on
 * a delete at all — an undefined relation, an undefined type or a
 * subject type the relation does not admit all fall through to
 * `"missing"`. A gate that reused the write validators would
 * report `"refused"` for every one of those, and a model change
 * that dropped a relation would strand the rows written under it.
 */
export type DeleteOutcome = "accepted" | "refused" | "missing";

/**
 * Assert that tsfga and OpenFGA treat the same delete the same
 * way, and that they do what the test expected.
 *
 * Sequential rather than raced, unlike every other helper here:
 * both engines are being asked to delete the *same* row, so
 * running them in parallel would have each racing the other's
 * effect on its own store. They do not share a store, but the
 * fixture's rows are written to both, and a test asserting
 * `"accepted"` then `"missing"` on a replay depends on the order.
 */
export async function expectDeleteConformance(
  storeId: string,
  authorizationModelId: string,
  tsfgaClient: TsfgaClient,
  tuple: RemoveTupleRequest,
  expected: DeleteOutcome,
): Promise<void> {
  const openFgaOutcome = await fgaDeleteOutcome(storeId, authorizationModelId, {
    objectType: tuple.objectType,
    objectId: tuple.objectId,
    relation: tuple.relation,
    subjectType: tuple.subjectType,
    subjectId: tuple.subjectId,
    subjectRelation: tuple.subjectRelation ?? null,
  });

  let tsfgaOutcome: DeleteOutcome;
  try {
    await tsfgaClient.removeTuple(tuple);
    tsfgaOutcome = "accepted";
  } catch (error: unknown) {
    if (!(error instanceof TsfgaError)) throw error;
    // The two refusals are different outcomes, and telling them
    // apart is the whole point of this helper: a malformed delete
    // is refused at the request boundary, an absent row is refused
    // from inside the command, and a delete that is both must
    // report the first.
    tsfgaOutcome = error instanceof MissingTupleError ? "missing" : "refused";
  }

  expect(tsfgaOutcome).toBe(openFgaOutcome);
  expect(tsfgaOutcome).toBe(expected);
}

/**
 * Pin a *delete* divergence: assert what **each** engine does with
 * the same delete, knowing they do different things.
 *
 * The delete-path counterpart to `expectPinnedWriteDivergence`,
 * and it exists for a reason the write path never had. Seven rows
 * of `delete-gate.test.ts` assert that tsfga accepts a delete
 * syntactically and reaches the row — the guard against reusing
 * the write validators on a delete, which would strand every row
 * written under a dropped relation. Every one of those rows is
 * built on an id a `uuid` column cannot express, because that is
 * what makes them test anything, so once the store declares its id
 * domain tsfga refuses them by design. As parity assertions they
 * would go red; collapsed into "both refused" they would go green
 * and vacuous, losing the guard entirely.
 *
 * Pinned, they keep it: the assertion is still two-sided, it
 * still fails if tsfga's refusal moves, and it fails the day
 * upstream starts refusing them too — at which point the row
 * belongs back in the parity set.
 *
 * Refuses to pass on agreement, like every pin helper here.
 */
export async function expectPinnedDeleteDivergence(
  storeId: string,
  authorizationModelId: string,
  tsfgaClient: TsfgaClient,
  tuple: RemoveTupleRequest,
  expected: { openfga: DeleteOutcome; tsfga: DeleteOutcome },
): Promise<void> {
  expect(expected.openfga).not.toBe(expected.tsfga);

  const openFgaOutcome = await fgaDeleteOutcome(storeId, authorizationModelId, {
    objectType: tuple.objectType,
    objectId: tuple.objectId,
    relation: tuple.relation,
    subjectType: tuple.subjectType,
    subjectId: tuple.subjectId,
    subjectRelation: tuple.subjectRelation ?? null,
  });

  let tsfgaOutcome: DeleteOutcome;
  try {
    await tsfgaClient.removeTuple(tuple);
    tsfgaOutcome = "accepted";
  } catch (error: unknown) {
    // Only tsfga's own refusal counts, as everywhere else: a
    // dropped connection reported as a refusal would satisfy the
    // assertion it was meant to test.
    if (!(error instanceof TsfgaError)) throw error;
    tsfgaOutcome = error instanceof MissingTupleError ? "missing" : "refused";
  }

  expect(openFgaOutcome).toBe(expected.openfga);
  expect(tsfgaOutcome).toBe(expected.tsfga);
}
