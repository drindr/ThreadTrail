/**
 * Wire shapes the browser panel consumes from the host routes. The server's
 * own authoritative types live in `threadtrail-server/src/types.ts`; this is
 * the client-side projection (plus the fields the routes layer enriches, like
 * `prompt`).
 */

export interface LineRange {
  start: number;
  end: number;
}

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
  /** Added by the routes layer (prompt preview). */
  prompt?: string | null;
}

export interface Digest {
  sessionId: string;
  cwd: string | null;
  ops: DigestOpSummary[];
  fileIndex: Record<string, string[]>;
  turnIndex: Record<number, { userMessageSeq: number | null; opIds: string[]; assistantSeqs: number[] }>;
  gitHead: string | null;
  lastClean: { sha: string | null; time: number; trigger: string } | null;
}

export interface DiffLine {
  t: ' ' | '+' | '-';
  text: string;
}

/** Full op record as served by `…/op/<id>.json` (diff included). */
export interface OpDetail extends DigestOpSummary {
  sessionId: string;
  step: null;
  files: Array<
    DigestFileSummary & {
      sha: string | null;
      prevSha: string | null;
      diff: DiffLine[] | null;
      oldRanges: LineRange[];
      newRanges: LineRange[];
    }
  >;
  prompt?: string | null;
}

export interface TreeEntry {
  path: string;
  size: number;
}

export interface TreeResult {
  root: string;
  truncated: boolean;
  files: TreeEntry[];
}

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
  /** Added by the routes layer (prompt preview). */
  prompt?: string | null;
}

export interface NoteRecord {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  snippet: string;
  note: string;
  time: number;
}

export interface FileData {
  path: string;
  content: string;
  truncated: boolean;
  lines: number;
  ops: FileOpsEntry[];
  notes: NoteRecord[];
}

/** One op's rewind progress/result, held in panel state. */
export type RewindInfo =
  | { pending: string }
  | { ok: true; target: string; count: number }
  | { err: string };
