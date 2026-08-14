import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { CaptureStore } from '../src/capture.ts';
import { registerRoutes } from '../src/routes.ts';
import type { WebServerLike } from '../src/routes.ts';

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'threadtrail-routes-'));
}

function mockRes(): ServerResponse {
  const res = {
    chunks: [] as string[],
    status: null as number | null,
    headers: null as Record<string, unknown> | null,
    writeHead(status: number, headers: Record<string, unknown>) {
      this.status = status;
      this.headers = headers;
    },
    end(text: string) {
      this.chunks.push(text);
    },
  };
  return res as unknown as ServerResponse;
}

function mockSessions(eventsBySession: Record<string, unknown[]>): { get(id: string): { events: unknown[] } | undefined } {
  return {
    get(id) {
      return eventsBySession[id] ? { events: eventsBySession[id] } : undefined;
    },
  };
}

function makeHarness() {
  const routes: Array<{ kind: string; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }> = [];
  const webServer: WebServerLike = { register: (r) => routes.push(r as never) };
  return { routes, webServer };
}

test('routes: worktree browse works for a session with no ops (before any modification)', async () => {
  const root = await tempDir();
  const ws = path.join(root, 'ws');
  await fs.mkdir(path.join(ws, 'sub'), { recursive: true });
  await fs.writeFile(path.join(ws, 'a.txt'), 'one\n', 'utf8');
  await fs.writeFile(path.join(ws, 'sub', 'b.js'), 'const b = 2;\n', 'utf8');

  const store = new CaptureStore({ root: path.join(root, 'data') });
  await store.init();
  // Attached on session/created with its cwd; no scan has run — the user
  // browses the code before any modification has occurred.
  store.getOrCreate('sess-fresh', ws);

  const sessions = mockSessions({ 'sess-fresh': [] });
  const { routes, webServer } = makeHarness();
  registerRoutes(webServer, { store, sessions });
  const handler = routes[0].handler;

  // digest: empty op list, still 200
  {
    const res = mockRes();
    await handler({ method: 'GET', url: '/threadtrail/sess-fresh/digest.json' } as never, res);
    assert.equal(res.status, 200);
    const body = JSON.parse(res.chunks.join('')) as { ops: unknown[]; fileIndex: unknown };
    assert.deepEqual(body.ops, []);
    assert.deepEqual(body.fileIndex, {});
  }

  // tree: live workspace listing without any capture
  {
    const res = mockRes();
    await handler({ method: 'GET', url: '/threadtrail/sess-fresh/tree.json' } as never, res);
    assert.equal(res.status, 200);
    const body = JSON.parse(res.chunks.join('')) as { files: Array<{ path: string }> };
    assert.deepEqual(body.files.map((f) => f.path).sort(), ['a.txt', 'sub/b.js']);
  }

  // file: content + empty per-file op history
  {
    const res = mockRes();
    await handler({ method: 'GET', url: '/threadtrail/sess-fresh/file.json?path=sub/b.js' } as never, res);
    assert.equal(res.status, 200);
    const body = JSON.parse(res.chunks.join('')) as { content: string; lines: number; ops: unknown[]; notes: unknown[] };
    assert.equal(body.content, 'const b = 2;\n');
    assert.equal(body.lines, 1);
    assert.deepEqual(body.ops, []);
    assert.deepEqual(body.notes, []);
  }

  await fs.rm(root, { recursive: true, force: true });
});

