# threadtrail-client

The browser half of **ThreadTrail** for DeepSeek Harness: a panel in the
session-scoped `details` column (the right-hand pane) showing the captured
operation timeline between commits.

## Features

- **Timeline** — ops grouped by turn (plus a "manual edits" group), each row
  showing the file chips with `+added/-removed` counts; click an op to see the
  full unified diff (syntax-highlighted by file language), the prompt that
  drove it, and the assistant message seqs in that turn.
- **Worktree (realtime review)** — browse the workspace files; open any file in
  a line-numbered viewer where the lines changed by the latest op are
  highlighted (click a highlighted line to jump to that op and its
  conversation). Code is syntax-highlighted by a compact built-in tokenizer
  (extension detection, cross-line block comments). Below the code, the file's
  full op history with prompt previews. The open file refetches on every
  conversation-window change, so you watch the agent's edits land as it works.
  (Backed by `tree.json` / `file.json` host routes; traversal- and
  symlink-guarded.)
- **Browse before any modification** — the worktree reads the live workspace,
  so it works with zero ops. While a session is still blank (no conversation
  yet) the `details` column is hidden, so a ThreadTrail button in the sidebar
  footer opens the same wide worktree review for the current session — read
  the code before the agent has changed anything.
- **Clean on commit** — the op list is "between commits" data; once the
  workspace is committed the state is preserved in git, so the log is safe to
  clear. The server detects a moved git HEAD at capture time and resets the
  log automatically (the timeline notes "reset after commit <sha>"); a
  **clean** button in the panel header does the same on demand after a confirm
  dialog. The digest reports `gitHead` and `lastClean` for the UI.
- **Anchored notes** — select code in the viewer; a floating composer saves a
  note pinned to the line range (with the selected snippet). Notes are marked
  in the gutter, listed under the file, and click-to-jump back to the line
  (backed by `POST/DELETE /threadtrail/<sessionId>/notes`).
- **Expandable overlay** — the details column is capped at 520px by the shell
  layout, so entering the Worktree tab **auto-opens a wide overlay**
  (`shell.overlay`, up to 72vw / 1000px) with a side-by-side tree + viewer;
  it shares state with the details panel. Closing it (✕ / backdrop) stops the
  auto-open for that session; reopen via the ⛶ header button or the
  "Open wide review" banner inside the pane.
- **Rewind** — per-op "rewind workspace to this point": the host materializes
  the state right after that op into `<cwd>/.threadtrail/rewinds/<opId>-<ts>/`
  (non-destructive; files never touched by captured history are not copied).
- **Live-ish updates** — the panel refetches the digest (and the open file)
  whenever the conversation window changes (turn boundaries, tool results)
  plus a manual refresh button.

## How it loads

This file is a classic-script client bundle registered through the module
loader, exactly like the shipped client plugins — zero build step. The
factory's `require` resolves `react` and the dsh packages through the loader's
module table at runtime. `exports["./client"]` points at this file, and the
package's `dsh.client` declaration tells the modules node half to serve it
under `/plugins/threadtrail-client/client.js`.

## Install (web profile)

```sh
dsh plugin --profile web add file:/path/to/threadtrail-client
```

and add a row to `$DSH_HOME/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: threadtrail-client
      name: threadtrail-client
```

The panel occupies the `details` slot declared by `dsh-client-ui-layout`; it
appears when a session is open and the details column is expanded.
