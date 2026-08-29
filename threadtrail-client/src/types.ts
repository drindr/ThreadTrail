/**
 * Wire shapes the browser panel consumes from the host routes. The server's
 * own authoritative types live in `threadtrail-server/src/types.ts`; this is
 * the client-side projection.
 */

export interface DiffLine {
  t: ' ' | '+' | '-';
  text: string;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
  lines: DiffLine[];
}

export type DiffFileStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface DiffFile {
  path: string;
  oldPath: string | null;
  status: DiffFileStatus;
  binary: boolean;
  truncated?: boolean;
  added: number;
  removed: number;
  hunks: DiffHunk[];
}

/** One comparable record: the worktree (uncommitted state), a commit, or the empty tree. */
export interface RecordInfo {
  id: string;
  kind: 'worktree' | 'commit' | 'empty';
  shortSha?: string;
  subject?: string;
  author?: string;
  time?: number;
  /** First-parent sha of a commit, or null for the root commit. */
  parent?: string | null;
}

export interface RecordsResult {
  cwd: string;
  /** The active comparison root, relative to `cwd` ('' = the workspace root). */
  root: string;
  isRepo: boolean;
  gitAvailable: boolean;
  head: string | null;
  worktree: { changed: number; untracked: number } | null;
  records: RecordInfo[];
  /** When not a git repo: subfolders that are git repositories. */
  candidates: string[];
}

export interface DiffResult {
  from: string;
  to: string;
  files: DiffFile[];
  truncated: boolean;
}

/** The synthetic record id of the uncommitted worktree state. */
export const WORKTREE_ID = 'worktree';

/** The synthetic record id of the empty tree (before the first commit). */
export const EMPTY_ID = 'empty';
