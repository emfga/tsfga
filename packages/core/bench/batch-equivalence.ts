import { check } from "../src/check.ts";
import { checkMany } from "../src/check-many.ts";
import {
  KNOWN_ERRORS,
  outcome,
  reportCoverage,
  scenarios,
  withTimeout,
} from "./harness.ts";

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

let strictCases = 0;
let strictDivergences = 0;
let liveCases = 0;
let expectedDivergences = 0;
let unknownErrors = 0;

for (const { withIntersections, seed, n, store } of scenarios()) {
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
reportCoverage({
  strictCases,
  strictDivergences,
  liveCases,
  expectedDivergences,
  unknownErrors,
});
