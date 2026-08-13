# Changelog

Notable changes to `@tsfga/core`. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions
follow [Semantic Versioning](https://semver.org/) (pre-1.0: minor
releases may contain breaking changes).

## Unreleased

### Added

- **BREAKING: `TupleStore` declares an `idDomain`.** A required
  property saying which ids the store is able to hold, with
  `OPAQUE_IDS` and `CANONICAL_UUID_IDS` exported beside the
  `IdDomain` type. OpenFGA admits any non-empty id with no control
  character and no `#`, `:` or space; a store keeping its ids in a
  `uuid` column holds far fewer, and until now the only place that
  showed up was a driver error from three layers down.

  For a TypeScript adapter this is one line —
  `readonly idDomain = OPAQUE_IDS;` — and it is the same
  behaviour as before. It is a harder break than the branded write
  parameters beside it: a missing required property is not
  bivariant, so a third-party adapter genuinely fails to compile
  rather than merely losing a guarantee. A **JavaScript** consumer
  gets no signal at build time; its first sign is a runtime
  `IdDomainError` reading `store declares no id domain`, once the
  request gate lands.

  `IdDomainError` is exported, extends `TsfgaError`, and carries
  `position`, `type`, `id`, `domain` and `detail`.

- **An id outside the store's domain is refused at the request
  boundary**, before any store read, on `check`, `checkMany`,
  `listObjects`, `listSubjects`, `addTuple`, `removeTuple` and
  contextual tuples. The read paths **raise rather than answering
  `false`** — upstream returns HTTP 400 for every id it cannot
  represent and never answers `false`, and a silent deny is
  indistinguishable from a real one.

  Nothing changes for a store declaring `OPAQUE_IDS`, which is
  every store in this repository at this release.

  `IdDomainError.ruleId` is `ID-DOMAIN-OUT-OF-DOMAIN`, the second
  entry in `CAPABILITY_RULE_IDS` and in
  `capability-refusals.json`. It is a **capability refusal, not a
  parity claim**: every id it refuses is one OpenFGA accepts.

  **Precedence.** The domain rule runs behind every upstream rule
  about the request's own strings and ahead of the first rule
  about the model. A malformed id keeps reporting the upstream
  rule that refuses it — `doc:*` reports the typed wildcard, a
  subject holding `#` reports the malformed subject — because a
  caller should hear the refusal that is portable rather than the
  one that is local to a deployment.

  `validateIdDomain` and `validateSubjectIdDomain` are exported
  for a store author reimplementing a gate.

  `@tsfga/kysely` declares the narrow domain; see its changelog
  for what that costs a consumer of that adapter. A store
  declaring `OPAQUE_IDS` is unaffected.

- **`writeRelationConfig` refuses a rewrite cycle**, with
  `InvalidRelationConfigError` and cause `"rewrite cycle"`.
  `viewer: editor` beside `editor: viewer` was stored and is now
  refused, as OpenFGA refuses it. Nothing was granted by such a
  model — every check under it resolved `false` — so this widens
  the write gate rather than changing an answer. Rewrites on the
  same object type only; direct assignment and tuple-to-userset
  are not followed, because upstream's walk stops at both.

- **`TsfgaError.ruleId`.** Every write- and config-gate refusal
  names the rule that raised it. `UPSTREAM_RULE_IDS` and
  `CAPABILITY_RULE_IDS` are exported alongside the `WriteRuleId`,
  `UpstreamRuleId` and `CapabilityRuleId` types. Additive: the
  field is `null` on every error that is not a write refusal, and
  no constructor signature loses an argument.

- **The write-gate cause inventory.**
  `packages/core/write-gate-causes.json` enumerates every refusal
  OpenFGA v1.18.2 constructs in the seven Go files carrying its
  write- and model-write refusal vocabulary — 98 causes over 107
  construction sites — and disposes of each. `bun run
  check:write-gate-causes` re-derives it from the pinned checkout
  and fails on any difference, on an unattributed construction
  site, or on a reference that no longer resolves.
  `packages/core/capability-refusals.json` is the second list:
  refusals tsfga makes that upstream does not, each with the pin
  that fails if the divergence disappears. Neither file ships in
  the package.

### Changed

- **BREAKING: `removeTuple` returns `Promise<void>` and throws.**
  It threw nothing and answered `false` both for a malformed
  delete and for a row that was not there; OpenFGA refuses the
  first with a validation error and the second with
  `write_failed_due_to_invalid_input`, and has no word for the
  boolean tsfga was returning.

  **What breaks:** any caller reading the return value. `if (await
  fga.removeTuple(key))` no longer compiles, and a caller that
  deleted speculatively now has to catch:

  ```ts
  try {
    await fga.removeTuple(key);
  } catch (error) {
    if (!(error instanceof MissingTupleError)) throw error;
  }
  ```

  `TupleStore.deleteTuple` is unchanged and still returns
  `Promise<boolean>`: that boolean is how the client learns
  whether to throw, exactly as `insertTuple`'s feeds
  `DuplicateTupleError`. A store author has nothing to do.

  The syntactic gate that lands with it is upstream's delete
  validation, which is **not** its write validation: no relation
  config is read, so an undefined relation or type falls through
  to `MissingTupleError` rather than being refused. That is what
  keeps a model change recoverable.

### Added

- **`GatedTuple` and `GatedRelationConfig`.**
  `TupleStore.insertTuple` and `TupleStore.upsertRelationConfig`
  now take a branded argument, minted inside `@tsfga/core` only
  after the write validation has run, so a caller holding an
  exported store cannot write past `addTuple` and
  `writeRelationConfig`. Both types are exported; the mints are
  not. An adapter updates its two method signatures and is
  otherwise unaffected — brands erase at emit. The bivariance
  limit is documented rather than papered over: a store declaring
  the unbranded parameter still satisfies the interface.

- **`MissingTupleError`**, the twin of `DuplicateTupleError`,
  carrying the same fields and named for upstream's `on_missing`
  as that one is named for `on_duplicate`.

### Removed

- **BREAKING: `matches()` is no longer supported.** A condition
  whose expression calls it — in either the receiver spelling
  `s.matches(p)` or the global `matches(s, p)` — is refused at
  `writeConditionDefinition` with `ConditionCompileError:
  undeclared reference to 'matches'`. OpenFGA supports it, so this
  is a large, permanent, refusing-direction divergence: a model
  ported from OpenFGA whose conditions use `matches` will not
  load.

  **What breaks:** any stored condition definition using
  `matches`. Rewriting is usually mechanical — `startsWith`,
  `endsWith`, `contains`, `size` and `in` are all supported and
  behave identically on both engines, and nine of the ten fixtures
  in this repository's own corpus rewrote with no expected result
  changing. `packages/core/README.md` carries the substitution
  table.

  **Why, in the granting direction first**, because that is the
  half a consumer cannot detect: cel-go's `matches` is RE2 and
  cel-js's is a JavaScript `RegExp`, and fourteen measured
  constructs are ones RE2 rejects and JavaScript accepts. The
  sharpest is `^[^]*$` — a syntax error in RE2, so OpenFGA will not
  store the model, and *any character including newline* in
  JavaScript, so a pattern its author wrote as a whitelist admitted
  every possible input. Seven more are accepted by both and read
  differently, usually denying silently: `[[:alnum:]]` is a POSIX
  class in RE2 and seven literal characters in JavaScript. And
  `^(a+)+$` runs 20.9 seconds against a 32-character subject on V8,
  with no bound above that.

  A pattern translator shipped previously and a write-time
  deny-list was considered. Each closed part of that and left the
  rest. `docs/cel-js/` carries every measurement, the retired
  suites, and what a future cel-js fork would have to fix.

