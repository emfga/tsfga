# Catastrophic backtracking, and why no bound was enough

`^(a+)+$` is linear in RE2 and exponential in JavaScript. This is
the measurement that decided against every partial control, and it
is preserved because a future fork restoring `matches()` must not
rediscover it the hard way.

Re-run it yourself — `measure-backtracking.mjs` beside this file
executes unchanged on all three runtimes:

```
bun      docs/cel-js/regex/measure-backtracking.mjs
node     docs/cel-js/regex/measure-backtracking.mjs
deno run -A docs/cel-js/regex/measure-backtracking.mjs
```

## The curves

`^(a+)+$` tested against `'a' * n + 'b'`, wall clock:

| n | Bun 1.3.14 (JSC) | Node v26.7.0 (V8) | Deno 2.9.5 (V8) |
|---|---|---|---|
| 20 | 5 ms | 36 ms | 32 ms |
| 24 | 69 ms | 80 ms | 87 ms |
| 26 | 268 ms | 324 ms | 349 ms |
| 28 | 418 ms | 1 281 ms | 1 346 ms |
| 30 | 408 ms | 5 205 ms | 5 345 ms |
| 32 | 420 ms | **20 931 ms** | **22 559 ms** |
| 34 | 419 ms | past budget | past budget |
| 100 | 409 ms | past budget | past budget |
| 5 000 | 418 ms | past budget | past budget |

## The methodology trap, which caught this effort

**JavaScriptCore bounds backtracking and V8 does not.** JSC
plateaus at roughly 420 ms and stays there for a five-thousand
character subject. V8 roughly quadruples every two characters and
does not stop.

An earlier revision of this analysis reported "~600 ms, doubling
per character" and treated the hazard as bounded. That figure was
taken on **Bun alone**, so it measured JSC's bailout rather than
the regular expression. `@tsfga/core` is published, and most
consumers run Node.

**Any future engine-behaviour claim in this repository is measured
on all three runtimes.** One runtime is an anecdote.

## The two controls that were measured and rejected

**A wall-clock timeout.** Rejected on determinism: it makes an
authorization decision depend on machine load, so the same request
is allowed on an idle host and refused on a busy one. An
authorization engine that answers differently under load is worse
than one that answers narrowly.

**A subject-length cap.** Rejected on the numbers above. The
blow-up crosses one second at n=28 and twenty seconds at n=32 —
below any length a real allow-list would want to impose. A cap low
enough to bound this would refuse ordinary email addresses.

**And the evaluation cost budget never bounded it either**, though
it was assumed to. `maxConditionEvaluationCost` prices an
expression by its *static shape*: `s.matches('^(a+)+$')` scores 7
against a default limit of 100 and is allowed. Backtracking is
exponential in the *subject's* length, which the static estimate
cannot see. The budget is a real limit on context-driven work —
2 000-character strings and 200-element lists do trip it — but it
never had anything to say about this.

Three controls, three different reasons none of them worked. That
is what made removing the feature the smaller change.
