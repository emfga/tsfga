import { check } from "../src/check.ts";
import { checkMany } from "../src/check-many.ts";
import type {
  IntersectionOperand,
  RelationConfig,
  Tuple,
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

/** Every direct subject ref these generated models can name. */
const ANY_DIRECT = ["user", "user:*", "doc", "doc:*"];

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
function usersetRefsFor(rels: readonly string[]): string[] {
  return [...rels.map((r) => `doc#${r}`), "doc#absent"];
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
        // Partial admission on both halves. A config that admits
        // either everything or nothing never exercises the clamp;
        // a random subset is what makes a row that the gate lets
        // through and the clamp drops actually occur.
        directlyAssignable: [
          ...(rand() < 0.5 ? ["user", "doc"] : ANY_DIRECT),
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
const coverage = { usersetRows: 0, admittedUserset: 0, directRows: 0 };

/** Tally the rows a store holds, and what its reads give back. */
function instrument(store: MockTupleStore): MockTupleStore {
  for (const t of store.tuples) {
    if (t.subjectRelation === null || t.subjectRelation === undefined) {
      coverage.directRows++;
    } else {
      coverage.usersetRows++;
    }
  }
  const read = store.findCheckTuples.bind(store);
  store.findCheckTuples = async (query) => {
    const reply = await read(query);
    coverage.admittedUserset += reply.usersets.length;
    return reply;
  };
  return store;
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string) {
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

const outcome = async (p: Promise<boolean>) => {
  try {
    return `ok:${await p}`;
  } catch (e) {
    return `err:${(e as Error).constructor.name}`;
  }
};

/**
 * A batch must answer what the same requests answer one at a time.
 *
 * Split in two for the same reason as the breadth harness: with an
 * intersection in play, an answer can legitimately differ between
 * two resolutions of the same node, because the intersection is
 * decided by whichever operand fails first and the two kinds of
 * failure carry different indeterminacy. So phase 1 (no
 * intersections) asserts strict equality, and phase 2 only counts
 * the differences while still failing on a hang or a leaked
 * internal error class.
 */
const KNOWN_ERRORS = new Set([
  "err:TsfgaError",
  "err:DepthExceededError",
  "err:ConditionEvaluationError",
  "err:ConditionNotFoundError",
  "err:RelationConfigNotFoundError",
  "err:InvalidSubjectTypeError",
  "err:UsersetNotAllowedError",
  "err:InvalidStoredDataError",
]);

let strictCases = 0;
let strictDivergences = 0;
let liveCases = 0;
let expectedDivergences = 0;
let unknownErrors = 0;

for (const withIntersections of [false, true]) {
  for (let seed = 1; seed <= 300; seed++) {
    const rand = rng(seed * 7919);
    const n = 3 + Math.floor(rand() * 6);
    const store = instrument(buildStore(rand, n, withIntersections));
    const requests = [];
    for (let i = 0; i < n; i++) {
      for (const objectId of ["1", "2", "3"]) {
        requests.push({
          objectType: "doc",
          objectId,
          relation: `r${i}`,
          subjectType: "user",
          subjectId: "alice",
        });
      }
    }
    // Duplicates too: identical requests coalesce at their root, and
    // that path must not change an answer either.
    requests.push(...requests.slice(0, 3));

    const solo = [];
    for (const request of requests) {
      solo.push(
        await outcome(
          withTimeout(check(store, request, { maxBreadth: 1 }), 5000, "solo"),
        ),
      );
    }

    for (const maxConcurrentChecks of [1, 3, 50, Number.POSITIVE_INFINITY]) {
      for (const maxBreadth of [1, 10]) {
        const batch = await withTimeout(
          checkMany(store, requests, { maxConcurrentChecks, maxBreadth }),
          20000,
          `batch seed=${seed} c=${maxConcurrentChecks} b=${maxBreadth}`,
        );
        for (const [i, got] of batch.entries()) {
          const shown = got.error
            ? `err:${(got.error as Error).constructor.name}`
            : `ok:${got.allowed}`;
          const label = `seed=${seed} i=${i} c=${maxConcurrentChecks} b=${maxBreadth}`;
          if (shown.startsWith("err:") && !KNOWN_ERRORS.has(shown)) {
            unknownErrors++;
            console.log(`UNKNOWN ERROR ${label}: ${shown}`);
          }
          if (!withIntersections) {
            strictCases++;
            if (shown !== solo[i]) {
              strictDivergences++;
              console.log(`DIVERGE ${label}: ${shown} != ${solo[i]}`);
              if (strictDivergences > 10) process.exit(1);
            }
          } else {
            liveCases++;
            if (shown !== solo[i]) expectedDivergences++;
          }
        }
      }
    }
  }
}
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
