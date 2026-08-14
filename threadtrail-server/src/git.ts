/**
 * Git helpers — dependency-free (no `git` binary required): gitdir
 * resolution, HEAD resolution, and gitignore(5) matching.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Resolve the gitdir of a workspace: `cwd/.git` (a directory), or a worktree /
 * submodule `.git` file pointing at a gitdir.
 * @returns the gitdir absolute path, or null when `cwd` is not inside a git
 *   repository (no `.git`, or a `.git` file without a `gitdir:` line).
 */
export async function resolveGitDir(cwd: string): Promise<string | null> {
  const gitPath = path.join(cwd, '.git');
  let gitDir = gitPath;
  try {
    const st = await fs.stat(gitPath);
    if (st.isFile()) {
      const content = await fs.readFile(gitPath, 'utf8');
      const m = /^gitdir:\s*(.+)$/m.exec(content);
      if (!m) return null;
      gitDir = path.resolve(cwd, m[1].trim());
    }
  } catch {
    return null; // no .git at all — not a git workspace
  }
  return gitDir;
}

/** True when `cwd` is inside a git repository (`.git` present). */
export async function isGitRepo(cwd: string): Promise<boolean> {
  return (await resolveGitDir(cwd)) !== null;
}

/**
 * Resolve the current git HEAD commit sha of a workspace without spawning
 * git: reads `.git/HEAD` (handles both a `.git` directory and a worktree /
 * submodule `.git` file pointing at a gitdir), follows symbolic refs, and
 * falls back to packed-refs.
 * @returns the HEAD sha (lowercase, 40 hex), or null when the directory is
 *   not inside a git repository.
 */
export async function gitHead(cwd: string): Promise<string | null> {
  const gitDir = await resolveGitDir(cwd);
  if (!gitDir) return null;
  let head: string;
  try {
    head = (await fs.readFile(path.join(gitDir, 'HEAD'), 'utf8')).trim();
  } catch {
    return null;
  }
  const ref = /^ref:\s*(\S+)$/.exec(head);
  if (ref) {
    try {
      head = (await fs.readFile(path.join(gitDir, ref[1]), 'utf8')).trim();
    } catch {
      // the ref is packed — look it up in packed-refs
      try {
        const packed = await fs.readFile(path.join(gitDir, 'packed-refs'), 'utf8');
        let found: string | null = null;
        for (const line of packed.split('\n')) {
          const pm = /^([0-9a-f]{40,})\s+(\S+)$/.exec(line.trim());
          if (pm && pm[2] === ref[1]) {
            found = pm[1];
            break;
          }
        }
        head = found ?? '';
      } catch {
        head = '';
      }
    }
  }
  return /^[0-9a-f]{40}$/.test(head) ? head : null;
}

/** One parsed gitignore pattern (a single non-comment line). */
interface RawPattern {
  negated: boolean;
  dirOnly: boolean;
  anchored: boolean;
  body: string;
}

/** A compiled pattern: raw fields plus the base dir and matcher regex. */
interface CompiledPattern extends RawPattern {
  /** '' = repo root, else the rel dir of the .gitignore file (or exclude). */
  base: string;
  /** Anchored: full rel-path regex. Basename: single-component regex. */
  re: RegExp;
}

/**
 * Git-ignore matching for a workspace, implemented from scratch so no `git`
 * binary is required. Reads `.git/info/exclude` plus every `.gitignore` in
 * the tree and implements the gitignore(5) rules for the common cases:
 * basename patterns at any depth, slash-anchored patterns, directory-only
 * (`dir/`) patterns, `**` globs, comments, and `!` negation (including the
 * "re-include a file under an excluded directory" rule). The global excludes
 * file is not read.
 */
export class GitIgnore {
  private patterns: CompiledPattern[] = [];
  /** abs path -> mtimeNs of every ignore file currently loaded. */
  private loadedFiles = new Map<string, bigint>();
  private cache = new Map<string, boolean>();
  private root = '';
  private skipDirs: ReadonlySet<string> = new Set();

