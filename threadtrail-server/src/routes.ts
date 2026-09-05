/**
 * HTTP routes for the ThreadTrail git-diff panel. Mounted on the web server
 * under the `/threadtrail/` prefix (the web-server exact/prefix table matches
 * before the SPA fallback). Read-only GETs only — comparing records never
 * touches the workspace.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { collectRecords, diffRecords, worktreeStamp } from './repo.ts';
import { isGitRepo } from './git.ts';

const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

/**
 * Response caches keyed by route + workspace + selection. The client polls
 * while an agent turn runs, but the underlying git state rarely moves between
 * ticks — so answers are recomputed only when the worktree stamp moves.
 * Bodies are stored pre-serialized; anything larger than the cap is served
 * uncached. Commit-to-commit diffs are immutable and skip stamping entirely.
 */
interface CacheEntry {
  stamp: string;
  body: string;
}
const recordsCache = new Map<string, CacheEntry>();
const diffCache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<string>>();
const CACHE_LIMIT = 60;
const MAX_CACHED_BODY_BYTES = 4 * 1024 * 1024;

function cachePut(map: Map<string, CacheEntry>, key: string, entry: CacheEntry): void {
  if (entry.body.length > MAX_CACHED_BODY_BYTES) return;
  if (map.size >= CACHE_LIMIT) map.delete(map.keys().next().value as string);
  map.set(key, entry);
}

/** Single-flight: concurrent identical requests share one computation. */
function computeOnce(key: string, fn: () => Promise<string>): Promise<string> {
  const existing = inflight.get(key);
  if (existing) return existing;
  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** Send a pre-serialized JSON body. */
function sendRawJson(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

/** The web-server face this plugin needs (the host webserver satisfies it). */
export interface WebServerLike {
  register(opts: { kind: string; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }): void;
}

/** The session-store face the routes need for workspace lookup. */
export interface SessionStoreLike {
  get(sessionId: string): { header?: { cwd?: string | null } } | undefined;
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

/**
 * Register the /threadtrail/ routes on the web server.
 *
 * NOTE: the prefix must NOT end with a slash — the webserver matcher tests
 * `pathname.startsWith(prefix + "/")`, so "/threadtrail/" would demand a double
 * slash and never match.
 */
export function registerRoutes(webServer: WebServerLike, deps: { sessions: SessionStoreLike | undefined }): void {
  webServer.register({
    kind: 'prefix',
    path: '/threadtrail',
    handler: async (req, res) => {
      try {
        await handle(req, res, deps);
      } catch (err) {
        sendJson(res, 500, { error: String(err instanceof Error ? err.message : err) });
      }
    },
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, deps: { sessions: SessionStoreLike | undefined }): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean); // ['threadtrail', ...]

  if (parts.length === 2 && parts[1] === 'status.json' && req.method === 'GET') {
    sendJson(res, 200, { enabled: true });
    return;
  }

  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }
  if (parts.length !== 3 || parts[0] !== 'threadtrail') {
    sendJson(res, 404, { error: 'not found' });
    return;
  }
  const sessionId = parts[1];
  if (!SESSION_ID_RE.test(sessionId)) {
    sendJson(res, 400, { error: 'invalid session id' });
    return;
  }

  const cwd = deps.sessions?.get(sessionId)?.header?.cwd ?? null;
  if (!cwd) {
    sendJson(res, 400, { error: 'session has no workspace' });
    return;
  }

  // The comparison root: the workspace itself, or a user-picked subfolder
  // (for workspaces that are not git repositories but contain one).
  const root = sanitizeRoot(url.searchParams.get('root'));
  if (root === null) {
    sendJson(res, 400, { error: 'invalid root' });
    return;
  }
  const effectiveCwd = root ? path.join(cwd, root) : cwd;

  if (parts[2] === 'records.json') {
    const key = `records|${effectiveCwd}`;
    const stamp = await worktreeStamp(effectiveCwd);
    const hit = recordsCache.get(key);
    if (hit && hit.stamp === stamp) {
      sendRawJson(res, 200, hit.body);
      return;
    }
    const body = await computeOnce(key, async () => {
      const result = await collectRecords(effectiveCwd);
      result.root = root;
      return JSON.stringify(result);
    });
    cachePut(recordsCache, key, { stamp, body });
    sendRawJson(res, 200, body);
    return;
  }

  if (parts[2] === 'diff.json') {
    if (!(await isGitRepo(effectiveCwd))) {
      sendJson(res, 400, { error: 'not a git repository' });
      return;
    }
    const from = url.searchParams.get('from') ?? '';
    const to = url.searchParams.get('to') ?? '';
    try {
      const key = `diff|${effectiveCwd}|${from}|${to}`;
      // Commit-to-commit diffs are immutable; anything touching the worktree
      // is stamped so unchanged worktrees skip the git diff entirely.
      const stamp = from !== 'worktree' && to !== 'worktree' ? 'static' : await worktreeStamp(effectiveCwd);
      const hit = diffCache.get(key);
      if (hit && hit.stamp === stamp) {
        sendRawJson(res, 200, hit.body);
        return;
      }
      const body = await computeOnce(key, async () => JSON.stringify(await diffRecords(effectiveCwd, from, to)));
      cachePut(diffCache, key, { stamp, body });
      sendRawJson(res, 200, body);
    } catch (err) {
      const code = (err as Error & { code?: string }).code;
      sendJson(res, code === 'THREADTRAIL_BAD_RECORD' ? 400 : 500, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  sendJson(res, 404, { error: 'not found' });
}

/**
 * Validate the `root` query param: a workspace-relative subfolder path.
 * @returns the normalized relative path ('' = workspace root), or null when
 *   the value escapes the workspace.
 */
function sanitizeRoot(raw: string | null): string | null {
  if (raw == null || raw === '' || raw === '.') return '';
  const norm = path.normalize(raw.replace(/\\/g, '/')).replace(/\\/g, '/');
  if (norm.startsWith('..') || path.isAbsolute(norm) || norm.includes('\0')) return null;
  return norm === '.' ? '' : norm;
}
