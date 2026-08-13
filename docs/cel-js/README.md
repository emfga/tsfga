# `docs/cel-js/` — the cel-js gap catalogue

tsfga evaluates CEL conditions with
[`@marcbachmann/cel-js`](https://github.com/nicholasgasior/cel-js).
OpenFGA evaluates them with cel-go. The two share a language
specification and do not share an implementation.

This directory is the measured record of where they part company:
what was tested, against which versions, what each engine did, and
what tsfga decided to do about it. It is checked in — not
gitignored, not a planning artifact — because it is the starting
material for the only real fix, which is a cel-js that behaves
like cel-go.

`CLAUDE.md`'s **CEL is bounded by cel-js** section is the rule
this directory supports. Read that first if you are about to
change `packages/core/src/conditions.ts`.

## Why there is no regex

**tsfga does not support `matches()`.** A condition whose
expression calls it is refused when you write it:

```
ConditionCompileError: undeclared reference to 'matches'
```

There is no pattern layer in any direction — none that translates,
none that validates, none that measures. `matches` is simply
absent from the declaration allow-list, so the gate that already
refuses `split` and `substring` refuses it too, by name, at the
earliest and loudest moment available.

That is a large, permanent, refusing-direction divergence: OpenFGA
supports `matches()`, and a model ported from OpenFGA whose
conditions use it will not load. It was chosen over the
alternatives on evidence, and the evidence is here.

**It was not the first answer.** An earlier release shipped a
compatibility layer: an RE2-to-`RegExp` pattern translator, and an
AST source-splice that renamed calls onto tsfga-owned overloads so
the translator could reach them. Roughly 830 lines, in the path of
every authorization decision, and a second regular-expression
implementation owned by this project. After that, a write-time
deny-list refusing patterns RE2 rejects was authorised as a
smaller replacement.

**Neither survived contact with the measurements**, for three
separate reasons, in three documents:

- [`regex/bypass.md`](./regex/bypass.md) — `^[^]*$` is a syntax
  error in RE2 and *every possible input* in JavaScript. An
  author's whitelist admits everything, silently. This row is
  what reopened the question twice.
- [`regex/re2-vs-celjs.md`](./regex/re2-vs-celjs.md) — the
  construct-by-construct gap table, in three groups. A deny-list
  built from RE2's grammar closes the first group and passes the
  second straight through, and the second is the silent-denial
  family: `[[:alnum:]]+` matches `"abc123"` in RE2 and does not in
  JavaScript, so an allow-list stops admitting everything it was
  written for and nothing errors.
- [`regex/backtracking.md`](./regex/backtracking.md) — `^(a+)+$`
  is linear in RE2 and exponential in V8: 5.2 s at 30 characters,
  20.9 s at 32, measured. No length cap could bound it, because
  the blow-up starts below any usable limit; a wall-clock timeout
  would make an authorization decision depend on machine load; and
  the evaluation cost budget prices the pattern at 7 against a
  limit of 100.

Each partial fix closed some rows and left others, and every
measurement pass moved which. Removing the feature removed the
class. The second amendment **narrowed the code** — no deny-list,
~120 lines never written — while **widening the refusal**, from
"some patterns" to "all of them".

**Restoring `matches()` is fork-shaped, not a patch.** It needs a
cel-js whose `matches` is RE2. After that, tsfga needs one entry
back in `CEL_GO_MEMBER_CALLS` and nothing else — which is the
whole reason regex support was expressed as a table entry rather
than as a layer.

## Layout

| path | what it holds |
|---|---|
| `regex/` | the dossier above, plus `measure-backtracking.mjs`, which runs unchanged on Bun, Node and Deno |
| `cases.jsonl` | one measured cell per line, both version strings mandatory |
| `gaps/` | one file per gap, with a back-pointer to the issue that raised it |
| `probes/` | reproducible probe scripts |
| `retired/` | the removed dialect suites and the deleted translator, verbatim |
| `upstream/` | drafted but unfiled cel-js issue bodies |

## `retired/` is an acceptance suite, not a graveyard

The six relocated suites are `.ts.txt` rather than `.ts` on
purpose — see the note at the end of this file — but their cells
are also in `cases.jsonl` with their `openfga` and `celjs` columns
measured. That makes them re-runnable against a candidate cel-js
with **no database, no container and no authorization graph**: an
expression, a context, and an expected value.

A fork evaluating a candidate build should start with
`retired/cel-re2/`, which is the highest-value single file for
this purpose, and with `regex/measure-backtracking.mjs`.

No suite was deleted. A suite whose point was dialect behaviour is
evidence for the fork, and is preserved as evidence even though it
no longer runs.

## `cases.jsonl`

One JSON object per line:

```
{ id, gap, expression, parameters, context,
  openfga, celjs, tsfga, direction,
  openfgaVersion, celjsVersion, measuredAt, source }
```

**Both version strings are mandatory.** A measurement without them
is folklore: OpenFGA and cel-js will both have moved by the time
anyone acts on this directory.

A row whose `tsfga` key is **absent** has not been measured on
tsfga yet. Absence says that; `null` would assert a value.

`gaps/` uses fresh ids rather than reusing the archived
`020`/`320`/`381` numbering. That scheme is closed, and carrying it
forward as a primary key would import a dead index.

## Why the archived files end in `.ts.txt`

Three CI problems, one answer. `biome.json` includes `**/*.ts` and
sets `useFilenamingConvention` to `error` with kebab-case, so an
archived `translateRe2Pattern.ts` would fail `bun run biome:check`.
The archived translator will not type-check once its module
context is gone. And a stray `bun test` from the repository root
would collect `retired/**/original.test.ts` and try to run it.

`.ts.txt` removes all three permanently, at the cost of syntax
highlighting on files nobody edits. `probes/` stays `.ts` because
probes are meant to run.
