/**
 * Git-diff engine of the ThreadTrail repurpose: the records a session's
 * workspace can be compared between (every commit, plus the uncommitted
 * worktree state treated as one record) and the unified diff between any two
 * of them.
 *
 * Unlike the capture engine this replaces, commit-to-commit diffs cannot be
 * reconstructed from scratch — they need git object access — so this module
 * spawns the `git` binary (validated arguments only) and degrades to an
 * explicit `gitAvailable: false` state when it is missing.
 */

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { gitHead, isGitRepo } from './git.ts';
import type { DiffFile, DiffHunk, DiffLine, RecordInfo, RecordsResult, DiffResult } from './types.ts';

/** The synthetic record id of the uncommitted worktree state. */
export const WORKTREE_ID = 'worktree';

/** The synthetic record id of the empty tree (before the first commit). */
export const EMPTY_ID = 'empty';

/** git's well-known empty-tree sha — valid anywhere a tree-ish is expected. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** Full-length commit shas only — record ids double as git CLI arguments. */
const COMMIT_ID_RE = /^[0-9a-f]{40}$/;

function isRecordId(id: string): boolean {
  return COMMIT_ID_RE.test(id) || id === WORKTREE_ID || id === EMPTY_ID;
}

const MAX_COMMITS = 300;
const MAX_PATCH_BYTES = 24 * 1024 * 1024;
const MAX_DIFF_FILES = 500;
const MAX_DIFF_LINES = 20000;
const MAX_UNTRACKED_FILES = 200;
const MAX_UNTRACKED_BYTES = 1024 * 1024;
const MAX_UNTRACKED_LINES = 2000;

/** True when the `git` binary can be spawned at all. */
export async function gitAvailable(): Promise<boolean> {
  try {
    await runGit('.', ['--version']);
    return true;
  } catch {
    return false;
  }
}

interface GitOutput {
  text: string;
  /** True when the output hit the byte cap and the process was killed. */
  truncated: boolean;
}

/** Spawn git and collect stdout (byte-capped; kills the process on overflow). */
function runGit(cwd: string, args: string[], maxBytes = MAX_PATCH_BYTES): Promise<GitOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        truncated = true;
        child.kill('SIGKILL');
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (Buffer.concat(errChunks).length < 4096) errChunks.push(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (truncated) {
        resolve({ text: Buffer.concat(chunks).toString('utf8'), truncated: true });
      } else if (code === 0) {
        resolve({ text: Buffer.concat(chunks).toString('utf8'), truncated: false });
      } else {
        reject(new Error(`git ${args[0] ?? ''} failed (${code}): ${Buffer.concat(errChunks).toString('utf8').trim().slice(0, 300)}`));
      }
    });
  });
}

/** One `git log` row. */
export interface CommitRow {
  sha: string;
  shortSha: string;
  /** First-parent sha, or null for the root commit. */
  parent: string | null;
  author: string;
  time: number;
  subject: string;
}

/** Recent commits of the workspace, newest first ([] on an unborn HEAD). */
export async function listCommits(cwd: string, limit = MAX_COMMITS): Promise<CommitRow[]> {
  let out: GitOutput;
  try {
    out = await runGit(cwd, ['log', '--no-color', `--format=%H%x1f%h%x1f%P%x1f%an%x1f%at%x1f%s`, '-n', String(limit)], 4 * 1024 * 1024);
  } catch (err) {
    // "fatal: your current branch ... does not have any commits yet"
    if (/does not have any commits|bad default revision/i.test(String(err instanceof Error ? err.message : err))) return [];
    throw err;
  }
  const rows: CommitRow[] = [];
  for (const line of out.text.split('\n')) {
    if (!line) continue;
    const [sha, shortSha, parents, author, at, subject] = line.split('\x1f');
    if (!sha || !COMMIT_ID_RE.test(sha)) continue;
    const parent = (parents ?? '').split(' ')[0];
    rows.push({ sha, shortSha, parent: parent && COMMIT_ID_RE.test(parent) ? parent : null, author: author ?? '', time: Number(at) * 1000, subject: subject ?? '' });
  }
  return rows;
}

