/**
 * The Worktree tab: file tree list, the syntax-highlighted viewer with
 * changed-line annotations and anchored notes, and the floating note
 * composer. Shared by the details panel and the wide overlay through the
 * worktree store.
 */

import { createElement, Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { detectLang, createHighlighter, renderTokens } from '../highlighter.tsx';
import { fmtSize, fmtTime } from '../format.ts';
import { worktreeStore, useWorktree } from '../store.ts';
import type { WorktreeState } from '../store.ts';
import type { FileOpsEntry, NoteRecord } from '../types.ts';
import { refreshIcon, expandIcon } from '../icons.tsx';

export interface WorktreeViewProps {
  sessionId: string;
  onOpenOp: (opId: string) => void;
}

/** The worktree view (file tree + viewer + notes). */
export function WorktreeView({ sessionId, onOpenOp }: WorktreeViewProps): ReactElement {
  const wt = useWorktree();

  useEffect(() => {
    if (sessionId && wt.tree === null && !wt.treeError) void worktreeStore.fetchTree(sessionId);
  }, [sessionId, wt.tree, wt.treeError]);

  const banner = !wt.overlayOpen ? (
    <button type="button" className="ddb-widen" onClick={() => worktreeStore.openOverlay(sessionId)}>
      {expandIcon(12)} Open wide review (this column is capped at 520px)
    </button>
  ) : null;

  if (!wt.openPath) {
    return (
      <Fragment>
        {banner}
        {renderTreeList(wt, (rel) => void worktreeStore.openFile(sessionId, rel))}
      </Fragment>
    );
  }
  return (
    <Fragment>
      {banner}
      {renderViewer(wt, sessionId, onOpenOp)}
    </Fragment>
  );
}

export function renderTreeList(wt: WorktreeState, openFile: (rel: string) => void): ReactElement {
  const head = (
    <div className="ddb-tree-head">
      <span className="ddb-tree-count">{wt.tree ? `${wt.tree.files.length} files` : '…'}</span>
      <button
        type="button"
        className="ddb-iconbtn"
        title="Refresh file list"
        onClick={() => wt.sessionId && void worktreeStore.fetchTree(wt.sessionId)}
      >
        {refreshIcon(14)}
      </button>
    </div>
  );
  if (wt.treeError) {
    const noWs = /no workspace/i.test(wt.treeError);
    return (
      <Fragment>
        {head}
        <div className={'ddb-note' + (noWs ? '' : ' ddb-error')}>
          {noWs
            ? 'This session has no workspace yet — pick a directory for it (workspace picker), then browse its code here.'
            : `Worktree: ${wt.treeError}`}
        </div>
      </Fragment>
    );
  }
  if (!wt.tree) {
    return (
      <Fragment>
        {head}
        <div className="ddb-note">Loading worktree…</div>
      </Fragment>
    );
  }
  if (!wt.tree.files.length) {
    return (
      <Fragment>
        {head}
        <div className="ddb-note">Workspace is empty.</div>
      </Fragment>
    );
  }
  const items = wt.tree.files.map((f) => (
    <button key={f.path} type="button" className="ddb-tree-item" onClick={() => openFile(f.path)} title={f.path}>
      <span className="ddb-tree-item-path">{f.path}</span>
      <span className="ddb-tree-item-size">{fmtSize(f.size)}</span>
    </button>
  ));
  return (
    <Fragment>
      {head}
      {wt.tree.truncated ? <div className="ddb-note">showing first {wt.tree.files.length} files</div> : null}
      <div className="ddb-tree">{items}</div>
    </Fragment>
  );
}

export function renderViewer(wt: WorktreeState, sessionId: string, onOpenOp: (opId: string) => void): ReactElement {
  const head = (
    <div className="ddb-viewer-head">
      <button type="button" className="ddb-back" onClick={() => worktreeStore.closeFile()}>← files</button>
      <span className="ddb-viewer-path" title={wt.openPath ?? undefined}>{wt.openPath}</span>
      {wt.fileRefreshing ? <span className="ddb-refreshing">refreshing…</span> : null}
      <button
        type="button"
        className="ddb-iconbtn"
        title="Reload file"
        onClick={() => wt.openPath && void worktreeStore.openFile(sessionId, wt.openPath)}
      >
        {refreshIcon(14)}
      </button>
    </div>
  );

  let content: ReactElement;
  if (!wt.fileData) {
    content = wt.fileError ? (
      <div className="ddb-note ddb-error">{wt.fileError}</div>
    ) : (
      <div className="ddb-note">{wt.fileLoading ? 'Loading file…' : 'Open a file to review it.'}</div>
    );
  } else {
    // Keep showing the last content when a realtime refresh failed.
    content = <FileContent wt={wt} sessionId={sessionId} onOpenOp={onOpenOp} />;
  }

  return (
    <div className="ddb-viewer">
      {head}
      {content}
    </div>
  );
}

interface FileContentProps {
  wt: WorktreeState;
  sessionId: string;
  onOpenOp: (opId: string) => void;
}

/** The file content: highlighted lines, change annotations, notes. */
function FileContent({ wt, sessionId, onOpenOp }: FileContentProps): ReactElement {
  const lang = detectLang(wt.openPath ?? '');
  const hl = useMemo(() => createHighlighter(lang), [lang]);
  const codeRef = useRef<HTMLDivElement | null>(null);
  const [noteBox, setNoteBox] = useState<{ startLine: number; endLine: number; snippet: string; x: number; y: number } | null>(null);
  const fileData = wt.fileData!;

  // Preserve the reader's place across realtime refreshes: when a refresh
  // starts (fileRefreshing true) the current content is still on screen, so
  // save the scroll offset of the scrolling container; when the fresh content
  // lands (fileRefreshing false) restore it. The viewer stays mounted
  // throughout — only the first open ever shows a loader.
  const viewportRef = useRef<HTMLElement | null>(null);
  const savedScrollRef = useRef(0);
  useEffect(() => {
    if (wt.fileRefreshing) {
      let vp = viewportRef.current;
      if (!vp) {
        let el: HTMLElement | null = codeRef.current;
        while (el && el !== document.body) {
          const ov = getComputedStyle(el).overflowY;
          if (ov === 'auto' || ov === 'scroll') {
            vp = el;
            break;
          }
          el = el.parentElement;
        }
      }
      viewportRef.current = vp || null;
      savedScrollRef.current = vp ? vp.scrollTop : 0;
    } else if (viewportRef.current) {
      const vp = viewportRef.current;
      const max = vp.scrollHeight - vp.clientHeight;
      vp.scrollTop = Math.max(0, Math.min(savedScrollRef.current, max));
      viewportRef.current = null;
    }
  }, [wt.fileRefreshing]);

  const ops: FileOpsEntry[] = fileData.ops || [];
  const notes: NoteRecord[] = fileData.notes || [];

  // Lines changed by the latest op (accurate for current content only).
  const changed = useMemo(() => {
    const set = new Set<number>();
    let latest: FileOpsEntry | null = null;
    for (const entry of ops) {
      const f = entry.files && entry.files[0];
      if (f && !f.deleted && f.newRanges && f.newRanges.length) latest = entry;
    }
    if (latest) {
      for (const r of latest.files[0].newRanges) for (let i = r.start; i <= r.end; i++) set.add(i);
    }
    return { set, latest };
  }, [ops]);

  const noteLines = useMemo(() => {
    const m = new Map<number, NoteRecord>();
    for (const n of notes) {
      for (let i = n.startLine; i <= n.endLine; i++) {
        if (!m.has(i)) m.set(i, n);
      }
    }
    return m;
  }, [notes]);

  const raw = fileData.content.split('\n');
  if (raw.length && raw[raw.length - 1] === '') raw.pop();
  const MAX_SHOWN = 2000;
  const shown = raw.slice(0, MAX_SHOWN);

  const rows = shown.map((text, idx) => {
    const lineNo = idx + 1;
    const hlLine = changed.set.has(lineNo);
    const note = noteLines.get(lineNo);
    const latest = hlLine ? changed.latest : null;
    return (
      <div
        key={lineNo}
        data-line={lineNo}
        className={'ddb-cline' + (hlLine ? ' ddb-cline-hl' : '') + (note ? ' ddb-cline-note' : '')}
        title={
          latest
            ? `changed in ${latest.opId} (turn ${latest.turn ?? 'manual'}) — click for the conversation`
            : note
              ? `${note.id}: ${note.note}`
              : undefined
        }
        onClick={latest ? () => onOpenOp(latest.opId) : undefined}
      >
        <span className="ddb-cline-no">{lineNo}</span>
        <span className="ddb-cline-text">{renderTokens(hl(text), `l${lineNo}`)}</span>
      </div>
    );
  });

  // Selection → anchored note (only for selections inside the code block).
  function onMouseUp(): void {
    const sel = window.getSelection && window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) {
      setNoteBox(null);
      return;
    }
    const range = sel.getRangeAt(0);
    const startEl = closestLine(range.startContainer);
    const endEl = closestLine(range.endContainer);
    const codeEl = codeRef.current;
    if (!startEl || !endEl || !codeEl || !codeEl.contains(startEl) || !codeEl.contains(endEl)) {
      setNoteBox(null);
      return;
    }
    const startLine = Number(startEl.getAttribute('data-line'));
    const endLine = Number(endEl.getAttribute('data-line'));
    const snippet = sel.toString().replace(/\s+/g, ' ').slice(0, 500);
    const rect = range.getBoundingClientRect();
    worktreeStore.set({ selection: { startLine, endLine, snippet, x: rect.right, y: rect.bottom }, noteDraft: '' });
    setNoteBox({ startLine, endLine, snippet, x: rect.right, y: rect.bottom });
  }

  function closestLine(node: Node): HTMLElement | null {
    let el: HTMLElement | null = node && node.nodeType === 3 ? (node.parentElement as HTMLElement) : (node as HTMLElement);
    while (el && el !== document.body) {
      if (el.classList && el.classList.contains('ddb-cline')) return el;
      el = el.parentElement;
    }
    return null;
  }

  const meta: string[] = [];
  if (fileData.truncated) meta.push('(truncated)');
  if (changed.latest) meta.push(`highlighted: lines changed by ${changed.latest.opId}`);
  if (wt.fileError) meta.push(`refresh failed: ${wt.fileError} — showing last loaded content`);

  // per-file op history (code -> conversation)
  const opRows = ops.map((entry) => {
    const f = entry.files && entry.files[0];
    const stats = f && f.deleted ? 'deleted' : f ? `+${f.added}/-${f.removed}` : '';
    return (
      <button key={entry.opId} type="button" className="ddb-fileop" onClick={() => onOpenOp(entry.opId)}>
        <span className="ddb-op-id">{entry.opId}</span>
        <span className="ddb-op-kind">{entry.kind === 'manual' ? 'manual' : `turn ${entry.turn}`}</span>
        <span className="ddb-delta">{stats}</span>
        <span className="ddb-op-time">{fmtTime(entry.time)}</span>
      </button>
    );
  });

  // anchored notes list
  const noteItems = notes.map((n) => (
    <div key={n.id} className="ddb-note-item">
      <button
        type="button"
        className="ddb-note-jump"
        title={`L${n.startLine}-${n.endLine}`}
        onClick={() => jumpToLine(n.startLine)}
      >
        L{n.startLine}{n.endLine !== n.startLine ? `-${n.endLine}` : ''}
      </button>
      <div className="ddb-note-body">
        {n.snippet ? <div className="ddb-note-snippet">{n.snippet}</div> : null}
        <div className="ddb-note-text">{n.note}</div>
      </div>
      <button
        type="button"
        className="ddb-note-del"
        title="delete note"
        onClick={() => void worktreeStore.deleteNote(sessionId, n.id)}
      >
        ×
      </button>
    </div>
  ));

  function jumpToLine(line: number): void {
    const el = codeRef.current && codeRef.current.querySelector(`[data-line="${line}"]`);
    if (el instanceof HTMLElement) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.classList.remove('ddb-jump');
      void el.offsetWidth;
      el.classList.add('ddb-jump');
    }
  }

  return (
    <div className="ddb-filecontent">
      {meta.length ? <div className="ddb-filemeta">{meta.join(' · ')}</div> : null}
      <div className="ddb-code" ref={codeRef} onMouseUp={onMouseUp}>
        {rows}
      </div>
      {noteBox ? (
        <NoteForm box={noteBox} onCancel={() => setNoteBox(null)} onSave={() => void worktreeStore.addNote(sessionId)} />
      ) : null}
      {raw.length > MAX_SHOWN ? <div className="ddb-note">showing first {MAX_SHOWN} of {raw.length} lines</div> : null}
      {noteItems.length ? (
        <div className="ddb-notes">
          <div className="ddb-group-label">notes ({noteItems.length})</div>
          {noteItems}
        </div>
      ) : null}
      <div className="ddb-filehistory">
        <div className="ddb-group-label">edits to this file</div>
        {opRows.length ? <div className="ddb-filefocus-ops">{opRows}</div> : <div className="ddb-note">No captured edits yet.</div>}
      </div>
    </div>
  );
}

