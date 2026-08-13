import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { CAPABILITY_RULE_IDS, UPSTREAM_RULE_IDS } from "../src/write-rules.ts";

/**
 * The two refusal lists, checked for the properties a reader of
 * either one is entitled to assume.
 *
 * `scripts/check-write-gate-causes.mjs` does the part that needs
 * the OpenFGA checkout — re-extraction, the residue, the version
 * pin, every reference resolving. This does the part that needs
 * nothing, so it runs on every runner and in every environment:
 * the shape of each entry, and the one rule that makes the second
 * list mean anything, which is that a refusal cannot be in both.
 */

/**
 * Read a checked-in JSON artifact beside the package root.
 *
 * `JSON.parse` is the one place a shape is asserted without an
 * `as`: its result is untyped, so the annotation on the caller's
 * binding is a declaration rather than an assertion. The gate
 * script is what actually verifies the file against the checkout.
 */
function read(name: string) {
  const path = fileURLToPath(new URL(`../${name}`, import.meta.url));
  return JSON.parse(fs.readFileSync(path, "utf-8"));
}

interface Cause {
  package: string;
  key: string;
  rule: string;
  sites: string[];
  disposition: string;
  rules?: string[];
  test?: string;
  gap?: string;
  reason?: string;
  readmeAnchor?: string;
}

interface Inventory {
  openfga: { tag: string; sha: string };
  sources: Array<{ path: string; kind: string; why: string }>;
  measured: { sites: number; causes: number; residue: number };
  excluded: Array<{ file: string; line: number; reason: string }>;
  probes: Array<{ field: string; disposition: string; rules?: string[] }>;
  causes: Cause[];
}

interface Capability {
  refusals: Array<{
    id: string;
    reason: string;
    readmeAnchor: string;
    pin: string;
  }>;
}

function inventory(): Inventory {
  const value: Inventory = read("write-gate-causes.json");
  return value;
}

function capability(): Capability {
  const value: Capability = read("capability-refusals.json");
  return value;
}

const DISPOSITIONS: readonly string[] = [
  "claimed",
  "claimed-partial",
  "pinned",
  "open",
  "n/a",
];

describe("the upstream cause inventory", () => {
  test("names its version in both halves", () => {
    const { openfga } = inventory();
    expect(openfga.tag.startsWith("v")).toBe(true);
    expect(openfga.sha).toHaveLength(40);
  });

  test("records a residue of zero", () => {
    // The recall claim, in one number. A non-zero residue means
    // the three extraction rules do not describe how upstream
    // constructs its errors, and the denominator below is a count
    // of whatever the rules happened to catch.
    const { measured, excluded } = inventory();
    expect(measured.residue).toBe(0);
    expect(excluded).toHaveLength(0);
  });

  test("counts what it holds", () => {
    const { measured, causes } = inventory();
    expect(causes.length).toBe(measured.causes);
  });

  test("no cause is entered twice", () => {
    const { causes } = inventory();
    const identities = new Set(
      causes.map((cause) => `${cause.package}|${cause.key}`),
    );
    expect(identities.size).toBe(causes.length);
  });

  test("every entry carries what its disposition requires", () => {
    for (const cause of inventory().causes) {
      // The identity is folded into the asserted value rather than
      // into a message, because the shim contract has no matcher
      // that carries one -- so a failure has to name the entry
      // itself or the reader is left grepping 89 rows.
      const id = `${cause.package}|${cause.key}`;
      const missing: string[] = [];
      if (!DISPOSITIONS.includes(cause.disposition))
        missing.push("disposition");
      if (cause.sites.length === 0) missing.push("sites");
      if (cause.disposition === "claimed") {
        if ((cause.rules ?? []).length === 0) missing.push("rules");
        if (cause.test === undefined) missing.push("test");
      }
      if (cause.disposition === "claimed-partial") {
        if ((cause.rules ?? []).length === 0) missing.push("rules");
        if (cause.gap === undefined) missing.push("gap");
      }
      if (cause.disposition === "pinned" && cause.test === undefined) {
        missing.push("test");
      }
      if (cause.disposition === "open") {
        if (cause.gap === undefined) missing.push("gap");
        if (cause.readmeAnchor === undefined) missing.push("readmeAnchor");
      }
      if (cause.disposition === "n/a" && cause.reason === undefined) {
        missing.push("reason");
      }
      expect(`${id}: ${missing.join(", ")}`).toBe(`${id}: `);
    }
  });

  test("every source says why it is in scope", () => {
    for (const source of inventory().sources) {
      expect(source.why.length > 0).toBe(true);
    }
  });
});

describe("the bijection between the inventory and the rule ids", () => {
  /** Every rule id an upstream cause or a probe claims. */
  function claimedIds(): Set<string> {
    const { causes, probes } = inventory();
    const ids = new Set<string>();
    for (const entry of [...causes, ...probes]) {
      for (const rule of entry.rules ?? []) ids.add(rule);
    }
    return ids;
  }

  test("every claimed id is a declared upstream rule", () => {
    const declared = new Set<string>(UPSTREAM_RULE_IDS);
    for (const id of claimedIds()) {
      expect(`${id} is declared: ${declared.has(id)}`).toBe(
        `${id} is declared: true`,
      );
    }
  });

  test("every declared upstream rule is claimed by a cause", () => {
    // The direction that makes the inventory a completeness
    // artifact rather than a checklist. A rule nothing claims is a
    // refusal tsfga makes with no upstream cause behind it -- which
    // is what the capability list is for, and it must be in that
    // list instead.
    const claimed = claimedIds();
    for (const id of UPSTREAM_RULE_IDS) {
      expect(`${id} is claimed: ${claimed.has(id)}`).toBe(
        `${id} is claimed: true`,
      );
    }
  });

  test("the two namespaces are disjoint", () => {
    const upstream = new Set<string>(UPSTREAM_RULE_IDS);
    for (const id of CAPABILITY_RULE_IDS) {
      expect(`${id} is upstream: ${upstream.has(id)}`).toBe(
        `${id} is upstream: false`,
      );
    }
  });

  test("every capability rule id has an entry", () => {
    const entries = new Set(capability().refusals.map((each) => each.id));
    for (const id of CAPABILITY_RULE_IDS) {
      expect(`${id} has an entry: ${entries.has(id)}`).toBe(
        `${id} has an entry: true`,
      );
    }
    for (const entry of capability().refusals) {
      const declared: readonly string[] = CAPABILITY_RULE_IDS;
      expect(`${entry.id} is declared: ${declared.includes(entry.id)}`).toBe(
        `${entry.id} is declared: true`,
      );
    }
  });
});

describe("the capability refusal list", () => {
  test("every entry carries a reason, an anchor and a pin", () => {
    for (const refusal of capability().refusals) {
      expect(refusal.reason.length > 0).toBe(true);
      expect(refusal.readmeAnchor.includes("#")).toBe(true);
      expect(refusal.pin.includes(":")).toBe(true);
    }
  });

  test("no id is entered twice", () => {
    const ids = capability().refusals.map((refusal) => refusal.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("no upstream cause claims a capability refusal", () => {
    // The whole point of two lists. A capability refusal is one
    // upstream does *not* make, so a cause that claimed one would
    // be asserting parity with a divergence.
    const ids = new Set(capability().refusals.map((refusal) => refusal.id));
    for (const cause of inventory().causes) {
      for (const rule of cause.rules ?? []) {
        expect(`${cause.key} claims ${rule}: ${ids.has(rule)}`).toBe(
          `${cause.key} claims ${rule}: false`,
        );
      }
    }
  });
});