test('routes: digest, op, rewind, status, and error paths', async () => {
  const root = await tempDir();
  const ws = path.join(root, 'ws');
  await fs.mkdir(ws, { recursive: true });
  await fs.writeFile(path.join(ws, 'a.txt'), 'one\n', 'utf8');
  await fs.writeFile(path.join(ws, 'b.txt'), 'bee\n', 'utf8');

  const store = new CaptureStore({ root: path.join(root, 'data') });
  await store.init();
  const sc = store.getOrCreate('sess-abc', ws);
  await sc.scan({ trigger: 'turn/start', atSeq: 1, turn: null, userMessageSeq: null, assistantSeqs: [] });
  await fs.writeFile(path.join(ws, 'a.txt'), 'one\ntwo\n', 'utf8');
  await sc.scan({ trigger: 'turn/end', atSeq: 5, turn: 1, userMessageSeq: 3, assistantSeqs: [4] });

  const sessions = mockSessions({
    'sess-abc': [
      { seq: 3, type: 'user/message', data: { content: [{ type: 'text', text: 'add a line please' }] } },
    ],
  });

  const { routes, webServer } = makeHarness();
  registerRoutes(webServer, { store, sessions });
  assert.equal(routes.length, 1);
  assert.equal(routes[0].kind, 'prefix');
  assert.equal(routes[0].path, '/threadtrail');
  // Fidelity to the webserver's matcher: a prefix route matches only when
  // pathname.startsWith(prefix + "/") (or equals it) — a trailing slash on the
  // prefix would demand a double slash and never match.
  {
    const { path } = routes[0];
    for (const probe of ['/threadtrail/status.json', '/threadtrail/sess-abc/digest.json', '/threadtrail']) {
      assert.ok(probe === path || probe.startsWith(`${path}/`), `matcher should accept ${probe}`);
    }
    assert.ok(!'/threadtrailX/status.json'.startsWith(`${path}/`), 'sibling paths must not match');
  }

  const handler = routes[0].handler;

  // digest
  {
    const res = mockRes();
    await handler({ method: 'GET', url: '/threadtrail/sess-abc/digest.json' } as never, res);
    assert.equal(res.status, 200);
    const body = JSON.parse(res.chunks.join('')) as { ops: Array<{ prompt: string }>; fileIndex: Record<string, string[]> };
    assert.equal(body.ops.length, 1);
    assert.equal(body.ops[0].prompt, 'add a line please');
    assert.deepEqual(body.fileIndex['a.txt'], ['op-1']);
  }

  // op detail with full diff
  {
    const res = mockRes();
    await handler({ method: 'GET', url: '/threadtrail/sess-abc/op/op-1.json' } as never, res);
    assert.equal(res.status, 200);
    const body = JSON.parse(res.chunks.join('')) as { files: Array<{ added: number; diff: unknown }>; prompt: string };
    assert.equal(body.files[0].added, 1);
    assert.ok(Array.isArray(body.files[0].diff));
    assert.equal(body.prompt, 'add a line please');
  }

  // rewind
  {
    const res = mockRes();
    await handler({ method: 'GET', url: '/threadtrail/sess-abc/rewind/op-1.json' } as never, res);
    assert.equal(res.status, 200);
    const body = JSON.parse(res.chunks.join('')) as { target: string };
    const content = await fs.readFile(path.join(body.target, 'a.txt'), 'utf8');
    assert.equal(content, 'one\ntwo\n');
  }

  // status
  {
    const res = mockRes();
    await handler({ method: 'GET', url: '/threadtrail/status.json' } as never, res);
    assert.equal(res.status, 200);
    const body = JSON.parse(res.chunks.join('')) as { enabled: boolean; sessions: Array<{ sessionId: string }> };
    assert.equal(body.enabled, true);
    assert.ok(body.sessions.some((s) => s.sessionId === 'sess-abc'));
  }

  // errors: unknown op, invalid session id, wrong method
  {
    const res = mockRes();
    await handler({ method: 'GET', url: '/threadtrail/sess-abc/op/op-99.json' } as never, res);
    assert.equal(res.status, 404);
  }
  {
    const res = mockRes();
    await handler({ method: 'GET', url: '/threadtrail/bad.id/digest.json' } as never, res);
    assert.equal(res.status, 400);
  }
  {
    const res = mockRes();
    await handler({ method: 'POST', url: '/threadtrail/sess-abc/digest.json' } as never, res);
    assert.equal(res.status, 405);
  }

  // worktree browser: tree listing
  {
    const res = mockRes();
    await handler({ method: 'GET', url: '/threadtrail/sess-abc/tree.json' } as never, res);
    assert.equal(res.status, 200);
    const body = JSON.parse(res.chunks.join('')) as { files: Array<{ path: string }> };
    assert.deepEqual(body.files.map((f) => f.path).sort(), ['a.txt', 'b.txt']);
  }

  // worktree browser: file content + per-file op history with ranges
  {
    const res = mockRes();
    await handler({ method: 'GET', url: '/threadtrail/sess-abc/file.json?path=a.txt' } as never, res);
    assert.equal(res.status, 200);
    const body = JSON.parse(res.chunks.join('')) as {
      content: string;
      lines: number;
      ops: Array<{ opId: string; files: Array<{ newRanges: Array<{ start: number; end: number }> }>; prompt: string }>;
    };
    assert.equal(body.content, 'one\ntwo\n');
    assert.equal(body.lines, 2);
    assert.equal(body.ops.length, 1);
    assert.equal(body.ops[0].opId, 'op-1');
    assert.deepEqual(body.ops[0].files[0].newRanges, [{ start: 2, end: 2 }]);
    assert.equal(body.ops[0].prompt, 'add a line please');
  }

  // traversal guard: escaping paths are refused
  {
    const res = mockRes();
    await handler({ method: 'GET', url: `/threadtrail/sess-abc/file.json?path=${encodeURIComponent('../secret.txt')}` } as never, res);
    assert.equal(res.status, 400);
  }
  {
    const res = mockRes();
    await handler({ method: 'GET', url: '/threadtrail/sess-abc/file.json?path=missing.txt' } as never, res);
    assert.equal(res.status, 404);
  }

  // notes: POST an anchored note, read it back via file.json, DELETE it
  {
    const res = mockRes();
    await handler(
      {
        method: 'POST',
        url: '/threadtrail/sess-abc/notes',
        [Symbol.asyncIterator]: async function* () {
          yield Buffer.from(JSON.stringify({ path: 'a.txt', startLine: 2, endLine: 2, snippet: 'two', note: 'check this' }));
        },
      } as never,
      res,
    );
    assert.equal(res.status, 200);
    const note = JSON.parse(res.chunks.join('')) as { id: string; path: string };
    assert.equal(note.id, 'n-1');
    assert.equal(note.path, 'a.txt');
  }
  {
    const res = mockRes();
    await handler({ method: 'GET', url: '/threadtrail/sess-abc/file.json?path=a.txt' } as never, res);
    const body = JSON.parse(res.chunks.join('')) as { notes: Array<{ note: string }> };
    assert.equal(body.notes.length, 1);
    assert.equal(body.notes[0].note, 'check this');
  }
  {
    const res = mockRes();
    await handler({ method: 'GET', url: '/threadtrail/sess-abc/file.json?path=b.txt' } as never, res);
    const body = JSON.parse(res.chunks.join('')) as { notes: unknown[] };
    assert.equal(body.notes.length, 0);
  }
  // validation: escaping path, bad range, empty note
  {
    const res = mockRes();
    await handler(
      {
        method: 'POST',
        url: '/threadtrail/sess-abc/notes',
        [Symbol.asyncIterator]: async function* () {
          yield Buffer.from(JSON.stringify({ path: '../x', startLine: 1, endLine: 1, note: 'x' }));
        },
      } as never,
      res,
    );
    assert.equal(res.status, 400);
  }
  {
    const res = mockRes();
    await handler(
      {
        method: 'POST',
        url: '/threadtrail/sess-abc/notes',
        [Symbol.asyncIterator]: async function* () {
          yield Buffer.from(JSON.stringify({ path: 'a.txt', startLine: 5, endLine: 2, note: 'x' }));
        },
      } as never,
      res,
    );
    assert.equal(res.status, 400);
  }
  {
    const res = mockRes();
    await handler(
      {
        method: 'POST',
        url: '/threadtrail/sess-abc/notes',
        [Symbol.asyncIterator]: async function* () {
          yield Buffer.from(JSON.stringify({ path: 'a.txt', startLine: 1, endLine: 1, note: '   ' }));
        },
      } as never,
      res,
    );
    assert.equal(res.status, 400);
  }
  {
    const res = mockRes();
    await handler({ method: 'DELETE', url: '/threadtrail/sess-abc/notes/n-1' } as never, res);
    assert.equal(res.status, 200);
  }
  {
    const res = mockRes();
    await handler({ method: 'DELETE', url: '/threadtrail/sess-abc/notes/n-1' } as never, res);
    assert.equal(res.status, 404);
  }

  // clean: POST clears the op list (safe after a commit), and the digest then
  // reports the reset plus the git HEAD bookkeeping
  {
    const res = mockRes();
    await handler({ method: 'POST', url: '/threadtrail/sess-abc/clean' } as never, res);
    assert.equal(res.status, 200);
    const body = JSON.parse(res.chunks.join('')) as { ok: boolean; ops: number; lastClean: { trigger: string } };
    assert.equal(body.ok, true);
    assert.equal(body.ops, 0);
    assert.equal(body.lastClean.trigger, 'manual');
  }
  {
    const res = mockRes();
    await handler({ method: 'GET', url: '/threadtrail/sess-abc/digest.json' } as never, res);
    assert.equal(res.status, 200);
    const body = JSON.parse(res.chunks.join('')) as { ops: unknown[]; lastClean: { trigger: string }; gitHead: unknown };
    assert.deepEqual(body.ops, []);
    assert.equal(body.lastClean.trigger, 'manual');
    assert.ok('gitHead' in body);
  }
  // POST clean is the only clean path; GET is not a clean (falls through to 404)
  {
    const res = mockRes();
    await handler({ method: 'GET', url: '/threadtrail/sess-abc/clean' } as never, res);
    assert.equal(res.status, 404);
  }

  await fs.rm(root, { recursive: true, force: true });
});
