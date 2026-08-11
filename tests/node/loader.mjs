/**
 * Node.js ESM resolve hook that intercepts "bun:test" imports and redirects
 * them to the local compatibility shim.
 */

const shimUrl = new URL("./bun-test-shim.mjs", import.meta.url).href;

/**
 * @param {string} specifier
 * @param {unknown} context
 * @param {(specifier: string, context: unknown) => unknown} nextResolve
 */
export function resolve(specifier, context, nextResolve) {
  if (specifier === "bun:test") {
    return { url: shimUrl, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
