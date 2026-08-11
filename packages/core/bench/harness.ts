/**
 * The generator both equivalence harnesses run on.
 *
 * It exists because `breadth-equivalence.ts` and
 * `batch-equivalence.ts` carried two copies of it. Two copies that
 * must agree, with nothing enforcing agreement, is the same hazard
 * as a harness reporting clean over a path it never enters — which
 * is what happened here for a full round. Both files were twice
 * edited identically and checked afterwards with `diff` run by
 * hand; that is a habit, not a mechanism.
 *
 * The invariant: the seed sequence, and the order in which `rand()`
 * is drawn, are the contract. Every number both harnesses report is
 * a function of them. Nothing may reorder a draw, insert a draw, or
 * consume `rand` outside `buildStore`.
 *
 * The export policy: widen the list below when a third harness
 * actually needs a symbol, not before. `noUnusedLocals` is `false`
 * in `tsconfig.base.json`, so the compiler will never tell you an
 * export went dead — the list only grows unless someone keeps it
 * honest.
 */
import type {
  IntersectionOperand,
  RelationConfig,
  Tuple,
  TypeRestriction,
} from "../src/types.ts";
import { MockTupleStore } from "../tests/helpers/mock-store.ts";

// xorshift32, so runs are reproducible from a seed.
function rng(seed: number) {
  let s = seed || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };
}

/** Every direct subject shape these generated models can name. */
const DIRECT_SHAPES: TypeRestriction[] = [
  { type: "user" },
  { type: "user", wildcard: true },
  { type: "doc" },
  { type: "doc", wildcard: true },
];

/**
 * The conditions a restriction may carry, `undefined` included.
 *
 * The restriction's condition is matched exactly against the row's,
 * so a model that only ever admits bare refs drops every
 * conditioned row at the clamp — which is the same way this
 * harness went blind to userset expansion, one dimension over.
 */
const REF_CONDITIONS = [undefined, "always", "never"];

/** Each shape, bare and under each condition. */
function withConditions(shapes: TypeRestriction[]): TypeRestriction[] {
  return shapes.flatMap((shape) =>
    REF_CONDITIONS.map((condition) =>
      condition === undefined ? { ...shape } : { ...shape, condition },
    ),
  );
}

const ANY_DIRECT = withConditions(DIRECT_SHAPES);

/**
 * The userset refs a generated model can name, derived from the
 * very relation list the tuple generator draws `subjectRelation`
 * from.
 *
 * Deriving is the whole point; a hand-written list is what broke
 * this harness. It read `["doc#member", "user#member"]` while the
 * generator emitted `doc#r0 … doc#r8`, so `clampToQuery` dropped
 * every userset row and the run reported clean over a path it
 * never entered.
 *
 * `doc#absent` names no relation any config defines and is here on
 * purpose, so that admitting some refs is never the same as
 * admitting all of them.
 */
function usersetRefsFor(rels: readonly string[]): TypeRestriction[] {
  return withConditions([
    ...rels.map((relation) => ({ type: "doc", relation })),
    { type: "doc", relation: "absent" },
  ]);
}

// `directlyAssignable` is required rather than defaulted: what a
// relation admits is the thing under test, and a default is how it
// silently stops matching the tuples generated beside it.
function cfg(
  o: Partial<RelationConfig> & Pick<RelationConfig, "directlyAssignable">,
): RelationConfig {
  return {
    objectType: "",
    relation: "",
    impliedBy: null,
    computedUserset: null,
    tupleToUserset: null,
    excludedBy: null,
    intersection: null,
    ...o,
  };
}

function tup(o: Partial<Tuple>): Tuple {
  return {
    objectType: "",
    objectId: "",
    relation: "",
    subjectType: "",
    subjectId: "",
    subjectRelation: null,
    conditionName: null,
    conditionContext: null,
    ...o,
  };
}

