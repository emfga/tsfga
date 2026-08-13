# Draft: allow a registered function to replace a built-in

**Status: drafted, unfiled.** Against `@marcbachmann/cel-js`
8.0.0.

## The ask

`registerFunction` and `registerOperator` refuse to bind a name
the standard library already declares. There is no `replace: true`
option and no `deleteFunction`, and the registry locks on clone.

## Why it matters to an embedder

cel-js's built-ins are correct CEL and are not always *cel-go's*
CEL. An embedder tracking cel-go — anyone building an
OpenFGA-compatible engine, which is a real and growing category —
needs to supply cel-go's semantics for a handful of names.

The concrete cases measured in this repository:

- `int(double)` and `double(string)` do not range-check, so
  `int(1e100)` answers where cel-go raises an overflow.
- `int(uint)`, `int(duration)`, `int(timestamp)`,
  `string(duration)` and `string(timestamp)` are overloads cel-go
  declares and cel-js does not.
- `MinInt64 / -1`, `MinInt64 % -1` and `-MinInt64` are unchecked,
  where cel-go raises.

The last group is the sharpest, because `registerOperator` cannot
touch a built-in operator at all — so there is no workaround, not
even an ugly one.

## The workaround, and why it was abandoned

tsfga registered `tsfga_int`, `tsfga_double` and friends under
names cel-js does not declare, then **rewrote the author's source
text** to call them: parse, walk the AST for owned call names,
splice the new name over the old one in the source, re-parse.

It worked and it was deleted. A source splicer in the path of
every authorization decision is a second implementation of the
language, and comment masking, receiver-versus-global spellings
and unplaceable call sites were all load-bearing in it. The
retired code is in `../retired/translate-re2-pattern.ts.txt` and
its neighbours if it is useful as motivation.

## Suggested shape

```js
env.registerFunction("int", fn, { replace: true });
```

Opt-in per call, so no existing program changes behaviour. An
`env.unregister(name)` or a `stdlib: false` construction option
would serve equally.
