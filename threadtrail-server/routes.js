/**
 * HTTP routes for the ThreadTrail panel. Mounted on the web server under the
 * `/threadtrail/` prefix (the web-server exact/prefix table matches before the SPA
 * fallback). GETs for reads; POST/DELETE only for the anchored-notes API.
 * Rewind is non-destructive (materializes into `<cwd>/.threadtrail/rewinds/…`).
 */

import path from 'node:path';
import { promptPreview } from './messages.js';

const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const OP_ID_RE = /^op-\d+$/;

export function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

export function sendText(res, status, text) {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

const MAX_BODY_BYTES = 64 * 1024;

/** Read and JSON-parse a request body (size-capped). */
async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const e = new Error('request body too large');
      e.code = 'THREADTRAIL_BODY_TOO_LARGE';
      throw e;
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  return JSON.parse(text);
}

/**
 * Register the /threadtrail/ routes on the web server.
 *
 * NOTE: the prefix must NOT end with a slash — the webserver matcher tests
 * `pathname.startsWith(prefix + "/")`, so "/threadtrail/" would demand a double
 * slash and never match.
 * @param {import('@deepseek-ai/dsh-host-webserver').WebServer} webServer
 * @param {{ store: import('./capture.js').CaptureStore, sessions: import('@deepseek-ai/dsh-session').SessionStore }} deps
 */
export function registerRoutes(webServer, { store, sessions }) {
  webServer.register({
    kind: 'prefix',
    path: '/threadtrail',
    handler: async (req, res) => {
      try {
        await handle(req, res, { store, sessions });
      } catch (err) {
        sendJson(res, 500, { error: String(err?.message ?? err) });
      }
    },
  });
}

async function handle(req, res, { store, sessions }) {
  const url = new URL(req.url, 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean); // ['threadtrail', ...]

  if (parts.length === 2 && parts[1] === 'status.json' && req.method === 'GET') {
    const rows = [];
    for (const [id, sc] of store.sessions) {
      rows.push({ sessionId: id, cwd: sc.cwd, ops: sc.ops.length, notes: sc.notes.length });
    }
    sendJson(res, 200, { enabled: true, root: store.root, sessions: rows });
    return;
  }

  if (parts.length < 3 || parts[0] !== 'threadtrail') {
    sendJson(res, 404, { error: 'not found' });
    return;
  }
  const sessionId = parts[1];
  if (!SESSION_ID_RE.test(sessionId)) {
    sendJson(res, 400, { error: 'invalid session id' });
    return;
  }

  const sc = store.get(sessionId);
  if (!sc) {
    // A request for a session we have not seen yet: attach it if the session
    // store knows it (cold session) — capture then starts on its next events.
    const session = sessions?.get?.(sessionId);
    store.getOrCreate(sessionId, session?.header?.cwd ?? null);
  }
  const cap = store.get(sessionId);

  // ── notes: POST /threadtrail/<sid>/notes, DELETE /threadtrail/<sid>/notes/<id> ──
  if (parts[2] === 'notes' && parts.length === 3 && req.method === 'POST') {
    try {
      const body = await readBody(req);
      if (!cap.cwd) {
        sendJson(res, 400, { error: 'session has no workspace' });
        return;
      }
      const abs = await cap.resolveWorkspacePath(body?.path);
      if (!abs) {
        sendJson(res, 400, { error: 'path escapes the workspace' });
        return;
      }
      const startLine = Number(body?.startLine);
      const endLine = Number(body?.endLine);
      const note = typeof body?.note === 'string' ? body.note.trim() : '';
      const snippet = typeof body?.snippet === 'string' ? body.snippet.slice(0, 1000) : '';
      if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) {
        sendJson(res, 400, { error: 'invalid line range' });
        return;
      }
      if (!note || note.length > 2000) {
        sendJson(res, 400, { error: 'note must be 1..2000 characters' });
        return;
      }
      const record = await cap.addNote({ path: String(body.path), startLine, endLine, snippet, note });
      sendJson(res, 200, record);
    } catch (err) {
      sendJson(res, err?.code === 'THREADTRAIL_BODY_TOO_LARGE' ? 413 : 400, { error: err?.message ?? 'bad request' });
    }
    return;
  }

  if (parts[2] === 'notes' && parts.length === 4 && /^n-\d+$/.test(parts[3]) && req.method === 'DELETE') {
    const removed = await cap.deleteNote(parts[3]);
    sendJson(res, removed ? 200 : 404, removed ? { ok: true } : { error: `note not found: ${parts[3]}` });
    return;
  }

  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }

  if (parts[2] === 'digest.json') {
    await cap.load();
    const digest = cap.digest();
    // Enrich each op with a short preview of the prompt that drove it
    // (code -> conversation at a glance).
    for (const op of digest.ops) {
      op.prompt = await promptPreview(sessions, sessionId, op.userMessageSeq);
    }
    sendJson(res, 200, digest);
    return;
  }

  if (parts[2] === 'op' && parts.length === 4 && OP_ID_RE.test(parts[3].replace(/\.json$/, ''))) {
    const opId = parts[3].replace(/\.json$/, '');
    const record = await cap.opRecord(opId);
    if (!record) {
      sendJson(res, 404, { error: `op not found: ${opId}` });
      return;
    }
    record.prompt = await promptPreview(sessions, sessionId, record.userMessageSeq);
    sendJson(res, 200, record);
    return;
  }

  if (parts[2] === 'rewind' && parts.length === 4 && OP_ID_RE.test(parts[3].replace(/\.json$/, ''))) {
    if (!cap.cwd) {
      sendJson(res, 400, { error: 'session has no workspace' });
      return;
    }
    const opId = parts[3].replace(/\.json$/, '');
    const target = path.join(cap.cwd, `.threadtrail`, 'rewinds', `${opId}-${Date.now()}`);
    try {
      const result = await cap.rewind(opId, target);
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, err.code === 'THREADTRAIL_OP_NOT_FOUND' ? 404 : 500, { error: err.message });
    }
    return;
  }

  if (parts[2] === 'tree.json') {
    const tree = await cap.tree();
    if (!tree) {
      sendJson(res, 400, { error: 'session has no workspace' });
      return;
    }
    sendJson(res, 200, tree);
    return;
  }

  if (parts[2] === 'file.json') {
    const rel = url.searchParams.get('path') ?? '';
    try {
      const data = await cap.readFile(rel);
      // Per-file op history with line ranges + prompt previews: the viewer's
      // "code -> conversation" anchor data. Notes ride along for the viewer.
      const ops = await Promise.all(
        cap.fileOps(rel).map(async (entry) => ({
          ...entry,
          prompt: await promptPreview(sessions, sessionId, entry.userMessageSeq),
        })),
      );
      const notes = await cap.notesFor(rel);
      sendJson(res, 200, { ...data, ops, notes });
    } catch (err) {
      const status =
        err.code === 'THREADTRAIL_PATH_ESCAPE' ? 400 : err.code === 'THREADTRAIL_NO_FILE' ? 404 : 400;
      sendJson(res, status, { error: err.message });
    }
    return;
  }

  sendJson(res, 404, { error: 'not found' });
}
