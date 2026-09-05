/**
 * The details-column panel: the record picker (commits + the uncommitted
 * worktree record) and the diff between the two picked records, with the
 * realtime refresh wired to the conversation window (while the agent works,
 * the worktree record moves and the diff follows).
 */

import { createElement, Fragment, useEffect, useRef } from 'react';
import type { ReactElement } from 'react';
import { diffStore, useDiffStore } from '../store.ts';
import { CompareBar, RecordsList } from './records.tsx';
import { DiffView } from './diffview.tsx';
import { backIcon, expandIcon, refreshIcon } from '../icons.tsx';

/** True only while the page AND the panel itself are on screen. Polling a
 *  hidden panel (closed details column, background tab, offscreen pager page)
 *  burns host git spawns and client re-renders for nothing. */
function panelVisible(root: HTMLElement | null, onScreen: boolean): boolean {
  if (document.visibilityState !== 'visible') return false;
  // IntersectionObserver state: an offscreen pager page (dsh-mobile's third
  // page) has layout but is scrolled out of the viewport — not visible.
  if (!onScreen) return false;
  if (root === null || !root.isConnected) return false;
  // checkVisibility covers display:none ancestors (closed details column);
  // older engines without it fall back to "mounted is enough".
  return typeof root.checkVisibility === 'function' ? root.checkVisibility() : true;
}

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
  const useSession = props.useSession;
  // DSH ≥ 0.1.2: the session snapshot no longer carries chat `nodes` (chunk-row
  // projections moved behind the keyed `projection` hook) — the live activity
  // signal is `running`. Turn edges (start/finish) are exactly when the
  // worktree record is worth re-reading.
  const running = useSession ? useSession((s) => !!(s && (s as { running?: boolean }).running)) : false;
  const state = useDiffStore();
  const rootRef = useRef<HTMLDivElement>(null);
  /** Viewport-intersection state, kept by the observer below. Starts true so
   *  pre-IO ticks behave; the observer's initial callback corrects it. */
  const onScreenRef = useRef(true);

  // Reset per-session view state.
  useEffect(() => {
    if (sessionId) diffStore.reset(sessionId);
  }, [sessionId]);

  // Realtime: refetch records (and the open diff) on turn edges — the worktree
  // record moves as the agent edits the workspace. While a turn runs, poll so
  // the panel follows file edits live instead of only updating at the end.
  // Every tick is visibility-gated: a hidden panel or background tab neither
  // polls nor re-renders, and becoming visible again triggers one refresh.
  useEffect(() => {
    if (!sessionId) return;
    const tick = (): void => {
      // The initial load runs even while hidden (its records drive the
      // auto-open below); only repeat refreshes are gated on visibility.
      if (diffStore.get().records !== null && !panelVisible(rootRef.current, onScreenRef.current)) return;
      diffStore.refresh(sessionId);
    };
    const timer = setTimeout(tick, running ? 400 : 0);
    const poll = running ? setInterval(tick, 4000) : undefined;
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') tick();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearTimeout(timer);
      if (poll !== undefined) clearInterval(poll);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [sessionId, running]);

  // Refresh once when the panel itself scrolls/opens into view (details
  // column reopened, mobile pager swiped to it) — visibility-gated ticks skip
  // those stretches, so the first visible moment catches up.
  useEffect(() => {
    const el = rootRef.current;
    if (!sessionId || el === null || typeof IntersectionObserver !== 'function') return;
    let wasVisible = false;
    const io = new IntersectionObserver((entries) => {
      const visible = entries.some((entry) => entry.isIntersecting);
      onScreenRef.current = visible;
      if (visible && !wasVisible && document.visibilityState === 'visible') diffStore.refresh(sessionId);
      wasVisible = visible;
    });
    io.observe(el);
    return () => io.disconnect();
  }, [sessionId]);

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
    <div className="ddb-root" ref={rootRef}>
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
