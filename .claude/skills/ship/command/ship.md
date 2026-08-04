---
description: Validate, commit, push, watch CI, rebase, and open PR.
allowed-tools: [Bash, Read, Grep, Glob, Edit, Write]
---

Run the full local-validate → commit → push → CI-watch → rebase → PR workflow.

Use `$ARGUMENTS` for hints about the commit message or PR description.

---

## Phase 1 — Local Validation

Run these steps sequentially. On any failure: fix the issue and restart
Phase 1 from step 1.

Before starting, check if infrastructure is running (needed for kysely and
conformance tests):

```
docker ps --filter "name=postgres" --filter "name=openfga" --format "{{.Names}}"
```

If PostgreSQL or OpenFGA are not running, run `bun run infra:setup` first.

1. `bun run biome:format` — fix formatting
2. `bun run biome:check` — lint (may auto-fix; if it reports errors, fix them)
3. `bun run tsc` — type check all packages
4. `bun run turbo:test` — run all tests (core, kysely, conformance, node, deno)

If any step fails, diagnose and fix the problem, then restart from step 1.
Do NOT proceed to Phase 2 until all 4 steps pass cleanly.

---

## Phase 2 — Commit

1. `git status` — see all changed/untracked files
2. `git diff` — review unstaged changes
3. `git log --oneline -5` — check recent commit message style
4. Stage files by name (`git add <file1> <file2> ...`). Never use `git add -A`
   or `git add .`.
5. Commit following project conventions:
   - 50-char imperative header, capital first letter, no conventional-commit
     prefix
   - Body explains WHY, wrapped at ~74 columns
   - Use HEREDOC format for the message
   - No tool attribution of any kind: no `Co-Authored-By` lines, no
     `Generated with` footers, no session links (see CLAUDE.md)
   - If `$ARGUMENTS` contains commit message hints, incorporate them

---

## Phase 3 — Push + CI Watch

1. Check if the current branch tracks a remote:
   `git rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null`
2. If no upstream tracking: `git push -u origin HEAD`
   Otherwise: `git push`
3. Trigger CI manually on origin:
   `gh workflow run CI --repo <origin-owner>/tsfga --ref <branch>`
   Get the origin owner from:
   `gh repo view --json owner -q .owner.login`
4. Wait a few seconds for the run to register, then find it:
   `gh run list --workflow=CI --branch=<branch> --repo <origin-owner>/tsfga --limit 1 --json databaseId -q '.[0].databaseId'`
5. Watch CI:
   `gh run watch <run-id> --repo <origin-owner>/tsfga --exit-status`
6. On CI failure:
   a. `gh run view <run-id> --repo <origin-owner>/tsfga --log-failed`
      to see what failed
   b. Diagnose and fix the issue
   c. Loop back to **Phase 1** (re-validate everything before
      committing the fix)

---

## Phase 4 — Rebase + Clean Up

1. `git fetch upstream`
2. `git rebase upstream/main`
   - If conflicts arise, resolve them, `git add` the resolved files,
     and `git rebase --continue`.
3. Examine commit history: `git log --oneline upstream/main..HEAD`
4. Identify fixup commits — commits that only fix lint errors, CI failures,
   typos, or other mechanical issues introduced during the iteration loop.
   These should be squashed into the commit they repair.
5. To squash fixups (since interactive rebase requires an editor Claude
   cannot use):
   a. Count meaningful commits: the ones that should survive as separate
      commits in the PR
   b. `git reset --soft upstream/main` to unstage all commits while
      keeping changes in the working tree
   c. Re-commit in logical groups, each with a proper message following
      project conventions
   d. If there is only one logical change, create a single commit
6. `git push --force-with-lease`
7. Trigger CI manually on origin (same as Phase 3 steps 3-5):
   `gh workflow run CI --repo <origin-owner>/tsfga --ref <branch>`
   Then find the run and watch it with `gh run watch`.
   - On failure, fix and loop back to Phase 1

---

## Phase 5 — Open PR

1. `gh pr create --repo emfga/tsfga --base main --title "..." --body "$(cat <<'EOF'
   ## Summary
   <1-3 bullet points>

   ## Test plan
   - [ ] ...
   EOF
   )"`
2. Use `$ARGUMENTS` for hints on title/description if provided.
3. Return the PR URL.

---

## Error Recovery Reference

| Situation | Action |
|-----------|--------|
| Format/lint failure | Fix, restart Phase 1 from step 1 |
| Type error | Fix, restart Phase 1 from step 1 |
| Test failure | Fix, restart Phase 1 from step 1 |
| CI failure | `gh run view --log-failed`, fix, restart Phase 1 |
| Rebase conflict | Resolve conflicts, `git rebase --continue` |
| Push rejected (non-fast-forward) | `git pull --rebase`, then retry push |
| Infrastructure not running | `bun run infra:setup`, then retry |
| No upstream remote | `git remote add upstream git@github.com:emfga/tsfga.git` |

<user-request>
$ARGUMENTS
</user-request>
