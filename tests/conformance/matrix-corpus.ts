import { test } from "bun:test";
import type {
  AddTupleRequest,
  ConditionDefinition,
  RelationConfig,
  TsfgaClient,
} from "@tsfga/core";
import { type CheckOutcome, expectConformance } from "./helpers/conformance.ts";
import {
  fgaCreateStore,
  fgaWriteModel,
  fgaWriteTuplesRaw,
} from "./helpers/openfga.ts";

/**
 * The scaffolding the `b1-*` fixtures share.
 *
 * Those fixtures port upstream's own generated case matrices —
 * `tests/check/check_userset.go` and `tests/check/check_ttu.go` at
 * v1.18.2 — which are tables rather than prose: one model, a few
 * hundred rows of tuples, and a stated `Expectation:` per check.
 * Transcribing the tables by hand would be several thousand lines
 * of near-identical TypeScript, so the fixtures state the table
 * and this states how to run it.
 *
 * Nothing model-specific lives here. Each fixture carries its own
 * types, its own relation configs, its own DSL and its own ids,
 * because they run against one shared Postgres and one shared
 * OpenFGA alongside other fixtures.
 *
 * ## Why a store per stage
 *
 * Upstream's runner creates a **fresh store per stage** and writes
 * only that stage's tuples into it. The port has to do the same,
 * or it is not running upstream's case: merging the stages into
 * one store measurably changes OpenFGA's answers. With every
 * stage's rows present, `or_comp_from_direct_parent` on a
 * context-free check stops answering `true` and refuses, because a
 * conditioned row belonging to a *different* stage becomes
 * reachable on one arm of the union and its missing parameter
 * aborts the whole check.
 *
 * That behaviour is worth knowing, and `condition-spread`
 * probes it deliberately — but it is not what these stages assert,
 * and inheriting it here would quietly rewrite hundreds of
 * transcribed expectations.
 *
 * tsfga has no store to isolate, so the fixtures isolate it the
 * other way: every id is minted per stage, so one stage's rows are
 * unreachable from another's however a read is shaped.
 */

/** One row of an upstream case table. */
export interface Case {
  /** `<stage>/<assertion>`, as the Go corpus names it. */
  name: string;
  objectType: string;
  objectId: string;
  relation: string;
  subjectType: string;
  subjectId: string;
  /** Set when the subject is a userset — `team:eng#member`. */
  subjectRelation?: string;
  context?: Record<string, unknown>;
  /**
   * Upstream's `Expectation:`, transcribed. `"refused"` stands for
   * its `ErrorCode: 2000` — a condition whose parameter the
   * request never supplied, which neither engine answers.
   */
  expected: CheckOutcome;
}

/** One upstream `stage`: its tuples, and the checks over them. */
export interface Stage {
  name: string;
  tuples: AddTupleRequest[];
  cases: Case[];
}

/** What a fixture has once its `beforeAll` has run. */
export interface Corpus {
  tsfgaClient: TsfgaClient;
  /** Stage name to the OpenFGA store holding only that stage. */
  stores: Map<string, { storeId: string; authorizationModelId: string }>;
}

export interface CorpusSpec {
  /** Names the OpenFGA stores, one per stage. */
  slug: string;
  /** The DSL both engines are given, relative to this directory. */
  modelPath: string;
  conditions: readonly ConditionDefinition[];
  /** In dependency order: a tupleset's config before its user. */
  configs: readonly RelationConfig[];
  stages: readonly Stage[];
}

/**
 * How many tuples one OpenFGA write request may carry.
 *
 * A larger one is refused with `exceeded_entity_limit`, and a
 * stage ported from a table of forty-odd rows is already at the
 * edge. Upstream's runner chunks at 40 (`tests/check/check.go`,
 * `writeMaxChunkSize`); this matches it rather than inventing a
 * second number.
 */
const WRITE_CHUNK = 40;

/**
 * Write the whole corpus: tsfga once, OpenFGA once per stage.
 *
 * The client is expected to be wrapped by `recordFixture`
 * already, so the configs written here are the ones
 * `expectConfigsMatchModel` later compares against the DSL.
 */