  /** Load the ignore rules of a workspace (empty matcher when not a git repo). */
  static async load(root: string, opts: { skipDirs?: ReadonlySet<string> } = {}): Promise<GitIgnore> {
    const gi = new GitIgnore();
    gi.root = root;
    gi.skipDirs = opts.skipDirs ?? new Set();
    await gi.reload();
    return gi;
  }

  /** True when there are no ignore rules at all (nothing can be ignored). */
  get isEmpty(): boolean {
    return this.patterns.length === 0;
  }

  /**
   * Reload the rules if any loaded ignore file changed on disk. New
   * .gitignore files are only discovered by a full load (every capture scan
   * does one).
   * @returns true when the rules were reloaded.
   */
  async refreshIfChanged(): Promise<boolean> {
    if (this.loadedFiles.size === 0) return false;
    for (const [abs, mtime] of this.loadedFiles) {
      let changed = true;
      try {
        const st = await fs.stat(abs, { bigint: true });
        changed = st.mtimeNs !== mtime;
      } catch {
        // ignore file deleted — reload
      }
      if (changed) {
        await this.reload();
        return true;
      }
    }
    return false;
  }

  private async reload(): Promise<void> {
    this.patterns = [];
    this.loadedFiles = new Map();
    this.cache.clear();
    const gitDir = await resolveGitDir(this.root);
    if (!gitDir) return;

    // Lowest precedence: $GIT_DIR/info/exclude.
    const excludePath = path.join(gitDir, 'info', 'exclude');
    try {
      const text = await fs.readFile(excludePath, 'utf8');
      const st = await fs.stat(excludePath, { bigint: true });
      this.loadedFiles.set(excludePath, st.mtimeNs);
      this.addRaw('', parseGitignore(text));
    } catch {
      // no exclude file
    }

    // .gitignore files in the tree, deepest-last so that more specific
    // (deeper) files override shallower ones, like git does.
    const bases: string[] = [];
    const stack = [this.root];
    while (stack.length) {
      const dir = stack.pop()!;
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        continue; // unreadable directory — skip
      }
      for (const entry of entries) {
        if (entry.name === '.git') continue;
        if (entry.isDirectory()) {
          if (this.skipDirs.has(entry.name)) continue;
          stack.push(path.join(dir, entry.name));
        } else if (entry.name === '.gitignore') {
          bases.push(path.relative(this.root, dir));
        }
      }
    }
    const depth = (p: string): number => (p === '' ? 0 : p.split('/').length);
    bases.sort((a, b) => depth(a) - depth(b) || (a < b ? -1 : a > b ? 1 : 0));
    for (const base of bases) {
      const abs = path.join(this.root, base, '.gitignore');
      try {
        const text = await fs.readFile(abs, 'utf8');
        const st = await fs.stat(abs, { bigint: true });
        this.loadedFiles.set(abs, st.mtimeNs);
        this.addRaw(base, parseGitignore(text));
      } catch {
        // unreadable — skip
      }
    }
  }

  private addRaw(base: string, raws: RawPattern[]): void {
    for (const raw of raws) {
      try {
        const source = raw.anchored
          ? '^(?:' + globToRe(raw.body) + ')' + (raw.dirOnly ? '(?:/.*)?$' : '$')
          : '^(?:' + globToRe(raw.body) + ')$';
        this.patterns.push({ ...raw, base, re: new RegExp(source) });
      } catch {
        // skip a malformed pattern rather than failing the whole load
      }
    }
  }

  /**
   * True when `rel` (workspace-relative, '/' separators) is git-ignored.
   * A path is ignored when any of its ancestor directories is ignored (git
   * never re-includes files under an excluded directory), otherwise the last
   * matching pattern decides.
   */
  ignores(rel: string): boolean {
    const norm = normalizeRel(rel);
    if (!norm || this.isEmpty) return false;
    const cached = this.cache.get(norm);
    if (cached !== undefined) return cached;
    const parts = norm.split('/');
    for (let i = 1; i < parts.length; i++) {
      if (this.status(parts.slice(0, i).join('/'), true)) {
        this.cache.set(norm, true);
        return true;
      }
    }
    const ignored = this.status(norm, false);
    this.cache.set(norm, ignored);
    return ignored;
  }

  /** Last matching pattern wins (in precedence order). */
  private status(rel: string, isDir: boolean): boolean {
    let ignored = false;
    for (const p of this.patterns) {
      // A pattern applies only below its .gitignore's directory.
      if (p.base !== '' && !rel.startsWith(p.base + '/')) continue;
      const relToBase = p.base === '' ? rel : rel.slice(p.base.length + 1);
      if (patternMatches(p, relToBase, isDir)) ignored = !p.negated;
    }
    return ignored;
  }
}

