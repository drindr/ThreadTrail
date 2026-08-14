/**
 * The wide overlay (`shell.overlay`) hosting the same worktree review as the
 * details panel, in a side-by-side tree + viewer layout. Also the entry the
 * sidebar footer opens, so the workspace is browsable before any modification
 * (blank/pre-conversation sessions included).
 */

import { createElement, Fragment, useEffect } from 'react';
import type { ReactElement } from 'react';
import { worktreeStore, useWorktree } from '../store.ts';
import { renderTreeList, renderViewer } from './worktree.tsx';
import { closeIcon } from '../icons.tsx';

export interface WorktreeOverlayProps {
  useSessions?: <R>(selector: (s: { current?: string }) => R) => R;
}

export function WorktreeOverlay(props: WorktreeOverlayProps): ReactElement | null {
  const wt = useWorktree();
  const useSessions = props.useSessions;
  // Any current session qualifies — including a blank (pre-conversation)
  // session, so the workspace can be browsed before the first modification.
  const currentId = useSessions ? useSessions((s) => (s.current !== undefined ? s.current : undefined)) : undefined;
  const sessionId = wt.sessionId || currentId;
  useEffect(() => {
    if (sessionId && wt.tree === null && !wt.treeError) void worktreeStore.fetchTree(sessionId);
  }, [sessionId, wt.tree, wt.treeError]);
  if (!wt.overlayOpen || !sessionId) return null;

  return (
    <Fragment>
      <div className="ddb-overlay-backdrop" onClick={() => worktreeStore.closeOverlay()} />
      <div className="ddb-overlay">
        <div className="ddb-overlay-head">
          <span className="ddb-overlay-title">ThreadTrail — worktree review</span>
          <span className="ddb-overlay-session">{sessionId}</span>
          <button type="button" className="ddb-iconbtn" title="close" onClick={() => worktreeStore.closeOverlay()}>
            {closeIcon(14)}
          </button>
        </div>
        <div className="ddb-overlay-body">
          <div className="ddb-worksplit">
            <div className="ddb-worksplit-tree">{renderTreeList(wt, (rel) => void worktreeStore.openFile(sessionId, rel))}</div>
            <div className="ddb-worksplit-viewer">
              {wt.openPath ? renderViewer(wt, sessionId, () => {}) : <div className="ddb-note">Select a file on the left to review it.</div>}
            </div>
          </div>
        </div>
      </div>
    </Fragment>
  );
}