- **BREAKING: the CEL compatibility layer is retired.** Every
  overload `conditions.ts` registered on the evaluating
  environment is deleted, with the RE2 pattern translator and the
  AST source-splicer that routed calls onto them — about 1500
  lines. tsfga's condition dialect is now exactly
  `@marcbachmann/cel-js`'s, and `CLAUDE.md`'s *CEL is bounded by
  cel-js* says why it stays that way. Nothing is registered on the
  evaluating environment any more.

  **Read the granting direction first**, because it is the half a
  consumer cannot detect. Four conversions that used to be
  range-checked here are not any more, and cel-js does not check
  them: `int(x)` on `±1e19` and `double(s)` on `"±1e400"` now
  answer `true` where OpenFGA refuses the check with `integer
  overflow` / `type conversion error`. If a condition of yours
  guards on a magnitude near the int64 or float64 bounds, it is
  now a grant rather than an error.

  **What stops answering**, which is the loud half. Five overloads
  cel-go declares and cel-js does not were supplied here and are
  gone: `int(uint)`, `int(duration)`, `int(timestamp)`,
  `string(duration)` and `string(timestamp)`. The definition still
  *writes* — refusing it would refuse a model upstream accepts —
  and every check that evaluates the call raises
  `ConditionEvaluationError`. They short-circuit like any cel-js
  expression, so `int(d) > 3600 || role == 'admin'` still answers.

  **One divergence closes in tsfga's favour:** `double('1e-400')`
  underflows to zero in Go and upstream answers `true`. The
  deleted overload classed a string landing on zero as a range
  error and refused it, so the comment in the source asserting
  upstream reports a range error there was wrong against the live
  container. Both engines answer `true` now.

  **One new granting cell is created rather than removed**, and it
  is a write-moment one. The kept write-time type gate was
  calibrated against the splicer's output; reading the author's
  own spelling instead, it would have refused all five overloads
  above *at write* — more refusing than bare cel-js, the dialect
  this retreats to, and refusing models OpenFGA stores. So a
  verdict of the form `found no matching overload for 'f(T)'` is
  now no verdict. cel-js reports a call **neither** engine
  overloads the same way, so `int(b)` on a `bool`, `duration(i)`
  on an `int` and `b.size()` on a `bool` are definitions tsfga
  stores and OpenFGA refuses the model for. The check refuses on
  both sides, so nothing grants on one. Operator verdicts
  (`no such overload: int != string`) and undeclared references
  are unaffected, which is where all three cells the gate exists
  to close live.

  Every row above is pinned two-sided in `tests/conformance/`, and
  `packages/core/README.md` now has exactly one CEL section
  carrying the whole table.

### Changed

- **BREAKING: `TupleStore.insertTuple` returns `Promise<boolean>`
  and no longer upserts.** It inserts and reports: `true` when a
  row was written, `false` when the natural key already existed,
  and on `false` nothing may be written. Every custom store must
  change; a store that can only upsert cannot implement upstream's
  default.

  The natural key is upstream's `TupleKeyWithoutCondition` — the
  condition is not part of it. Two writes of one edge differing
  only in their condition were one row being edited in place,
  silently, and in the widening direction (dropping a condition
  turns a time-boxed grant permanent) as readily as the narrowing
  one.

- **BREAKING: `addTuple` throws `DuplicateTupleError`** for an
  edge that already exists, including one re-granted under a
  different condition — upstream's `on_duplicate` default of
  `"error"`. The way to change a grant's condition is
  `removeTuple` then `addTuple`. Upstream's `on_duplicate:
  "ignore"` opt-in is not offered; a caller wanting the old
  behaviour catches the error and ignores it.

- **BREAKING: `CheckRequest` and `ListObjectsRequest` carry
  `subjectRelation`.** The field is additive to the types but
  behaviourally breaking for a caller who was packing the ref into
  `subjectId`: `subjectId: "eng#member"` used to resolve quietly
  to `false` and now raises `InvalidSubjectTypeError` with
  `cause: "malformed subject"`. A `subjectRelation` the subject's
  type does not define raises `RelationConfigNotFoundError` where
  it used to answer `false`, and a `subjectType` the model does
  not define raises `InvalidSubjectTypeError` with
  `cause: "undefined subject type"`. They are two separate
  refusals, and the type is checked first: upstream's
  `ValidateUser` reports the `user` field's type before it
  resolves a userset's relation.

- **A relation the subject's type cannot reach is denied, not
  walked.** Before resolving a node's rewrite, tsfga asks whether
  a subject of that type could hold the relation at all — the same
  `PathExists` question upstream asks at every node. Three shapes
  answered wrongly before: an unreachable chain whose row carries
  an unevaluable condition refused instead of denying, the same
  chain past the depth budget threw instead of denying, and an
  unreachable cyclic subtree on the subtract side of a `but not`
  denied where upstream grants.

- **Each `tupleToUserset` entry resolves as its own union
  branch.** One arm whose tupleset rows carry an unevaluable
  condition no longer sinks a sibling arm that grants.

- **`listObjects` gates the target relation up front.** An
  undefined relation raises `RelationConfigNotFoundError` before
  the candidate pool is read, rather than depending on whether any
  row happens to name an object of that type. Contextual tuples
  are still validated first, as upstream orders the two gates.

- **`listObjects` drops a depth-exceeded candidate** instead of
  failing the whole call, and answers with the objects that
  qualify. `check` still raises `DepthExceededError` in every
  position. Upstream's stated policy is to abort, but its boundary
  sits far enough out that it almost never reaches its own abort,
  so this is closer to upstream on every shape upstream can
  answer.

- **`listObjects` also drops a `ConditionEvaluationError` raised
  on a read that does not name the request subject.** The reads
  that do name it — the direct row and the `subjectType:*`
  wildcard row — are the ones upstream's reverse expansion always
  issues, so an error there refuses on both engines and still
  aborts. Every other read sits behind a hop upstream may never
  materialise, and tsfga checks each candidate forward and cannot
  know, so the candidate counts as `false`. The residue is
  under-reporting: where upstream's expansion does reach such a
  row it refuses the whole call and tsfga returns the partial
  list. Every other error still aborts the call in candidate
  order.

- **`listObjects` returns at most `listObjectsMaxResults`
  objects** (new on `CheckOptions`, default **1000**, matching
  `OPENFGA_LIST_OBJECTS_MAX_RESULTS`; `Infinity` opts out). The
  truncation is **silent** on both engines — `ListObjects` has no
  cursor and no field saying the answer was cut. Which objects
  survive the cap differs: upstream keeps what its pool finished
  first, tsfga keeps the first granting candidates in candidate
  order, so counts are comparable and membership is not. Reaching
  the cap also stops the producers, so a candidate past it is
  never resolved and can never raise — a call that answers is not
  evidence that every object of the type is resolvable.

- **`writeRelationConfig` refuses four model shapes OpenFGA's
  typesystem rejects**: a tupleset relation that is not a direct
  relation, type restrictions on a relation admitting no direct
  assignment, a relation that admits nothing and rewrites nothing,
  and the closed self-cycle form of a relation with no entrypoint.
  Each raises `InvalidRelationConfigError` with a discriminating
  `cause`. A config carrying one of these was already inert at
  check time; the refusal moves the report to the write, where it
  names the mistake.

- **New write-time condition refusals**
  (`InvalidConditionalTupleError`): a Unicode control character in
  a context key, in a string value at any depth, or in the
  condition name (`context contains forbidden characters`), and a
  condition context over 32 KiB (`context size limit exceeded`).
  The size rule is upstream's; the measure is not — upstream sizes
  a serialised protobuf `Struct` and tsfga sizes the context's
  JSON, so the two agree except within a narrow band of the
  boundary. It applies to `addTuple` only, as upstream applies it.

- **A `uint` parameter is carried as CEL's `uint`**, so its
  arithmetic is bounded by uint64 rather than int64 and
  `type(n) == uint` holds.

Both of the last two condition changes can turn a
previously-answered check into a refusal or flip a boolean — that
is the point, they are the cells where tsfga disagreed with
OpenFGA — but a consumer relying on the old answers will see it.

### Added

- **`maxConditionEvaluationCost` on `CheckOptions`**, defaulting
  to **100** — OpenFGA's default check evaluation cost. A
  condition whose estimated cost exceeds it raises
  `ConditionEvaluationError`, whose `cause` reads `evaluation cost
  limit exceeded: estimated N against a limit of M`, and
  `Infinity` opts out. cel-js has no
  runtime metering of any kind, so the cost is estimated from the
  AST and the coerced context before evaluation, which is why a
  refusal costs nothing to reach.

  The estimate is an approximation of cel-go's and does not agree
  with it cell for cell. Where the two disagree tsfga charges the
  larger figure, so the residue is in the refusing direction: a
  check upstream answers may be refused here, and one upstream
  refuses is never granted here on cost alone. Comprehensions
  are charged per iteration at the cost of the nodes cel-go's
  desugaring evaluates — 3 for `all`, 4 for `exists`, 2 for
  `exists_one`, 12 for `map` and 13 for `filter`, the last two
  because each pass builds a one-element list — plus a result
  charge of 1, or 2 for `exists_one`. Measured against v1.18.2,
  `exists`, `all`, `map` and `filter` refuse at exactly upstream's
  element count; `exists_one` refuses earlier, which is a pinned
  divergence in the refusing direction.

  This is a new class of refusal on the check path: an expression
  and a context that both used to answer can now raise. That is
  deliberate — the expression is fixed at model time and the
  request decides what it costs, so without the limit a caller
  chooses how much work the authorization path does.

- `DuplicateTupleError`, raised by `addTuple` alone.
- `writeContextByteLimit` on `CheckOptions`, with
  `DEFAULT_WRITE_CONTEXT_BYTE_LIMIT` (32768) exported beside it.
- `TupleWriteValidationOptions`, the optional third parameter of
  the already-exported `validateTupleWrite`. Omitting it does not
  measure the context at all, which is what the contextual path
  wants.
- `InvalidSubjectTypeError.cause`, optional and either
  `"malformed subject"` or `"undefined subject type"` where set.
  It is `undefined` for every other refusal — including the
  ordinary "this relation does not admit that subject" one — so
  existing messages are unchanged.

### Documentation

- **`packages/core/README.md` has exactly one CEL section.** Four
  scattered ones — "Write-time condition validation", "`uint`
  (closed)", "Known divergence: unchecked CEL operators" and
  "Known divergence: sub-millisecond timestamps" — are folded into
  `## Conditions`, which opens with `matches()` being unsupported
  and what to write instead, and carries the whole measured
  divergence table grouped by direction with granting first. The
  paragraph claiming compilation is parse-only is deleted: it had
  been stale since the write-time type gate landed.