export async function loadCorpus(
  tsfgaClient: TsfgaClient,
  spec: CorpusSpec,
): Promise<Corpus> {
  for (const condition of spec.conditions) {
    await tsfgaClient.writeConditionDefinition(condition);
  }
  for (const config of spec.configs) {
    await tsfgaClient.writeRelationConfig(config);
  }

  const stores = new Map<
    string,
    { storeId: string; authorizationModelId: string }
  >();
  for (const stage of spec.stages) {
    for (const tuple of stage.tuples) {
      await tsfgaClient.addTuple(tuple);
    }

    // OpenFGA caps a store name at 64 characters, and upstream's
    // longest stage name plus the slug is over it. The name is a
    // label; the id is what the test uses.
    const storeId = await fgaCreateStore(
      `${spec.slug}/${stage.name}`.slice(0, 64),
    );
    const authorizationModelId = await fgaWriteModel(storeId, spec.modelPath);
    for (let start = 0; start < stage.tuples.length; start += WRITE_CHUNK) {
      await fgaWriteTuplesRaw(
        storeId,
        authorizationModelId,
        stage.tuples.slice(start, start + WRITE_CHUNK).map((tuple) => ({
          user: tuple.subjectRelation
            ? `${tuple.subjectType}:${tuple.subjectId}#${tuple.subjectRelation}`
            : `${tuple.subjectType}:${tuple.subjectId}`,
          relation: tuple.relation,
          object: `${tuple.objectType}:${tuple.objectId}`,
          // The condition travels with the row: written without
          // it the row is admitted by a different restriction and
          // evaluated differently, so the two engines would be
          // compared over two datasets.
          ...(tuple.conditionName
            ? { condition: { name: tuple.conditionName } }
            : {}),
        })),
      );
    }
    stores.set(stage.name, { storeId, authorizationModelId });
  }
  return { tsfgaClient, stores };
}

/**
 * Register one `test` per case, against its own stage's store.
 *
 * The corpus arrives as a thunk because `describe` bodies run
 * before `beforeAll`: the stores and the client do not exist yet
 * when the tests are registered, only when they run.
 */
export function runStages(
  stages: readonly Stage[],
  corpus: () => Corpus,
): void {
  for (const stage of stages) {
    for (const each of stage.cases) {
      test(each.name, async () => {
        const { tsfgaClient, stores } = corpus();
        const store = stores.get(stage.name);
        if (!store) throw new Error(`No store for stage ${stage.name}`);
        await expectConformance(
          store.storeId,
          store.authorizationModelId,
          tsfgaClient,
          {
            objectType: each.objectType,
            objectId: each.objectId,
            relation: each.relation,
            subjectType: each.subjectType,
            subjectId: each.subjectId,
            ...(each.subjectRelation
              ? { subjectRelation: each.subjectRelation }
              : {}),
            ...(each.context ? { context: each.context } : {}),
          },
          each.expected,
        );
      });
    }
  }
}

/**
 * A relation config with every field stated, from the few a
 * fixture cares about.
 *
 * `RelationConfig` has no optional fields on purpose — absent and
 * null were an accidental third state — but a table of sixty
 * configs spelling out five nulls apiece reads as noise.
 */
export function cfg(
  objectType: string,
  relation: string,
  overrides: Partial<RelationConfig> = {},
): RelationConfig {
  return {
    objectType,
    relation,
    directlyAssignable: [],
    impliedBy: null,
    computedUserset: null,
    tupleToUserset: null,
    excludedBy: null,
    intersection: null,
    ...overrides,
  };
}

/**
 * Upstream's names, as the UUIDs the adapter's `uuid` columns
 * need.
 *
 * The names come from the Go corpus (`userset_1`,
 * `ttus_recursive_ttu_parent_case_1_4`) and carry meaning worth
 * keeping in the test output, so the mapping is by position in the
 * fixture's own list rather than by a hash: reading a failure
 * gives back the upstream row.
 *
 * Names are qualified by stage — `<stage>/<name>` — because that
 * is how tsfga is isolated per stage. `user:valid` in one stage
 * and `user:valid` in the next are different subjects, exactly as
 * they are upstream, where each stage has its own store.
 *
 * The `group` is the fourth UUID field, and each fixture is given
 * its own, so two fixtures running concurrently against one
 * database cannot mint the same id.
 */
export function ids(
  names: readonly string[],
  group: string,
): (name: string) => string {
  const map = new Map<string, string>();
  for (const [index, name] of names.entries()) {
    map.set(
      name,
      `00000000-0000-4000-${group}-${String(index + 1).padStart(12, "0")}`,
    );
  }
  return (name: string): string => {
    const id = map.get(name);
    if (!id) throw new Error(`No UUID for ${name}`);
    return id;
  };
}
