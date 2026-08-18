/**
 * ThreadTrail capture engine.
 *
 * Records every file-system change of a session's workspace with a stable
 * identity, linked to the conversation event that bracketed it. It is a
 * sidecar to the session log (the session log itself refuses unknown event
 * types on replay, so the op log lives beside it and references session
 * event seqs).
 *
 * Storage layout under `$DSH_HOME/threadtrail/`:
 *   blobs/<sha256>              content-addressed file contents (deduped)
 *   sessions/<sessionId>.jsonl  append-only op records (one JSON object per
 *                               line; the full diff text lives here)
 *   sessions/<sessionId>.head.json  git HEAD / last-reset bookkeeping
 *   notes/<sessionId>.jsonl     anchored notes
 *
 * Capture happens at turn boundaries (the "between commits" granularity):
 * a scan at `turn/start` records manual edits made since the last scan, and
 * a scan at `turn/end` records the agent's edits for that turn. A moved git
 * HEAD (a commit) clears the op list automatically — the state is in git.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { computeDiff, computeRanges } from './diff.ts';
import { GitIgnore, gitHead } from './git.ts';
import type {
  Digest,
  DigestOpSummary,
  DiffLine,
  FileChange,
  FileOpsEntry,
  NoteRecord,
  OpRecord,
  ReadFileResult,
  ResetOptions,
  RewindFileState,
  ScanOptions,
  TreeEntry,
} from './types.ts';

const require = createRequire(import.meta.url);
/** Canonical harness home helper from the platform when resolvable (profile
 * installs), else the identical inline logic (~/.dsh fallback). */
let dshHomePath: (...segments: string[]) => string;
try {
  dshHomePath = require('@deepseek-ai/dsh-home-paths').dshHomePath as typeof dshHomePath;
} catch {
  dshHomePath = (...segments: string[]) => {
    const env = process.env.DSH_HOME;
    const home = env && env.trim() ? env : path.join(os.homedir(), '.dsh');
    return path.join(home, ...segments);
  };
}

/** Directory/file names excluded from capture. */
export const IGNORE_NAMES = new Set([
  '.git', 'node_modules', '.threadtrail', 'target', 'dist', 'build', 'out',
  '.next', '.nuxt', '__pycache__', '.venv', 'venv', '.DS_Store',
  '.idea', '.vscode', 'coverage', '.turbo', '.cache', '.pytest_cache',
  // Package-manager caches and tool data: huge, churny, content-addressed —
  // capturing them produced multi-hundred-MB ops in legacy logs.
  '.npm', '.npm-tmp', '.pnpm-cache', '.pnpm-store', '.yarn', '.pnp', '.bun',
  '.eslintcache', '.parcel-cache', '.metro-cache', '.vite', '.webpack',
  '.sass-cache', '.gradle', '.hg', '.svn',
]);

/** Names starting with any of these prefixes are excluded from capture too
 *  (e.g. `chrome-data*` profile trees copied into a workspace). */
export const IGNORE_PREFIXES = ['chrome-data'];

function matchesIgnoredPrefix(name: string): boolean {
  for (const prefix of IGNORE_PREFIXES) if (name.startsWith(prefix)) return true;
  return false;
}

/** Files at or below this size are fully captured (blob + diff). Larger
 *  files are left out of the op log entirely — a big file's whole-file
 *  replace diff is exactly the bloat that ballooned legacy logs. */
export const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;

/** Jsonl lines above this many characters are skipped on load. They only
 *  occur in legacy logs written before diffs were externalized; parsing
 *  them costs hundreds of MB per line (V8 strings cap at ~536M chars). */
export const MAX_LOAD_LINE_CHARS = 16 * 1024 * 1024;

/** Legacy inline diffs above these bounds are migrated into the diff store
 *  on load, so memory stays bounded even for old logs. */
export const MAX_INLINE_DIFF_BYTES = 256 * 1024;
export const MAX_INLINE_DIFF_LINES = 4000;

