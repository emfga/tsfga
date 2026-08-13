# Draft: expose the full declared surface for enumeration

**Status: drafted, unfiled.** Against `@marcbachmann/cel-js`
8.0.0.

## The ask

A stable, complete enumeration of what an environment declares —
functions, macros and operators — so an embedder can diff it
against the surface they are tracking.

Today functions are reachable and macros and operators are not, so
an enumeration test covers part of the surface and reports clean
on the rest.

## Why it matters

An embedder tracking cel-go needs to know when cel-js's surface
*moves*. A new extension name in a minor release is, for an
authorization engine, a new expression that evaluates here and is
refused by the reference implementation — a granting divergence
introduced by a dependency bump, with no diff in the embedder's
own source.

tsfga carries a test that enumerates the declared functions and
asserts the set against a transcription of cel-go's. It is the
only thing that will report a twenty-first extension name
appearing. It cannot report a new macro or a new operator.

That test is now the most valuable single test in this area,
because after removing its compatibility layer the project has
*less* code standing between a new cel-js name and a granted
check, not more.

## Suggested shape

```js
env.getDefinitions();        // already exists for functions
env.getMacros();
env.getOperators();
```

Or one `env.describe()` returning all three. The shape matters
less than the completeness and the stability across releases.
