# Draft: let an environment opt out of extension libraries

**Status: drafted, unfiled.** Against `@marcbachmann/cel-js`
8.0.0.

## The ask

A construction option to build an environment **without** the
extension functions — the equivalents of cel-go's `ext.Strings()`
and `ext.Bindings()`.

## Why it matters

cel-go ships those as *libraries an embedder enables*, and OpenFGA
does not enable them. cel-js ships them as part of the base
environment with no way to leave them out. So `split`,
`substring`, `trim`, `indexOf`, `lastIndexOf`, `lowerAscii`,
`upperAscii`, `join` and `cel.bind` are callable in cel-js and are
not callable in the engine an embedder is tracking.

For an authorization engine that is a **granting** divergence: an
expression using them evaluates here and is a model the reference
implementation refuses to store.

## The workaround

An allow-list applied to the parsed AST: walk it, and refuse any
call name absent from a transcription of cel-go's declared
surface. It is about 130 lines and it works.

It has one property the maintainers should weigh, because it is
the reason this issue is worth filing rather than living with:
**the workaround is a deny-by-default transcription that goes
stale silently in the safe direction only by luck.** A name cel-js
adds in a future release is refused because it is absent from a
hand-written table, which is right — but the embedder has no way
to be told the surface moved, short of a test that enumerates
`getDefinitions()` and compares. Which is issue 3.

## Suggested shape

```js
new Environment({ stdlib: "minimal" });   // or
new Environment({ extensions: [] });
```
