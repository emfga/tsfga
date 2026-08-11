import { check } from "../src/check.ts";
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

/**
 * Every subject ref these generated models can name. A config
 * that is not itself narrowing admits all of them, which is what
 * the old nullable type list plus boolean used to say.
 */
const ANY_DIRECT = ["user", "user:*", "doc", "doc:*"];
const USERSET_REFS = ["doc#member", "user#member"];
const ANY_SUBJECT = [...ANY_DIRECT, ...USERSET_REFS];

function cfg(o: Partial<RelationConfig>): RelationConfig {
  return {
    objectType: "",
    relation: "",
    directlyAssignable: ANY_SUBJECT,
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
        directlyAssignable: [
          ...(rand() < 0.5 ? ["user", "doc"] : ANY_DIRECT),
          ...(rand() < 0.5 ? USERSET_REFS : []),
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
          }),
        );
      }
    }
  }
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
 * Two phases, because the invariant is not the same in both.
 *
 * Phase 1 — no intersections. Breadth must never change the answer
 * or the error class. This is a real invariant and a divergence is
 * a bug.
 *
 * Phase 2 — intersections enabled. Breadth *can* change the answer:
 * an intersection is decided by the first operand that fails to
 * hold, a definitive `false` and a cycle-truncated operand are both
 * failures carrying different indeterminacy, and an enclosing
 * `but not` reads the difference. Upstream does the same and its
 * answer likewise tracks which operand is cheaper — see
 * tests/conformance/intersection-cycle-precedence.test.ts. So here
 * a boolean divergence is expected and only counted. What is still
 * a bug, and what this phase is really for: a hang (deadlock), or
 * an error class that is not one of ours (a leaked internal
 * sentinel).
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
    const store = buildStore(rand, n, withIntersections);
    for (let i = 0; i < n; i++) {
      for (const objectId of ["1", "2"]) {
        const request = {
          objectType: "doc",
          objectId,
          relation: `r${i}`,
          subjectType: "user",
          subjectId: "alice",
        };
        const reference = await outcome(
          withTimeout(check(store, request, { maxBreadth: 1 }), 5000, "ref"),
        );
        for (const maxBreadth of [2, 3, 5, 10, Number.POSITIVE_INFINITY]) {
          const label = `seed=${seed} rel=r${i} obj=${objectId} b=${maxBreadth}`;
          const got = await outcome(
            withTimeout(check(store, request, { maxBreadth }), 5000, label),
          );
          if (got.startsWith("err:") && !KNOWN_ERRORS.has(got)) {
            unknownErrors++;
            console.log(`UNKNOWN ERROR ${label}: ${got}`);
          }
          if (!withIntersections) {
            strictCases++;
            if (got !== reference) {
              strictDivergences++;
              console.log(`DIVERGE ${label}: ${got} != ${reference}`);
              if (strictDivergences > 10) process.exit(1);
            }
          } else {
            liveCases++;
            if (got !== reference) expectedDivergences++;
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