- **The `uint` divergence is closed and its section rewritten.**
  The representation trade it described was taken: both its cells
  now agree.
- **The claim that integer overflow agrees was false and is
  corrected.** cel-js range-checks binary `+`, `-` and `*` on ints
  and `-` on uints, and nothing else; every operation upstream
  checks and cel-js does not is now pinned two-sided, together
  with the UTF-16 string-ordering cell.
- The depth-boundary divergence gains its `listObjects`
  amplification, and `listObjects` past the budget is documented
  as a divergence of its own.
- Two model-gate rules — a rewrite naming an undefined relation,
  and a tuple-to-userset whose computed relation no tupleset type
  defines — are documented as **open**, beside the existing
  write-order gap. Neither can be decided from one config: run
  warn-only over the whole conformance corpus, they fire on 43
  writes that are ordinary models written in definition order
  rather than dependency order. Both belong to a validator that
  sees the whole model at once.

## 0.6.0 — 2026-08

### Documentation

- **The depth boundary is documented as a divergence, not parity.**
  The README claimed both systems exhaust resolution at the same
  model depth. They do not: at the same numeric limit tsfga
  exhausts one dispatch earlier on most shapes, because upstream
  resolves the terminal hop in place rather than dispatching for
  it. The direction is conservative — tsfga refuses where OpenFGA
  answers — but the claim shipped and was false.

  The budget is deliberately **not** raised. The offset is not
  uniform: on a chain whose leaf relation is not weight 1,
  upstream declines its own resolver and the two agree exactly, so
  a uniform `+1` would grant where upstream returns
  `authorization_model_resolution_too_complex`. Both rows are
  pinned two-sided, so the gap cannot widen or close unnoticed.

- **`maxBreadth`'s doc comments no longer contradict the README.**
  `CheckOptions` and `check` both said bounding breadth never
  changes the boolean result; the README spends a section on the
  one shape where it does — a cycle reaching an intersection
  operand. The comments ship in the `.d.ts`, so the wrong half was
  the published one.


### Added

- **`admitsSubjectRef` and `directSubjectRef` are exported.** A
  consumer narrowing their own query can apply the gate tsfga
  applies instead of reimplementing it and drifting out of step.

  Both take a `RelationConfig`, never `null`: a missing config is
  the caller's to handle, because in a consumer's `WHERE` clause
  it usually means a misspelled relation name, and the permissive
  answer these once gave for `null` admitted everything. One
  hazard is documented rather than designed away: the predicate
  filters tuple *shapes* only, knowing nothing of `excludedBy` or
  `intersection`, so a row it admits is one `check` will consider,
  not one `check` will allow.

### Changed

- **The compiled-expression cache holds at most 1000 entries**,
  evicting the least recently used. It is process-wide and keyed
  by expression source text, so nothing about a caller's lifetime
  released it: writing many condition definitions — or rewriting
  one repeatedly, since every new source text is a new key — grew
  it without limit. A model of ordinary size never reaches the
  bound, and re-inserting on a hit keeps a hot expression from
  being evicted by a burst of cold ones.

- **A relation with no config is refused, not unrestricted.**
  `check` read a missing relation config as "nothing to restrict
  against" and narrowed nothing, so a row already in the store on
  such a relation granted. OpenFGA answers HTTP 400
  `validation_error`, `invalid relation: relation 'doc#reviewer'
  not found`, and answers it before reading anything. `check`,
  `checkMany`, `listObjects` and `listSubjects` now all raise
  `RelationConfigNotFoundError`, which `addTuple` already did —
  which is why this went unnoticed, since the write path could not
  create the state that exposes it. A row outliving its config
  can: a deleted config, an out-of-band writer, a half-applied
  fixture.

  **Breaking, and wider than the check path on purpose.** Fixing
  `check` alone would have left the library raising on one path
  and silently admitting on another, which is worse than either
  answer:

  - `admitsSubjectRef` and `admitsSubjectShape` take a
    `RelationConfig` rather than `RelationConfig | null`. They
    answered `true` for `null`, so the misspelled relation name in
    a consumer's `WHERE` clause quietly admitted everything; it is
    now a `null` the compiler makes you handle.
  - `listSubjects` raises instead of reporting every stored row.
  - `CheckTuplesQuery`'s three ref fields stay nullable, but core
    no longer sends `null` in them: every query it builds carries
    the relation's own restrictions. `null` remains what a wrapper
    says when it declines to narrow a query it forwards.

  One place a missing relation deliberately does **not** raise: a
  tuple-to-userset whose computed relation is undefined on the
  linked object's type. Upstream accepts such a model when at
  least one of the tupleset's admitted types defines the relation
  (`isUsersetRewriteValid`) and then skips the rows whose type
  does not (`produceTTUDispatches`), so `parent: [folder, org]`
  with `viewer from parent` answers `false` for an `org` parent
  rather than refusing. Raising there would have traded a
  fail-open for a fail-closed.