interface NoteFormProps {
  box: { startLine: number; endLine: number; snippet: string; x: number; y: number };
  onCancel: () => void;
  onSave: () => void;
}

/** Floating note composer anchored to the selection. */
function NoteForm({ box, onCancel, onSave }: NoteFormProps): ReactElement {
  const wt = useWorktree();
  const [text, setText] = useState(wt.noteDraft);
  useEffect(() => {
    worktreeStore.set({ noteDraft: text });
  }, [text]);
  return (
    <div className="ddb-note-form" style={{ left: Math.max(8, box.x - 220), top: box.y + 8 }}>
      <div className="ddb-note-form-range">
        L{box.startLine}{box.endLine !== box.startLine ? `-${box.endLine}` : ''} · {box.snippet.length > 60 ? box.snippet.slice(0, 60) + '…' : box.snippet}
      </div>
      <textarea
        className="ddb-note-input"
        rows={2}
        placeholder="Write a note…"
        value={text}
        autoFocus
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') onSave();
          if (e.key === 'Escape') onCancel();
        }}
      />
      <div className="ddb-note-form-actions">
        <button type="button" className="ddb-note-save" disabled={wt.saving || !text.trim()} onClick={onSave}>
          {wt.saving ? 'saving…' : 'save'}
        </button>
        <button type="button" className="ddb-note-cancel" onClick={onCancel}>cancel</button>
      </div>
    </div>
  );
}