/** Rough serialized size of a diff line list (bytes). */
function estimateDiffBytes(lines: DiffLine[]): number {
  let n = 0;
  for (const l of lines) n += l.text.length + 16;
  return n;
}

/** SHA-256 hex of a UTF-8 string. */
export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Per-path state recorded at a scan (hash plus filesystem metadata). */
interface ManifestEntry {
  sha: string | null;
  size: bigint;
  mtimeNs: bigint;
}

/** The persisted git-HEAD / last-reset sidecar record. */
interface HeadRecord {
  head: string | null;
  lastCleanSha: string | null;
  lastCleanTime: number | null;
  lastCleanTrigger: string | null;
}

/** Options for `listFiles`. */
export interface ListFilesOptions {
  /** Per-entry predicate (workspace-relative, '/' separators): when it
   * returns true the entry — file or directory — is skipped. Used to drop
   * git-ignored paths in git workspaces. */
  ignore?: (rel: string) => boolean;
}

/** Recursively list files under `root`, skipping ignored directories/files. */
export async function listFiles(root: string, opts: ListFilesOptions = {}): Promise<string[]> {
  const { ignore } = opts;
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable directory — skip
    }
    for (const entry of entries) {
      if (IGNORE_NAMES.has(entry.name)) continue;
      if (matchesIgnoredPrefix(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      if (ignore && ignore(normalizeRel(path.relative(root, abs)))) continue;
      if (entry.isDirectory()) {
        stack.push(abs);
      } else if (entry.isFile()) {
        out.push(abs);
      }
    }
  }
  return out.sort();
}

/** Hash every listed path into the manifest entries (bounded concurrency). */
async function hashBatch(paths: string[], manifest: Map<string, ManifestEntry>, sc: SessionCapture): Promise<void> {
  let i = 0;
  const limit = Math.min(16, paths.length);
  const workers = Array.from({ length: limit }, async () => {
    while (i < paths.length) {
      const abs = paths[i++];
      try {
        const content = await fs.readFile(abs, 'utf8');
        const entry = manifest.get(abs);
        if (entry) entry.sha = await sc.writeBlob(content);
      } catch {
        // unreadable file — leave sha null; it will not diff
      }
    }
  });
  await Promise.all(workers);
}

export class CaptureStore {
  root: string;
  blobsDir: string;
  diffsDir: string;
  sessionsDir: string;
  notesDir: string;
  sessions = new Map<string, SessionCapture>();
  private _init: Promise<void> | undefined;

  /**
   * @param opts - `root` is the threadtrail data directory (defaults to
   *   `$DSH_HOME/threadtrail`).
   */
  constructor({ root }: { root?: string } = {}) {
    // Canonical harness home (DSH_HOME, or ~/.dsh) — never the bare home dir.
    this.root = root || dshHomePath('threadtrail');
    this.blobsDir = path.join(this.root, 'blobs');
    this.diffsDir = path.join(this.root, 'diffs');
    this.sessionsDir = path.join(this.root, 'sessions');
    this.notesDir = path.join(this.root, 'notes');
  }

  async init(): Promise<void> {
    this._init ??= (async () => {
      await fs.mkdir(this.blobsDir, { recursive: true });
      await fs.mkdir(this.diffsDir, { recursive: true });
      await fs.mkdir(this.sessionsDir, { recursive: true });
      await fs.mkdir(this.notesDir, { recursive: true });
    })();
    return this._init;
  }

  get(sessionId: string): SessionCapture | undefined {
    return this.sessions.get(sessionId);
  }

  /** Attach a session (called on `session/created` or first touch). */
  getOrCreate(sessionId: string, cwd: string | null): SessionCapture {
    let sc = this.sessions.get(sessionId);
    if (!sc) {
      sc = new SessionCapture(this, sessionId, cwd);
      this.sessions.set(sessionId, sc);
    } else if (cwd && !sc.cwd) {
      sc.cwd = cwd;
    }
    return sc;
  }