/** Counts of the uncommitted state: tracked changes + untracked files. */
export async function worktreeStatus(cwd: string): Promise<{ changed: number; untracked: number }> {
  const out = await runGit(cwd, ['status', '--porcelain'], 4 * 1024 * 1024);
  let changed = 0;
  let untracked = 0;
  for (const line of out.text.split('\n')) {
    if (!line) continue;
    if (line.startsWith('??')) untracked++;
    else changed++;
  }
  return { changed, untracked };
}

/** Directories never descended into when looking for nested repositories. */
const SUBDIR_SKIP = new Set(['node_modules', 'dist', 'build', 'target', 'out', 'venv', '.venv', '__pycache__']);

/**
 * Find subfolders of a (non-git) workspace that are themselves git
 * repositories, so the user can pick one as the comparison root. Breadth of
 * search: up to `maxDepth` levels, skipping hidden/noise directories, not
 * descending into a repository once found. Returns workspace-relative paths
 * ('/' separators), sorted.
 */
export async function findGitSubdirs(cwd: string, maxDepth = 3, maxResults = 50): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, rel: string, depth: number): Promise<void> {
    if (out.length >= maxResults || depth > maxDepth) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory — skip
    }
    for (const entry of entries) {
      if (out.length >= maxResults) return;
      if (!entry.isDirectory() || entry.name.startsWith('.') || SUBDIR_SKIP.has(entry.name)) continue;
      const childAbs = path.join(dir, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (await isGitRepo(childAbs)) {
        out.push(childRel); // a repository root — do not descend further
        continue;
      }
      await walk(childAbs, childRel, depth + 1);
    }
  }
  await walk(path.resolve(cwd), '', 1);
  return out.sort();
}

/** The record list of a workspace: the worktree record plus every commit. */
export async function collectRecords(cwd: string): Promise<RecordsResult> {
  const repo = await isGitRepo(cwd);
  const gitOk = repo ? await gitAvailable() : false;
  // Nested repositories (submodules, vendored checkouts) are always offered
  // as selectable comparison roots — the workspace root being a repo itself
  // does not make them less interesting.
  const candidates = await findGitSubdirs(cwd);
  const base: RecordsResult = { cwd, root: '', isRepo: repo, gitAvailable: gitOk, head: null, worktree: null, records: [], candidates };
  if (!repo || !gitOk) return base;

  const [head, commits, wt] = await Promise.all([gitHead(cwd), listCommits(cwd), worktreeStatus(cwd)]);
  const records: RecordInfo[] = [{ id: WORKTREE_ID, kind: 'worktree' }];
  for (const c of commits) {
    records.push({ id: c.sha, kind: 'commit', shortSha: c.shortSha, subject: c.subject, author: c.author, time: c.time, parent: c.parent });
  }
  // The empty tree as the final record: makes the root commit viewable and
  // gives every commit a "from scratch" comparison base.
  if (commits.length) records.push({ id: EMPTY_ID, kind: 'empty' });
  return { cwd, root: '', isRepo: true, gitAvailable: true, head, worktree: wt, records, candidates };
}

/**
 * Compute the unified diff between two records. The worktree endpoint is the
 * live working tree (staged + unstaged tracked changes via `git diff <sha>`,
 * plus untracked files synthesized as whole-file additions); a commit
 * endpoint is its sha; the `empty` endpoint is git's empty tree.
 */
