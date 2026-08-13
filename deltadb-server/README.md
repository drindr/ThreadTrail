# deltadb-server

The server half of **DeltaDB-lite** for DeepSeek Harness: captures every file
edit of a session's workspace *between turns* (the "software is made between
commits" granularity), links each change to the conversation that produced it,
and exposes it to both the agent and the browser.

## What it does

- **Operation log with stable identity.** Every change recorded at a turn
  boundary becomes an op (`op-1`, `op-2`, …) in an append-only sidecar log
  under `$DSH_HOME/deltadb/sessions/<sessionId>.jsonl`, keyed to the session
  event seq that bracketed it (`atSeq`). File contents are stored
  content-addressed under `$DSH_HOME/deltadb/blobs/<sha256>`, deduped across
  ops and sessions.
- **Conversation ↔ code linking.** Each op carries the `userMessageSeq` of the
  prompt that drove the turn and the `assistantSeqs` of the messages inside it;
  a per-session `fileIndex` maps every path to the ops that touched it.
- **Agent-queryable.** Registers a global `deltadb` tool (`status`, `list`,
  `where <path>`, `why <opId|turn>`, `rewind <opId>`) so the model can answer
  "what changed here" / "why was this line written" itself.
- **Browser routes** (web profile only): `GET /deltadb/<sessionId>/digest.json`
  (op summaries + file index + prompt previews), `…/op/<opId>.json` (full diff),
  and `…/rewind/<opId>.json` (non-destructive materialization of the workspace
  as it was right after an op into `<cwd>/.deltadb/rewinds/<opId>-<ts>/`).
- **Correct capture.** Content-hash based (mtime heuristics are unreliable on
  coarse-granularity filesystems); ignored dirs: `.git`, `node_modules`,
  `.deltadb`, `target`, `dist`, `build`, `.next`, `venv`, …; files > 20 MB
  excluded. Manual (human) edits between turns are captured at the next
  `turn/start` as `kind: "manual"`.

## Layout

| file | role |
|---|---|
| `index.js` | Cordis plugin entry (`apply`/`inject`), event wiring |
| `capture.js` | `CaptureStore`: scans, blobs, diffs, ops, digest, rewind |
| `tool.js` | `deltadb` agent tool (`defineTool`) |
| `routes.js` | `/deltadb/...` HTTP handlers |
| `messages.js` | reads prompt text back out of the session log |

## Test

```sh
node --test 'test/*.test.mjs'   # capture engine + HTTP route handlers
```

## Install (web profile)

```sh
dsh plugin --profile web add file:/path/to/deltadb-server
```

and add a row to `$DSH_HOME/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: deltadb-server
      name: deltadb-server
```

Composes on both `web` and `headless` profiles; the HTTP routes register only
when `ctx.webServer` exists.
