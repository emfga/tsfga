# Equivalence harnesses

Randomized differential harnesses for `@tsfga/core`. Part of the
[tsfga] monorepo; see the [package README] for the check algorithm they
exercise and the [root README] for the project overview.

These are not benchmarks despite the directory name, and not unit tests.
Each one generates random relation graphs, resolves the same request
under two settings of a knob that is supposed to be answer-preserving,
and reports every case where the two disagree. They exist because the
properties they cover are not expressible as a fixed scenario: the bugs
live in graph shapes nobody would think to write down.

| harness | knob held to be answer-preserving |
|---|---|
| `breadth-equivalence.ts` | `maxBreadth` — 1 vs 2, 3, 5, 10, `Infinity` |
| `batch-equivalence.ts` | `checkMany` vs the same requests one at a time |

## Running them

```bash
cd packages/core
bun run bench:breadth
bun run bench:batch
```

Each takes a few minutes. There is no CI job — they are run by hand
before a change to the resolution machinery, and they are in the repo so
that the generator itself is reviewable. That is the point: the version
these replace lived outside the repo, and when its generator drifted out
of agreement with the model it generated, there was no diff for anyone
to notice.

## Two phases, two different bars

Both harnesses split their run in half, because the invariant is not the
same on each side.

**Phase 1 — no intersections.** The knob must never change the answer or
the error class. A divergence here is a bug and the harness prints it.

**Phase 2 — intersections enabled.** The knob legitimately *can* change
the answer. An intersection is decided by the first operand that fails
to hold; a definitive `false` and a cycle-truncated operand are both
failures carrying different indeterminacy, and an enclosing `but not`
reads the difference. So which operand gets there first is observable,
and upstream behaves the same way — see
`tests/conformance/intersection-cycle-precedence.test.ts`. Divergences
are therefore counted, not failed. What is still a bug in this phase: a
hang, or an error class that is not one of ours, which means an internal
sentinel leaked to a caller.

## Reading the output

Both end with a summary line per phase. Phase 1's divergence count must
be `0` and phase 2's unknown-error count must be `0`.

Each run also prints a `coverage` line — how many rows the generator
emitted, and how many userset rows the models actually admitted — and
**exits non-zero if the admitted count is `0`**. That assertion is
load-bearing rather than decorative. The generator builds tuples
independently of the configs, so the refs a config admits and the refs
the tuple generator draws from can fall out of agreement. When they do,
`clampToQuery` drops every userset row, the harness still runs, still
reports zero divergences, and has silently stopped testing userset
expansion at all.

That is not hypothetical. These harnesses read `admittedUserset: 0`
against 2500-odd generated userset rows for a full round, so a "0
divergences" result from that period says nothing whatever about step 2.
The counts exist so the next such drift is a red run rather than a quiet
one.

[tsfga]: https://github.com/emfga/tsfga
[package README]: ../README.md
[root README]: ../../../README.md
