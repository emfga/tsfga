import { describe, expect, test } from "bun:test";
import {
  InvalidConditionalTupleError,
  InvalidSubjectTypeError,
} from "../src/errors.ts";
import type { TypeRestriction } from "../src/types.ts";

/**
 * What a refusal is allowed to say out loud.
 *
 * `addTuple`'s errors are the ones a service is most likely to
 * surface to whoever attempted the write -- the ordinary shape is
 * a 400 carrying the message. So the message is a disclosure
 * surface, and it was disclosing the relation's entire type
 * restriction list: every admitted type, every userset relation
 * and every condition name. OpenFGA names only the offending
 * type and never the allow-list.
 *
 * The list is worth keeping for a caller that has legitimate
 * reason to inspect it, which is what the fields are for. The
 * distinction is between data reachable on the object and data
 * pushed into a string that tends to end up in logs and
 * responses.
 */

const ALLOWED: readonly TypeRestriction[] = [
  { type: "user" },
  { type: "user", condition: "weekday_only" },
  { type: "user", wildcard: true },
  { type: "secretgroup", relation: "confidential_members" },
];

describe("InvalidSubjectTypeError", () => {
  const error = new InvalidSubjectTypeError(
    { type: "team" },
    "doc",
    "viewer",
    ALLOWED,
  );

  test("names the offending subject and the relation", () => {
    expect(error.message).toContain("team");
    expect(error.message).toContain("doc");
    expect(error.message).toContain("viewer");
  });

  test("does not enumerate what the relation admits", () => {
    // The condition name is the sharpest of these: it names a
    // condition the caller was never told about.
    expect(error.message).not.toContain("weekday_only");
    expect(error.message).not.toContain("secretgroup");
    expect(error.message).not.toContain("confidential_members");
    expect(error.message).not.toContain("Allowed:");
  });

  test("carries the allow-list on the error instead", () => {
    // Dropping the rendering without this would lose the list:
    // the constructor rendered all four arguments and assigned
    // none of them.
    expect(error.allowed).toEqual(ALLOWED);
    expect(error.subject).toEqual({ type: "team" });
    expect(error.objectType).toBe("doc");
    expect(error.relation).toBe("viewer");
  });

  test("is stable across a reordering of the allow-list", () => {
    // The list rendered in whatever order the JSON column held,
    // so the message changed when a config was rewritten with the
    // same restrictions in a different order.
    const reordered = new InvalidSubjectTypeError(
      { type: "team" },
      "doc",
      "viewer",
      [...ALLOWED].reverse(),
    );
    expect(reordered.message).toBe(error.message);
  });
});

describe("InvalidConditionalTupleError", () => {
  const error = new InvalidConditionalTupleError(
    "undefined condition",
    { type: "user", condition: "nosuch" },
    "doc",
    "viewer",
    ALLOWED,
  );

  test("names the cause and the offending subject", () => {
    expect(error.cause).toBe("undefined condition");
    expect(error.message).toContain("nosuch");
    expect(error.message).toContain("doc");
  });

  test("does not enumerate what the relation admits", () => {
    // The sibling error stopped doing this; this one kept doing
    // it, which left the same disclosure on the same write path.
    expect(error.message).not.toContain("weekday_only");
    expect(error.message).not.toContain("secretgroup");
    expect(error.message).not.toContain("Allowed:");
  });

  test("carries the allow-list on the error instead", () => {
    expect(error.allowed).toEqual(ALLOWED);
    expect(error.objectType).toBe("doc");
    expect(error.relation).toBe("viewer");
  });
});
