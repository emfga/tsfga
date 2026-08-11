import { check } from "../src/check.ts";
import {
  KNOWN_ERRORS,
  outcome,
  reportCoverage,
  scenarios,
  withTimeout,
} from "./harness.ts";

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

let strictCases = 0;
let strictDivergences = 0;
let liveCases = 0;
let expectedDivergences = 0;
let unknownErrors = 0;

for (const { withIntersections, seed, n, store } of scenarios()) {
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
reportCoverage({
  strictCases,
  strictDivergences,
  liveCases,
  expectedDivergences,
  unknownErrors,
});
