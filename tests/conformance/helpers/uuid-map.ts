import * as fs from "node:fs";
import { parse as parseYaml } from "yaml";

interface FgaTupleYaml {
  user: string;
  object: string;
}

const UUID_SHAPED = /^[0-9a-fA-F-]{36}$/;

/** Every name a ref in the fixture puts after its `type:`. */
function namesIn(tuplesPath: string): Set<string> {
  const raw = fs.readFileSync(tuplesPath, "utf-8");
  const parsed: unknown = parseYaml(raw);
  const names = new Set<string>();
  if (!Array.isArray(parsed)) return names;

  for (const entry of parsed) {
    const tuple: FgaTupleYaml = entry;
    for (const ref of [tuple.user, tuple.object]) {
      if (typeof ref !== "string") continue;
      const hashIdx = ref.indexOf("#");
      const base = hashIdx >= 0 ? ref.slice(0, hashIdx) : ref;
      const colonIdx = base.indexOf(":");
      if (colonIdx < 0) continue;
      const name = base.slice(colonIdx + 1);
      if (name === "*" || UUID_SHAPED.test(name)) continue;
      names.add(name);
    }
  }
  return names;
}

/**
 * Gate 0 — discovery completeness, against an independent source.
 *
 * Every name the OpenFGA-side fixture uses must be a key of the
 * test file's map. It says the map is *complete* rather than
 * merely *consistently applied*: a residue search can only search
 * for keys, so a value the discovery never found is invisible to
 * it by construction. The fixture is written by hand and not
 * derived from the test file, so it can disagree.
 *
 * It is not the only completeness gate, and it is the weaker of
 * the two. `resolveRef` in `helpers/openfga.ts` throws on any
 * unmapped ref, at fixture load, for every file that passes a
 * `uuidMap` — a stronger check over more files, because it sees
 * every ref actually resolved rather than the ones a text scan
 * recognises. Both are kept: this one runs as an ordinary
 * assertion, names every missing key at once, and reports against
 * the tuples file the way a reader reads it, while `resolveRef`
 * fails on the first ref and only where a map is passed at all.
 */
export function assertUuidMapCovers(
  tuplesPath: string,
  map: ReadonlyMap<string, string>,
): void {
  const missing = [...namesIn(tuplesPath)]
    .filter((name) => !map.has(name))
    .sort();
  if (missing.length > 0) {
    throw new Error(
      `${tuplesPath} names ids the uuidMap does not carry: ` +
        `${missing.join(", ")}`,
    );
  }
}

/**
 * Gate 1 — injectivity.
 *
 * Two names on one UUID merges two logically distinct objects.
 * Both engines then see the merged id, both agree, and the test
 * passes — the one silent failure `uuid()`'s own throw cannot
 * catch.
 */
export function assertUuidMapInjective(map: ReadonlyMap<string, string>): void {
  const seen = new Map<string, string>();
  for (const [name, id] of map) {
    const first = seen.get(id);
    if (first !== undefined) {
      throw new Error(`uuidMap maps both "${first}" and "${name}" to ${id}`);
    }
    seen.set(id, name);
  }
}
