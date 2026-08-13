# `^[^]*$` — the row that decided it

Readable on its own in under a minute. This is the shortest
complete argument for why regex was removed rather than repaired.

## The pattern

```cel
user_email.matches('^[^]*$')
```

An author writes `[^]` meaning "a negated class" and expects it to
admit a narrow set — that is what a `^` inside a class does
everywhere else. In an authorization condition, they have written
a whitelist.

## What each engine does with it

**RE2 calls it a syntax error.** A negated character class with no
members is not a valid class, so the pattern does not compile.
OpenFGA compiles every condition while it validates the model
write, so `WriteAuthorizationModel` **refuses the model**. The
author finds out immediately, at the moment they try to create the
rule. Measured against v1.18.2: refused.

**JavaScript reads it as *any character, including newline*.**
`[^]` is the idiomatic JavaScript spelling of "match anything" —
it is what people write before `/s` is available. So `^[^]*$`
matches every possible input. Measured: `true` for
`"anything at all"`, `true` for `"a\nb"`, `true` for `""`.

## Why it is the worst shape available

The condition was written to narrow access and it admits
everything. Nothing errors. Nothing logs. The check answers
`true`, which is what the caller asked for and what a passing test
would assert. The only way to notice is to read the pattern and
know that two engines read it differently.

And it is granting on the side where OpenFGA does not merely
disagree — upstream **will not store the model**. So there is no
version of this where the two systems can be compared in
production, because only one of them has the rule.

## Why a deny-list was authorised, and then abandoned

A write-time scanner refusing every pattern RE2 rejects closes
this row. It was authorised on the strength of this row alone.

It was abandoned because it closes only [group
1](./re2-vs-celjs.md) of three. Group 2 — `[[:alnum:]]`, `\A`,
`\Q`, `\s` — is patterns RE2 *accepts*, so a deny-list built from
RE2's grammar passes them through, and they are the silent-denial
family. A pattern arriving through condition context, as
`actions`'s fixture does, cannot be scanned at all without
re-introducing the source splicer. And [catastrophic
backtracking](./backtracking.md) is untouched by any of it.

Each measurement pass moved the count of what a deny-list would
and would not catch. Removing `matches()` removed the class.