  /** Drop in-memory state for a disposed session (the jsonl stays on disk). */
  dispose(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}

export class SessionCapture {
  store: CaptureStore;
  sessionId: string;
  cwd: string | null;
  manifest = new Map<string, ManifestEntry>();
  ops: OpRecord[] = [];
  opCounter = 0;
  lastUserSeq: number | null = null;
  /** turn -> assistant/message seqs */
  assistantSeqs = new Map<number, number[]>();
  notes: NoteRecord[] = [];
  noteCounter = 0;
  notesLoaded = false;
  loaded = false;
  baselined = false;
  // git HEAD bookkeeping: the last HEAD seen and the last op-list reset
  // (persisted so restarts do not re-trigger a reset for the same commit).
  lastHead: string | null = null;
  lastCleanSha: string | null = null;
  lastCleanTime: number | null = null;
  lastCleanTrigger: string | null = null;
  // Non-fatal load/scan diagnostics surfaced in status/digest (e.g. skipped
  // oversized legacy lines). Bounded to a handful of entries.
  warnings: string[] = [];
  // git-ignore matcher for the workspace (null until first used). Built fresh
  // at every capture scan; the worktree browser reuses it and only reloads
  // when a known ignore file changed on disk.
  gitIgnore: GitIgnore | null = null;
  gitIgnoreCwd: string | null = null;

  constructor(store: CaptureStore, sessionId: string, cwd: string | null) {
    this.store = store;
    this.sessionId = sessionId;
    this.cwd = cwd || null;
  }

  jsonlPath(): string {
    return path.join(this.store.sessionsDir, `${this.sessionId}.jsonl`);
  }

  headPath(): string {
    return path.join(this.store.sessionsDir, `${this.sessionId}.head.json`);
  }

  notesPath(): string {
    return path.join(this.store.notesDir, `${this.sessionId}.jsonl`);
  }

  async loadNotes(): Promise<void> {
    if (this.notesLoaded) return;
    this.notesLoaded = true;
    try {
      const text = await fs.readFile(this.notesPath(), 'utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line) as NoteRecord;
          this.notes.push(rec);
          const n = Number(rec.id.replace(/^n-/, ''));
          if (Number.isInteger(n) && n > this.noteCounter) this.noteCounter = n;
        } catch {
          // skip a corrupt line
        }
      }
    } catch {
      // no notes yet
    }
  }

  /**
   * Add an anchored note on a file's line range (the "notation" feature).
   * @returns the stored note record.
   */
  async addNote(opts: { path: string; startLine: number; endLine: number; snippet?: string; note: string }): Promise<NoteRecord> {
    await this.loadNotes();
    const record: NoteRecord = {
      id: `n-${++this.noteCounter}`,
      path: normalizeRel(opts.path),
      startLine: opts.startLine,
      endLine: opts.endLine,
      snippet: opts.snippet ?? '',
      note: opts.note,
      time: Date.now(),
    };
    this.notes.push(record);
    try {
      await fs.mkdir(this.store.notesDir, { recursive: true });
      await fs.appendFile(this.notesPath(), JSON.stringify(record) + '\n', 'utf8');
    } catch {
      // best-effort persistence
    }
    return record;
  }

  /** Remove a note by id. */
  async deleteNote(id: string): Promise<boolean> {
    await this.loadNotes();
    const before = this.notes.length;
    this.notes = this.notes.filter((n) => n.id !== id);
    if (this.notes.length === before) return false;
    try {
      await fs.mkdir(this.store.notesDir, { recursive: true });
      await fs.writeFile(this.notesPath(), this.notes.map((n) => JSON.stringify(n)).join('\n') + '\n', 'utf8');
    } catch {
      // best-effort persistence
    }
    return true;
  }

