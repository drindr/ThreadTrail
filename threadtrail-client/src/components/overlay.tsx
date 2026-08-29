/**
 * The wide overlay (`shell.overlay`) hosting the same record picker + diff as
 * the details panel, in a side-by-side layout (the details column is capped
 * at 520px; diffs want width). Also the entry the sidebar footer opens.
 */

import { createElement, Fragment, useEffect } from 'react';
import type { ReactElement } from 'react';
import { diffStore, useDiffStore } from '../store.ts';
import { CompareBar, RecordsList } from './records.tsx';
import { DiffView } from './diffview.tsx';
import { closeIcon } from '../icons.tsx';

export interface DiffOverlayProps {
  useSessions?: <R>(selector: (s: { current?: string }) => R) => R;
}

export function DiffOverlay(props: DiffOverlayProps): ReactElement | null {
  const state = useDiffStore();
  const useSessions = props.useSessions;
  // Any current session qualifies — including a blank (pre-conversation)
  // session, so the records can be browsed before the first message.
  const currentId = useSessions ? useSessions((s) => (s.current !== undefined ? s.current : undefined)) : undefined;
  const sessionId = state.sessionId || currentId;

  useEffect(() => {
    if (state.overlayOpen && sessionId && !state.records && !state.recordsError) void diffStore.fetchRecords(sessionId);
  }, [state.overlayOpen, sessionId, state.records, state.recordsError]);

  if (!state.overlayOpen || !sessionId) return null;

  return (
    <Fragment>
      <div className="ddb-overlay-backdrop" onClick={() => diffStore.closeOverlay()} />
      <div className="ddb-overlay">
        <div className="ddb-overlay-head">
          <span className="ddb-overlay-title">ThreadTrail — git diff compare</span>
          <span className="ddb-overlay-session">{sessionId}</span>
          <button type="button" className="ddb-iconbtn" title="close" onClick={() => diffStore.closeOverlay()}>
            {closeIcon(14)}
          </button>
        </div>
        <div className="ddb-overlay-body">
          <div className="ddb-worksplit">
            <div className="ddb-worksplit-tree">
              <CompareBar state={state} sessionId={sessionId} />
              <RecordsList state={state} sessionId={sessionId} />
            </div>
            <div className="ddb-worksplit-viewer">
              <DiffView state={state} sessionId={sessionId} />
            </div>
          </div>
        </div>
      </div>
    </Fragment>
  );
}
