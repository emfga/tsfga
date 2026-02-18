export { expect } from "jsr:@std/expect@1";
export {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  test,
} from "jsr:@std/testing@1/bdd";

import { describe as _describe } from "jsr:@std/testing@1/bdd";

/**
 * Wraps describe to disable Deno's resource and op sanitizers.
 * npm packages like pg open TCP connections that outlive individual
 * test suites, triggering false-positive leak detection in Deno >= 2.6.
 */
export function describe(name: string, fn: () => void) {
  return _describe(name, { sanitizeResources: false, sanitizeOps: false }, fn);
}
