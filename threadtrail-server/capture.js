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
 *   blobs/<sha256>          content-addressed file contents (deduped across
 *                           sessions and ops)
 *   sessions/<sessionId>.jsonl   append-only op records (one JSON object per
 *                           line; the full diff text lives here)
 *
 * An op record has a stable identity `op-<n>` per session and carries:
 *   atSeq          the session event seq that triggered the capture
 *   turn/step      the agent turn the change belongs to (null for manual)
 *   userMessageSeq the seq of the human prompt that drove the turn
 *   assistantSeqs  seqs of the assistant messages inside that turn
 *   files[]        per-file { path, sha, prevSha, deleted, added, removed,
 *                  diff } where diff is a line-marker list
 *
 * Capture happens at turn boundaries (the "between commits" granularity):
 * a scan at `turn/start` records manual edits made since the last scan, and
 * a scan at `turn/end` records the agent's edits for that turn.
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
/** Canonical harness home helper from the platform when resolvable (profile
 * installs), else the identical inline logic (~/.dsh fallback). */
let dshHomePath;
try {
  dshHomePath = require('@deepseek-ai/dsh-home-paths').dshHomePath;
} catch {
  dshHomePath = (...segments) => {
    const env = process.env.DSH_HOME;
    const home = env && env.trim() ? env : path.join(os.homedir(), '.dsh');
    return path.join(home, ...segments);
  };
}

export const IGNORE_NAMES = new Set([
  '.git', 'node_modules', '.threadtrail', 'target', 'dist', 'build', 'out',
  '.next', '.nuxt', '__pycache__', '.venv', 'venv', '.DS_Store',
  '.idea', '.vscode', 'coverage', '.turbo', '.cache', '.pytest_cache',
]);

/** Files larger than this are excluded from capture (hashed and diffed). */
export const MAX_CAPTURE_BYTES = 20 * 1024 * 1024;

/** Line counts above this skip the LCS diff and emit a whole-file replace. */
export const LCS_MAX_LINES = 800;

export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Compute a line diff between two texts.
 * @returns {{ added: number, removed: number, lines: Array<{t: ' '|'+'|'-', text: string}> }}
 */
export function computeDiff(oldText, newText) {
  // Split on newlines and drop the artifact empty element from a trailing
  // newline — a trailing '\n' is a property of the file, not an extra line.
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  if (a.length && a[a.length - 1] === '') a.pop();
  if (b.length && b[b.length - 1] === '') b.pop();
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) suffix++;
  const midA = a.slice(prefix, a.length - suffix);
  const midB = b.slice(prefix, b.length - suffix);

  const lines = [];
  for (let i = 0; i < prefix; i++) lines.push({ t: ' ', text: a[i] });
  if (midA.length === 0) {
    for (const x of midB) lines.push({ t: '+', text: x });
  } else if (midB.length === 0) {
    for (const x of midA) lines.push({ t: '-', text: x });
  } else if (midA.length <= LCS_MAX_LINES && midB.length <= LCS_MAX_LINES) {
    for (const { t, text } of lcsDiff(midA, midB)) lines.push({ t, text });
  } else {
    for (const x of midA) lines.push({ t: '-', text: x });
    for (const x of midB) lines.push({ t: '+', text: x });
  }
  for (let i = a.length - suffix; i < a.length; i++) lines.push({ t: ' ', text: a[i] });

  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.t === '+') added++;
    else if (l.t === '-') removed++;
  }
  return { added, removed, lines };
}

/**
 * Compute old/new line ranges covered by a diff's changed runs (unified-diff
 * hunk semantics): each contiguous run of `+`/`-` lines becomes one range on
 * each side. Used to anchor code to conversation ("which lines did this op
 * touch") and to highlight changed lines in the worktree viewer.
 * @param {Array<{t: ' '|'+'|'-', text: string}>} lines
 * @returns {{ oldRanges: Array<{start: number, end: number}>, newRanges: Array<{start: number, end: number}> }}
 */