- **`ConditionParameterType` carries a container's element type.**
  `"list"` and `"map"` are no longer spellings; a container
  parameter is declared `"list<string>"` or `"map<int>"`, matching
  the model, and every element is coerced as that type. Without it
  nothing read the elements: `list<string>` given `[1]` was
  accepted here and refused upstream, and a `list<int>` reached
  CEL as doubles, so `n[0] + 1` found no overload.

  The scalar half is exported as `ConditionParameterScalarType`.

  **Breaking.** A condition declaring `"list"` or `"map"` no
  longer type-checks, and `KyselyTupleStore` rejects a stored row
  spelling it that way as invalid data. Rewrite it as the
  model spells it.

- **A condition that cannot be evaluated no longer abandons its
  siblings.** A tupleset row or userset row whose condition threw
  ended the whole branch with that error, whatever the rows beside
  it said. OpenFGA reads such a set through one filtered iterator,
  which stashes the first error and raises it at the end **only if
  no row's condition evaluated true**.

  So a granting sibling rescues the branch, and so does a sibling
  whose condition held but whose subtree denied — that one is the
  case tsfga got wrong most visibly, answering an error where
  upstream answers `false`. A sibling whose condition evaluated
  *false* does **not** rescue it: the predicate is "some condition
  was satisfied", not "some row was admitted", and the looser
  reading would answer `false` where upstream refuses to answer.

  The decision is per read, not per node. A userset row whose
  condition held does not rescue a broken *direct* row on the same
  relation, and two tuple-to-userset entries on one relation keep
  two decisions — measured both ways against v1.18.2.

- **BREAKING: `writeConditionDefinition` compiles the
  expression.** It was infallible; it now throws the new
  `ConditionCompileError` when the expression does not parse.
  OpenFGA compiles every condition while validating the model
  write that carries it, so such an expression never reaches a
  check upstream. Here it was accepted three times over — the
  definition write, every tuple write beneath it, and every check
  until someone ran one.

  The deferred failure was also raised as cel-js's own
  `ParseError`, which is not a `TsfgaError`, because `parse` sat
  outside the `try` that wraps evaluation. It is inside now, so
  the condition path raises only `TsfgaError`. That claim is
  scoped to the condition path: the Kysely adapter still surfaces
  the driver's own error for a malformed id, which is a separate
  gap and not addressed here.

  Compilation is parse-only. Upstream additionally type-checks
  the expression against its declared parameters, so
  `not_a_function(x)` is refused there and accepted here, failing
  at evaluation instead. Documented in the README and pinned
  two-sided.

- **BREAKING: `listObjects` takes a request object and accepts
  contextual tuples.** `CheckRequest` has carried
  `contextualTuples` and both `check` and `checkMany` honour them,
  but `listObjects` took flat positional arguments with nowhere to
  put them, while upstream's `ListObjectsRequest` has
  `contextual_tuples`. The published API could not express what
  the operation it mirrors supports.

  ```diff
  - fga.listObjects("doc", "viewer", "user", "alice", context)
  + fga.listObjects({ objectType: "doc", relation: "viewer",
  +                   subjectType: "user", subjectId: "alice",
  +                   context, contextualTuples })
  ```

  The flat form was an accidental design rather than a considered
  one, so it is replaced rather than kept alive behind an
  overload. The exported `ListObjectsRequest` type is new.

  Contextual tuples apply once to the whole call, not once per
  candidate, so the shared node memo that makes `listObjects`
  cheaper than N checks survives them. They are validated exactly
  as `addTuple` validates a write, before any candidate is
  checked. `ContextualTupleStore.listCandidateObjectIds` now
  unions in the objects they name: the pool is a pre-filter, and
  an object no stored tuple mentions is still an answer if a
  contextual tuple puts the subject on it — upstream returns it,
  and passing the pool through unchanged left it out with no
  error.

- **BREAKING: `writeRelationConfig` and `addTuple` refuse shapes
  OpenFGA rejects.** `writeRelationConfig` was infallible; it now
  throws the new `InvalidRelationConfigError`, whose `cause` is
  one of `intersection has fewer than two operands`, `undefined
  condition`, `tupleset relation admits a userset` or `tupleset
  relation admits a wildcard`. All four are an
  `invalid_authorization_model` upstream, measured on v1.18.2.

  Two were fail-open. A single-operand `intersection` resolved to
  whatever that one operand said, so a config that means nothing
  granted. A tupleset relation admitting a userset had its subject
  relation **discarded** on dispatch, landing on a different
  relation of the linked object and granting.

  **Stated gap.** The two tupleset rules are properties of a
  different relation than the one being written, so they are
  checked only when that relation's config already exists. A
  tuple-to-userset declared before its tupleset relation is not
  validated, and neither is a later widening of that relation.
  Closing either needs a reverse lookup `TupleStore` has not got;
  a validator that fired on write order would refuse correct
  models for arriving in an order nothing documents. Conditions
  have no such gap, but must be defined before the configs naming
  them.

  `addTuple` throws the new `ImplicitTupleError` for a tuple that
  says only what the model already says
  (`doc:1#blocked@doc:1#blocked`), which upstream refuses as
  "implicit". **On the write path only**: the same tuple supplied
  as a contextual tuple is accepted upstream and answered over, so
  the gate is deliberately not in the validation `addTuple` and
  contextual tuples share. Putting it there — as an earlier
  reading proposed — would have refused a tuple OpenFGA takes.

  `isSelfDefining` and `validateRelationConfigWrite` are exported
  for store authors applying the same gates.

- **`InvalidConditionalTupleError` no longer names what the
  relation admits either.** It kept rendering the allow-list into
  its message after its sibling stopped, which left the same
  disclosure on the same write path — and it is the *more* likely
  of the two to be returned, since condition mistakes are the
  ordinary case. The list moves onto the error as `allowed`,
  alongside new `subject`, `objectType` and `relation` fields.
  **Breaking** if you matched on the message text.

- **`InvalidSubjectTypeError` no longer names what the relation
  admits.** Its message rendered the relation's whole type
  restriction list — every admitted type, every userset relation
  and, since this release made the fourth constructor argument
  `TypeRestriction[]`, every condition name. `addTuple`'s errors
  are the ones a service is most likely to return to whoever
  attempted the write, so that list was a description of the
  authorization model disclosed to anyone who could attempt one.
  OpenFGA names only the offending type.

  The message now names the subject and the relation. The list
  moves onto the error as `allowed`, alongside new `subject`,
  `objectType` and `relation` fields — the constructor previously
  rendered all four arguments and assigned none, so dropping the
  rendering without adding the fields would have lost them.

  This also removes an instability: the list rendered in
  `directlyAssignable` order, i.e. whatever the JSON column held,
  so the message changed when a config was rewritten with the same
  restrictions in a different order.

  **BREAKING** twice over: the fourth constructor argument is a
  `TypeRestriction[]` rather than a `string[]`, and the message
  text changed. Nothing in this repo matched on the text; every
  assertion on this class is an `instanceof`.

- **BREAKING: `RelationConfig.directlyAssignableTypes` and
  `.allowsUsersetSubjects` are replaced by one required
  `directlyAssignable: TypeRestriction[]`**, matching OpenFGA's
  `directly_related_user_types` one for one. Each entry mirrors
  a `RelationReference` field for field:

  ```ts
  { type: "user" }                                  // user
  { type: "user", wildcard: true }                  // user:*
  { type: "team", relation: "member" }              // team#member
  { type: "user", condition: "weekday_only" }       // user with weekday_only
  ```

  Structured rather than a `"user with weekday_only"` string
  because every consumer needs a different projection: the read
  gate is condition-blind, the clamp is exact, and the Kysely
  adapter wants `type` and `relation` as separate columns. A
  joined string would be re-parsed at each, and
  `CachingTupleStore` already refuses one on that ground.

  This also retires an overloaded `null`, which meant both
  *unrestricted* and *purely computed*. `[]` now says "admits no
  direct assignment" precisely, so a purely computed relation
  issues no tuple read at all — which upstream does and tsfga
  previously could not express.

  Migration `005` is unchanged as DDL — the column was and stays
  `jsonb NOT NULL` — but the payload shape changes, so relation
  configs must be rewritten from your authorization model. There
  is no automatic conversion, and a guessed one would err in the
  granting direction. Tuples are untouched.

