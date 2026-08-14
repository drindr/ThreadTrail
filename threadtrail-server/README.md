# threadtrail-server

The server half of **ThreadTrail** for DeepSeek Harness: captures every file
edit of a session's workspace *between turns* (the "software is made between
commits" granularity), links each change to the conversation that produced it,
and exposes it to both the agent and the browser.

## What it does

- **Operation log with stable identity.** Every change recorded at a turn
  boundary becomes an op (`op-1`, `op-2`, …) in an append-only sidecar log
  under `$DSH_HOME/threadtrail/sessions/<sessionId>.jsonl`, keyed to the session
  event seq that bracketed it (`atSeq`). File contents are stored
  content-addressed under `$DSH_HOME/threadtrail/blobs/<sha256>`, deduped across
  ops and sessions.
- **Conversation ↔ code linking.** Each op carries the `userMessageSeq` of the
  prompt that drove the turn and the `assistantSeqs` of the messages inside it;
  a per-session `fileIndex` maps every path to the ops that touched it.
- **Agent-queryable.** Registers a global `threadtrail` tool (`status`, `list`,
  `where <path>`, `why <opId|turn>`, `rewind <opId>`) so the model can answer
  "what changed here" / "why was this line written" itself.
- **Clean on commit.** The op log is "between commits" granularity, so once
  the workspace is committed it is safe to clear. At every capture scan the
  store resolves the workspace git HEAD (`.git/HEAD`, worktree/submodule
  `.git` files, packed refs — no `git` binary required); a moved HEAD resets
  the log and re-baselines automatically. `POST /threadtrail/<sessionId>/clean`
  does the same on demand. The last seen HEAD and the last reset are persisted
  per session (`sessions/<id>.head.json`), so a restart does not re-trigger a
  reset for the same commit. The digest carries `gitHead` / `lastClean` for
  the panel; notes and per-turn attribution state survive a reset.
- **Browser routes** (web profile only): `GET /threadtrail/<sessionId>/digest.json`
  (op summaries + file index + prompt previews), `…/op/<opId>.json` (full diff),
  and `…/rewind/<opId>.json` (non-destructive materialization of the workspace
  as it was right after an op into `<cwd>/.threadtrail/rewinds/<opId>-<ts>/`).
- **Correct capture.** Content-hash based (mtime heuristics are unreliable on
  coarse-granularity filesystems); ignored dirs: `.git`, `node_modules`,
  `.threadtrail`, `target`, `dist`, `build`, `.next`, `venv`, …; files > 20 MB
  excluded. Manual (human) edits between turns are captured at the next
  `turn/start` as `kind: "manual"`.

## Layout

TypeScript in `src/`, compiled by `tsc` to `dist/` (ESM, `.js` specifiers
rewritten from `.ts` imports). Tests run the TS sources directly via Node's
native type stripping — no build needed to test.

| file | role |
|---|---|
| `src/index.ts` | Cordis plugin entry (`apply`/`inject`), event wiring |
| `src/capture.ts` | `CaptureStore` / `SessionCapture`: scans, blobs, ops, digest, rewind, reset |
| `src/diff.ts` | pure line-diff primitives (`computeDiff`, `computeRanges`, `lcsDiff`) |
| `src/git.ts` | dependency-free `gitHead` resolution |
| `src/tool.ts` | `threadtrail` agent tool (`defineTool`) |
| `src/routes.ts` | `/threadtrail/...` HTTP handlers |
| `src/messages.ts` | reads prompt text back out of the session log |
| `src/types.ts` | shared op/digest/note record types |

## Build & test

```sh
pnpm build      # tsc → dist/
pnpm typecheck  # tsc --noEmit
pnpm test       # node --test on the TS test sources (capture engine + route handlers)
```

## Install (web profile)

```sh
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
