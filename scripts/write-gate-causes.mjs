/**
 * Extract OpenFGA's write- and model-write refusal vocabulary from
 * a local checkout, by three mechanical rules over a stated set of
 * Go files.
 *
 * Shared by `scripts/check-write-gate-causes.mjs` (the CI gate) and
 * usable on its own to re-derive the inventory when the pinned
 * container moves.
 *
 * The rules are the completeness artifact. An inventory whose
 * denominator is a number someone remembered is not evidence of
 * anything; one whose extraction is mechanical, and whose *residue*
 * — every error-construction site the rules did not attribute — is
 * required to be empty, states its own recall.
 */
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Every way the six files construct an error.
 *
 * `status.Error(` is here because `pkg/server/errors/errors.go`
 * declares twelve of its thirteen package-level sentinels with it
 * and none with `errors.New`. A residue check is what found that;
 * a rule set naming only `errors.New` and `fmt.Errorf` reports
 * twelve unattributed sites in one file.
 */
const SITE = /errors\.New\(|fmt\.Errorf\(|status\.Error\(/;

/**
 * The fourth construction shape, and the one the recorder run
 * found: an error *type* whose message is built by `fmt.Sprintf`
 * inside its own `Error()` method, and which is therefore
 * constructed as a struct literal that no pattern over
 * `errors.New` / `fmt.Errorf` can see.
 *
 * `parameter type error on condition '%s'` and `failed to compile
 * expression on condition '%s'` are both this shape. Both are
 * user-visible write refusals, both were observed coming out of
 * the container, and neither was in the inventory until the
 * recorder measured them. That is the file set being wrong and
 * the rules being wrong at once.
 */
const ERROR_METHOD = /^func \([a-z]+ \*?([A-Z]\w*)\) Error\(\) string \{/;
const SPRINTF = /fmt\.Sprintf\(/;

/**
 * R1 — a package-level sentinel, keyed by its **Go identifier**.
 *
 * The identifier rather than the message: upstream rewords prose
 * between releases and does not rename an exported sentinel
 * without it being a breaking change.
 *
 * Both spellings: inside a grouped `var (` block, which is how five
 * of the six files declare theirs, and as a bare `var X = ...`,
 * which is how `internal/condition` declares its one.
 */
const R1 =
  /^(?:\t|var )(\w+)\s*=\s*(?:errors\.New|fmt\.Errorf|status\.Error)\(/;

/**
 * R2 — an exported refusal constructor, keyed by its **function
 * name**. This is where `InvalidWriteInputError` and
 * `TupleConditionConflictError` live, and neither is reachable by
 * any pattern over inline literals.
 */
const R2 = /^func (?:\([^)]*\) )?([A-Z]\w*)\(/;

/** R3 — an inline literal, keyed by the **format string verbatim**. */
const R3_SAME_LINE = /fmt\.Errorf\(\s*"((?:[^"\\]|\\.)*)"/;
const R3_CONTINUED = /fmt\.Errorf\(\s*$/;
const LEADING_STRING = /^\s*"((?:[^"\\]|\\.)*)"/;

/**
 * One extracted refusal cause: the key, the rule that found it, and
 * every site that constructs it.
 */
export function extract(checkout, files) {
  /** @type {Map<string, {rule: string, sites: string[]}>} */
  const causes = new Map();
  /** @type {Array<{file: string, line: number, text: string}>} */
  const residue = [];

  for (const file of files) {
    const lines = fs
      .readFileSync(path.join(checkout, file), "utf8")
      .split("\n");
    // Two packages spell four sentinels the same way --
    // `ErrInvalidWriteInput`, `ErrTransactionThrottled`,
    // `ErrInvalidContinuationToken`, `ErrInvalidStartTime` are each
    // declared in both `pkg/storage` and `pkg/server/errors`, and
    // they are different refusals. The key alone is not an
    // identity; the package plus the key is.
    const pkg = (lines.find((line) => line.startsWith("package ")) ?? "")
      .slice("package ".length)
      .trim();
    let constructor = null;
    let errorType = null;

    lines.forEach((line, index) => {
      const at = `${file}:${index + 1}`;

      const method = line.match(ERROR_METHOD);
      if (method) errorType = method[1];
      else if (line === "}") errorType = null;
      if (errorType !== null && SPRINTF.test(line)) {
        record(causes, pkg, errorType, "R4", at);
        return;
      }

      const sentinel = line.match(R1);
      if (sentinel) {
        record(causes, pkg, sentinel[1], "R1", at);
        return;
      }

      const declaration = line.match(R2);
      if (declaration) constructor = declaration[1];
      // A closing brace in column zero ends the declaration, which
      // is what `gofmt` guarantees and nothing else produces.
      else if (line === "}") constructor = null;

      if (!SITE.test(line)) return;

      if (constructor !== null) {
        record(causes, pkg, `${constructor}()`, "R2", at);
        return;
      }

      const inline = line.match(R3_SAME_LINE);
      if (inline) {
        record(causes, pkg, inline[1], "R3", at);
        return;
      }
      // `gofmt` breaks a long `fmt.Errorf` after the paren and puts
      // the format string on the next line by itself. Every such
      // site is invisible to a single-line pattern, which is how a
      // method with no residue check loses them silently.
      if (R3_CONTINUED.test(line)) {
        const continued = (lines[index + 1] ?? "").match(LEADING_STRING);
        if (continued) {
          record(causes, pkg, continued[1], "R3", at);
          return;
        }
      }

      residue.push({ file, line: index + 1, text: line.trim() });
    });
  }

  return { causes, residue };
}

/** The identity of a cause: its Go package and its key. */
export function identity(pkg, key) {
  return `${pkg}|${key}`;
}

function record(causes, pkg, key, rule, at) {
  const id = identity(pkg, key);
  const existing = causes.get(id);
  if (existing) {
    existing.sites.push(at);
    return;
  }
  causes.set(id, { package: pkg, key, rule, sites: [at] });
}

/** Every error-construction site in the stated files. */
export function countSites(checkout, files) {
  let total = 0;
  for (const file of files) {
    const lines = fs
      .readFileSync(path.join(checkout, file), "utf8")
      .split("\n");
    let errorType = null;
    for (const line of lines) {
      const method = line.match(ERROR_METHOD);
      if (method) errorType = method[1];
      else if (line === "}") errorType = null;
      if (SITE.test(line)) total += 1;
      else if (errorType !== null && SPRINTF.test(line)) total += 1;
    }
  }
  return total;
}
