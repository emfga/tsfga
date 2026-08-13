import { describe, expect, test } from "bun:test";
import { CANONICAL_UUID_IDS, OPAQUE_IDS } from "../src/store-interface.ts";

/**
 * The predicate that carries the whole safety argument for a store
 * keeping its ids in a `uuid` column.
 *
 * PostgreSQL's `uuid` input grammar is many-to-one: five spellings
 * of one value all store as the same row. OpenFGA's id space is
 * one-to-one: those same five spellings are five distinct ids. A
 * domain admitting more than one of them would let a grant written
 * for one answer `true` for another, which is the only
 * granting-direction hole this design could have. Every refusal
 * below is what closes it.
 */

/** The spelling the column stores back unchanged. */
const CANONICAL = "00000000-0000-4000-d570-000000000001";

describe("CANONICAL_UUID_IDS", () => {
  test("admits the canonical spelling", () => {
    expect(CANONICAL_UUID_IDS.defect(CANONICAL)).toBeNull();
  });

  test("admits the nil UUID as an ordinary id", () => {
    // The reason there is no version check. The nil UUID used to *be* the typed wildcard, so a
    // real subject carrying it was read back as everyone. It has a
    // column of its own now, no id value is reserved, and a
    // version-nibble check would refuse the exact id that freed.
    expect(
      CANONICAL_UUID_IDS.defect("00000000-0000-0000-0000-000000000000"),
    ).toBeNull();
  });

  test("admits a variant nibble RFC 4122 does not define", () => {
    // Syntax only. 471 of the 579 UUID literals in the conformance
    // corpus carry a 4th group starting `c` or `d`; PostgreSQL
    // accepts them and so does upstream, so a validator that did
    // not would refuse the fixtures it exists to police.
    expect(
      CANONICAL_UUID_IDS.defect("00000000-0000-4000-d570-000000000001"),
    ).toBeNull();
    expect(
      CANONICAL_UUID_IDS.defect("00000000-0000-4000-c500-000000000001"),
    ).toBeNull();
  });

  describe("refuses every spelling a uuid column would fold onto one row", () => {
    // Measured on PG 18: each of these five is accepted by
    // `uuid_in` and compares equal to the canonical spelling.
    // Measured on OpenFGA v1.18.2: each is a distinct id.
    const folded: ReadonlyArray<[string, string]> = [
      ["uppercase", CANONICAL.toUpperCase()],
      ["hyphenless", CANONICAL.replaceAll("-", "")],
      ["braced", `{${CANONICAL}}`],
      ["braced hyphenless", `{${CANONICAL.replaceAll("-", "")}}`],
      ["odd hyphens", "0000-0000-0000-4000-d570-0000-00000001"],
    ];

    for (const [name, spelling] of folded) {
      test(name, () => {
        expect(CANONICAL_UUID_IDS.defect(spelling)).not.toBeNull();
      });
    }
  });

  describe("refuses an id that is not a UUID at all", () => {
    const refused: ReadonlyArray<[string, string]> = [
      ["a slug", "alice"],
      ["a non-ASCII id", "café"],
      ["an empty id", ""],
      ["a long id", "x".repeat(300)],
      ["36 non-hex characters", "zzzzzzzz-zzzz-4000-d570-zzzzzzzzzzzz"],
      // `$` without the `m` flag anchors at end of input in
      // JavaScript and does not match before a trailing newline.
      // Asserted rather than assumed: the opposite is true in
      // several other languages, and it would admit two strings
      // one column value.
      ["a trailing newline", `${CANONICAL}\n`],
      ["a leading space", ` ${CANONICAL}`],
      ["the typed wildcard", "*"],
    ];

    for (const [name, id] of refused) {
      test(name, () => {
        expect(CANONICAL_UUID_IDS.defect(id)).not.toBeNull();
      });
    }
  });

  test("names itself in a phrase, not a code", () => {
    expect(CANONICAL_UUID_IDS.name).toBe("canonical UUID");
  });
});

describe("OPAQUE_IDS", () => {
  test("admits everything the other domain refuses", () => {
    for (const id of [
      CANONICAL,
      CANONICAL.toUpperCase(),
      "alice",
      "café",
      "",
      "*",
      "x".repeat(300),
    ]) {
      expect(OPAQUE_IDS.defect(id)).toBeNull();
    }
  });
});
