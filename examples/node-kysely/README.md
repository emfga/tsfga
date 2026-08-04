# Node.js + Kysely example

A minimal, runnable consumer of [tsfga] — defines a small document
authorization model, writes tuples, and runs permission checks against
PostgreSQL.

Part of the [tsfga] monorepo. See the [root README] for the project
overview.

## What it shows

The model is the classic three-tier document ACL, expressed as
`RelationConfig` records rather than DSL (tsfga does not parse DSL —
see the root README for why):

```
document
  relations
    define owner:  [user]
    define editor: [user] or owner
    define viewer: [user] or editor
```

`editor` is `impliedBy: ["owner"]` and `viewer` is
`impliedBy: ["editor"]`, so a single `owner` tuple satisfies all three
checks through relation inheritance. Running it prints:

```
  alice → owner: true
  alice → editor: true
  alice → viewer: true
  bob → owner: false
  bob → editor: true
  bob → viewer: true
```

alice is written as `owner` and bob as `editor`, so bob resolves as
`editor` and `viewer` but not `owner`.

The script cleans up after itself — it removes both tuples and all
three relation configs before exiting, so it is safe to re-run.

## Requirements

- Node.js >= 22.12.0
- A PostgreSQL database with the tsfga schema migrated

## Running it

From the monorepo root, start PostgreSQL and apply the migrations:

```bash
bun run infra:setup
```

Then, in this directory:

```bash
cp .env.example .env    # adjust if your database differs
npm ci
npm start
```

`npm run typecheck` type-checks without running.

This example uses **npm** and ships a `package-lock.json`, since it is
the plain-Node.js example — the point is that it works with the
toolchain a Node user already has, not with the one this monorepo
happens to build with.

Connection settings are read from the environment
(`POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_DB`, `POSTGRES_USER`,
`POSTGRES_PASSWORD`); see `.env.example`. Node.js does not read `.env`
on its own — either export the variables or run with
`node --env-file=.env`.

## Why this is not a workspace member

The example deliberately sits outside the root `workspaces` array and
carries **its own `package-lock.json`**. It installs `@tsfga/core` and
`@tsfga/kysely` from npm at their published versions, exactly as a real
consumer would, so it exercises the published entry points, types and
dependency ranges rather than the local source.

Making it a workspace member would replace those with `workspace:*`,
which is also the protocol that `pkg-pr-new` cannot resolve — this
directory is published as the preview template by
`.github/workflows/preview.yml`.

The trade-off is that its dependency versions do not follow the
workspace automatically. Renovate manages them instead, and CI installs,
type-checks and runs every example on each PR, so a bad bump fails
visibly rather than silently shipping a broken template.

[tsfga]: https://github.com/emfga/tsfga
[root README]: ../../README.md
