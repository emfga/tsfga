// Measure catastrophic backtracking for `^(a+)+$` against
// 'a' * n + 'b' on whatever runtime executes this file.
//
// Runtime-agnostic on purpose: `bun`, `node` and `deno run` all
// execute it unchanged. JavaScriptCore bounds backtracking and V8
// does not, so a figure taken on one runtime says nothing about
// the other, and @tsfga/core is published to consumers who mostly
// run Node.
//
//   bun  docs/cel-js/regex/measure-backtracking.mjs
//   node docs/cel-js/regex/measure-backtracking.mjs
//   deno run -A docs/cel-js/regex/measure-backtracking.mjs

const PATTERN = /^(a+)+$/;
const BUDGET_MS = 20000;

function runtime() {
  if (typeof Bun !== "undefined") return `Bun ${Bun.version}`;
  if (typeof Deno !== "undefined") return `Deno ${Deno.version.deno}`;
  if (typeof process !== "undefined") return `Node ${process.version}`;
  return "unknown";
}

console.log(`runtime: ${runtime()}`);
console.log(`pattern: ${PATTERN.source}   subject: 'a'*n + 'b'`);

for (const n of [20, 24, 26, 28, 30, 32, 34, 40, 100, 5000]) {
  const subject = "a".repeat(n) + "b";
  const started = Date.now();
  PATTERN.test(subject);
  const ms = Date.now() - started;
  console.log(`n=${String(n).padStart(5)}  ${String(ms).padStart(7)} ms`);
  if (ms > BUDGET_MS) {
    console.log(`  stopped: past the ${BUDGET_MS} ms budget`);
    break;
  }
}
