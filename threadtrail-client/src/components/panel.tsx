/**
 * The details-column panel: header (clean / expand / refresh), timeline ⇄
 * worktree tabs, and the realtime digest refresh wired to the conversation
 * window.
 */

import { createElement, Fragment, useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { hostFetch } from '../format.ts';
import { worktreeStore, useWorktree } from '../store.ts';
import { cleanNote, renderOpDetail, renderTimeline } from './timeline.tsx';
import { WorktreeView } from './worktree.tsx';
import { cleanIcon, expandIcon, refreshIcon } from '../icons.tsx';
import type { Digest, DigestOpSummary, OpDetail, RewindInfo } from '../types.ts';

/** Selector-hook shapes the shell passes to slot entries. */
export type SelectorHook<T> = <R>(selector: (state: T) => R) => R;

export interface DeltaPanelProps {
  sessionId?: string;
  useSession?: SelectorHook<unknown>;
  useSessions?: SelectorHook<unknown>;
  openDetails?: () => void;
}

export function DeltaPanel(props: DeltaPanelProps): ReactElement {
  const sessionId = props.sessionId;
  const useSession = props.useSession;
  const useSessions = props.useSessions;
  const windowLen = useSession ? useSession((s) => (s && (s as { nodes?: unknown[] }).nodes ? (s as { nodes: unknown[] }).nodes.length : 0)) : 0;
  const wt = useWorktree();

  const [digest, setDigest] = useState<Digest | null>(null);
  const [opRecord, setOpRecord] = useState<OpDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rewindInfo, setRewindInfo] = useState<RewindInfo | null>(null);
  const [tab, setTab] = useState<'timeline' | 'worktree'>('timeline');

  // The details column is narrow (ui-layout caps it at 520px), so entering
  // the worktree tab auto-opens the wide overlay review — unless the user
  // dismissed it for this session (they can reopen via the expand icon or the banner).
  const selectTab = (next: 'timeline' | 'worktree'): void => {
    setTab(next);
    if (next === 'worktree' && sessionId && !wt.overlayOpen && !wt.overlayDismissed) {
      worktreeStore.openOverlay(sessionId);
    }
  };

  const fetchDigest = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      if (!sessionId) return;
      try {
        const d = await hostFetch(`/threadtrail/${encodeURIComponent(sessionId)}/digest.json`, signal);
        setDigest(d as Digest);
        setError(null);
      } catch (e) {
        if (!(e instanceof DOMException && e.name === 'AbortError')) setError(e instanceof Error ? e.message : String(e));
      }
    },
    [sessionId],
  );

  // Refetch digest (and the open worktree file) on session/window change:
  // that is the "realtime worktree review" — every conversation change
  // re-reads the current file while the agent works.
  useEffect(() => {
    if (!sessionId) return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      void fetchDigest(ctrl.signal);
      worktreeStore.refreshOpen(sessionId);
    }, windowLen === 0 ? 0 : 400);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [sessionId, windowLen, fetchDigest]);

  // Reset per-session view state.
  useEffect(() => {
    setOpRecord(null);
    setRewindInfo(null);
    setError(null);
    if (sessionId) worktreeStore.reset(sessionId);
  }, [sessionId]);

  // Auto-open the details column when a session with conversation is
  // selected so the panel is discoverable.
  useEffect(() => {
    if (!sessionId || windowLen === 0) return;
    const t = setTimeout(() => {
      try {
        props.openDetails?.();
      } catch {
        /* layout panel actions not wired yet — fine */
      }
    }, 150);
    return () => clearTimeout(t);
  }, [sessionId, windowLen, props.openDetails]);

  if (!sessionId) {
    return <div className="ddb-empty">Open a session to see its edit history.</div>;
  }

  const ops: DigestOpSummary[] = digest ? digest.ops : [];

  const openOp = (opId: string): void => {
    setRewindInfo(null);
    hostFetch(`/threadtrail/${encodeURIComponent(sessionId)}/op/${encodeURIComponent(opId)}.json`)
      .then(setOpRecord)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };

  const doRewind = (opId: string): void => {
    setRewindInfo({ pending: opId });
    hostFetch(`/threadtrail/${encodeURIComponent(sessionId)}/rewind/${encodeURIComponent(opId)}.json`)
      .then((r) => setRewindInfo({ ok: true, target: r.target, count: r.files.length }))
      .catch((e) => setRewindInfo({ err: e instanceof Error ? e.message : String(e) }));
  };

  const doClean = (): void => {
    if (!window.confirm('Clean the captured op list? Safe after a commit — the workspace state is preserved in git. Uncommitted edits in the log would be lost.')) return;
    hostFetch(`/threadtrail/${encodeURIComponent(sessionId)}/clean`, undefined, { method: 'POST' })
      .then(() => {
        setOpRecord(null);
        return fetchDigest();
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };

  const grouped: DigestOpSummary[] = [];
  const manual: DigestOpSummary[] = [];
  for (const op of ops) {
    (op.turn == null ? manual : grouped).push(op);
  }
  grouped.reverse(); // newest turn first
  const byTurn = new Map<number, DigestOpSummary[]>();
  for (const op of grouped) {
    const list = byTurn.get(op.turn as number) || [];
    list.push(op);
    byTurn.set(op.turn as number, list);
  }

  const header = (
    <div className="ddb-header">
      <div className="ddb-title">
        <span className="ddb-title-main">ThreadTrail</span>
        <span className="ddb-title-sub">software is made between commits</span>
      </div>
      <div className="ddb-header-actions">
        <button
          type="button"
          className="ddb-iconbtn"
          title="Clean the op list — safe after a commit (the workspace state is in git)"
          onClick={doClean}
        >
          {cleanIcon(14)}
        </button>
        <button type="button" className="ddb-iconbtn" title="Expand worktree" onClick={() => worktreeStore.openOverlay(sessionId)}>
          {expandIcon(14)}
        </button>
        <button type="button" className="ddb-iconbtn" title="Refresh" onClick={() => void fetchDigest()}>
          {refreshIcon(14)}
        </button>
      </div>
    </div>
  );

  let body: ReactElement;
  if (error && !digest) {
    body = <div className="ddb-note ddb-error">ThreadTrail host: {error}</div>;
  } else if (!digest) {
    body = <div className="ddb-note">Loading…</div>;
  } else if (opRecord) {
    body = renderOpDetail(opRecord, rewindInfo, doRewind, (fn) => {
      setOpRecord(null);
      fn && fn();
    });
  } else if (tab === 'worktree') {
    body = <WorktreeView sessionId={sessionId} onOpenOp={openOp} />;
  } else {
    body = (
      <Fragment>
        {cleanNote(digest)}
        {renderTimeline(byTurn, manual, ops, openOp)}
      </Fragment>
    );
  }

  const tabs = (
    <div className="ddb-tabs">
      <button
        type="button"
        className={tab === 'timeline' ? 'ddb-tab ddb-tab-active' : 'ddb-tab'}
        onClick={() => selectTab('timeline')}
      >
        Timeline
      </button>
      <button
        type="button"
        className={tab === 'worktree' ? 'ddb-tab ddb-tab-active' : 'ddb-tab'}
        onClick={() => selectTab('worktree')}
      >
        Worktree
      </button>
    </div>
  );

  return (
    <div className="ddb-root">
      {header}
      {tabs}
      <div className="ddb-body">{body}</div>
    </div>
  );
}
