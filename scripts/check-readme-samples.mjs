/**
 * Fail if a README's published sample has drifted from the region
 * it quotes in tests/docs/readme-samples.ts.
 *
 * The fixture is authoritative: it is the copy the type checker
 * sees. A README block claims a region with an HTML comment on the
 * line before its fence:
 *
 *   <!-- sample: core-quick-start -->
 *   ```typescript
 *   ...
 *   ```
 *
 * Without this, the fixture and the prose drift apart and the
 * compiled copy stops saying anything about the published one.
 */

import { readFileSync } from "node:fs";
import { relative } from "node:path";

const FIXTURE = "tests/docs/readme-samples.ts";
const READMES = ["README.md", "packages/core/README.md", "packages/kysely/README.md"];

/** @param {string} text */
function parseRegions(text) {
  /** @type {Map<string, string>} */
  const regions = new Map();
  const lines = text.split("\n");
  /** @type {{ name: string, body: string[], indent: number } | null} */
  let open = null;
  for (const line of lines) {
    const start = line.match(/^(\s*)\/\/ #region (\S+)\s*$/);
    if (start) {
      open = { name: start[2], body: [], indent: start[1].length };
      continue;
    }
    const end = line.match(/^\s*\/\/ #endregion (\S+)\s*$/);
    if (end) {
      if (!open || open.name !== end[1]) {
        throw new Error(`Mismatched #endregion ${end[1]} in ${FIXTURE}`);
      }
      regions.set(open.name, dedent(open.body, open.indent));
      open = null;
      continue;
    }
    if (open) open.body.push(line);
  }
  if (open) throw new Error(`Unclosed #region ${open.name} in ${FIXTURE}`);
  return regions;
}

/**
 * @param {string[]} body
 * @param {number} indent
 */
function dedent(body, indent) {
  return body
    .map((line) => (line.startsWith(" ".repeat(indent)) ? line.slice(indent) : line))
    .join("\n")
    .trim();
}

/** @param {string} text */
function parseClaims(text) {
  /** @type {Array<{ name: string, body: string, line: number }>} */
  const claims = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const marker = lines[i].match(/^<!--\s*sample:\s*(\S+)\s*-->$/);
    if (!marker) continue;
    let fence = i + 1;
    while (fence < lines.length && lines[fence].trim() === "") fence++;
    if (!lines[fence]?.startsWith("```")) {
      throw new Error(`sample marker ${marker[1]} is not followed by a fence`);
    }
    let close = fence + 1;
    while (close < lines.length && !lines[close].startsWith("```")) close++;
    claims.push({
      name: marker[1],
      body: lines.slice(fence + 1, close).join("\n").trim(),
      line: i + 1,
    });
  }
  return claims;
}

const regions = parseRegions(readFileSync(FIXTURE, "utf8"));
let failed = 0;
let checked = 0;

for (const path of READMES) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    continue;
  }
  for (const claim of parseClaims(text)) {
    checked++;
    const region = regions.get(claim.name);
    if (region === undefined) {
      console.error(`${path}:${claim.line}: no region "${claim.name}" in ${FIXTURE}`);
      failed++;
      continue;
    }
    if (region !== claim.body) {
      console.error(
        `${path}:${claim.line}: sample "${claim.name}" has drifted from ` +
          `${relative(".", FIXTURE)}. The fixture is authoritative; update the README.`,
      );
      failed++;
    }
  }
}

if (checked === 0) {
  console.error("No sample markers found. The check is not covering anything.");
  process.exit(1);
}
console.log(`checked ${checked} README sample(s) against ${regions.size} region(s)`);
process.exit(failed === 0 ? 0 : 1);
