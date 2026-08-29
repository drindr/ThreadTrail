/**
 * The record list — the workspace's git log timeline: the uncommitted
 * worktree state first, then the commits newest first, and the empty tree at
 * the end. Clicking a row views that record git-log style (a commit against
 * its parent, the worktree against HEAD); the F/T chips on each row pick the
 * two records to compare. The compare bar above shows the current pair.
 */

import { createElement, Fragment } from 'react';
import type { ReactElement } from 'react';
import { fmtTime } from '../format.ts';
import { diffStore } from '../store.ts';
import type { DiffState } from '../store.ts';
import { EMPTY_ID, WORKTREE_ID } from '../types.ts';
import type { RecordInfo } from '../types.ts';
import { swapIcon, clearIcon } from '../icons.tsx';

/** Short label for a record id (for the compare bar). */
export function recordLabel(state: DiffState, id: string | null): string {
  if (!id) return '…';
  if (id === WORKTREE_ID) return 'worktree';
  if (id === EMPTY_ID) return 'empty';
  const rec = state.records?.records.find((r) => r.id === id);
  return rec?.shortSha ?? id.slice(0, 8);
}

/** The compare bar: the picked pair, swap, and clear. */
export function CompareBar({ state, sessionId }: { state: DiffState; sessionId: string }): ReactElement {
  const both = state.from && state.to;
  return (
    <div className="ddb-compare">
      <span className={'ddb-compare-slot' + (state.from ? ' ddb-compare-from' : '')} title={state.from ?? undefined}>
        {recordLabel(state, state.from)}
      </span>
      <span className="ddb-compare-arrow">→</span>
      <span className={'ddb-compare-slot' + (state.to ? ' ddb-compare-to' : '')} title={state.to ?? undefined}>
        {recordLabel(state, state.to)}
      </span>
      <button
        type="button"
        className="ddb-iconbtn"
        title="Swap the two records"
        disabled={!both}
        onClick={() => diffStore.swap(sessionId)}
      >
        {swapIcon(13)}
      </button>
      <button type="button" className="ddb-iconbtn" title="Clear selection" disabled={!state.from && !state.to} onClick={() => diffStore.clearSelection()}>
        {clearIcon(13)}
      </button>
    </div>
  );
}

/** The git-log record list. */
export function RecordsList({ state, sessionId }: { state: DiffState; sessionId: string }): ReactElement {
  const records = state.records;
  if (state.recordsError && !records) {
    return <div className="ddb-note ddb-error">{state.recordsError}</div>;
  }
  if (!records) {
    return <div className="ddb-note">Loading records…</div>;
  }
  if (!records.isRepo) {
    return <NoRepoView state={state} sessionId={sessionId} />;
  }
  if (!records.gitAvailable) {
    return <div className="ddb-note ddb-error">The `git` binary is not available on the host, so records cannot be listed.</div>;
  }

  const rows = records.records.map((rec) => (
    <RecordRow key={rec.id} rec={rec} state={state} sessionId={sessionId} />
  ));
  return (
    <Fragment>
      {state.root ? <RootBar state={state} sessionId={sessionId} /> : null}
      <div className="ddb-group-label">git log — click a record to view it · F/T pick two to compare</div>
      <div className="ddb-records">{rows}</div>
    </Fragment>
  );
}

/** The active subfolder root, with a way back to the workspace root. */
function RootBar({ state, sessionId }: { state: DiffState; sessionId: string }): ReactElement {
  return (
    <div className="ddb-rootbar">
      <span className="ddb-rootbar-path" title={state.root}>
        repo: {state.root}
      </span>
      <button type="button" className="ddb-back" onClick={() => diffStore.selectRoot(sessionId, '')}>
        ← workspace root
      </button>
    </div>
  );
}

/** Not a git repository: offer the subfolders that are. */
function NoRepoView({ state, sessionId }: { state: DiffState; sessionId: string }): ReactElement {
  const records = state.records!;
  const candidates = records.candidates ?? [];
  return (
    <Fragment>
      {state.root ? <RootBar state={state} sessionId={sessionId} /> : null}
      <div className="ddb-note">
        {state.root ? `The subfolder ${state.root}` : 'This session’s workspace'} is not a git repository.
      </div>
      {candidates.length ? (
        <Fragment>
          <div className="ddb-group-label">subfolders with a git repository</div>
          <div className="ddb-candidates">
            {candidates.map((rel) => (
              <button key={rel} type="button" className="ddb-candidate" title={rel} onClick={() => diffStore.selectRoot(sessionId, rel)}>
                <span className="ddb-candidate-path">{rel}</span>
              </button>
            ))}
          </div>
        </Fragment>
      ) : (
        <div className="ddb-note">No git repository found in its subfolders either.</div>
      )}
    </Fragment>
  );
}

function RecordRow({ rec, state, sessionId }: { rec: RecordInfo; state: DiffState; sessionId: string }): ReactElement {
  const isFrom = state.from === rec.id;
  const isTo = state.to === rec.id;
  const viewable = rec.kind !== 'empty';
  const cls = 'ddb-record' + (isFrom ? ' ddb-record-from' : '') + (isTo ? ' ddb-record-to' : '');
  return (
    <div
      className={cls}
      role={viewable ? 'button' : undefined}
      title={viewable ? (rec.kind === 'worktree' ? 'view uncommitted changes (vs HEAD)' : `view this commit (vs ${rec.parent ? rec.parent.slice(0, 8) : 'empty tree'})`) : 'the empty tree — comparison base only'}
      onClick={viewable ? () => diffStore.viewRecord(sessionId, rec.id) : undefined}
    >
      <span className="ddb-record-chips">
        <button
          type="button"
          className={'ddb-chip' + (isFrom ? ' ddb-chip-from-on' : '')}
          title="Pick as the comparison base (from)"
          onClick={(e) => {
            e.stopPropagation();
            diffStore.pickFrom(sessionId, rec.id);
          }}
        >
          F
        </button>
        <button
          type="button"
          className={'ddb-chip' + (isTo ? ' ddb-chip-to-on' : '')}
          title="Pick as the comparison target (to)"
          onClick={(e) => {
            e.stopPropagation();
            diffStore.pickTo(sessionId, rec.id);
          }}
        >
          T
        </button>
      </span>
      {rec.kind === 'worktree' ? (
        <Fragment>
          <span className="ddb-record-main">
            <span className="ddb-record-title">uncommitted changes</span>
            <span className="ddb-record-meta">
              {state.records?.worktree
                ? `${state.records.worktree.changed} changed · ${state.records.worktree.untracked} untracked`
                : 'working tree'}
            </span>
          </span>
          <span className="ddb-record-sha">worktree</span>
        </Fragment>
      ) : rec.kind === 'empty' ? (
        <Fragment>
          <span className="ddb-record-main">
            <span className="ddb-record-title ddb-record-dim">empty tree</span>
            <span className="ddb-record-meta">before the first commit</span>
          </span>
          <span className="ddb-record-sha">empty</span>
        </Fragment>
      ) : (
        <Fragment>
          <span className="ddb-record-main">
            <span className="ddb-record-title" title={rec.subject}>
              {rec.subject || '(no subject)'}
            </span>
            <span className="ddb-record-meta">
              {rec.author}
              {rec.time ? ` · ${fmtTime(rec.time)}` : ''}
            </span>
          </span>
          <span className="ddb-record-sha">{rec.shortSha}</span>
        </Fragment>
      )}
    </div>
  );
}
