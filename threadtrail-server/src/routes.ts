/**
 * HTTP routes for the ThreadTrail git-diff panel. Mounted on the web server
 * under the `/threadtrail/` prefix (the web-server exact/prefix table matches
 * before the SPA fallback). Read-only GETs only — comparing records never
 * touches the workspace.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { collectRecords, diffRecords } from './repo.ts';
import { isGitRepo } from './git.ts';

const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

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
    const result = await collectRecords(effectiveCwd);
    result.root = root;
    sendJson(res, 200, result);
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
      sendJson(res, 200, await diffRecords(effectiveCwd, from, to));
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
