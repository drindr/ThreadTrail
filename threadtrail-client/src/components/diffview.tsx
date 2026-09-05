/**
 * The diff view: the unified diff between the two picked records, per file,
 * with syntax-highlighted hunk lines.
 */

import { createElement, Fragment, memo, useCallback, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { detectLang, createHighlighter, renderTokens } from '../highlighter.tsx';
import { diffStore } from '../store.ts';
import type { DiffState } from '../store.ts';
import type { DiffFile, DiffResult } from '../types.ts';
import { chevronIcon, refreshIcon } from '../icons.tsx';

const STATUS_LABEL: Record<DiffFile['status'], string> = {
  added: 'added',
  modified: 'modified',
  deleted: 'deleted',
  renamed: 'renamed',
};

/** The diff between the two picked records (or the selection hint). */
export function DiffView({ state, sessionId }: { state: DiffState; sessionId: string }): ReactElement {
  if (!state.from || !state.to) {
    return <div className="ddb-note">Click a record above to view its changes, or use the F/T chips to pick two records to compare — the worktree record stands for the uncommitted changes.</div>;
  }
  if (state.diffError && !state.diff) {
    return <div className="ddb-note ddb-error">Diff failed: {state.diffError}</div>;
  }
  if (!state.diff) {
    return <div className="ddb-note">{state.diffLoading ? 'Computing diff…' : ''}</div>;
  }
  return <DiffResultView state={state} diff={state.diff} sessionId={sessionId} />;
}

function DiffResultView({ state, diff, sessionId }: { state: DiffState; diff: DiffResult; sessionId: string }): ReactElement {
  // Collapsed files, keyed by path. Lives here (not in FileDiff) so the
  // collapse-all button can drive it, and survives realtime diff refreshes.
  // A large diff starts fully collapsed: rendering thousands of highlighted
  // lines the user never opened is the panel's single most expensive
  // operation, and the file heads already carry the +/-/status summary.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => {
    let lines = 0;
    for (const f of diff.files) for (const h of f.hunks) lines += h.lines.length;
    return lines > 1500 ? new Set(diff.files.map((f) => f.path)) : new Set();
  });
  const totals = useMemo(() => {
    let added = 0;
    let removed = 0;
    for (const f of diff.files) {
      added += f.added;
      removed += f.removed;
    }
    return { added, removed };
  }, [diff]);

  const toggleFile = useCallback((path: string): void => {
    // Functional update keeps this callback referentially stable, which is
    // what lets the memoized FileDiff below bail out on unchanged polls.
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);
  const allCollapsed = diff.files.length > 0 && diff.files.every((f) => collapsed.has(f.path));
  const toggleAll = (): void => {
    setCollapsed(allCollapsed ? new Set() : new Set(diff.files.map((f) => f.path)));
  };

  if (!diff.files.length) {
    return <div className="ddb-note">No differences between these two records.</div>;
  }
  return (
    <Fragment>
      <div className="ddb-diff-summary">
        <span>
          {diff.files.length} file{diff.files.length === 1 ? '' : 's'} · <span className="ddb-stat-add">+{totals.added}</span>{' '}
          <span className="ddb-stat-del">-{totals.removed}</span>
        </span>
        {state.diffRefreshing ? <span className="ddb-refreshing">refreshing…</span> : null}
        {diff.truncated ? <span className="ddb-diff-truncated">diff truncated (too large)</span> : null}
        <button type="button" className="ddb-iconbtn" title={allCollapsed ? 'Expand all files' : 'Collapse all files'} onClick={toggleAll}>
          <span className={'ddb-chevron' + (allCollapsed ? ' ddb-chevron-collapsed' : '')}>{chevronIcon(13)}</span>
        </button>
        <button type="button" className="ddb-iconbtn" title="Recompute diff" onClick={() => void diffStore.fetchDiff(sessionId)}>
          {refreshIcon(13)}
        </button>
      </div>
      {state.diffError ? <div className="ddb-note ddb-error">refresh failed: {state.diffError} — showing the last diff</div> : null}
      {diff.files.map((f) => (
        <FileDiff key={f.path} file={f} collapsed={collapsed.has(f.path)} onToggleFile={toggleFile} />
      ))}
    </Fragment>
  );
}

/** Memoized: the diff store keeps file objects referentially stable when a
 *  poll returns unchanged content, so an unchanged poll never re-tokenizes a
 *  single line. */
const FileDiff = memo(function FileDiff({ file, collapsed, onToggleFile }: { file: DiffFile; collapsed: boolean; onToggleFile: (path: string) => void }): ReactElement {
  const lang = detectLang(file.path);
  const hl = useMemo(() => createHighlighter(lang), [lang]);
  return (
    <div className="ddb-opfile">
      <div
        className="ddb-opfile-head ddb-opfile-toggle"
        role="button"
        title={collapsed ? 'Expand this file' : 'Collapse this file'}
        onClick={() => onToggleFile(file.path)}
      >
        <span className={'ddb-chevron' + (collapsed ? ' ddb-chevron-collapsed' : '')}>{chevronIcon(12)}</span>
        <span className="ddb-opfile-path" title={file.oldPath && file.oldPath !== file.path ? `${file.oldPath} → ${file.path}` : file.path}>
          {file.oldPath && file.status === 'renamed' ? `${file.oldPath} → ${file.path}` : file.path}
        </span>
        <span className="ddb-opfile-stats">
          <span className={`ddb-status ddb-status-${file.status}`}>{STATUS_LABEL[file.status]}</span>{' '}
          {file.binary ? 'binary' : `+${file.added}/-${file.removed}`}
          {file.truncated ? ' · truncated' : ''}
        </span>
      </div>
      {collapsed ? null : file.hunks.length ? (
        <div className="ddb-diff">
          {file.hunks.map((h, hi) => (
            <Fragment key={hi}>
              <div className="ddb-hunk-head">
                @@ -{h.oldStart},{h.oldLines} +{h.newStart},{h.newLines} @@ {h.header}
              </div>
              {h.lines.map((l, li) => (
                <div key={li} className={`ddb-line ddb-line-${l.t}`}>
                  <span className="ddb-line-mark">{l.t === ' ' ? ' ' : l.t}</span>
                  <span className="ddb-line-text">{renderTokens(hl(l.text), `h${hi}-${li}`)}</span>
                </div>
              ))}
            </Fragment>
          ))}
        </div>
      ) : file.binary ? (
        <div className="ddb-note">Binary file — no text diff.</div>
      ) : file.status === 'renamed' ? (
        <div className="ddb-note">Renamed without content changes.</div>
      ) : null}
    </div>
  );
});