export async function diffRecords(cwd: string, from: string, to: string): Promise<DiffResult> {
  if (!isRecordId(from)) throw Object.assign(new Error(`invalid record id: ${from}`), { code: 'THREADTRAIL_BAD_RECORD' });
  if (!isRecordId(to)) throw Object.assign(new Error(`invalid record id: ${to}`), { code: 'THREADTRAIL_BAD_RECORD' });
  if (from === to) return { from, to, files: [], truncated: false };

  const inverted = from === WORKTREE_ID;
  const fromRev = from === EMPTY_ID ? EMPTY_TREE : from;
  const toRev = to === EMPTY_ID ? EMPTY_TREE : to;
  let patch: GitOutput;
  if (from !== WORKTREE_ID && to !== WORKTREE_ID) {
    patch = await runGit(cwd, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '-M', fromRev, toRev]);
  } else {
    // git diff <sha> = worktree (tracked, staged + unstaged) relative to the
    // commit; when the worktree is the "from" side the diff is inverted below.
    const commit = inverted ? toRev : fromRev;
    patch = await runGit(cwd, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '-M', commit]);
  }

  let files = parsePatch(patch.text);
  let truncated = patch.truncated;

  if (from === WORKTREE_ID || to === WORKTREE_ID) {
    const untracked = await untrackedFiles(cwd);
    files = mergeByPath(files, untracked);
    if (inverted) files = files.map(invertFile);
  }

  // Bound the payload: cap files and total diff lines (stats stay whole —
  // they were counted during the full parse; the flag says hunks were cut).
  if (files.length > MAX_DIFF_FILES) {
    files = files.slice(0, MAX_DIFF_FILES);
    truncated = true;
  }
  let lines = 0;
  let cut = false;
  for (const f of files) {
    if (cut) {
      f.hunks = [];
      continue;
    }
    const kept: DiffHunk[] = [];
    for (const h of f.hunks) {
      if (lines + h.lines.length > MAX_DIFF_LINES) {
        cut = true;
        truncated = true;
        break;
      }
      kept.push(h);
      lines += h.lines.length;
    }
    f.hunks = kept;
  }

  return { from, to, files, truncated };
}

/** Untracked files as whole-file additions (git diff never reports them). */
async function untrackedFiles(cwd: string): Promise<DiffFile[]> {
  const out = await runGit(cwd, ['ls-files', '--others', '--exclude-standard', '-z'], 4 * 1024 * 1024);
  const rels = out.text.split('\0').filter(Boolean).slice(0, MAX_UNTRACKED_FILES).sort();
  const files: DiffFile[] = [];
  for (const rel of rels) {
    const abs = path.join(cwd, rel);
    if (!abs.startsWith(path.resolve(cwd) + path.sep)) continue;
    let text: string;
    try {
      const st = await fs.stat(abs);
      if (!st.isFile() || st.size > MAX_UNTRACKED_BYTES) continue;
      text = await fs.readFile(abs, 'utf8');
    } catch {
      continue; // unreadable or non-UTF8 — skip
    }
    if (text.slice(0, 8192).includes('\0')) continue; // binary — skip
    let lines = text === '' ? [] : text.split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    let truncated = false;
    if (lines.length > MAX_UNTRACKED_LINES) {
      lines = lines.slice(0, MAX_UNTRACKED_LINES);
      truncated = true;
    }
    const diffLines: DiffLine[] = lines.map((l) => ({ t: '+', text: l }));
    files.push({
      path: rel,
      oldPath: null,
      status: 'added',
      binary: false,
      truncated,
      added: diffLines.length,
      removed: 0,
      hunks: diffLines.length
        ? [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: diffLines.length, header: 'untracked file', lines: diffLines }]
        : [],
    });
  }
  return files;
}

/** Merge two file-diff lists by path (untracked entries sort into place). */
function mergeByPath(a: DiffFile[], b: DiffFile[]): DiffFile[] {
  const seen = new Set(a.map((f) => f.path));
  const out = [...a];
  for (const f of b) if (!seen.has(f.path)) out.push(f);
  out.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  return out;
}

