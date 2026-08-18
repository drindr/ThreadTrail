/**
 * Shared record types of the ThreadTrail capture engine. Mirrored (loosely)
 * by the client bundle's own local types in `threadtrail-client/src/types.ts`.
 */

/** A line marker in a unified diff: context, addition, removal. */
export type DiffMarker = ' ' | '+' | '-';

export interface DiffLine {
  t: DiffMarker;
  text: string;
}

/** Inclusive 1-based line range. */
export interface LineRange {
  start: number;
  end: number;
}

/** One file's change inside an op. */
export interface FileChange {
  path: string;
  sha: string | null;
  prevSha: string | null;
  deleted: boolean;
  added: number;
  removed: number | null;
  /** Inline diff text. Newly captured ops keep this null and reference the
   *  diff store instead (`diffSha`); `opRecord()` hydrates it on demand. */
  diff: DiffLine[] | null;
  /** Content-addressed reference into the diff store (`<root>/diffs/<sha>`). */
  diffSha?: string | null;
  oldRanges: LineRange[];
  newRanges: LineRange[];
}

/** A captured op: every file change recorded at one turn boundary. */
export interface OpRecord {
  id: string;
  sessionId: string;
  atSeq: number;
  time: number;
  trigger: string;
  kind: 'manual' | 'agent';
  turn: number | null;
  step: null;
  userMessageSeq: number | null;
  assistantSeqs: number[];
  files: FileChange[];
}

/** An anchored note pinned to a file's line range. */
export interface NoteRecord {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  snippet: string;
  note: string;
  time: number;
}

export interface ScanOptions {
  trigger: string;
  atSeq: number;
  turn: number | null;
  userMessageSeq: number | null;
  assistantSeqs?: number[];
}

export interface ResetOptions {
  trigger: 'commit' | 'manual';
  sha?: string | null;
}

/** One row of the worktree listing. */
export interface TreeEntry {
  path: string;
  size: number;
}

export interface TreeResult {
  root: string;
  truncated: boolean;
  files: TreeEntry[];
}

export interface ReadFileResult {
  path: string;
  content: string;
  truncated: boolean;
  lines: number;
}

/** Compact per-file summary inside the digest. */
export interface DigestFileSummary {
  path: string;
  added: number;
  removed: number | null;
  deleted: boolean;
}

export interface DigestOpSummary {
  id: string;
  atSeq: number;
  time: number;
  trigger: string;
  kind: 'manual' | 'agent';
  turn: number | null;
  userMessageSeq: number | null;
  assistantSeqs: number[];
  files: DigestFileSummary[];
}

export interface Digest {
  sessionId: string;
  cwd: string | null;
  ops: DigestOpSummary[];
  fileIndex: Record<string, string[]>;
  turnIndex: Record<number, { userMessageSeq: number | null; opIds: string[]; assistantSeqs: number[] }>;
  gitHead: string | null;
  lastClean: { sha: string | null; time: number; trigger: string } | null;
  /** Non-fatal load diagnostics (e.g. skipped oversized legacy lines). */
  warnings?: string[];
}

/** Per-file op history entry served to the worktree viewer. */
export interface FileOpsEntry {
  opId: string;
  turn: number | null;
  kind: 'manual' | 'agent';
  time: number;
  userMessageSeq: number | null;
  files: Array<{
    added: number;
    removed: number | null;
    deleted: boolean;
    oldRanges: LineRange[];
    newRanges: LineRange[];
  }>;
}

/** State of one path inside a rewind reconstruction. */
export interface RewindFileState {
  path: string;
  state: 'written' | 'deleted';
}
