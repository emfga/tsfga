/**
 * Compatibility shim that implements the bun:test API subset used by this
 * project on top of node:test + node:assert/strict. Loaded via the custom
 * ESM loader in loader.mjs so that test files importing "bun:test" resolve
 * here when running under Node.js.
 */

import { strict as assert } from "node:assert";
import { after, before, beforeEach, afterEach, describe, test } from "node:test";

const beforeAll = before;
const afterAll = after;

/**
 * Run `fn` and report what it threw, distinguishing "threw nothing"
 * from "threw undefined" so `toThrow` cannot pass on the latter.
 */
function capture(fn) {
  if (typeof fn !== "function") {
    assert.fail(`Expected a function to call, got ${typeof fn}`);
  }
  try {
    fn();
  } catch (error) {
    return { threw: true, error };
  }
  return { threw: false, error: undefined };
}

/**
 * Bun's toThrow argument forms. Bare means "threw anything"; a class
 * matches by instance, a RegExp against the message, a string as a
 * message substring, and an Error by exact message.
 */
function matchesExpected(error, expected) {
  if (expected === undefined) {
    return true;
  }
  if (typeof expected === "function") {
    return error instanceof expected;
  }
  if (expected instanceof RegExp) {
    return expected.test(String(error?.message ?? error));
  }
  if (expected instanceof Error) {
    return String(error?.message ?? error) === expected.message;
  }
  return String(error?.message ?? error).includes(String(expected));
}

function describeExpected(expected) {
  if (expected === undefined) {
    return "to throw";
  }
  if (typeof expected === "function") {
    return `to throw ${expected.name}`;
  }
  if (expected instanceof RegExp) {
    return `to throw a message matching ${expected}`;
  }
  if (expected instanceof Error) {
    return `to throw the message ${JSON.stringify(expected.message)}`;
  }
  return `to throw a message containing ${JSON.stringify(String(expected))}`;
}

function expect(actual) {
  const matchers = {
    toBe(expected) {
      assert.strictEqual(actual, expected);
    },
    toBeNull() {
      assert.strictEqual(actual, null);
    },
    toEqual(expected) {
      assert.deepStrictEqual(actual, expected);
    },
    toHaveLength(n) {
      assert.strictEqual(actual.length, n);
    },
    toBeTruthy() {
      assert.ok(actual);
    },
    toBeInstanceOf(ctor) {
      assert.ok(
        actual instanceof ctor,
        `Expected instance of ${ctor.name}, got ${actual?.constructor?.name}`,
      );
    },
    toThrow(expected) {
      const { threw, error } = capture(actual);
      if (!threw) {
        assert.fail(`Expected ${describeExpected(expected)}, but it did not`);
      }
      assert.ok(
        matchesExpected(error, expected),
        `Expected ${describeExpected(expected)}, got ${error?.constructor?.name}: ${error?.message ?? error}`,
      );
    },
    not: {
      toBeNull() {
        assert.notStrictEqual(actual, null);
      },
      toBe(expected) {
        assert.notStrictEqual(actual, expected);
      },
      toThrow(expected) {
        const { threw, error } = capture(actual);
        if (threw && matchesExpected(error, expected)) {
          assert.fail(
            `Expected not ${describeExpected(expected)}, got ${error?.constructor?.name}: ${error?.message ?? error}`,
          );
        }
      },
    },
    rejects: {
      async toBeInstanceOf(ctor) {
        await assert.rejects(actual, (err) => err instanceof ctor);
      },
    },
  };
  return matchers;
}

export { describe, test, beforeEach, afterEach, beforeAll, afterAll, expect };
