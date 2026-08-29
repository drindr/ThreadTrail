# threadtrail-client

The browser half of **ThreadTrail** for DeepSeek Harness: a panel in the
session-scoped `details` column (the right-hand pane) for comparing any two
**git records** of the session workspace — every commit, plus the uncommitted
worktree state treated as one record.

## Features

- **Git-log timeline** — the record list is the workspace's git log: the
  uncommitted changes first (with `changed / untracked` counts), then the
  commits (short sha, subject, author, time) newest first, and the **empty
  tree** at the end (the base before the first commit). **Clicking a record
  views it** git-log style: a commit diffed against its first parent (the root
  commit against the empty tree), the worktree against HEAD.
- **Compare any two records** — the `F` / `T` chips on each row pick the
  **from** base and the **to** target (click again to unpick); the compare bar
  shows the pair with **swap** and **clear** actions.
- **Diff view** — the unified diff between the two picked records, per file,
  with status badges (added / modified / deleted / renamed), `+added/-removed`
  stats, hunk headers, and **syntax-highlighted** diff lines (compact built-in
  tokenizer, extension-detected language, dark-theme aware). Oversized diffs
  are capped host-side and marked *truncated*.
- **Worktree record** — the uncommitted state is a first-class record:
  compare it against any commit (or against nothing) to review pending
  changes, untracked files included (shown as whole-file additions). Picking
  worktree as **from** and a commit as **to** inverts the diff.
- **Subfolder repositories** — when the session workspace is not a git
  repository, the panel lists the subfolders that are (up to 3 levels deep)
  and lets you pick one as the comparison root, with a breadcrumb back to
  the workspace root.
- **Sensible default** — on first load with uncommitted changes present, the
  panel pre-selects `HEAD → worktree` so the pending diff is one glance away.
- **Wide overlay** — the details column is capped at 520px by the shell
  layout, so an expand button (and the sidebar footer entry) opens a wide
  overlay (`shell.overlay`, up to 78vw / 1200px) with the record list on the
  left and the diff on the right; it shares state with the details panel.
- **Live-ish updates** — the panel refetches the records (and the open diff)
  whenever the conversation window changes, so while the agent edits the
  workspace the worktree record and the diff follow. Refreshes are
  **non-disruptive**: the current diff stays visible while the fresh copy
  loads, and a failed refresh keeps the last diff with an error note.
- **Mobile (dsh-mobile)** — the client sets `data-dshm-details-page` on
  `<html>`, opting the details column into dsh-mobile's pager as a third
  full-width page right of the chat (sidebar | chat | ThreadTrail): a left
  swipe from the chat page reveals it, and a back button (mobile-only)
  scrolls back to the chat. The wide-overlay expand button is hidden on
  phones (the panel is already full-width there). Inert without dsh-mobile.

## How it loads

TypeScript/TSX in `src/` is bundled by **esbuild** (`build/build.mjs`) into a
classic-script module-loader bundle at `dist/client.js`. The bundle is wrapped
in the loader contract:

```js
window.__ModuleLoader__.load({
  id: "threadtrail-client",
  factory: function (require) { /* bundled modules */ return ThreadTrailClient; },
});
```

Nesting the bundle inside the factory is what makes its external
`require("react")` calls resolve through the loader's module table at runtime
(`react` is never bundled). `exports["./client"]` points at `dist/client.js`,
and the package's `dsh.client` declaration tells the modules node half to
serve it under `/plugins/threadtrail-client/client.js` regardless.

Source layout: `client.ts` (entry: apply + exports), `store.ts` (shared
diff-compare store), `format.ts`, `icons.tsx` (hand-written SVG icons),
`highlighter.tsx` (syntax highlighting), `css.ts` (stylesheet), and
`components/` (`panel.tsx`, `records.tsx`, `diffview.tsx`, `overlay.tsx`,
`footer.tsx`).

## Build & test

```sh
pnpm build      # esbuild → dist/client.js (loader-wrapped)
pnpm typecheck  # tsc --noEmit
pnpm test       # node --test test/ (module-loader contract harness)
```

## Install (web profile)

Build first (the profile receives the built bundle):

```sh
pnpm build   # esbuild → dist/client.js
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
