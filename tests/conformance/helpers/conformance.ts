import { expect } from "bun:test";
import * as fs from "node:fs";
import { transformer } from "@openfga/syntax-transformer";
import {
  type AddTupleRequest,
  type CheckRequest,
  formatRestriction,
  type RelationConfig,
  type TsfgaClient,
  type TypeRestriction,
} from "@tsfga/core";
import { fgaCheck, fgaWrite } from "./openfga.ts";

/**
 * Assert that tsfga and OpenFGA return the same result for a permission check.
 * Runs both checks in parallel for speed.
 */
export async function expectConformance(
  storeId: string,
  authorizationModelId: string,
  tsfgaClient: TsfgaClient,
  params: CheckRequest,
  expected: boolean,
): Promise<void> {
  const contextualTuples = params.contextualTuples?.map((t) => ({
    user: t.subjectRelation
      ? `${t.subjectType}:${t.subjectId}#${t.subjectRelation}`
      : `${t.subjectType}:${t.subjectId}`,
    relation: t.relation,
    object: `${t.objectType}:${t.objectId}`,
  }));

  const [tsfgaResult, openFgaResult] = await Promise.all([
    tsfgaClient.check(params),
    fgaCheck(storeId, authorizationModelId, {
      objectType: params.objectType,
      objectId: params.objectId,
      relation: params.relation,
      subjectType: params.subjectType,
      subjectId: params.subjectId,
      context: params.context,
      contextualTuples,
    }),
  ]);

  if (openFgaResult === null) {
    throw new Error("OpenFGA returned an error");
  }

  // Both systems must agree
  expect(tsfgaResult).toBe(openFgaResult);
  // And match expected value
  expect(tsfgaResult).toBe(expected);
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
  const [tsfgaOutcome, openFgaOutcome] = await Promise.all([
    tsfgaClient
      .addTuple(tuple)
      .then(() => "accepted" as const)
      .catch(() => "refused" as const),
    fgaWrite(storeId, authorizationModelId, tuple),
  ]);

  expect(tsfgaOutcome).toBe(openFgaOutcome);
  expect(tsfgaOutcome).toBe(expected);
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
