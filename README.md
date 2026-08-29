# ThreadTrail for DeepSeek Harness

A git-diff comparison plugin set for the DeepSeek Harness **web** profile:
pick any two **records** of a session's workspace — every commit, with the
uncommitted worktree state treated as one record — and read the
syntax-highlighted diff between them, live while the agent works. A **pnpm
TypeScript workspace** with two packages.

## Packages

| package | role |
|---|---|
| [`threadtrail-server`](threadtrail-server/) | Host plugin (TypeScript → `dist/`): resolves each session's workspace and serves read-only `/threadtrail/...` HTTP routes — `records.json` (the worktree record with changed/untracked counts + up to 300 commits with first-parent links + the empty-tree record) and `diff.json?from=…&to=…` (commit ↔ commit via `git diff`, commit ↔ worktree including untracked files as additions, inverted when the worktree is the "from" side). |
| [`threadtrail-client`](threadtrail-client/) | Browser plugin (TypeScript/TSX → esbuild bundle `dist/client.js`): a panel in the session-scoped `details` column — a **git-log timeline** (click a record to view it: commit vs its parent, worktree vs HEAD), two-record compare via per-row `F`/`T` chips (with swap/clear), per-file unified diff with **syntax-highlighted** hunks and status badges, an **expandable wide overlay**, a sidebar footer entry that opens the compare view **before any message** (fresh/blank sessions included), and non-disruptive realtime refresh as the agent edits the workspace. |

## Build & test

```sh
pnpm install            # workspace install (typescript, esbuild, @types/*)
pnpm build              # server: tsc → threadtrail-server/dist; client: esbuild → threadtrail-client/dist/client.js
pnpm test               # server: node --test on TS sources (real temp git repos); client: module-loader bundle test
pnpm typecheck          # tsc --noEmit in both packages
```

## How it works

- **Records** = the workspace's comparable states: the synthetic `worktree`
  record (everything not yet committed: staged + unstaged tracked changes and
  untracked files), the commit history (`git log`, newest first, capped at
  300, each with its first-parent sha so a commit can be viewed against its
  parent), and the synthetic `empty` record (git's empty tree — the base
  before the first commit). Workspaces that are not a git repository offer
  their git-repository **subfolders** (up to 3 levels deep) as selectable
  comparison roots; hosts without the `git` binary degrade to an explanatory
  empty state.
- **Diffing** spawns the `git` binary (commit-to-commit diffs need real git
  object access): `git diff -M from to` for two commits; `git diff -M <sha>`
  for worktree involvement, with untracked files (`git ls-files --others
  --exclude-standard`) synthesized as whole-file additions. The unified patch
  is parsed into per-file hunks (renames, binary files, quoted paths) with
  payload caps and a `truncated` flag. Record ids are validated as 40-hex shas
  before they reach the CLI. The plugin never writes to the workspace.
- **Realtime review**: the panel refetches the records and the open diff on
  every conversation-window change, so the worktree record (and its diff)
  tracks the agent's edits as they land. The previous diff stays on screen
  while a refresh loads.
- **Wide overlay**: the details column is capped at 520px by the shell layout,
  so an expand button / sidebar footer entry opens a wide `shell.overlay`
  (up to 78vw) with the record list beside the diff, sharing the same store.

## Install

Already done for this machine's web profile; to reproduce elsewhere:

```sh
# 1. prerequisites: Node.js >= 22 (native TS support), pnpm, git, and dsh on PATH

# 2. clone + install + build the workspace (build produces the dist/ artifacts
#    the profiles receive)
git clone <this-repo> && cd ThreadTrail
pnpm install
pnpm build

# 3. install both plugins into the web profile (dsh plugin forwards to pnpm
#    inside the profile directory; file: deps are copied)
dsh plugin --profile web add file:$PWD/threadtrail-server file:$PWD/threadtrail-client
```

Then add to `$DSH_HOME/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: threadtrail-server
      name: threadtrail-server
    - id: threadtrail-client
      name: threadtrail-client
```

Restart `dsh web` and hard-refresh the browser tab (see "Activate" below).

### Headless profile (optional)

```sh
dsh plugin --profile headless add file:$PWD/threadtrail-server
```

and add `threadtrail-server` to `$DSH_HOME/profiles/headless/cordis.patch.yml`
(routes only register where a web server exists, so this is inert there).

### After editing the source

> pnpm `file:` deps are **copied**, not linked: after editing the source, run
> `pnpm build` again and re-sync the copies
> (`dsh plugin --profile web add file:... --force`, or `cp` the package's
> `package.json` + `dist/` into `$DSH_HOME/profiles/web/node_modules/<pkg>/`).

## Activate (requires restart)

The running web GUI predates the plugin — restart it:

1. Stop the current `dsh web` process (the one serving this page).
2. Start it again the same way (e.g. `npm exec @deepseek-ai/dsh web`).
3. Hard-refresh the browser tab (the client bundle is composed into the page's
   boot graph at load time).

Then: open any session and the **ThreadTrail** panel appears in the right-hand
column (it auto-opens the details column; close it like any panel).
`curl http://127.0.0.1:3080/threadtrail/status.json` confirms the server half.

## What to expect / known tradeoffs

- The plugin needs the `git` binary on the host and a workspace that is a git
  repository; both degrade to an explicit empty state in the panel.
- The worktree record is the *live* working tree: it changes as files are
  edited, so a pinned `HEAD → worktree` diff is a realtime review of pending
  changes. Untracked files appear as whole-file additions (capped per file).
- Very large diffs are truncated host-side (24 MB patch / 500 files / 20 000
  lines) and flagged in the UI.
- The panel occupies the `details` column at `priority: -1`, shadowing
  ui-conversation's built-in tool-inspector panel (single slot, lowest priority
  wins). Restore coexistence by moving the ThreadTrail panel to a different
  surface.

## Tests

```sh
pnpm test    # server: node --test on the TS sources; client: bundle harness
pnpm typecheck
```
