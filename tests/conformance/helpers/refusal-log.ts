import * as fs from "node:fs";

/**
 * Record every refusal OpenFGA reports, so the *scope* of the
 * upstream cause inventory can be measured rather than argued.
 *
 * `packages/core/write-gate-causes.json` enumerates upstream's
 * refusal vocabulary from a stated set of Go files. A stated scope
 * is an argument; this turns it into a measurement. Set
 * `TSFGA_REFUSAL_LOG` to a path, run the suite, and every refusal
 * the conformance helpers observed is appended as JSONL. A message
 * in that file that maps to no inventory entry means the file set
 * was wrong.
 *
 * Deliberately **not** a CI gate. Wiring artifact collection
 * through the conformance job for a once-per-effort measurement is
 * not worth it, and a gate nobody can reproduce locally is a gate
 * that gets muted. Unset, this costs one `undefined` check per
 * write.
 */
const path = process.env.TSFGA_REFUSAL_LOG;

/** One observed refusal, as the helper saw it. */
export interface RefusalRecord {
  /** Which helper observed it. */
  helper: string;
  /** OpenFGA's API error code, when upstream refused. */
  code?: string;
  /** OpenFGA's message, verbatim. */
  reason?: string;
}

/** Append one record, or do nothing when the log is not enabled. */
export function recordRefusal(record: RefusalRecord): void {
  if (path === undefined) return;
  fs.appendFileSync(path, `${JSON.stringify(record)}\n`);
}