/** Flip a diff's direction (worktree→commit instead of commit→worktree). */
function invertFile(f: DiffFile): DiffFile {
  let status = f.status;
  let p = f.path;
  let o = f.oldPath;
  if (f.status === 'added') {
    status = 'deleted';
    o = f.path;
  } else if (f.status === 'deleted') {
    status = 'added';
    p = f.oldPath ?? f.path;
    o = null;
  } else if (f.status === 'renamed') {
    p = f.oldPath ?? f.path;
    o = f.path;
  }
  return {
    ...f,
    status,
    path: p,
    oldPath: o,
    added: f.removed,
    removed: f.added,
    hunks: f.hunks.map((h) => ({
      oldStart: h.newStart,
      oldLines: h.newLines,
      newStart: h.oldStart,
      newLines: h.oldLines,
      header: h.header,
      lines: h.lines.map((l) => ({ t: l.t === '+' ? '-' : l.t === '-' ? '+' : ' ', text: l.text })),
    })),
  };
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@\s?(.*)$/;

/**
 * Parse `git diff` unified output into per-file hunks. Paths come from the
 * `---`/`+++` header lines (authoritative, quoted-path aware); the
 * `diff --git` line only opens a new entry.
 */
export function parsePatch(patch: string): DiffFile[] {
  const files: DiffFile[] = [];
  let cur: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      cur = { path: '', oldPath: null, status: 'modified', binary: false, added: 0, removed: 0, hunks: [] };
      files.push(cur);
      hunk = null;
      // Initial paths from the header line (the only source for binary
      // files); the ---/+++ lines refine them for text diffs.
      const [a, b] = splitDiffGitPaths(line.slice('diff --git '.length));
      if (a) cur.oldPath = stripPrefix(a);
      if (b) cur.path = stripPrefix(b);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('new file mode')) {
      cur.status = 'added';
    } else if (line.startsWith('deleted file mode')) {
      cur.status = 'deleted';
    } else if (line.startsWith('rename from ')) {
      cur.oldPath = line.slice('rename from '.length);
      cur.status = 'renamed';
    } else if (line.startsWith('rename to ')) {
      cur.path = line.slice('rename to '.length);
      cur.status = 'renamed';
    } else if (line.startsWith('Binary files') || line.startsWith('GIT binary patch')) {
      cur.binary = true;
    } else if (line.startsWith('--- ')) {
      const p = unquotePath(line.slice(4));
      if (p !== '/dev/null') cur.oldPath = stripPrefix(p);
    } else if (line.startsWith('+++ ')) {
      const p = unquotePath(line.slice(4));
      if (p !== '/dev/null') cur.path = stripPrefix(p);
    } else if (line.startsWith('@@')) {
      const m = HUNK_RE.exec(line);
      if (m) {
        hunk = {
          oldStart: Number(m[1]),
          oldLines: m[2] == null ? 1 : Number(m[2]),
          newStart: Number(m[3]),
          newLines: m[4] == null ? 1 : Number(m[4]),
          header: m[5] ?? '',
          lines: [],
        };
        cur.hunks.push(hunk);
      }
    } else if (hunk && line.length > 0 && (line[0] === '+' || line[0] === '-' || line[0] === ' ')) {
      const t = line[0] as DiffLine['t'];
      hunk.lines.push({ t, text: line.slice(1) });
      if (t === '+') cur.added++;
      else if (t === '-') cur.removed++;
    }
    // '\ No newline at end of file' and everything else: ignored.
  }
  // Deleted files never get a `+++` path (it is /dev/null) — fall back to the
  // old path so the UI always has a display name; added files have no old
  // path (/dev/null).
  for (const f of files) {
    if (!f.path && f.oldPath) f.path = f.oldPath;
    if (f.status === 'added') f.oldPath = null;
  }
  return files.filter((f) => f.path || f.oldPath);
}

/** Strip the a/ b/ prefix git puts on diff header paths. */
function stripPrefix(p: string): string {
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

/**
 * Split the two paths of a `diff --git <a> <b>` line. Unquoted paths may
 * contain spaces (git only C-quotes control/non-ASCII characters), so the
 * split happens at the ` b/` boundary; quoted paths are honored first.
 */
function splitDiffGitPaths(rest: string): [string | null, string | null] {
  if (rest.startsWith('"')) {
    let j = 1;
    while (j < rest.length) {
      if (rest[j] === '\\') j += 2;
      else if (rest[j] === '"') break;
      else j++;
    }
    const a = unquotePath(rest.slice(0, j + 1));
    const b = rest.slice(j + 2);
    return [a, b ? (b.startsWith('"') ? unquotePath(b) : b) : null];
  }
  const idx = rest.indexOf(' b/');
  if (idx !== -1) return [rest.slice(0, idx), rest.slice(idx + 1)];
  const q = rest.indexOf(' "');
  if (q !== -1) return [rest.slice(0, q), unquotePath(rest.slice(q + 1))];
  return [null, null];
}

/** Undo git's C-style quoting of unusual paths ("a/foo\tbar"). */
function unquotePath(p: string): string {
  if (!p.startsWith('"')) return p;
  try {
    return JSON.parse(p) as string;
  } catch {
    return p;
  }
}
