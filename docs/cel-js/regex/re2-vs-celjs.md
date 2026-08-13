# RE2 versus cel-js `matches()`, construct by construct

cel-go's `matches()` is RE2. cel-js's is a JavaScript `RegExp`.
They share a syntax and are different languages.

Measured against **OpenFGA v1.18.2** in the compose container and
**`@marcbachmann/cel-js` 8.0.0**. The OpenFGA column is the
outcome of `WriteAuthorizationModel` for a model whose only
condition is `s.matches(<pattern>)`; upstream compiles every
condition while validating the model, so an RE2 syntax error is a
refused model rather than a failed check. The cel-js column is
`new RegExp(<pattern>)`.

The three groups are separated because a fork must fix each a
different way.

## Group 1 — RE2 rejects, JavaScript accepts

**Direction: granting.** tsfga would answer on a model OpenFGA
will not store at all. This is the group a consumer cannot detect.

| pattern | OpenFGA | cel-js |
|---|---|---|
| `(?=a)` lookahead | refused | accepted |
| `(?!a)` negative lookahead | refused | accepted |
| `(?<=a)` lookbehind | refused | accepted |
| `(?<!a)` negative lookbehind | refused | accepted |
| `(a)\1` backreference | refused | accepted |
| `(?<n>a)\k<n>` named backreference | refused | accepted |
| `\y` | refused | accepted |
| `\Z` | refused | accepted |
| `\cA` control escape | refused | accepted |
| `[\b]` backspace class | refused | accepted |
| `[^]` | refused | accepted |
| `[a-\w]` class-range to a class | refused | accepted |
| `^[^]*$` | refused | accepted |
| `a{1001}` repetition past RE2's limit | refused | accepted |

RE2 has no backtracking, so it has no lookaround and no
backreferences by construction — they are not omissions, they are
what buys the linear time guarantee. `a{1001}` is refused because
RE2 bounds repetition counts to keep the compiled program finite.

`^[^]*$` is the row that decided the whole question. See
[`bypass.md`](./bypass.md).

## Group 2 — both accept, the readings differ

**Direction: silent.** Both engines store the model, both answer
the check, and the answers differ with no error anywhere. In every
measured case the JavaScript reading was the wider one or the
empty one — usually the empty one, so the symptom is access
quietly disappearing.

| pattern | RE2 reads | JavaScript reads |
|---|---|---|
| `[[:alnum:]]` | the POSIX alphanumeric class | a character class of the seven literal characters `[ : a l n u m` |
| `[[:alpha:]]` and the whole POSIX family | the named class | the same literal-character reading |
| `\A` | start of text | the literal `A` |
| `\Q…\E` | a quoted literal span | `Q`, the span, `E` — with the span's metacharacters still live |
| `\s` | `[\t\n\f\r ]` | `[\t\n\v\f\r   …﻿]`, which includes Unicode spaces RE2's `\s` excludes |
| `\p{L}`, `\pL` | the Unicode letter category | a syntax error without the `u` flag; with it, the category |

Measured, so the shape is concrete: `[[:alnum:]]+` tested against
`"abc123"` is **false** in JavaScript and true in RE2, while the
same pattern against the literal string `"[:alnum:]"` is **true**
in JavaScript and false in RE2. An email allow-list written with a
POSIX class therefore stops matching every address it was written
to admit, and starts matching a string nobody would send.

## Group 3 — RE2 accepts, JavaScript rejects

**Direction: refusing.** `new RegExp` throws, so tsfga cannot
answer at all where upstream answers.

| pattern | OpenFGA | cel-js |
|---|---|---|
| `(?i)abc` and the leading inline-flag family | accepted | `SyntaxError: Invalid regular expression: unrecognized` |
| `(?P<n>a)` Python-style named group | accepted | `SyntaxError: Invalid regular expression: unrecognized` |

## What a fork has to do

Group 3 is the easy group: a syntax translation closes it, and the
retired translator in [`../retired/`](../retired/) did exactly
that. Group 1 needs the engine to *reject* what JavaScript accepts,
which a translator can do but only for a pattern it can see —
never for one arriving through condition context. Group 2 needs
the engine to *read* patterns as RE2 does, which is not a
translation problem at all.

So restoring `matches()` needs a cel-js whose `matches` is RE2.
That is the fork this directory exists to feed. After it, tsfga
needs one table entry back in `CEL_GO_MEMBER_CALLS` and nothing
else.