- **BREAKING: `CheckTuplesQuery`'s three `include*` booleans are
  replaced by `directRefs`, `wildcardRefs` and `usersetRefs`**,
  each `readonly TypeRestriction[] | null` — the restrictions the
  relation admits for that part, so a store can narrow its query
  by type, userset relation and condition rather than only by
  which parts are wanted. For all three, `null` declines to narrow
  and `[]` excludes the part — they are opposites, and a wrapper
  that forwards `null` where it meant "already answered" opens the
  gate rather than closing it.

  Still a hint, not a trust boundary: `clampToQuery` re-clamps
  every reply against the query it sent, so a store that
  over-returns loses rows rather than smuggling them past the
  model.

- **BREAKING: `listSubjects` is now condition-exact.** A row
  carrying a condition the relation does not admit is no longer
  reported, exactly as a row of an unadmitted type is not.

- **`InvalidSubjectTypeError` is condition-blind and raised
  first**; the condition dimension raises the new
  `InvalidConditionalTupleError`, which carries a `cause`
  discriminator. OpenFGA raises one error for all condition
  causes and discriminates by cause string, so tsfga does the
  same. Folding the two together would have produced
  `Subject type 'user with weekday_only' is not allowed`, naming
  a type nobody wrote.

- `TypeRestriction`, `SubjectShape`, `subjectShape`,
  `admitsSubjectShape` and `formatRestriction` are exported.
  `admitsSubjectShape` is the read gate; `admitsSubjectRef`
  remains the exact match used by the clamp and the write path.
  A consumer narrowing a `WHERE` clause wants the first to decide
  what to fetch and the second to filter what it holds.

- **BREAKING: `TupleStore.listDirectSubjects` is removed.** It was
  already a strict subset of `findTuplesByRelation` — the same
  columns off the same predicate, minus the condition fields.
  `listSubjects` reads through `findTuplesByRelation` and
  projects.

- **BREAKING: `UsersetNotAllowedError` is removed.** A userset on
  a relation that admits none is now an `InvalidSubjectTypeError`
  naming the offending ref, which is the single error upstream
  raises for every type-restriction violation.

### Fixed

- **A store row whose `subjectRelation` is absent reads as null.**
  `clampToQuery` tested `=== null`, so an `undefined` failed the
  direct and wildcard slots, passed the userset test on `!== null`
  and was then dropped by the falsy guard in `checkBase`: the same
  store and the same row granted with `null` and denied with
  `undefined`, silently either way. Not reachable through shipped
  code — the field is required, `ContextualTupleStore` normalizes
  it and the Kysely adapter maps a real `NULL` — but `TupleStore`
  is the documented extension point, and a hand-written or
  JavaScript adapter has nothing stopping it.

- **`int` and `uint` context values reach CEL as integers.** They
  were passed to cel-js as JS numbers, which CEL reads as
  `double`. Every arithmetic binary operator — `+ - * / %` —
  raised `no such overload` where OpenFGA answers, and every
  comparison past 2^53 answered the *opposite boolean with no
  error*. Under a `but not`, a wrong `false` on the subtract side
  does not exclude, so it grants. This was the only place tsfga
  was confidently wrong rather than loud.

  The value usually arrives as a string, so it is now parsed
  directly to `bigint`: routing it through `Number()` first loses
  the precision before a `BigInt` could preserve it. The integer
  path takes a strict decimal grammar — `BigInt`'s own string
  grammar accepts `0x10`, `" 42 "` and `""` as readily as
  `Number`'s did. Magnitudes outside int64 saturate to its
  bounds, because upstream converts through `bigFloat.Int64()`
  and answers on the clamped value.

  Overflow parity comes with it: past the int64 ceiling both
  engines now raise an integer overflow.

  Not a regression from 0.5.0's coercion work. CEL `==` is total
  across types, so the precision comparison already answered a
  silent `false` before it; that commit closed a much larger
  class of silent-wrongs and only the ordering and arithmetic
  operators moved from an error to a wrong answer.

  Two `uint` cells remain divergent and are documented in the
  README. The reason stated there is a representation trade, not
  a missing capability: cel-js does expose an `UnsignedInt`
  carrier on its `./evaluator` subpath, and using it makes both
  cells agree — but cel-js has no `int(uint)` overload at all, so
  it would break `int(n) == 7`, which OpenFGA answers. Two exotic
  expressions for one ordinary one, left as a deliberate open
  decision rather than taken silently.

- **Context values are read by OpenFGA's grammar, everywhere it
  differs from JavaScript's.** An exhaustive sweep of the coercion
  surface against v1.18.2 found 39 diverging cells of 70 — 16
  fail-open, 19 fail-closed, 4 answering a different boolean. All
  70 now agree.

  The largest cause was `asNumber` accepting the whole `Number()`
  grammar. Upstream parses every numeric type with
  `big.ParseFloat(value, 10, 64, 0)`, which takes none of the
  prefixed literal forms (`0x10`, `0o10`, `0b10`, `1_000`) and no
  surrounding whitespace, but does take the exponent and
  zero-fraction spellings (`1e3`, `4.0`, `5.`, `.5`, and `1p3`
  with a binary exponent) that a bare-digit grammar refused. It
  reads `Inf`, `+Inf`, `-Inf` and `inf` — and not `Infinity` or
  `NaN`. A `double` additionally refuses any decimal that is not
  exactly a `float64`, so `"0.1"` as a string is an error where
  `0.1` as a number is not.

  Also: a `uint` saturates at **int64**'s ceiling rather than
  uint64's, matching upstream's single `Int64()` conversion; a
  bare `"0"` is a duration; RFC 3339 designators must be
  uppercase, where the lowercase forms used to be read and
  answered on; and fractional seconds past nine digits are read
  rather than refused — cel-js's `timestamp()` declines them by
  string length, so the `Date` is built directly.

  Under an exclusion each of these inverts into a grant, which is
  why they are one item: a value upstream refuses to read at all
  coerced cleanly here, the exclusion did not fire, and access
  followed.

  `coerceValue`'s fallback branch returned the parameter type's
  own **name** in place of the caller's value. It refuses now.

  `ipaddress` and `in_cidr` remain unsupported. cel-js has
  neither, and adding them means moving the compile path onto a
  configured `Environment` with a registered host type — a change
  of architecture rather than of grammar.

- **`addTuple` validates the condition, all five ways OpenFGA
  does.** Type restrictions are enforced twice upstream — on write
  and on read — and only the read half checked the condition, so a
  caller could create a row the model does not admit and get no
  error, then find every check ignoring it. The read gate made
  that safe; it did not make it discoverable.

  Refused, each with its own `cause` on
  `InvalidConditionalTupleError`: *condition is missing*,
  *invalid condition for type restriction*, *undefined condition*,
  *parameter type error*, *invalid context parameter*.

  Two ordering rules are upstream's and were probed rather than
  assumed: an **undefined** condition reports that even when the
  restriction would not have admitted the name either, and a
  context carrying both an ill-typed value and a stray key reports
  the type error.

  **Only the context keys actually present are validated.** A
  conditioned tuple with no context, or a partial one, is
  accepted — the rest can still arrive with the check request, and
  requiring it here would refuse writes OpenFGA takes.

  **Cost: a conditioned write goes from 2 round-trips to 3.**
  `addTuple` validates against the raw store — the request-scoped
  config cache is built inside `check`, so it is not on this path
  — and the third trip is the condition-definition lookup.
  Unconditioned writes are unchanged, since an unconditioned tuple
  needs no definition and no context read. Bulk-loading 10,000
  conditioned tuples goes from 20,000 trips to 30,000.

  A client-lifetime cache was rejected rather than overlooked. A
  validation gate that caches goes stale across processes: another
  instance narrows a restriction and this client keeps accepting
  tuples the model no longer admits, which is the fail-open class
  this whole round exists to close. A cache scoped to one
  `addTuple` would save nothing.

