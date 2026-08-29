/**
 * Sidebar footer entry (always visible): open the wide git-diff compare for
 * the current session. The details column is hidden while a session is still
 * blank (before the first message), so this is the entry that makes the
 * records browsable from the very start.
 */

import { createElement } from 'react';
import type { ReactElement } from 'react';
import { diffStore } from '../store.ts';
import { expandIcon } from '../icons.tsx';

export interface DiffFooterActionProps {
  useSessions?: <R>(selector: (s: { current?: string }) => R) => R;
  wide?: boolean;
}

export function DiffFooterAction(props: DiffFooterActionProps): ReactElement | null {
  const useSessions = props.useSessions;
  const currentId = useSessions ? useSessions((s) => (s.current !== undefined ? s.current : undefined)) : undefined;
  if (!currentId) return null;
  return (
    <button
      type="button"
      className={'ddb-footbtn' + (props.wide ? ' ddb-footbtn-wide' : '')}
      title="ThreadTrail — compare git records"
      onClick={() => diffStore.openOverlay(currentId)}
    >
      <span className="ddb-footbtn-icon">{expandIcon(14)}</span>
      {props.wide ? <span className="ddb-footbtn-label">ThreadTrail</span> : null}
    </button>
  );
}
