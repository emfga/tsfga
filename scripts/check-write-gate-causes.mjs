#!/usr/bin/env node
/**
 * The write-gate cause gate.
 *
 * `packages/core/write-gate-causes.json` claims to enumerate every
 * refusal OpenFGA constructs in six named Go files, and to dispose
 * of each one. This checks that claim rather than trusting it:
 *
 * 1. the checkout is at the pinned SHA, and the pinned tag is the
 *    one `compose.yaml` runs -- bump the container and leave the
 *    inventory, and this goes red instead of going stale while
 *    green;
 * 2. re-extraction from that checkout produces exactly the keys
 *    the inventory holds, both directions;
 * 3. the residue -- every error-construction site the three rules
 *    did not attribute -- is empty, or listed in `excluded` with a
 *    reason. This is the recall claim, and it is the only reason
 *    the denominator means anything;
 * 4. every entry's disposition carries what its disposition
 *    requires, and every reference it makes resolves.
 *
 * What it does **not** do: audit whether a disposition is correct.
 * Those are decided once, by hand, and reviewed. This detects an
 * upstream change and a reference that has rotted.
 *
 * Run as `bun run check:write-gate-causes`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { countSites, extract, identity } from "./write-gate-causes.mjs";

const root = path.resolve(import.meta.dirname, "..");
const inventoryPath = path.join(root, "packages/core/write-gate-causes.json");
const capabilityPath = path.join(root, "packages/core/capability-refusals.json");

const problems = [];
const fail = (message) => problems.push(message);

/**
 * Resolve the OpenFGA checkout the same way `check-schema-drift.sh`
 * resolves its database: absent is a local skip and a CI failure,
 * because a contributor without the checkout must still be able to
 * run the suite, and CI must not silently stop checking.
 */
function resolveCheckout() {
  const fromEnv = process.env.OPENFGA_REPO;
  if (fromEnv) return fromEnv;
  const pointer = path.join(root, ".openfga_repo");
  if (fs.existsSync(pointer)) return fs.readFileSync(pointer, "utf8").trim();
  return null;
}

const checkout = resolveCheckout();
if (checkout === null || !fs.existsSync(checkout)) {
  const message =
    "No OpenFGA checkout: set OPENFGA_REPO or write its path to " +
    ".openfga_repo. See CLAUDE.md, 'OpenFGA Source of Truth'.";
  if (process.env.CI) {
    console.error(`error: ${message}`);
    process.exit(1);
  }
  console.log(`skipping: ${message}`);
  process.exit(0);
}

const inventory = JSON.parse(fs.readFileSync(inventoryPath, "utf8"));
const capability = JSON.parse(fs.readFileSync(capabilityPath, "utf8"));

// 1. The version pin, in both directions.
const head = execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
if (head !== inventory.openfga.sha) {
  fail(
    `checkout is at ${head}, inventory is pinned to ` +
      `${inventory.openfga.sha} (${inventory.openfga.tag})`,
  );
}
const compose = fs.readFileSync(path.join(root, "compose.yaml"), "utf8");
if (!compose.includes(`openfga/openfga:${inventory.openfga.tag}`)) {
  fail(
    `compose.yaml does not run openfga/openfga:${inventory.openfga.tag}; ` +
      "the inventory is pinned to a version the suite does not measure",
  );
}

// 2 and 3. Re-extract, and require an empty residue.
const files = inventory.sources
  .filter((source) => source.kind === "go")
  .map((source) => source.path);
const { causes, residue } = extract(checkout, files);
const excluded = new Set(
  (inventory.excluded ?? []).map((entry) => `${entry.file}:${entry.line}`),
);
for (const site of residue) {
  if (excluded.has(`${site.file}:${site.line}`)) continue;
  fail(`unattributed error-construction site ${site.file}:${site.line}`);
}
for (const entry of inventory.excluded ?? []) {
  if (!entry.reason) fail(`excluded ${entry.file}:${entry.line} has no reason`);
}

const inventoryKeys = new Set();
for (const entry of inventory.causes) {
  const id = identity(entry.package, entry.key);
  if (inventoryKeys.has(id)) fail(`duplicate inventory entry ${id}`);
  inventoryKeys.add(id);
  if (!causes.has(id)) fail(`inventory names ${id}, the checkout does not`);
}
for (const id of causes.keys()) {
  if (!inventoryKeys.has(id)) fail(`the checkout constructs ${id}, the inventory does not name it`);
}

const sites = countSites(checkout, files);
if (sites !== inventory.measured.sites) {
  fail(
    `the checkout has ${sites} error-construction sites, the inventory ` +
      `records ${inventory.measured.sites}`,
  );
}
if (inventory.causes.length !== inventory.measured.causes) {
  fail("`measured.causes` does not match the number of entries");
}