- **A context value is now read as its declared parameter type.**
  An ill-typed value raised nothing and resolved the condition
  `false`, which on the subtract side of an `excludedBy` means the
  exclusion does not fire — so `n: int` given `4.5` **granted**.
  The mirror was fail-closed: `n: int` given `"42"` threw, where
  OpenFGA accepts it.

  ```
  n=42    (declared int)  tsfga true    OpenFGA true
  n=4.5   (declared int)  tsfga false   OpenFGA parameter type error
  n="42"  (declared int)  tsfga throws  OpenFGA true
  ```

  `coerceContext` ports OpenFGA's
  `internal/condition/types/converters.go`, probed case by case
  against v1.18.2. A `typeof` check diverges on six of them: the
  numeric types accept numeric **strings**, because JSON has no
  integer type and upstream parses rather than asserts, while
  `duration` and `timestamp` accept **only** strings. It is
  exported, and shared with the write path so a tuple cannot be
  writable but unevaluable.

  Only the keys actually present are read. A context key the
  condition does not declare is accepted at check time — probed —
  and refused only on write.

- **A tuple-to-userset's tupleset row is now condition-checked.**
  `define parent: [folder with flag]` with
  `define viewer: viewer from parent` means the link exists only
  while `flag` holds. tsfga read the tupleset rows and dispatched
  on every one without evaluating their conditions, so access
  granted through a link the model had switched off. The rows are
  also now gated on the tupleset relation's own type restriction,
  which nothing narrowed before.

  **Two call sites shared the defect** — step 5's plain
  tuple-to-userset and `checkIntersection`'s `tupleToUserset`
  operand — and they now share one `resolveTupleset` helper. The
  second is the more dangerous: an intersection operand satisfied
  through a switched-off link, inside the subtrahend of an
  exclusion, grants rather than denies. A test covering only the
  first passes while it is still live, which is what
  `tests/conformance/tupleset-conditions.test.ts` pins.

- **A type restriction now carries its condition, and the
  condition is matched exactly.** `directlyAssignable` recorded
  `user` for the OpenFGA restriction `[user with weekday_only]`,
  dropping the condition. OpenFGA treats the condition as part of
  the restriction and matches it in both directions — probed
  against v1.18.2:

  | stored row | model admits | OpenFGA |
  |---|---|---|
  | `user:alice`, no condition | `[user with weekday_only]` | `false` |
  | `user:alice` with `weekday_only` | `[user]` | `false` |
  | `user:alice` with `weekday_only` | `[user with other_cond]` | `false` |
  | `team:eng#member` with `weekday_only` | `[team#member]` | `false` |

  The first row is the fail-open one: tsfga admitted it, found no
  `conditionName`, treated that as unconditional access and
  granted — **even where the check context would have satisfied
  the condition it lacked**. The wildcard cases mirror it exactly.

  `tests/conformance/condition-restrictions.test.ts` reproduces
  the whole table against the container. Against the previous
  commit 6 of its 11 cases fail, all of them in the granting
  direction; the other 5 hold before and after.

- **Userset type restrictions are now recorded and enforced.**
  `RelationConfig` kept a type array plus a bare boolean —
  *whether* userset subjects were allowed, never *which*. A
  relation admitting only `team#member` accepted
  `document:budget#viewer@team:eng#owner` through `addTuple`, the
  documented validating write path, and then granted on it.

  Probed against OpenFGA v1.18.2: it refuses that write outright,
  and on a store where the row already exists it answers `false`
  where tsfga answered `true`. A fail-open divergence reachable
  through the ordinary public API, with no raw SQL.

  Both halves are now enforced, on the write path and in the check
  read gate, and both are covered by
  `tests/conformance/userset-restrictions.test.ts`.

- **`listSubjects` applies the relation's type restrictions.** It
  was a bare pass-through to the store, so it reported subjects
  the model does not admit and `check` denies. Narrowing a
  relation does not revalidate the tuples already written, so that
  state is reached by ordinary model evolution.

  The gate is in core, not the adapter, so every `TupleStore` —
  the wrappers, third-party stores — is covered, and adapter
  authors stay outside the security boundary.

  **Consequence:** no library path now *finds* an inadmissible row
  in order to delete it. Upstream keeps `Read` unfiltered for that
  reason; a maintenance read is owed.

  `listObjects` is deliberately unchanged: it re-checks every
  candidate through the gated path, so over-returning candidates
  costs work and cannot grant.

### Documented

- **Sub-millisecond timestamps are a known divergence.** Go's
  `time.Time` is nanosecond-resolution and cel-js maps a CEL
  timestamp onto a JS `Date`, which is millisecond, so finer
  precision is discarded from the context value and from the
  `timestamp('…')` literal alike. Both engines answer and the
  booleans differ in four cells, two of them granting: under an
  equality predicate a truncated value compares equal here and
  unequal upstream.

  Not reachable through `@marcbachmann/cel-js` 8.0.0. A
  nanosecond carrier can be registered as a host type, but the
  built-in `timestamp(string)` overload cannot be displaced and
  the standard library cannot be declined, so the literal side of
  every comparison truncates regardless. Recorded in the README
  beside the other known divergences and pinned two-sided in the
  conformance suite, so a cel-js release that changes the
  resolution is a failing test rather than a silent change of
  answer.

## 0.5.0 — 2026-08

### Added

- **`checkMany(requests)`**, on the client and as a standalone
  export, runs a batch of checks in one resolution scope. The
  relation-config cache and the node memo span the batch, so the
  part of the graph the requests have in common is resolved once
  instead of once per call. A consumer measured a page render
  making four checks about one object at 862 store statements;
  the same work in one scope is 21-31.

  Shape follows OpenFGA's BatchCheck: outcomes are
  `{ allowed, error? }`, a failing check reports its error in its
  own outcome rather than failing the batch, and only invalid
  options throw. Answers come back in request order — upstream
  keys an unordered map on a caller-supplied correlation id, and
  the array position serves the same purpose without asking for
  one. Identical requests in a batch coalesce and cost one
  resolution, which is what upstream gets by de-duplicating on a
  cache key before dispatch.

  The scope is bounded by the call, so it is safe to use inside a
  transaction — a tuple written earlier in that transaction is
  visible to it. That is why this is a shared scope and not a
  tuple cache.

- **`CheckOptions.maxConcurrentChecks`** (default 50, matching
  `OPENFGA_MAX_CONCURRENT_CHECKS_PER_BATCH_CHECK`) bounds how many
  checks of one `checkMany` batch resolve concurrently. It is a
  separate knob from `maxBreadth`, which bounds the branches
  within a single check — the same split upstream makes. `check`
  and `listObjects` ignore it.

### Changed

- **Concurrent routes into the same node now resolve it once.**
  The node memo published only settled results, so at any
  `maxBreadth` above 1 the routes overlapped and every one of them
  re-resolved the shared subtree and re-issued its reads: the
  resolution DAG walked as a tree, with breadth as the duplication
  multiplier. A consumer profiling a page render measured one
  immutable parent edge read 215 times in a single request. A
  route that arrives while another is still resolving now waits
  for it.

  Results are unchanged, including for cyclic models. A subtree
  truncated by a cycle and a subtree that threw are still never
  shared — both are properties of the route rather than of the
  node, which is the same line upstream's cached resolver draws
  for a cycle-detected response.

- **Branches abandoned after a node settles stop querying the
  store.** A union that found its grant already refused to launch
  queued branches; the branches already in flight now stop at
  their next checkpoint instead of walking their subtree. One read
  per abandoned branch — the one already handed to the store —
  still lands, because cancellation is not part of the
  `TupleStore` contract. If you instrument your store, drain its
  counters before reading them.