/** Random relation graph on one object type, cycles allowed. */
function buildStore(
  rand: () => number,
  n: number,
  withIntersections: boolean,
): MockTupleStore {
  const store = new MockTupleStore();
  const rels = Array.from({ length: n }, (_, i) => `r${i}`);
  const objs = ["1", "2", "3"];
  const usersetRefs = usersetRefsFor(rels);

  // Deterministic, so a condition never makes the answer depend on
  // anything but whether the row carrying it was reached. `never`
  // is the interesting one: the row is admitted by the type
  // restriction and then denied by its condition, which is a
  // different path from never being admitted at all.
  store.conditionDefinitions.push(
    { name: "always", expression: "true", parameters: null },
    { name: "never", expression: "false", parameters: null },
  );
  const condition = (): string | null => {
    const pick = rand();
    if (pick < 0.12) return "never";
    if (pick < 0.24) return "always";
    return null;
  };

  for (const relation of rels) {
    const implied: string[] = [];
    for (const other of rels) {
      if (other !== relation && rand() < 0.25) implied.push(other);
    }
    const usesTtu = rand() < 0.25;
    const usesExcl = rand() < 0.12;
    const usesComputed = rand() < 0.15;
    store.relationConfigs.push(
      cfg({
        objectType: "doc",
        relation,
        // Partial admission on every dimension — type, wildcard,
        // userset relation and condition. A config that admits
        // either everything or nothing never exercises the clamp;
        // a random subset is what makes a row that the read gate
        // lets through and the clamp then drops actually occur,
        // and that pair is the whole point of the split.
        directlyAssignable: [
          ...(rand() < 0.5
            ? withConditions([{ type: "user" }, { type: "doc" }])
            : ANY_DIRECT
          ).filter(() => rand() < 0.7),
          ...(rand() < 0.25 ? [] : usersetRefs.filter(() => rand() < 0.6)),
        ],
        impliedBy: implied.length ? implied : null,
        computedUserset: usesComputed
          ? rels[Math.floor(rand() * rels.length)]
          : null,
        tupleToUserset: usesTtu
          ? [
              {
                tupleset: rels[Math.floor(rand() * rels.length)] ?? "r0",
                computedUserset: rels[Math.floor(rand() * rels.length)] ?? "r0",
              },
            ]
          : null,
        excludedBy: usesExcl ? rels[Math.floor(rand() * rels.length)] : null,
        // Intersections are where the two denials — a definitive
        // false and a cycle-truncated operand — meet, and where
        // getting their precedence wrong makes breadth change the
        // answer. A generator without them cannot see that.
        intersection:
          withIntersections && rand() < 0.2
            ? Array.from(
                { length: 2 + Math.floor(rand() * 2) },
                (): IntersectionOperand => {
                  const pick = rand();
                  if (pick < 0.34) return { type: "direct" };
                  if (pick < 0.67) {
                    return {
                      type: "computedUserset",
                      relation: rels[Math.floor(rand() * rels.length)] ?? "r0",
                    };
                  }
                  return {
                    type: "tupleToUserset",
                    tupleset: rels[Math.floor(rand() * rels.length)] ?? "r0",
                    computedUserset:
                      rels[Math.floor(rand() * rels.length)] ?? "r0",
                  };
                },
              )
            : null,
      }),
    );
  }
  for (const objectId of objs) {
    for (const relation of rels) {
      if (rand() < 0.15) {
        store.tuples.push(
          tup({
            objectType: "doc",
            objectId,
            relation,
            subjectType: "user",
            subjectId: "alice",
            conditionName: condition(),
          }),
        );
      }
      if (rand() < 0.25) {
        store.tuples.push(
          tup({
            objectType: "doc",
            objectId,
            relation,
            subjectType: "doc",
            subjectId: objs[Math.floor(rand() * objs.length)] ?? "1",
            subjectRelation: rels[Math.floor(rand() * rels.length)] ?? "r0",
            conditionName: condition(),
          }),
        );
      }
      if (rand() < 0.2) {
        store.tuples.push(
          tup({
            objectType: "doc",
            objectId,
            relation,
            subjectType: "doc",
            subjectId: objs[Math.floor(rand() * objs.length)] ?? "1",
            conditionName: condition(),
          }),
        );
      }
    }
  }
  return store;
}

/**
 * Rows the generator emitted, and rows the model actually let
 * through. The generator builds tuples independently of the
 * configs, so these can disagree — and if `admittedUserset` is
 * zero the run has exercised no userset expansion at all, no
 * matter how many cases it reports.
 */
const coverage = {
  usersetRows: 0,
  admittedUserset: 0,
  directRows: 0,
  conditionedRows: 0,
  admittedConditioned: 0,
};