  /** Notes anchored on a path, newest first. */
  async notesFor(rel: string): Promise<NoteRecord[]> {
    await this.loadNotes();
    const norm = normalizeRel(rel);
    return this.notes.filter((n) => n.path === norm).reverse();
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      for await (const { lineNo, line } of this.iterJsonlLines()) {
        if (!line.trim()) continue;
        try {
          await this.ingestOp(JSON.parse(line) as OpRecord);
        } catch {
          // skip a corrupt line — the log is best-effort
        }
      }
    } catch {
      // no log yet (or unreadable)
    }
    try {
      const rec = JSON.parse(await fs.readFile(this.headPath(), 'utf8')) as HeadRecord;
      this.lastHead = rec.head ?? null;
      this.lastCleanSha = rec.lastCleanSha ?? null;
      this.lastCleanTime = rec.lastCleanTime ?? null;
      this.lastCleanTrigger = rec.lastCleanTrigger ?? null;
    } catch {
      // no head record yet
    }
  }

  /**
   * Stream the op log line by line, skipping pathological oversized lines
   * instead of materializing them (a single legacy line can be hundreds of
   * MB — far beyond what a JS string can hold). Skipped lines are counted
   * in `warnings`; their ops are gone from the in-memory view, which is the
   * safe outcome for logs written before diffs were externalized.
   */
  private async *iterJsonlLines(): AsyncGenerator<{ lineNo: number; line: string }> {
    let st;
    try {
      st = await fs.stat(this.jsonlPath());
    } catch {
      return;
    }
    if (st.size === 0) return;
    const rs = createReadStream(this.jsonlPath(), { encoding: 'utf8', highWaterMark: 1 << 20 });
    let buf = '';
    let lineNo = 0;
    // True while a single line grew past MAX_LOAD_LINE_CHARS: content is
    // dropped until its terminating newline, so no oversized string is ever
    // materialized (legacy lines can be hundreds of MB — beyond what a JS
    // string can even hold) and the rest of the log still parses.
    let discarding = false;
    const warn = (msg: string): void => {
      if (this.warnings.length < 8) this.warnings.push(msg);
    };
    try {
      for await (const chunk of rs) {
        if (discarding) {
          const idx = chunk.indexOf('\n');
          if (idx < 0) continue; // still inside the oversized line
          lineNo++; // the oversized line ends here
          buf = chunk.slice(idx + 1);
          discarding = false;
        } else {
          buf += chunk;
        }
        let idx: number;
        while ((idx = buf.indexOf('\n')) >= 0) {
          lineNo++;
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (line.length > MAX_LOAD_LINE_CHARS) {
            warn(`line ${lineNo} is ${line.length} chars (>= ${MAX_LOAD_LINE_CHARS}); skipped — consider cleaning this log`);
            continue;
          }
          yield { lineNo, line };
        }
        // `buf` now holds a partial line with no newline. If it grew past the
        // cap it can never be a useful line: drop it without materializing.
        if (!discarding && buf.length > MAX_LOAD_LINE_CHARS) {
          warn(`oversized line at line ${lineNo + 1} skipped; consider cleaning this log`);
          discarding = true;
          buf = '';
        }
      }
      if (!discarding && buf.length) {
        lineNo++;
        yield { lineNo, line: buf };
      }
    } finally {
      rs.destroy();
    }
  }

  /**
   * Fold one parsed op record into memory. Legacy records with a fat inline
   * `diff` are migrated into the diff store so the retained op stays lean —
   * this is what keeps memory bounded even when old logs are loaded.
   */
  private async ingestOp(rec: OpRecord): Promise<void> {
    const n = Number(rec.id.replace(/^op-/, ''));
    if (Number.isInteger(n) && n > this.opCounter) this.opCounter = n;
    for (const f of rec.files) {
      if (f.diff && (f.diff.length > MAX_INLINE_DIFF_LINES || estimateDiffBytes(f.diff) > MAX_INLINE_DIFF_BYTES)) {
        f.diffSha = await this.writeDiff(f.diff);
        f.diff = null;
      }
    }
    this.ops.push(rec);
  }

  /**
   * The git-ignore matcher for the workspace, or null when it is not a git
   * repo. `forceReload` (used at capture scans) re-reads every .gitignore
   * file; the worktree browser reuses the cached matcher and only reloads
   * when a known ignore file changed on disk.
   */
  private async gitIgnoreMatcher(forceReload: boolean): Promise<GitIgnore | null> {
    if (!this.cwd) return null;
    if (forceReload || !this.gitIgnore || this.gitIgnoreCwd !== this.cwd) {
      this.gitIgnore = await GitIgnore.load(this.cwd, { skipDirs: IGNORE_NAMES });
      this.gitIgnoreCwd = this.cwd;
    } else {
      await this.gitIgnore.refreshIfChanged();
    }
    return this.gitIgnore;
  }

  /** Persist the git-HEAD / last-reset bookkeeping (best-effort). */
  async saveHead(): Promise<void> {
    try {
      await fs.writeFile(
        this.headPath(),
        JSON.stringify({
          head: this.lastHead ?? null,
          lastCleanSha: this.lastCleanSha ?? null,
          lastCleanTime: this.lastCleanTime ?? null,
          lastCleanTrigger: this.lastCleanTrigger ?? null,
        } satisfies HeadRecord),
        'utf8',
      );
    } catch {
      // best-effort persistence
    }
  }

  async writeBlob(content: string): Promise<string> {
    const sha = sha256(content);
    try {
      await fs.access(path.join(this.store.blobsDir, sha));
    } catch {
      await fs.writeFile(path.join(this.store.blobsDir, sha), content, 'utf8');
    }
    return sha;
  }

  async readBlob(sha: string | null): Promise<string> {
    if (!sha) return '';
    try {
      return await fs.readFile(path.join(this.store.blobsDir, sha), 'utf8');
    } catch {
      return '';
    }
  }

  /** Content-addressed diff store: op records reference diffs by sha and the
   *  full diff text lives here, so the in-memory op list and the jsonl stay
   *  lean (legacy logs embedded the diff inline, which ballooned both). */
  async writeDiff(lines: DiffLine[]): Promise<string> {
    const text = JSON.stringify(lines);
    const sha = sha256(text);
    try {
      await fs.access(path.join(this.store.diffsDir, sha));
    } catch {
      await fs.writeFile(path.join(this.store.diffsDir, sha), text, 'utf8');
    }
    return sha;
  }

  async readDiff(sha: string): Promise<DiffLine[] | null> {
    try {
      return JSON.parse(await fs.readFile(path.join(this.store.diffsDir, sha), 'utf8')) as DiffLine[];
    } catch {
      return null;
    }
  }

  /** Current op-log size on disk (for status/observability). */
  async jsonlBytes(): Promise<number> {
    try {
      return (await fs.stat(this.jsonlPath())).size;
    } catch {
      return 0;
    }
  }

  /**
   * Clear the captured op list and re-arm the baseline. Safe after a git
   * commit — the workspace state is preserved in git, so the "between
   * commits" granularity up to that point can be dropped. The next scan
   * re-establishes the baseline against the current workspace, so subsequent
   * edits are recorded as ops starting from op-1. Notes and conversation
   * attribution state (lastUserSeq, per-turn assistant seqs) are kept.
   */
  async resetOps({ trigger, sha = null }: ResetOptions = { trigger: 'manual' }): Promise<void> {
    await this.load();
    this.ops = [];
    this.opCounter = 0;
    this.manifest = new Map();
    this.baselined = false;
    this.lastCleanSha = sha ?? this.lastHead ?? null;
    this.lastCleanTime = Date.now();
    this.lastCleanTrigger = trigger;
    try {
      await fs.writeFile(this.jsonlPath(), '', 'utf8');
    } catch {
      // best-effort persistence
    }
    await this.saveHead();
  }

  /**
   * Scan the workspace and record an op for whatever changed since the last
   * scan. The first scan on a fresh session only establishes the baseline.
   * @returns the recorded op, or null when nothing changed.
   */
  async scan(opts: ScanOptions): Promise<OpRecord | null> {
    const { trigger, atSeq, turn, userMessageSeq, assistantSeqs = [] } = opts;
    if (!this.cwd) return null;
    await this.store.init(); // idempotent; safe even if activation did not await
    await this.load();
    const gi = await this.gitIgnoreMatcher(true);
    const files = await listFiles(this.cwd, {
      ignore: gi && !gi.isEmpty ? (rel) => gi.ignores(rel) : undefined,
    });
    const next = new Map<string, ManifestEntry>();
    const pending: string[] = [];
    for (const abs of files) {
      let st: import('node:fs').BigIntStats;
      try {
        st = await fs.stat(abs, { bigint: true });
      } catch {
        continue;
      }
      if (st.size > MAX_CAPTURE_BYTES) continue;
      next.set(abs, { sha: null, size: st.size, mtimeNs: st.mtimeNs });
      pending.push(abs);
    }
    // Hash every file each scan: mtime granularity on some filesystems smears
    // same-bucket rewrites, so timestamp-based change detection is unreliable.
    // Content hashing is always correct; scans run at turn boundaries only.
    await hashBatch(pending, next, this);

    // Git commit detection: a moved HEAD means the workspace state is baked
    // into git, so the captured "between commits" ops are safe to clear. The
    // current scan then just re-establishes the baseline (no op is recorded).
    const head = await gitHead(this.cwd);
    if (head && this.lastHead && head !== this.lastHead) {
      await this.resetOps({ trigger: 'commit', sha: head });
    }
    if (head !== this.lastHead) {
      this.lastHead = head;
      await this.saveHead();
    }

    // The first scan only establishes the baseline; nothing is recorded.
    if (!this.baselined) {
      this.manifest = next;
      this.baselined = true;
      return null;
    }

    // changed or added files (content hash differs from the previous scan)
    const changed: Array<{ abs: string; entry: ManifestEntry; prev: ManifestEntry | undefined }> = [];
    for (const [abs, entry] of next) {
      const prev = this.manifest.get(abs);
      if (prev && prev.sha === entry.sha) continue; // genuinely unchanged
      changed.push({ abs, entry, prev });
    }
    // removed files
    const removed: Array<{ abs: string; prev: ManifestEntry }> = [];
    for (const [abs, prev] of this.manifest) {
      if (!next.has(abs)) removed.push({ abs, prev });
    }

    if (changed.length === 0 && removed.length === 0) {
      this.manifest = next;
      return null;
    }

    const filesRec: FileChange[] = [];
    for (const { abs, entry, prev } of changed) {
      let content: string;
      try {
        content = await fs.readFile(abs, 'utf8');
      } catch {
        continue;
      }
      const prevText = prev?.sha ? await this.readBlob(prev.sha) : '';
      const diff = computeDiff(prevText, content);
      const { oldRanges, newRanges } = computeRanges(diff.lines);
      const diffSha = await this.writeDiff(diff.lines);
      filesRec.push({
        path: path.relative(this.cwd, abs),
        sha: entry.sha,
        prevSha: prev?.sha ?? null,
        deleted: false,
        added: diff.added,
        removed: diff.removed,
        diff: null,
        diffSha,
        oldRanges,
        newRanges,
      });
    }
    for (const { abs, prev } of removed) {
      filesRec.push({
        path: path.relative(this.cwd, abs),
        sha: null,
        prevSha: prev.sha ?? null,
        deleted: true,
        added: 0,
        removed: null,
        diff: null,
        oldRanges: [],
        newRanges: [],
      });
    }

    const op: OpRecord = {
      id: `op-${++this.opCounter}`,
      sessionId: this.sessionId,
      atSeq,
      time: Date.now(),
      trigger,
      kind: turn == null ? 'manual' : 'agent',
      turn: turn ?? null,
      step: null,
      userMessageSeq: userMessageSeq ?? this.lastUserSeq ?? null,
      assistantSeqs,
      files: filesRec,
    };
    this.ops.push(op);
    this.manifest = next;
    try {
      await fs.appendFile(this.jsonlPath(), JSON.stringify(op) + '\n', 'utf8');
    } catch {
      // best-effort persistence
    }
    return op;
  }

  /**
   * Materialize the workspace state right after `opId` into an empty target
   * directory. Delta snapshot semantics: every file whose last recorded op
   * <= opId (and not deleted) is written with its content at that point;
   * files never touched by captured history are not copied.
   */
  async rewind(opId: string, targetDir: string): Promise<{ target: string; files: RewindFileState[] }> {
    await this.load();
    const idx = this.ops.findIndex((o) => o.id === opId);
    if (idx < 0) {
      const err = new Error(`op not found: ${opId}`);
      (err as Error & { code: string }).code = 'THREADTRAIL_OP_NOT_FOUND';
      throw err;
    }
    const state = new Map<string, { sha: string | null; deleted: boolean }>();
    for (let i = 0; i <= idx; i++) {
      for (const f of this.ops[i].files) {
        state.set(f.path, { sha: f.sha, deleted: f.deleted });
      }
    }
    await fs.mkdir(targetDir, { recursive: true });
    const files: RewindFileState[] = [];
    for (const [rel, s] of state) {
      if (s.deleted) {
        files.push({ path: rel, state: 'deleted' });
        continue;
      }
      const content = await this.readBlob(s.sha);
      const abs = path.join(targetDir, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content, 'utf8');
      files.push({ path: rel, state: 'written' });
    }
    return { target: targetDir, files };
  }

  /** Compact digest for the panel: op summaries + path -> ops index. */
  digest(): Digest {
    const ops: DigestOpSummary[] = this.ops.map((o) => ({
      id: o.id,
      atSeq: o.atSeq,
      time: o.time,
      trigger: o.trigger,
      kind: o.kind,
      turn: o.turn,
      userMessageSeq: o.userMessageSeq,
      assistantSeqs: o.assistantSeqs,
      files: o.files.map((f) => ({
        path: f.path,
        added: f.added,
        removed: f.removed,
        deleted: f.deleted,
      })),
    }));
    const fileIndex: Record<string, string[]> = {};
    for (const o of this.ops) {
      for (const f of o.files) {
        (fileIndex[f.path] ??= []).push(o.id);
      }
    }
    const turnIndex: Digest['turnIndex'] = {};
    for (const o of this.ops) {
      if (o.turn == null) continue;
      const t = (turnIndex[o.turn] ??= { userMessageSeq: o.userMessageSeq, opIds: [], assistantSeqs: o.assistantSeqs });
      if (o.userMessageSeq != null) t.userMessageSeq = o.userMessageSeq;
      t.opIds.push(o.id);
      for (const s of o.assistantSeqs) if (!t.assistantSeqs.includes(s)) t.assistantSeqs.push(s);
    }
    return {
      sessionId: this.sessionId,
      cwd: this.cwd,
      ops,
      fileIndex,
      turnIndex,
      gitHead: this.lastHead ?? null,
      lastClean: this.lastCleanTrigger
        ? { sha: this.lastCleanSha ?? null, time: this.lastCleanTime ?? 0, trigger: this.lastCleanTrigger }
        : null,
      warnings: this.warnings.slice(),
    };
  }

  async opRecord(opId: string): Promise<OpRecord | null> {
    await this.load();
    const op = this.ops.find((o) => o.id === opId) ?? null;
    if (!op) return null;
    // Return a clone with diffs hydrated from the diff store. The retained
    // in-memory op stays lean — mutating it here would re-introduce the
    // multi-hundred-MB retentions that crashed the process.
    const copy = structuredClone(op) as OpRecord;
    for (const f of copy.files) {
      if (f.diff == null && f.diffSha) {
        f.diff = await this.readDiff(f.diffSha);
      }
    }
    return copy;
  }

  /**
   * List the current workspace files (ignoring capture-ignored dirs), for the
   * worktree browser. Capped to keep the payload UI-scale.
   */
  async tree(): Promise<{ root: string; truncated: boolean; files: TreeEntry[] } | null> {
    if (!this.cwd) return null;
    const MAX_FILES = 3000;
    const gi = await this.gitIgnoreMatcher(false);
    const files = await listFiles(this.cwd, {
      ignore: gi && !gi.isEmpty ? (rel) => gi.ignores(rel) : undefined,
    });
    const out: TreeEntry[] = [];
    for (const abs of files.slice(0, MAX_FILES)) {
      try {
        const st = await fs.stat(abs, { bigint: true });
        out.push({ path: path.relative(this.cwd, abs), size: Number(st.size) });
      } catch {
        // skip unreadable
      }
    }
    return { root: this.cwd, truncated: files.length > MAX_FILES, files: out };
  }

  /**
   * Resolve a relative workspace path, refusing escapes (lexical and via
   * symlinks). Missing files still resolve (the caller decides what to do).
   * @returns absolute path, or null when escaping/invalid.
   */
  async resolveWorkspacePath(rel: string): Promise<string | null> {
    if (!this.cwd) return null;
    if (typeof rel !== 'string' || rel.length === 0 || rel.includes('\0')) return null;
    const abs = path.resolve(this.cwd, rel);
    if (abs !== this.cwd && !abs.startsWith(this.cwd + path.sep)) return null;
    try {
      const real = await fs.realpath(abs);
      const realCwd = await fs.realpath(this.cwd);
      if (real !== realCwd && !real.startsWith(realCwd + path.sep)) return null;
      return real;
    } catch {
      // realpath failed (missing file, unreadable dir) — allow; the read reports NO_FILE.
      return abs;
    }
  }

  /**
   * Read a workspace file's current content, guarded against path traversal
   * (lexical and symlink escapes refused; missing files -> THREADTRAIL_NO_FILE).
   * @throws {Error} with `code` THREADTRAIL_NO_CWD / THREADTRAIL_PATH_ESCAPE / THREADTRAIL_NO_FILE
   */
  async readFile(rel: string): Promise<ReadFileResult> {
    if (!this.cwd) throw errWith('session has no workspace', 'THREADTRAIL_NO_CWD');
    const abs = await this.resolveWorkspacePath(rel);
    if (!abs) throw errWith('path escapes the workspace', 'THREADTRAIL_PATH_ESCAPE');
    let content: string;
    try {
      content = await fs.readFile(abs, 'utf8');
    } catch {
      throw errWith('file is missing or unreadable', 'THREADTRAIL_NO_FILE');
    }
    const MAX_FILE = 512 * 1024;
    let truncated = false;
    if (content.length > MAX_FILE) {
      content = content.slice(0, MAX_FILE);
      truncated = true;
    }
    const parts = content.split('\n');
    if (parts.length && parts[parts.length - 1] === '') parts.pop();
    return { path: rel, content, truncated, lines: parts.length };
  }

  /**
   * Every op that touched a path, with its line ranges — the worktree
   * viewer's "code -> conversation" anchor data.
   */
  fileOps(rel: string): FileOpsEntry[] {
    const norm = normalizeRel(rel);
    const out: FileOpsEntry[] = [];
    for (const o of this.ops) {
      const files = o.files.filter((f) => normalizeRel(f.path) === norm);
      if (!files.length) continue;
      out.push({
        opId: o.id,
        turn: o.turn,
        kind: o.kind,
        time: o.time,
        userMessageSeq: o.userMessageSeq,
        files: files.map((f) => ({
          added: f.added,
          removed: f.removed,
          deleted: f.deleted,
          oldRanges: f.oldRanges ?? [],
          newRanges: f.newRanges ?? [],
        })),
      });
    }
    return out;
  }
}

/** Build an Error carrying a stable machine code. */
export function errWith(message: string, code: string): Error & { code: string } {
  const e = new Error(message) as Error & { code: string };
  e.code = code;
  return e;
}

/** Normalize a relative path for comparisons (forward slashes, no ./). */
export function normalizeRel(rel: string): string {
  return String(rel).replace(/\\/g, '/').replace(/^\.\//, '');
}