### Documentation

- **The README no longer claims that `maxBreadth` never changes the
  boolean result.** It can, on a model where a cycle reaches an
  intersection operand: the first failing operand decides and
  carries its own indeterminacy out, and an enclosing `but not`
  reads a cycle-flagged denial differently from a plain one. This
  is upstream's behaviour — OpenFGA's intersection short-circuits
  the same way and its answer likewise tracks which operand is
  cheaper — so it is documented rather than "fixed"; making it
  deterministic would mean granting where OpenFGA denies. The claim
  was already wrong in 0.4.0. New conformance fixture
  `intersection-cycle-precedence` pins both directions against a
  live OpenFGA.

### Notes

- `maxBreadth` keeps its default of 10.
  `OPENFGA_RESOLVE_NODE_BREADTH_LIMIT` is 10 upstream, and with
  the change above breadth is no longer a duplication multiplier.
  What remains true is that breadth buys parallelism only if the
  store can execute reads concurrently: on a single pooled
  PostgreSQL connection it buys queueing, and `maxBreadth: 1` is a
  reasonable setting there.

## 0.4.0 — 2026-08

### Breaking changes

- **`TupleStore.findDirectTuple` and `TupleStore.findUsersetTuples`
  are replaced by `findCheckTuples`.** A check node wanted all
  three reads — the subject's direct tuple, the `type:*` wildcard
  tuple, the userset rows — and issued three calls for them. It
  now issues one, taking a `CheckTuplesQuery` and returning a
  `CheckTuples`; both types are exported. Custom `TupleStore`
  implementations must be updated: the two old methods are gone,
  with no fallback shim.

  The query carries which parts the caller wants, so the relation
  config gating below still applies. Those `include*` flags let a
  store narrow its query, but they are not a trust boundary: the
  check algorithm re-clamps every reply against the query it
  sent, so a store that ignores a flag or files a row under the
  wrong slot loses that row rather than granting access the model
  forbids. A node whose config rules out all three parts skips
  the store altogether.

  This is a latency change, not a work change: the number of rows
  read is the same, and the store-call count barely moves,
  because the type-restriction gating below had already cut most
  nodes to a single admitted read. What moves is round-trips and
  connection-pool pressure. A node used to issue up to three
  concurrent reads, so at the default `maxBreadth` of 10 a single
  wide node could demand up to 30 connections at once; it now
  demands 10. Measured against PostgreSQL on a 10-connection
  pool, relations that admit more than one part (`[user,
  group#member]`, the common nested-group shape) resolve
  1.8x–3.0x faster; relations that admit exactly one part emit
  identical SQL and are unchanged. On a single-connection handle
  every shape improves, 1.1x–2.3x.

  Porting a custom store is mechanical. The minimal version keeps
  whatever queries you already had and drops the flags:

  ```ts
  async findCheckTuples(query) {
    const onNode = [query.objectType, query.objectId, query.relation];
    return {
      direct: query.includeDirect
        ? await this.oldFindDirectTuple(
            ...onNode, query.subjectType, query.subjectId)
        : null,
      wildcard: query.includeWildcard
        ? await this.oldFindDirectTuple(
            ...onNode, query.subjectType, "*")
        : null,
      usersets: query.includeUsersets
        ? await this.oldFindUsersetTuples(...onNode)
        : [],
    };
  }
  ```

  That is correct but keeps three round-trips. The point of the
  change is to serve the parts in one query where the backend can
  — see `@tsfga/kysely` for a SQL implementation.

  `ContextualTupleStore`'s overlay is unchanged and still
  deliberately asymmetric: a contextual tuple *replaces* the
  stored direct or wildcard tuple (a probe returns one row, so an
  override has to win outright) but is *concatenated* with the
  stored userset rows.

- **A cycle in the resolution path no longer throws.** Revisiting
  a node used to raise `DepthExceededError`, the same error as
  depth exhaustion. It now resolves `false`, and `check()` returns
  `false` to the caller. OpenFGA errors only on depth exhaustion;
  a cycle is `Allowed:false` with an internal `CycleDetected`
  flag. Callers that catch `DepthExceededError` to detect a cyclic
  model will no longer see it — depth exhaustion still throws, and
  is now the only thing that does.

  Internally the flag is tracked rather than collapsed into a
  plain `false`, because the set operators read the two
  differently. Most sharply: on the subtract side of `but not` a
  cycle *denies*, so `base:true but not subtract:cycle` is
  `false`. Treating a cycle as an ordinary `false` there would
  grant — a fail-open. Like OpenFGA, the flag is not exposed on
  the public result.

  Known divergence, documented in the README: OpenFGA has
  dedicated resolvers for recursive relation shapes
  (`define member: [user, group#member]`, or a TTU recursing on
  its own relation), which resolve a data loop to a definitive
  `false` with no flag. tsfga reports indeterminacy there. The
  only case where that is observable is the subtract side of a
  `but not`, where OpenFGA grants and tsfga denies.

- **A condition evaluated with missing declared parameters is now
  an error, not an unmet condition.** A tuple whose condition
  declares a parameter that neither the tuple context nor the
  request context supplies used to resolve `false`; it now throws
  `ConditionEvaluationError` naming the absent keys, matching
  OpenFGA's check path. The difference is not cosmetic: a
  silently-unmet condition fails open through an exclusion
  branch, where "not excluded" grants. Callers that relied on a
  missing parameter reading as a denial must supply the
  parameter, or catch the error.

- **A definitive denial now outranks a sibling error in
  intersection and exclusion.** Unions already let a branch
  resolving `true` beat an errored sibling; the other two
  operators rejected as soon as any branch did. As in OpenFGA,
  an intersection operand resolving `false` now denies even
  though another operand errored, and an exclusion whose
  subtracted branch resolves `true` denies even though the base
  errored — only a base that *granted* alongside an errored
  exclusion branch still propagates. Checks that used to reject
  now resolve `false`; the theopenlane fixtures hit exactly this
  through `member and access`, where a conditioned tuple with
  missing parameters inside one operand poisoned a check OpenFGA
  resolves. The fail-closed invariant holds throughout: an error
  never becomes a grant, only definitive denials win past one.

  When several branches do fail, which error surfaces follows
  completion order, so it is not deterministic under concurrency
  — the same nondeterminism OpenFGA's union reducer has.

### Added

- **`CheckOptions.maxBreadth`** bounds how many branches of one
  resolution node are evaluated concurrently, mirroring
  OpenFGA's `OPENFGA_RESOLVE_NODE_BREADTH_LIMIT`. It **defaults
  to 10**, that option's upstream default; before this release
  fanout was unbounded, so a union over 1k userset tuples issued
  1k concurrent sub-checks and ran every one to completion even
  after a branch had granted. Pass `maxBreadth: Infinity` to
  restore the old behavior.

  Bounding changes scheduling, not answers: the boolean result
  and whether a check errors are unaffected, and the core,
  adapter, and conformance suites pass unchanged at the new
  default. On a 1k-branch union that grants, the bound cuts the
  benchmark from ~270 ms/3005 store calls to ~108 ms/1166; a
  100-branch TTU hit goes from ~41 ms/306 to ~17 ms/192. The one
  measured regression is all-miss wide unions under concurrent
  load (~20% slower batch wall time for four parallel 1k-branch
  misses), where unbounded fanout kept the pool queue full —
  `Infinity` restores it for miss-heavy workloads.

  Exclusion keeps a fixed breadth of 2, as upstream does. Values
  other than an integer >= 1 or `Infinity` throw `TsfgaError`;
  a fractional bound would admit one more branch than stated.

  `maxBreadth` also bounds how many `listObjects` candidates are
  checked at once, following upstream, whose ListObjects worker
  pool is sized from the same limit.

### Changed

