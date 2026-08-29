/**
 * The details-column panel: the record picker (commits + the uncommitted
 * worktree record) and the diff between the two picked records, with the
 * realtime refresh wired to the conversation window (while the agent works,
 * the worktree record moves and the diff follows).
 */

import { createElement, Fragment, useEffect } from 'react';
import type { ReactElement } from 'react';
import { diffStore, useDiffStore } from '../store.ts';
import { CompareBar, RecordsList } from './records.tsx';
import { DiffView } from './diffview.tsx';
import { expandIcon, refreshIcon } from '../icons.tsx';

/** Selector-hook shapes the shell passes to slot entries. */
export type SelectorHook<T> = <R>(selector: (state: T) => R) => R;

export interface DiffPanelProps {
  sessionId?: string;
  useSession?: SelectorHook<unknown>;
  useSessions?: SelectorHook<unknown>;
  openDetails?: () => void;
}

export function DiffPanel(props: DiffPanelProps): ReactElement {
  const sessionId = props.sessionId;
  const useSession = props.useSession;
  const windowLen = useSession ? useSession((s) => (s && (s as { nodes?: unknown[] }).nodes ? (s as { nodes: unknown[] }).nodes.length : 0)) : 0;
  const state = useDiffStore();

  // Reset per-session view state.
  useEffect(() => {
    if (sessionId) diffStore.reset(sessionId);
  }, [sessionId]);

  // Realtime: refetch records (and the open diff) on conversation change —
  // the worktree record moves as the agent edits the workspace.
  useEffect(() => {
    if (!sessionId) return;
    const timer = setTimeout(() => diffStore.refresh(sessionId), windowLen === 0 ? 0 : 400);
    return () => clearTimeout(timer);
  }, [sessionId, windowLen]);

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
    return <div className="ddb-empty">Open a session to compare its git records.</div>;
  }

  return (
    <div className="ddb-root">
      <div className="ddb-header">
        <div className="ddb-title">
          <span className="ddb-title-main">ThreadTrail</span>
          <span className="ddb-title-sub">git log · compare records</span>
        </div>
        <div className="ddb-header-actions">
          <button type="button" className="ddb-iconbtn" title="Expand to wide view" onClick={() => diffStore.openOverlay(sessionId)}>
            {expandIcon(14)}
          </button>
          <button type="button" className="ddb-iconbtn" title="Refresh" onClick={() => diffStore.refresh(sessionId)}>
            {refreshIcon(14)}
          </button>
        </div>
      </div>
      <div className="ddb-body">
        <CompareBar state={state} sessionId={sessionId} />
        <RecordsList state={state} sessionId={sessionId} />
        <div className="ddb-group-label">diff</div>
        <DiffView state={state} sessionId={sessionId} />
      </div>
    </div>
  );
}
