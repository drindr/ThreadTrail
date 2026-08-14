/**
 * The Timeline tab: ops grouped by turn, plus the op detail view with the
 * syntax-highlighted unified diff, the driving prompt, and rewind.
 */

import { createElement, Fragment } from 'react';
import type { ReactElement } from 'react';
import { detectLang, createHighlighter, renderTokens } from '../highlighter.tsx';
import { fmtTime } from '../format.ts';
import type { Digest, DigestOpSummary, OpDetail, RewindInfo } from '../types.ts';

/** Note shown when the op list was reset (after a commit, or manually). */
export function cleanNote(digest: Digest | null): ReactElement | null {
  const lc = digest && digest.lastClean;
  if (!lc) return null;
  const what = lc.trigger === 'commit' ? `reset after commit ${lc.sha ? lc.sha.slice(0, 8) : '?'}` : 'reset manually';
  return <div className="ddb-note ddb-clean-note">Op list {what} · {fmtTime(lc.time)} — the timeline shows only edits since then.</div>;
}

export function renderTimeline(
  byTurn: Map<number, DigestOpSummary[]>,
  manual: DigestOpSummary[],
  _ops: DigestOpSummary[],
  openOp: (opId: string) => void,
): ReactElement {
  const children: ReactElement[] = [];
  const turns = [...byTurn.keys()].sort((a, b) => b - a);
  for (const turn of turns) {
    const list = byTurn.get(turn) ?? [];
    children.push(
      <div key={`t${turn}`} className="ddb-group">
        <div className="ddb-group-label">turn {turn}</div>
        {list.map((op) => opRow(op, openOp))}
      </div>,
    );
  }
  if (manual.length) {
    children.push(
      <div key="manual" className="ddb-group">
        <div className="ddb-group-label">manual edits</div>
        {manual.map((op) => opRow(op, openOp))}
      </div>,
    );
  }
  return <Fragment>{children}</Fragment>;
}

function opRow(op: DigestOpSummary, openOp: (opId: string) => void): ReactElement {
  const files = op.files.map((f, i) => (
    <span key={i} className={'ddb-file' + (f.deleted ? ' ddb-file-del' : '')}>
      {f.path}
      {!f.deleted && (f.added || f.removed) ? <span className="ddb-delta">+{f.added}/-{f.removed}</span> : null}
    </span>
  ));
  return (
    <button key={op.id} type="button" className="ddb-op" onClick={() => openOp(op.id)}>
      <div className="ddb-op-head">
        <span className="ddb-op-id">{op.id}</span>
        <span className="ddb-op-time">{fmtTime(op.time)}</span>
        <span className="ddb-op-kind">{op.kind === 'manual' ? 'manual' : `turn ${op.turn}`}</span>
      </div>
      <div className="ddb-op-files">{files}</div>
    </button>
  );
}

/** Op detail: diff lines are syntax-highlighted by each file's language. */
export function renderOpDetail(
  rec: OpDetail,
  rewindInfo: RewindInfo | null,
  doRewind: (opId: string) => void,
  close: (fn?: () => void) => void,
): ReactElement {
  const fileRows = rec.files.map((f, i) => {
    const lang = detectLang(f.path);
    const hl = createHighlighter(lang);
    let diffEl: ReactElement | null = null;
    if (!f.deleted && Array.isArray(f.diff)) {
      const lines = f.diff.map((l, j) => (
        <div key={j} className={`ddb-line ddb-line-${l.t}`}>
          <span className="ddb-line-mark">{l.t === ' ' ? ' ' : l.t}</span>
          <span className="ddb-line-text">{renderTokens(hl(l.text), `d${i}-${j}`)}</span>
        </div>
      ));
      diffEl = <div className="ddb-diff">{lines}</div>;
    }
    return (
      <div key={i} className="ddb-opfile">
        <div className="ddb-opfile-head">
          <span className="ddb-opfile-path">{f.path}</span>
          <span className="ddb-opfile-stats">{f.deleted ? 'deleted' : `+${f.added}/-${f.removed}`}</span>
        </div>
        {diffEl}
      </div>
    );
  });

  const rewindEl = rewindInfo ? (
    <div className="ddb-rewind">
      {'pending' in rewindInfo ? (
        'Rewinding…'
      ) : 'err' in rewindInfo ? (
        `Rewind failed: ${rewindInfo.err}`
      ) : (
        `Materialized into ${rewindInfo.target} (${rewindInfo.count} files)`
      )}
    </div>
  ) : null;

  return (
    <div className="ddb-detail">
      <div className="ddb-detail-head">
        <button type="button" className="ddb-back" onClick={() => close()}>← back</button>
        <span className="ddb-detail-id">{rec.id}</span>
        <span className="ddb-detail-meta">
          {rec.kind === 'manual' ? 'manual edit' : `turn ${rec.turn}`}
          {rec.userMessageSeq != null ? ` · prompt seq ${rec.userMessageSeq}` : ''}
          {rec.assistantSeqs && rec.assistantSeqs.length ? ` · assistant ${rec.assistantSeqs.join(',')}` : ''}
        </span>
      </div>
      {rec.prompt ? (
        <div className="ddb-prompt">
          <div className="ddb-prompt-label">prompt that drove this change</div>
          <div className="ddb-prompt-text">{rec.prompt}</div>
        </div>
      ) : null}
      <button type="button" className="ddb-rewind-btn" onClick={() => doRewind(rec.id)}>
        rewind workspace to this point (non-destructive)
      </button>
      {rewindEl}
      <div className="ddb-detail-files">{fileRows}</div>
    </div>
  );
}
