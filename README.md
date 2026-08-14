# ThreadTrail for DeepSeek Harness

A single-user "software is made between commits" plugin set for the DeepSeek
Harness **web** profile — the ThreadTrail effect (operation log between commits,
code ↔ conversation tracing, rewind to any point, agent-queryable history)
without real multiplayer. A **pnpm TypeScript workspace** with two packages.

## Packages

| package | role |
|---|---|
| [`threadtrail-server`](threadtrail-server/) | Host plugin (TypeScript → `dist/`): captures every file edit at turn boundaries with stable identity (`op-1`, `op-2`, …), stores content-addressed blobs + an append-only op log under `$DSH_HOME/threadtrail/`, links edits to prompts (`userMessageSeq` / `assistantSeqs`), **cleans the op list when a git commit is made** (HEAD-move detection at scan time) or on demand (`POST …/clean`), registers the agent-facing `threadtrail` tool, and serves `/threadtrail/...` HTTP routes (digest, op detail, non-destructive rewind). |
| [`threadtrail-client`](threadtrail-client/) | Browser plugin (TypeScript/TSX → esbuild bundle `dist/client.js`): a panel in the session-scoped `details` column — timeline grouped by turn, op → **syntax-highlighted** unified diff, **Worktree tab** (realtime file browser + language-aware viewer with changed-line annotations, **anchored notes on selected text**, per-file op history), an **expandable wide overlay** for comfortable review, one-click rewind, and a sidebar entry that opens the worktree **before any modification** (fresh/blank sessions included). |

## Build & test

```sh
pnpm install            # workspace install (typescript, esbuild, @types/*)
pnpm build              # server: tsc → threadtrail-server/dist; client: esbuild → threadtrail-client/dist/client.js
pnpm test               # server: node --test on TS sources; client: module-loader bundle test
pnpm typecheck          # tsc --noEmit in both packages
```

## How it works

- **Capture** runs at turn boundaries (`turn/start` records manual edits,
  `turn/end` records the agent's edits for that turn), content-hash based for
  correctness on coarse-granularity filesystems. Ignored: `.git`,
  `node_modules`, `.threadtrail`, `target`, `dist`, `build`, `venv`, …; files
  > 20 MB excluded.
- **Stable identity** = `(sessionId, opId)`; ops reference the session event
  seq that bracketed them (`atSeq`), so the op log and the conversation log
  stay addressable together.
- **Rewind** is non-destructive: it materializes the workspace state right
  after an op into `<cwd>/.threadtrail/rewinds/<opId>-<ts>/` (delta snapshot: files
  never touched by captured history are not copied).
- **Realtime worktree review**: the panel's Worktree tab lists the workspace
  files (`/threadtrail/<sessionId>/tree.json`), reads any file
  (`…/file.json?path=…`, symlink- and traversal-guarded), highlights the lines
  the latest op changed (anchored by per-op `newRanges` recorded at capture),
  and shows the file's full op history with prompt previews — refreshed on
  every conversation-window change while the agent works. Code is
  **syntax-highlighted** by language (extension-detected, compact built-in
  tokenizer with cross-line block comments; diffs highlight the code too). The
  ⛶ button expands the review into a wide overlay (`shell.overlay`) with a
  side-by-side tree + viewer.
- **Browse before the modification**: the worktree is not tied to capture —
  `tree.json`/`file.json` read the live workspace, so a session can be
  browsed with **zero ops**. The `details` column is hidden while a session is
  still blank (before its first message), so a ThreadTrail entry in the
  sidebar footer (`sidebar.footer.action`) opens the wide worktree review for
  the current session from the very start — read the code before asking the
  agent to change anything.
- **Anchored notes** ("notation on selected text"): select code in the viewer
  and press save on the floating note composer — the note is stored
  (`POST /threadtrail/<sessionId>/notes`, `DELETE …/notes/<id>`) with its line
  range and snippet, marked in the gutter, listed under the file, and
  click-to-jump back to the line.
- **Clean on commit**: the op log is "between commits" granularity — once the
  workspace is committed, that window is preserved in git, so the captured ops
  are safe to clear. At every capture scan the server resolves the workspace
  git HEAD (`.git/HEAD`, worktree/submodule `.git` files, packed refs — no git
  binary needed); when HEAD moved, the op log is reset and re-baselined
  automatically, and the timeline notes "reset after commit <sha>". A **clean**
  button in the panel header does the same on demand (with a confirm dialog).
  The last seen HEAD and reset marker are persisted per session, so restarts
  do not re-trigger a reset for the same commit. Notes are kept.
- **The agent can query its own history** via the `threadtrail` tool
  (`status | list | where <path> | why <opId|turn> | rewind <opId>`).

## Install

Already done for this machine's web profile; to reproduce elsewhere:

```sh
# 1. prerequisites: Node.js >= 22 (native TS support), pnpm, and dsh on PATH

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

### Headless profile (optional smoke-test bed)

```sh
dsh plugin --profile headless add file:$PWD/threadtrail-server
```

and add `threadtrail-server` to `$DSH_HOME/profiles/headless/cordis.patch.yml`.

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

Then: open any session with a conversation and the **ThreadTrail** panel appears in
the right-hand column (it auto-opens the details column; close it like any
panel). `curl http://127.0.0.1:3080/threadtrail/status.json` confirms the server
half.

## What to expect / known tradeoffs

- Capture starts fresh per session: the first turn of a session establishes the
  baseline, so edits from *before* the plugin was active (including this
  session) are not in the log. The worktree browser itself is unaffected —
  it reads the live workspace, so it works before the first baseline too.
- Commits reset the op list (auto-detected HEAD move, or the manual clean
  button). Any HEAD movement — commit, branch switch, reset — counts, since
  in every case the workspace state is a git state. Pre-commit ops are gone
  from the panel, but the code itself is preserved in git; uncommitted edits
  in the log are lost when you clean manually (the dialog warns).
- The panel occupies the `details` column at `priority: -1`, shadowing
  ui-conversation's built-in tool-inspector panel (single slot, lowest priority
  wins). Restore coexistence by moving the ThreadTrail panel to a different
  surface.
- The headless profile on this machine also carries `threadtrail-server` (a
  smoke-test bed): `dsh --profile headless "use the threadtrail tool to list what changed"`.
  Remove the two lines from `profiles/headless/cordis.patch.yml` to disable.
- Multi-machine replication, virtualized worktrees, and shared threads are
  deliberately out of scope (single user + agent collaboration).

## Tests

```sh
pnpm test    # server: node --test on the TS sources (13 tests); client: bundle harness
pnpm typecheck
```