/** Tally the rows a store holds, and what its reads give back. */
function instrument(store: MockTupleStore): MockTupleStore {
  for (const t of store.tuples) {
    if (t.subjectRelation === null || t.subjectRelation === undefined) {
      coverage.directRows++;
    } else {
      coverage.usersetRows++;
    }
    if (t.conditionName !== null) coverage.conditionedRows++;
  }
  const read = store.findCheckTuples.bind(store);
  store.findCheckTuples = async (query) => {
    const reply = await read(query);
    coverage.admittedUserset += reply.usersets.length;
    for (const row of [reply.direct, reply.wildcard, ...reply.usersets]) {
      if (row !== null && row.conditionName !== null) {
        coverage.admittedConditioned++;
      }
    }
    return reply;
  };
  return store;
}

export async function withTimeout<T>(p: Promise<T>, ms: number, label: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`TIMEOUT ${label}`)), ms);
  });
  try {
    return await Promise.race([p, guard]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// The `(e as Error)` is moved verbatim; narrowing it is
// deliberately deferred, so that a byte-fidelity refactor does not
// also change what this reports.
export const outcome = async (p: Promise<boolean>) => {
  try {
    return `ok:${await p}`;
  } catch (e) {
    return `err:${(e as Error).constructor.name}`;
  }
};

export const KNOWN_ERRORS = new Set([
  "err:TsfgaError",
  "err:DepthExceededError",
  "err:ConditionEvaluationError",
  "err:ConditionNotFoundError",
  "err:RelationConfigNotFoundError",
  "err:InvalidSubjectTypeError",
  "err:UsersetNotAllowedError",
  "err:InvalidStoredDataError",
]);

/**
 * Every (phase, seed) scenario both harnesses run, in order.
 *
 * The store is yielded already `instrument`ed. That is the part
 * that earns this generator its keep: a harness that builds a store
 * and forgets to wrap it reports clean with `admittedUserset: 0`,
 * and folding the wrap in here means the coverage assertion cannot
 * be bypassed by omission.
 *
 * `seed` is yielded because both drivers put it in every diagnostic
 * label, and those labels are the only thing that makes a `DIVERGE`
 * or `UNKNOWN ERROR` line reproducible. `rand` is deliberately not
 * yielded: the generator keeps sole ownership of the draw sequence.
 */
export function* scenarios(): Generator<{
  withIntersections: boolean;
  seed: number;
  n: number;
  store: MockTupleStore;
}> {
  for (const withIntersections of [false, true]) {
    for (let seed = 1; seed <= 300; seed++) {
      const rand = rng(seed * 7919);
      const n = 3 + Math.floor(rand() * 6);
      yield {
        withIntersections,
        seed,
        n,
        store: instrument(buildStore(rand, n, withIntersections)),
      };
    }
  }
}

/** The five per-phase tallies a driver accumulates. */
export interface Counts {
  strictCases: number;
  strictDivergences: number;
  liveCases: number;
  expectedDivergences: number;
  unknownErrors: number;
}

/** Both summary lines, the coverage line, and both assertions. */
export function reportCoverage(counts: Counts): void {
  const {
    strictCases,
    strictDivergences,
    liveCases,
    expectedDivergences,
    unknownErrors,
  } = counts;
  console.log(
    `phase 1 (no intersections): ${strictCases} cases, ` +
      `${strictDivergences} divergences (must be 0)`,
  );
  console.log(
    `phase 2 (intersections):    ${liveCases} cases, ` +
      `${expectedDivergences} expected divergences, ` +
      `${unknownErrors} unknown error classes (must be 0), no hangs`,
  );
  console.log("coverage:", coverage);

  // The counts above are the deliverable, not decoration. A run whose
  // configs admit none of the userset refs its tuples carry reports
  // clean while never entering step 2 at all.
  if (coverage.admittedUserset === 0) {
    console.log(
      "FAIL: no userset row was admitted by any config — " +
        "userset expansion was never exercised",
    );
    process.exit(1);
  }
  if (coverage.admittedConditioned === 0) {
    console.log(
      "FAIL: no conditioned row was admitted by any config — " +
        "the condition dimension of the restriction was never exercised",
    );
    process.exit(1);
  }
}
