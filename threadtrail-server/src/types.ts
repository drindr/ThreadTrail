/**
 * Shared wire types of the ThreadTrail git-diff service. Mirrored (loosely)
 * by the client bundle's own local types in `threadtrail-client/src/types.ts`.
 */

/** A line marker in a unified diff: context, addition, removal. */
export type DiffMarker = ' ' | '+' | '-';

export interface DiffLine {
  t: DiffMarker;
  text: string;
}

/** One unified-diff hunk. */
export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** The text after the closing `@@` (usually the enclosing symbol). */
  header: string;
  lines: DiffLine[];
}

export type DiffFileStatus = 'added' | 'modified' | 'deleted' | 'renamed';

/** One file's diff between the two compared records. */
export interface DiffFile {
  path: string;
  /** Set for renames (the previous path) and deletions. */
  oldPath: string | null;
  status: DiffFileStatus;
  binary: boolean;
  /** True when this file's diff was cut short (large synthesized file). */
  truncated?: boolean;
  added: number;
  removed: number;
  hunks: DiffHunk[];
}

/**
 * One comparable record of the workspace. `kind: 'worktree'` is the
 * synthetic record for the uncommitted state (id `worktree`); commits carry
 * their sha as id; `kind: 'empty'` is git's empty tree (id `empty`), the
 * base before the first commit.
 */
export interface RecordInfo {
  id: string;
  kind: 'worktree' | 'commit' | 'empty';
  shortSha?: string;
  subject?: string;
  author?: string;
  /** Commit time (ms since epoch). */
  time?: number;
  /** First-parent sha of a commit, or null for the root commit. */
  parent?: string | null;
}

/** `GET …/records.json` response. */
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

/** `GET …/diff.json` response. */
export interface DiffResult {
  from: string;
  to: string;
  files: DiffFile[];
  /** True when the payload was cut short (byte / file / line caps). */
  truncated: boolean;
}
