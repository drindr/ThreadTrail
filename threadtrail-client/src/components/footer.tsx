/**
 * Sidebar footer entry (always visible): open the worktree review for the
 * current session. The details column is hidden while a session is still
 * blank (before the first message/modification), so this is the entry that
 * makes "browse the code before the modification occurs" possible.
 */

import { createElement } from 'react';
import type { ReactElement } from 'react';
import { worktreeStore } from '../store.ts';
import { expandIcon } from '../icons.tsx';

export interface WorktreeFooterActionProps {
  useSessions?: <R>(selector: (s: { current?: string }) => R) => R;
  wide?: boolean;
}

export function WorktreeFooterAction(props: WorktreeFooterActionProps): ReactElement | null {
  const useSessions = props.useSessions;
  const currentId = useSessions ? useSessions((s) => (s.current !== undefined ? s.current : undefined)) : undefined;
  if (!currentId) return null;
  return (
    <button
      type="button"
      className={'ddb-footbtn' + (props.wide ? ' ddb-footbtn-wide' : '')}
      title="ThreadTrail — browse the workspace"
      onClick={() => worktreeStore.openOverlay(currentId)}
    >
      <span className="ddb-footbtn-icon">{expandIcon(14)}</span>
      {props.wide ? <span className="ddb-footbtn-label">ThreadTrail</span> : null}
    </button>
  );
}