export function computeRanges(lines) {
  const oldRanges = [];
  const newRanges = [];
  let oldLine = 1;
  let newLine = 1;
  let runOldStart = null;
  let runNewStart = null;
  let oldTouched = false;
  let newTouched = false;
  let inRun = false;
  const closeRun = () => {
    if (!inRun) return;
    if (oldTouched) oldRanges.push({ start: runOldStart, end: oldLine - 1 });
    if (newTouched) newRanges.push({ start: runNewStart, end: newLine - 1 });
    inRun = false;
  };
  for (const l of lines) {
    if (l.t === ' ') {
      closeRun();
      oldLine++;
      newLine++;
    } else {
      if (!inRun) {
        inRun = true;
        runOldStart = oldLine;
        runNewStart = newLine;
        oldTouched = false;
        newTouched = false;
      }
      if (l.t === '-') {
        oldTouched = true;
        oldLine++;
      } else {
        newTouched = true;
        newLine++;
      }
    }
  }
  closeRun();
  return { oldRanges, newRanges };
}

/** LCS diff of two line arrays (n*m DP over Int32 rows, memory-bounded by caller). */
export function lcsDiff(a, b) {
  const n = a.length;
  const m = b.length;
  const rows = [new Int32Array(m + 1)];
  for (let i = 1; i <= n; i++) {
    const prev = rows[i - 1];
    const cur = new Int32Array(m + 1);
    const ai = a[i - 1];
    for (let j = 1; j <= m; j++) {
      cur[j] = ai === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    rows.push(cur);
  }
  const out = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      out.push({ t: ' ', text: a[i - 1] });
      i--;
      j--;
    } else if (rows[i - 1][j] >= rows[i][j - 1]) {
      out.push({ t: '-', text: a[i - 1] });
      i--;
    } else {
      out.push({ t: '+', text: b[j - 1] });
      j--;
    }
  }
  while (i > 0) {
    out.push({ t: '-', text: a[i - 1] });
    i--;
  }
  while (j > 0) {
    out.push({ t: '+', text: b[j - 1] });
    j--;
  }
  return out.reverse();
}

