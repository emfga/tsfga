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
 * What `toThrow` accepts: bare, a constructor, a RegExp, a message
 * substring, or an Error whose message must match exactly.
 * @typedef {undefined | Function | RegExp | Error | string} ThrowExpectation
 */

/**
 * Run `fn` and report what it threw, distinguishing "threw nothing"
 * from "threw undefined" so `toThrow` cannot pass on the latter.
 * @param {unknown} fn
 * @returns {{ threw: boolean, error: any }}
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
 * @param {any} error
 * @param {ThrowExpectation} expected
 * @returns {boolean}
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

/**
 * @param {ThrowExpectation} expected
 * @returns {string}
 */
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

/**
 * @param {any} actual
 */
function expect(actual) {
  const matchers = {
    /** @param {any} expected */
    toBe(expected) {
      assert.strictEqual(actual, expected);
    },
    toBeNull() {
      assert.strictEqual(actual, null);
    },
    /** @param {any} expected */
    toEqual(expected) {
      assert.deepStrictEqual(actual, expected);
    },
    /** @param {number} n */
    toHaveLength(n) {
      assert.strictEqual(actual.length, n);
    },
    toBeTruthy() {
      assert.ok(actual);
    },
    toBeUndefined() {
      assert.strictEqual(actual, undefined);
    },
    /** @param {number} n */
    toBeGreaterThan(n) {
      assert.ok(
        actual > n,
        `Expected ${actual} to be greater than ${n}`,
      );
    },
    /** @param {Function} ctor */
    toBeInstanceOf(ctor) {
      assert.ok(
        actual instanceof ctor,
        `Expected instance of ${ctor.name}, got ${actual?.constructor?.name}`,
      );
    },
    /**
     * Substring for a string, membership for an array. Bun's
     * matcher is overloaded the same way.
     * @param {any} expected
     */
    toContain(expected) {
      if (typeof actual === "string") {
        assert.ok(
          actual.includes(expected),
          `Expected ${JSON.stringify(actual)} to contain ${JSON.stringify(expected)}`,
        );
        return;
      }
      assert.ok(
        Array.isArray(actual) && actual.includes(expected),
        `Expected ${JSON.stringify(actual)} to contain ${JSON.stringify(expected)}`,
      );
    },
    /** @param {ThrowExpectation} [expected] */
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
      /** @param {any} expected */
      toBe(expected) {
        assert.notStrictEqual(actual, expected);
      },
      /** @param {any} expected */
      toContain(expected) {
        const has =
          typeof actual === "string"
            ? actual.includes(expected)
            : Array.isArray(actual) && actual.includes(expected);
        assert.ok(
          !has,
          `Expected ${JSON.stringify(actual)} not to contain ${JSON.stringify(expected)}`,
        );
      },
      /** @param {ThrowExpectation} [expected] */
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
      /** @param {Function} ctor */
      async toBeInstanceOf(ctor) {
        await assert.rejects(actual, (/** @type {any} */ err) => err instanceof ctor);
      },
    },
    /**
     * The awaited value, matched. A rejection propagates rather
     * than being reported as a mismatch, so `.resolves` asserting
     * "this settles, and settles to X" fails with the real error.
     */
    resolves: {
      async toBeUndefined() {
        assert.strictEqual(await actual, undefined);
      },
      /** @param {any} expected */
      async toBe(expected) {
        assert.strictEqual(await actual, expected);
      },
      /** @param {any} expected */
      async toEqual(expected) {
        assert.deepStrictEqual(await actual, expected);
      },
    },
  };
  return matchers;
}

export { describe, test, beforeEach, afterEach, beforeAll, afterAll, expect };
