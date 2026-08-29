/**
 * Git helpers — dependency-free (no `git` binary required): gitdir
 * resolution and HEAD resolution. Commit listing and diffs need real git
 * object access; those live in `repo.ts` and spawn the `git` binary.
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