/** Recursively list files under `root`, skipping ignored directories/files. */
export async function listFiles(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable directory — skip
    }
    for (const entry of entries) {
      if (IGNORE_NAMES.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
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
async function hashBatch(paths, manifest, sc) {
  let i = 0;
  const limit = Math.min(16, paths.length);
  const workers = Array.from({ length: limit }, async () => {
    while (i < paths.length) {
      const abs = paths[i++];
      try {
        const content = await fs.readFile(abs, 'utf8');
        manifest.get(abs).sha = await sc.writeBlob(content);
      } catch {
        // unreadable file — leave sha null; it will not diff
      }
    }
  });
  await Promise.all(workers);
}

export class CaptureStore {
  /**
   * @param {{ root: string }} opts - `root` is the threadtrail data directory
   *   (defaults to `$DSH_HOME/threadtrail`).
   */
  constructor({ root } = {}) {
    // Canonical harness home (DSH_HOME, or ~/.dsh) — never the bare home dir.
    this.root = root || dshHomePath('threadtrail');
    this.blobsDir = path.join(this.root, 'blobs');
    this.sessionsDir = path.join(this.root, 'sessions');
    this.notesDir = path.join(this.root, 'notes');
    /** @type {Map<string, SessionCapture>} */
    this.sessions = new Map();
  }

  async init() {
    this._init ??= (async () => {
      await fs.mkdir(this.blobsDir, { recursive: true });
      await fs.mkdir(this.sessionsDir, { recursive: true });
      await fs.mkdir(this.notesDir, { recursive: true });
    })();
    return this._init;
  }

  get(sessionId) {
    return this.sessions.get(sessionId);
  }

  /** Attach a session (called on `session/created` or first touch). */
  getOrCreate(sessionId, cwd) {
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
  dispose(sessionId) {
    this.sessions.delete(sessionId);
  }
}

class SessionCapture {
  constructor(store, sessionId, cwd) {
    this.store = store;
    this.sessionId = sessionId;
    this.cwd = cwd || null;
    /** @type {Map<string, {sha: string|null, size: bigint, mtimeNs: bigint}>} */
    this.manifest = new Map();
    /** @type {Array<object>} */
    this.ops = [];
    this.opCounter = 0;
    this.lastUserSeq = null;
    /** @type {Map<number, number[]>} turn -> assistant/message seqs */
    this.assistantSeqs = new Map();
    this.notes = [];
    this.noteCounter = 0;
    this.notesLoaded = false;
    this.loaded = false;
    this.baselined = false;
  }

  jsonlPath() {
    return path.join(this.store.sessionsDir, `${this.sessionId}.jsonl`);
  }

  notesPath() {
    return path.join(this.store.notesDir, `${this.sessionId}.jsonl`);
  }

  async loadNotes() {
    if (this.notesLoaded) return;
    this.notesLoaded = true;
    try {
      const text = await fs.readFile(this.notesPath(), 'utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line);
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
   * @returns {Promise<object>} the stored note record.
   */
  async addNote({ path: rel, startLine, endLine, snippet, note }) {
    await this.loadNotes();
    const record = {
      id: `n-${++this.noteCounter}`,
      path: normalizeRel(rel),
      startLine,
      endLine,
      snippet: snippet ?? '',
      note,
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
  async deleteNote(id) {
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
  async notesFor(rel) {
    await this.loadNotes();
    const norm = normalizeRel(rel);
    return this.notes.filter((n) => n.path === norm).reverse();
  }

  async load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const text = await fs.readFile(this.jsonlPath(), 'utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line);
          this.ops.push(rec);
          const n = Number(rec.id.replace(/^op-/, ''));
          if (Number.isInteger(n) && n > this.opCounter) this.opCounter = n;
        } catch {
          // skip a corrupt line — the log is best-effort
        }
      }
    } catch {
      // no log yet
    }
  }

  async writeBlob(content) {
    const sha = sha256(content);
    try {
      await fs.access(path.join(this.store.blobsDir, sha));
    } catch {
      await fs.writeFile(path.join(this.store.blobsDir, sha), content, 'utf8');
    }
    return sha;
  }

  async readBlob(sha) {
    if (!sha) return '';
    try {
      return await fs.readFile(path.join(this.store.blobsDir, sha), 'utf8');
    } catch {
      return '';
    }
  }

  /**
   * Scan the workspace and record an op for whatever changed since the last
   * scan. The first scan on a fresh session only establishes the baseline.
   * @returns {Promise<object|null>} the recorded op, or null when nothing changed.
   */
  async scan({ trigger, atSeq, turn, userMessageSeq, assistantSeqs = [] }) {
    if (!this.cwd) return null;
    await this.store.init(); // idempotent; safe even if activation did not await
    await this.load();
    const files = await listFiles(this.cwd);
    const next = new Map();
    const pending = [];
    for (const abs of files) {
      let st;
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

    // The first scan only establishes the baseline; nothing is recorded.
    if (!this.baselined) {
      this.manifest = next;
      this.baselined = true;
      return null;
    }

    // changed or added files (content hash differs from the previous scan)
    const changed = [];
    for (const [abs, entry] of next) {
      const prev = this.manifest.get(abs);
      if (prev && prev.sha === entry.sha) continue; // genuinely unchanged
      changed.push({ abs, entry, prev });
    }
    // removed files
    const removed = [];
    for (const [abs, prev] of this.manifest) {
      if (!next.has(abs)) removed.push({ abs, prev });
    }

    if (changed.length === 0 && removed.length === 0) {
      this.manifest = next;
      return null;
    }

    const filesRec = [];
    for (const { abs, entry, prev } of changed) {
      let content;
      try {
        content = await fs.readFile(abs, 'utf8');
      } catch {
        continue;
      }
      const prevText = prev?.sha ? await this.readBlob(prev.sha) : '';
      const diff = computeDiff(prevText, content);
      const { oldRanges, newRanges } = computeRanges(diff.lines);
      filesRec.push({
        path: path.relative(this.cwd, abs),
        sha: entry.sha,
        prevSha: prev?.sha ?? null,
        deleted: false,
        added: diff.added,
        removed: diff.removed,
        diff: diff.lines,
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
      });
    }

    const op = {
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
   * @returns {Promise<{target: string, files: Array<{path: string, state: 'written'|'deleted'|'unchanged'}>}>}
   */
  async rewind(opId, targetDir) {
    await this.load();
    const idx = this.ops.findIndex((o) => o.id === opId);
    if (idx < 0) {
      const err = new Error(`op not found: ${opId}`);
      err.code = 'THREADTRAIL_OP_NOT_FOUND';
      throw err;
    }
    /** @type {Map<string, {sha: string|null, deleted: boolean}>} */
    const state = new Map();
    for (let i = 0; i <= idx; i++) {
      for (const f of this.ops[i].files) {
        state.set(f.path, { sha: f.sha, deleted: f.deleted });
      }
    }
    await fs.mkdir(targetDir, { recursive: true });
    const files = [];
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
  digest() {
    const ops = this.ops.map((o) => ({
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
    /** @type {Record<string, string[]>} */
    const fileIndex = {};
    for (const o of this.ops) {
      for (const f of o.files) {
        (fileIndex[f.path] ??= []).push(o.id);
      }
    }
    const turnIndex = {};
    for (const o of this.ops) {
      if (o.turn == null) continue;
      const t = (turnIndex[o.turn] ??= { userMessageSeq: o.userMessageSeq, opIds: [], assistantSeqs: o.assistantSeqs });
      if (o.userMessageSeq != null) t.userMessageSeq = o.userMessageSeq;
      t.opIds.push(o.id);
      for (const s of o.assistantSeqs) if (!t.assistantSeqs.includes(s)) t.assistantSeqs.push(s);
    }
    return { sessionId: this.sessionId, cwd: this.cwd, ops, fileIndex, turnIndex };
  }

  async opRecord(opId) {
    await this.load();
    return this.ops.find((o) => o.id === opId) ?? null;
  }

  /**
   * List the current workspace files (ignoring capture-ignored dirs), for the
   * worktree browser. Capped to keep the payload UI-scale.
   * @returns {Promise<{root: string, truncated: boolean, files: Array<{path: string, size: number}>} | null>}
   */
  async tree() {
    if (!this.cwd) return null;
    const MAX_FILES = 3000;
    const files = await listFiles(this.cwd);
    const out = [];
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
   * @returns {Promise<string|null>} absolute path, or null when escaping/invalid.
   */
  async resolveWorkspacePath(rel) {
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
   * @returns {Promise<{path: string, content: string, truncated: boolean, lines: number}>}
   * @throws {Error} with `code` THREADTRAIL_NO_CWD / THREADTRAIL_PATH_ESCAPE / THREADTRAIL_NO_FILE
   */
  async readFile(rel) {
    if (!this.cwd) throw errWith('session has no workspace', 'THREADTRAIL_NO_CWD');
    const abs = await this.resolveWorkspacePath(rel);
    if (!abs) throw errWith('path escapes the workspace', 'THREADTRAIL_PATH_ESCAPE');
    let content;
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
   * @returns {Array<{opId, turn, kind, time, userMessageSeq, files: Array}>}
   */
  fileOps(rel) {
    const norm = normalizeRel(rel);
    const out = [];
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
function errWith(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/** Normalize a relative path for comparisons (forward slashes, no ./). */
function normalizeRel(rel) {
  return String(rel).replace(/\\/g, '/').replace(/^\.\//, '');
}
