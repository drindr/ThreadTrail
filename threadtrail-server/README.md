# threadtrail-server

The server half of **ThreadTrail** for DeepSeek Harness: a read-only git-diff
service for a session's workspace. It exposes the workspace's **comparable
records** — every commit, plus the uncommitted worktree state treated as one
record — and computes the unified diff between any two of them for the
browser panel.

## What it does

- **Records.** `GET /threadtrail/<sessionId>/records.json` resolves the
  session's workspace (`sessions` store → `header.cwd`) and answers the
  record list: the synthetic `worktree` record (with changed/untracked
  counts from `git status --porcelain`) first, then up to 300 commits,
  newest first (`git log`, each with its first-parent sha so the panel can
  view a commit against its parent), and the synthetic `empty` record (git's
  empty tree) last. Non-git workspaces and hosts without the `git` binary
  degrade to explicit `isRepo` / `gitAvailable` flags.
- **Subfolder roots.** When the workspace itself is not a git repository,
  `records.json` includes `candidates`: subfolders (up to 3 levels deep,
  skipping hidden/noise directories) that are git repositories. Both
  `records.json` and `diff.json` accept `?root=<relpath>` to run against
  such a subfolder instead; the value is traversal-guarded.
- **Diff.** `GET /threadtrail/<sessionId>/diff.json?from=<id>&to=<id>`
  compares any two records:
  - commit ↔ commit: `git diff -M from to` (`empty` maps to the well-known
  empty-tree sha, so the root commit is viewable);
  - commit ↔ worktree: `git diff -M <sha>` (staged + unstaged tracked
    changes) plus untracked files (`git ls-files --others
    --exclude-standard`) synthesized as whole-file additions; worktree →
    commit inverts the same diff;
  - identical records: empty diff.
- **Parsing.** The unified patch is parsed into per-file hunks
  (added/modified/deleted/renamed, binary detection, quoted paths, rename
  tracking) with payload caps (24 MB patch, 500 files, 20 000 diff lines,
  per-untracked-file limits) and a `truncated` flag when cut.
- **Safe arguments.** Record ids double as git CLI arguments, so commit ids
  are validated as full 40-hex shas and anything else is rejected with 400.

The plugin is read-only: it never writes to the workspace. Routes register
through `ctx.inject(['webServer'], …)`, which waits for the web-server
service to activate (a bare `ctx.get('webServer')` at apply time races
service startup and silently registers nothing) and never runs on headless
profiles, so the plugin composes everywhere.

## Layout

TypeScript in `src/`, compiled by `tsc` to `dist/` (ESM, `.js` specifiers
rewritten from `.ts` imports). Tests run the TS sources directly via Node's
native type stripping — no build needed to test.

| file | role |
|---|---|
| `src/index.ts` | Cordis plugin entry (`apply`/`inject`), route wiring |
| `src/repo.ts` | git spawning, commit list, worktree status, `diffRecords`, patch parser |
| `src/git.ts` | dependency-free gitdir / HEAD resolution |
| `src/routes.ts` | `/threadtrail/...` HTTP handlers |
| `src/types.ts` | shared record/diff wire types |

## Build & test

```sh
pnpm build      # tsc → dist/
pnpm typecheck  # tsc --noEmit
pnpm test       # node --test test/*.test.ts (spins up real temp git repos)
```

## Install (web profile)

Build first (the profile receives `dist/`):

```sh
pnpm build   # tsc → dist/
dsh plugin --profile web add file:/path/to/threadtrail-server
```

and add a row to `$DSH_HOME/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: threadtrail-server
      name: threadtrail-server
```

Composes on both `web` and `headless` profiles; the HTTP routes register only
when `ctx.webServer` exists.
