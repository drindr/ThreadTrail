/**
 * The details-column panel: the record picker (commits + the uncommitted
 * worktree record) and the diff between the two picked records. Load once per
 * session only when requested; workspace updates are explicitly loaded by the user.
 */

import { createElement, useEffect } from 'react';
import type { ReactElement } from 'react';
import { diffStore, useDiffStore } from '../store.ts';
import { CompareBar, RecordsList } from './records.tsx';
import { DiffView } from './diffview.tsx';
import { backIcon, expandIcon, refreshIcon } from '../icons.tsx';

/** Mobile (dsh-mobile) return-to-chat: the details panel is the pager's
 *  right-hand page, so scroll the frame one full page left — the pager's
 *  scroll-snap and settle re-snap land it exactly on the chat page. No-op
 *  without dsh-mobile (the frame selector matches nothing scrollable). */
function scrollPagerToChat(): void {
  const frame = document.querySelector('div:has(> [data-shell-overlay])');
  if (frame instanceof HTMLElement && frame.clientWidth > 0) {
    frame.scrollBy({ left: -frame.clientWidth, behavior: 'smooth' });
  }
}

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
  const state = useDiffStore();

  // Reset per-session view state.
  useEffect(() => {
    if (sessionId) diffStore.reset(sessionId);
  }, [sessionId]);

  // Deliberately no polling, turn-edge, visibility or intersection refresh.
  // A changing workspace stays a stable snapshot until Refresh is clicked.

  // Auto-open the details column once the session's records have loaded, so
  // the panel is discoverable. Gated on records (not the removed chat-nodes
  // field): a non-git workspace records nothing and stays closed.
  const hasRecords = !!state.records && state.records.isRepo && (state.records.records.length > 0 || state.records.head !== null || (state.records.worktree !== null && state.records.worktree.changed + state.records.worktree.untracked > 0));
  useEffect(() => {
    if (!sessionId || !hasRecords) return;
    const t = setTimeout(() => {
      try {
        props.openDetails?.();
      } catch {
        /* layout panel actions not wired yet — fine */
      }
    }, 150);
    return () => clearTimeout(t);
  }, [sessionId, hasRecords, props.openDetails]);

  if (!sessionId) {
    return <div className="ddb-empty">Open a session to compare its git records.</div>;
  }

  return (
    <div className="ddb-root">
      <div className="ddb-header">
        <button type="button" className="ddb-iconbtn ddb-backbtn" title="Back to chat" onClick={scrollPagerToChat}>
          {backIcon(14)}
        </button>
        <div className="ddb-title">
          <span className="ddb-title-main">ThreadTrail</span>
          <span className="ddb-title-sub">git log · compare records</span>
        </div>
        <div className="ddb-header-actions">
          <button type="button" className="ddb-iconbtn ddb-expandbtn" title="Expand to wide view" onClick={() => diffStore.openOverlay(sessionId)}>
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