function patternMatches(p: CompiledPattern, rel: string, isDir: boolean): boolean {
  if (p.anchored) return p.re.test(rel);
  // Basename patterns match any single path component; a component match
  // below the final one means the path sits under a matching directory.
  const comps = rel.split('/');
  for (let k = 0; k < comps.length; k++) {
    if (!p.re.test(comps[k])) continue;
    if (k < comps.length - 1) return true;
    return isDir || !p.dirOnly;
  }
  return false;
}

/** Parse a .gitignore file body into raw patterns. */
function parseGitignore(text: string): RawPattern[] {
  const out: RawPattern[] = [];
  for (const line of text.split('\n')) {
    let body = line.replace(/\r$/, '').trimEnd();
    if (!body || body.startsWith('#')) continue;
    let negated = false;
    if (body.startsWith('!')) {
      negated = true;
      body = body.slice(1);
    }
    if (!body) continue;
    let dirOnly = false;
    if (body.endsWith('/')) {
      dirOnly = true;
      body = body.slice(0, -1);
    }
    if (!body) continue;
    let anchored = false;
    if (body.startsWith('/')) {
      anchored = true;
      body = body.slice(1);
    }
    if (!body) continue;
    if (body.includes('/')) anchored = true;
    out.push({ negated, dirOnly, anchored, body });
  }
  return out;
}

/**
 * Translate a gitignore glob body into regex source. `*` and `?` never cross
 * `/`; `**` crosses it: a leading `**`-slash matches at any depth, a trailing
 * slash-`**` matches everything inside, and a `**` between slashes matches
 * zero or more directories; elsewhere `**` behaves like `*`.
 */
function globToRe(body: string): string {
  let out = '';
  let i = 0;
  while (i < body.length) {
    const ch = body[i];
    if (ch === '*') {
      if (body[i + 1] === '*') {
        if (i === 0 && body[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 3;
          continue; // leading **/
        }
        if (i > 0 && body[i - 1] === '/' && i + 2 === body.length) {
          out += '.*';
          i += 2;
          continue; // trailing /**
        }
        if (i > 0 && body[i - 1] === '/' && body[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 3;
          continue; // /**/ between slashes
        }
        out += '[^/]*';
        i += 2;
        continue; // non-special ** behaves like *
      }
      out += '[^/]*';
      i += 1;
      continue;
    }
    if (ch === '?') {
      out += '[^/]';
      i += 1;
      continue;
    }
    if (ch === '[') {
      // character class: [!...] negates, \ escapes, a missing ] is literal
      let j = i + 1;
      let cls = '';
      if (body[j] === '!') {
        cls += '^';
        j++;
      } else if (body[j] === '^') {
        cls += '\\^';
        j++;
      }
      let closed = false;
      while (j < body.length) {
        if (body[j] === '\\' && j + 1 < body.length) {
          cls += '\\' + body[j + 1];
          j += 2;
          continue;
        }
        if (body[j] === ']') {
          closed = true;
          break;
        }
        cls += body[j];
        j++;
      }
      if (closed) {
        out += '[' + cls + ']';
        i = j + 1;
        continue;
      }
      out += '\\[';
      i += 1;
      continue;
    }
    if (ch === '\\' && i + 1 < body.length) {
      out += escapeRe(body[i + 1]);
      i += 2;
      continue;
    }
    out += escapeRe(ch);
    i += 1;
  }
  return out;
}

function escapeRe(ch: string): string {
  return '.*+?^${}()|[]\\'.includes(ch) ? '\\' + ch : ch;
}

/** Normalize a relative path for comparisons (forward slashes, no ./). */
function normalizeRel(rel: string): string {
  return String(rel).replace(/\\/g, '/').replace(/^\.\//, '');
}