- **`maxDepth` now defaults to 25 instead of 10**, matching
  OpenFGA's `OPENFGA_RESOLVE_NODE_LIMIT`. The old default threw
  `DepthExceededError` on models a stock OpenFGA server resolves,
  so deep models needed an explicit override to conform. Callers
  who passed `maxDepth: 25` for that reason can drop it.

- **Relation configs and condition definitions are read once per
  check request.** Both are static per authorization model, but
  every resolution node re-fetched them — on a 1000-branch
  userset fanout, ~1000 redundant round-trips, a quarter of all
  store calls. An internal request-scoped cache now memoizes
  both, including negative results, and coalesces concurrent
  branches asking the same key onto one in-flight query; a
  failed read is evicted rather than pinned, so a later branch
  retries. The cache lives for one `check` call, so a config
  written between two checks is always observed; a write racing
  a check in flight may not be. Measured against PostgreSQL, a
  1000-branch fanout dropped from 4004 to 3005 store calls and
  365 ms to 260 ms.

- **A node reached by two routes in one request resolves once.**
  The check graph is a DAG explored as a tree, so a shared
  subtree was re-resolved per route. A request-scoped memo now
  publishes settled node results only — never in-flight promises,
  which deadlock on a cross-branch cycle — and only results that
  are not cycle-truncated, since a truncated `false` is
  path-dependent. Reuse is gated on the depth an entry was proved
  at, so a memo hit can never answer where a fresh resolution
  would have thrown `DepthExceededError`. At the default breadth
  a whole level is in flight before any of it settles, so the
  memo mostly pays inside `listObjects`, where it spans every
  candidate.

- **Only dispatches to another object spend the depth budget.**
  Userset expansion and tuple-to-userset expansion cost one depth
  each, as before; rewrites of the same object — `impliedBy`,
  `computedUserset`, `excludedBy` and intersection operands — now
  cost none. Previously every one of them charged a depth, so
  tsfga exhausted `maxDepth` earlier than OpenFGA and threw
  `DepthExceededError` on models OpenFGA resolves — reachable at
  the default limit of 25. The guard also moved from
  `depth > maxDepth` to `depth >= maxDepth`, matching OpenFGA's
  `Depth == maxResolutionDepth`: a budget of `maxDepth` admits a
  root node plus `maxDepth - 1` dispatches. Behavior-visible, not
  an API change: checks that used to throw may now resolve, and a
  check one dispatch past the limit throws where it previously
  resolved. Long rewrite ladders are still bounded — by cycle
  detection, since one object has a finite set of relations.

- **`listObjects` checks its candidates concurrently and shares
  one request scope across them.** Each candidate used to get its
  own relation-config cache and its own node memo, so N documents
  behind one folder re-read every config N times and re-resolved
  the shared subtree N times; they now span the whole call. The
  serial loop is also gone — candidates run with at most
  `maxBreadth` in flight, the same bound upstream uses for its
  ListObjects pool. On a 200-candidate benchmark where 195 share
  a three-node subtree this is 2361 store reads down to 852, and
  395 config reads down to 2.

  Two behaviors are now specified rather than incidental. The
  returned array is in candidate order, which concurrency would
  otherwise have scrambled. And when several candidates fail, the
  error raised is the first failing candidate in *candidate*
  order, not the first to fail in time — so a broken model
  reports the same error on every run. As before, any error fails
  the whole call rather than dropping the offending object.

- **A check no longer issues tuple reads the relation config
  rules out.** Each node used to probe for a direct tuple, a
  wildcard tuple and userset rows regardless of what the relation
  admits. Each read is now gated on the config — the same
  predicate `addTuple` applies, so a writable tuple is always a
  findable one — cutting a wide-union benchmark from 3005 store
  reads to 1004, a TTU fanout from 306 to 104, and the
  200-candidate `listObjects` shape from 852 to 436.

  **Behavior-visible.** A tuple the model does not admit — one
  written straight to the database bypassing `addTuple`, or left
  behind by a relation that has since narrowed its type list — is
  no longer found, where before it granted access. Relation
  configs are now load-bearing for the read path rather than
  advisory. OpenFGA behaves the same way and rejects such a tuple
  at write time; the change fails closed.

  A read is skipped only on a positive exclusion: no config, or
  `directlyAssignableTypes: null`, still reads everything. tsfga
  therefore skips less than OpenFGA, which issues no reads at all
  for a purely computed relation — tsfga encodes that as the same
  `null` that means "unrestricted" and cannot tell the two apart.
  Closing that gap would change what `null` means for writes too,
  so it is left for its own change.

  Ordering the config read before the tuple reads gives up the
  single overlapping read wave, also unreleased. The cost is one
  round-trip per relation per request, not per node, because
  configs are cached for the request.

### Fixed

- **An intersection with zero operands no longer grants.** A
  malformed config with an empty `intersection` array resolved
  vacuously `true`, granting the relation to every subject. It
  now throws `TsfgaError`; OpenFGA's typesystem rejects a set
  operation with too few children as an invalid model.
  Single-operand intersections stay valid — tsfga's decomposed
  configs use them legitimately.

## 0.3.1 — 2026-08

Maintenance release. No changes to the published code — the
package contents are identical to 0.3.0.

### Changed

- Release tooling: the publish job pins Node 24.19.0 and uses its
  bundled npm 11.17.0 for Trusted Publishing, and CI actions moved
  off the deprecated Node 20 runtime.
- CI now builds and runs the `examples/node-kysely` example
  against the workspace packages, so the documented consumer
  setup is verified on every run.

## 0.3.0 — 2026-08

### Breaking changes

- **Depth exhaustion and cycles now throw `DepthExceededError`**
  instead of returning `false`. In 0.2.x, exceeding `maxDepth`
  silently resolved a branch to `false`, which was fail-open under
  exclusion (`excludedBy`): a deep excluded sub-check could
  incorrectly grant access. Cyclic relation graphs throw the same
  error (mirroring OpenFGA's `resolution_too_complex`). A branch
  that short-circuits to `true` before the error still wins;
  otherwise the error propagates to the caller.
- **Contextual tuples are validated like `addTuple`.** Contextual
  tuples passed to `check` are now validated against relation
  configs (allowed subject types, userset rules). Callers relying
  on the previous lax behavior will now get validation errors.
- **ESM-only, Node.js >= 22.12.0.** The package declares
  `engines.node: ">=22.12.0"` and ships only an ESM build. Node.js
  20 (EOL April 2026) is no longer supported.

### Changed

- The CEL condition cache is keyed by expression content and scoped
  per instance instead of cached globally by condition name.
  Redefining a condition (same name, new expression) now takes
  effect immediately; 0.2.x could keep evaluating the stale
  compiled expression.
- Missing CEL condition parameters are detected structurally
  instead of by matching the evaluator's "Unknown variable" error
  message, so the missing-parameter → deny path no longer depends
  on error-message wording.
- `intersection` no longer shadows `excludedBy`: relations
  configured with both are evaluated correctly.
- `listObjects` propagates the request `context` to its internal
  checks, so condition-gated tuples are evaluated consistently.
- Updated to `@marcbachmann/cel-js` 8.

### Added

- `sideEffects: false` for bundler tree-shaking; the MIT `LICENSE`
  file now ships in the npm tarball.

## 0.2.0 — 2026-02-18

First published release, as part of the tsfga Turborepo monorepo.

- 5-step recursive check algorithm: direct tuples, userset
  expansion, relation inheritance (`impliedBy`), computed usersets,
  and tuple-to-userset (with multiple TTU paths per relation).
- Exclusion (`excludedBy`) and intersection operators.
- CEL condition evaluation with typed parameters, context merging
  (tuple context wins), and timestamp/duration coercion.
- Contextual tuples via `ContextualTupleStore`.
- Wildcard (public access) matching.
- Database-agnostic `TupleStore` interface and `createTsfga`
  public API.