// 4. Per-entry schema, and every reference resolves.
/**
 * `file.md#anchor` -- the file exists and holds a heading whose
 * GitHub slug is that anchor.
 *
 * An `open` gap and a capability refusal both point here rather
 * than at a number in a tracker, because the thing a consumer
 * needs is the paragraph explaining the divergence, and a
 * reference the repo can resolve cannot rot into a number nobody
 * can look up.
 */
function anchorResolves(reference) {
  const [file, anchor] = reference.split("#");
  if (!file || !anchor) return `malformed anchor '${reference}'`;
  const full = path.join(root, file);
  if (!fs.existsSync(full)) return `no such file '${reference}'`;
  const slugs = fs
    .readFileSync(full, "utf8")
    .split("\n")
    .filter((line) => line.startsWith("#"))
    .map((line) =>
      line
        .replace(/^#+\s*/, "")
        .toLowerCase()
        .replace(/[^a-z0-9 -]/g, "")
        .trim()
        .replace(/\s+/g, "-"),
    );
  return slugs.includes(anchor) ? null : `no such heading '${reference}'`;
}

/** `file:test name` -- the file exists and holds the name. */
function testResolves(reference, requirePin) {
  const split = reference.indexOf(":");
  if (split < 0) return `malformed test reference '${reference}'`;
  const file = path.join(root, reference.slice(0, split));
  const name = reference.slice(split + 1);
  if (!fs.existsSync(file)) return `no such test file '${reference}'`;
  const source = fs.readFileSync(file, "utf8");
  if (!source.includes(name)) return `no such test '${reference}'`;
  if (requirePin && !source.includes("expectPinned")) {
    return `'${reference}' names no pin helper, so it can pass on agreement`;
  }
  return null;
}

const DISPOSITIONS = new Set([
  "claimed",
  "claimed-partial",
  "pinned",
  "open",
  "n/a",
]);

for (const entry of [...inventory.causes, ...inventory.probes]) {
  const id = entry.key ? identity(entry.package, entry.key) : entry.field;
  if (!DISPOSITIONS.has(entry.disposition)) {
    fail(`${id}: unknown disposition '${entry.disposition}'`);
    continue;
  }
  if (entry.disposition === "claimed" || entry.disposition === "claimed-partial") {
    if (!Array.isArray(entry.rules) || entry.rules.length === 0) {
      fail(`${id}: ${entry.disposition} names no rule`);
    }
    const problem = entry.test
      ? testResolves(entry.test, false)
      : "no test reference";
    if (problem) fail(`${id}: ${problem}`);
    if (entry.disposition === "claimed-partial" && !entry.gap) {
      fail(`${id}: claimed-partial states no gap`);
    }
  }
  if (entry.disposition === "pinned") {
    const problem = entry.test
      ? testResolves(entry.test, true)
      : "no test reference";
    if (problem) fail(`${id}: ${problem}`);
  }
  if (entry.disposition === "open") {
    if (!entry.gap) fail(`${id}: open states no gap`);
    const problem = entry.readmeAnchor
      ? anchorResolves(entry.readmeAnchor)
      : "open names no README anchor";
    if (problem) fail(`${id}: ${problem}`);
  }
  if (entry.disposition === "n/a" && !entry.reason) {
    fail(`${id}: n/a states no reason`);
  }
}

// The second list. Every entry pins a real divergence.
const capabilityIds = new Set();
for (const entry of capability.refusals) {
  if (capabilityIds.has(entry.id)) fail(`duplicate capability id ${entry.id}`);
  capabilityIds.add(entry.id);
  if (!entry.reason) fail(`${entry.id}: no reason`);
  if (!entry.readmeAnchor) fail(`${entry.id}: no README anchor`);
  const pin = entry.pin ? testResolves(entry.pin, true) : "no pin";
  if (pin) fail(`${entry.id}: ${pin}`);
  const anchor = anchorResolves(entry.readmeAnchor);
  if (anchor) fail(`${entry.id}: ${anchor}`);
}

// A capability refusal is by definition one upstream does not make,
// so no upstream cause may claim one.
for (const entry of inventory.causes) {
  for (const rule of entry.rules ?? []) {
    if (capabilityIds.has(rule)) {
      fail(
        `${identity(entry.package, entry.key)} claims ${rule}, which is a ` +
          "capability refusal and has no upstream cause",
      );
    }
  }
}

if (problems.length > 0) {
  console.error("write-gate cause inventory is out of date:\n");
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error(
    `\n${problems.length} problem(s). Re-read the checkout at ` +
      `${inventory.openfga.tag} and update ` +
      "packages/core/write-gate-causes.json.",
  );
  process.exit(1);
}

console.log(
  `write-gate causes: ${inventory.causes.length} upstream causes over ` +
    `${sites} construction sites in ${files.length} files, 0 residue; ` +
    `${capability.refusals.length} capability refusal(s).`,
);
