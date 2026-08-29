import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { registerRoutes } from '../src/routes.ts';
import type { WebServerLike } from '../src/routes.ts';
import { WORKTREE_ID } from '../src/repo.ts';

async function tempRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'threadtrail-routes-'));
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  return dir;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function mockRes(): ServerResponse & { status: number | null; body(): unknown } {
  const res = {
    chunks: [] as string[],
    status: null as number | null,
    writeHead(status: number) {
      this.status = status;
    },
    end(text: string) {
      this.chunks.push(text);
    },
    body() {
      return JSON.parse(this.chunks.join(''));
    },
  };
  return res as unknown as ServerResponse & { status: number | null; body(): unknown };
}

function makeHarness() {
  const routes: Array<{ kind: string; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }> = [];
  const webServer: WebServerLike = {
    register(opts) {
      routes.push(opts);
    },
  };
  return { routes, webServer };
}

function mockReq(url: string, method = 'GET'): IncomingMessage {
  return { url, method } as unknown as IncomingMessage;
}

async function setup() {
  const cwd = await tempRepo();
  await fs.writeFile(path.join(cwd, 'a.txt'), 'one\n');
  git(cwd, ['add', '.']);
  git(cwd, ['commit', '-m', 'first']);
  const { routes, webServer } = makeHarness();
  const sessions = { get: (id: string) => (id === 'sess-1' ? { header: { cwd } } : undefined) };
  registerRoutes(webServer, { sessions });
  assert.equal(routes.length, 1);
  assert.equal(routes[0].path, '/threadtrail');
  return { handler: routes[0].handler, cwd };
}

test('status.json answers without a session', async () => {
  const { handler } = await setup();
  const res = mockRes();
  await handler(mockReq('/threadtrail/status.json'), res);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body(), { enabled: true });
});

test('records.json serves the record list of the session workspace', async () => {
  const { handler } = await setup();
  const res = mockRes();
  await handler(mockReq('/threadtrail/sess-1/records.json'), res);
  assert.equal(res.status, 200);
  const body = res.body() as { isRepo: boolean; records: Array<{ id: string; kind: string; subject?: string }> };
  assert.equal(body.isRepo, true);
  assert.equal(body.records[0].id, WORKTREE_ID);
  assert.equal(body.records[1].subject, 'first');
});

test('diff.json diffs two records selected by the user', async () => {
  const { handler, cwd } = await setup();
  const head = git(cwd, ['rev-parse', 'HEAD']).trim();
  await fs.writeFile(path.join(cwd, 'a.txt'), 'one\ntwo\n');

  const res = mockRes();
  await handler(mockReq(`/threadtrail/sess-1/diff.json?from=${head}&to=${WORKTREE_ID}`), res);
  assert.equal(res.status, 200);
  const body = res.body() as { files: Array<{ path: string; added: number }> };
  assert.equal(body.files.length, 1);
  assert.equal(body.files[0].path, 'a.txt');
  assert.equal(body.files[0].added, 1);
});

test('unknown sessions and bad ids are rejected', async () => {
  const { handler } = await setup();

  const noSession = mockRes();
  await handler(mockReq('/threadtrail/ghost/records.json'), noSession);
  assert.equal(noSession.status, 400);

  const badSession = mockRes();
  await handler(mockReq('/threadtrail/bad_id!/records.json'), badSession);
  assert.equal(badSession.status, 400);

  const badRecord = mockRes();
  await handler(mockReq('/threadtrail/sess-1/diff.json?from=--help&to=worktree'), badRecord);
  assert.equal(badRecord.status, 400);

  const notFound = mockRes();
  await handler(mockReq('/threadtrail/sess-1/nope.json'), notFound);
  assert.equal(notFound.status, 404);

  const method = mockRes();
  await handler(mockReq('/threadtrail/sess-1/records.json', 'POST'), method);
  assert.equal(method.status, 405);
});

test('non-git workspaces offer git subfolders selectable via ?root=', async () => {
  // Workspace is NOT a repo; sess-2's workspace contains one in sub/.
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'threadtrail-root-'));
  git(cwd, ['init', 'sub']);
  git(path.join(cwd, 'sub'), ['config', 'user.email', 'test@example.com']);
  git(path.join(cwd, 'sub'), ['config', 'user.name', 'Test']);
  await fs.writeFile(path.join(cwd, 'sub', 'a.txt'), 'one\n');
  git(path.join(cwd, 'sub'), ['add', '.']);
  git(path.join(cwd, 'sub'), ['commit', '-m', 'sub commit']);
  const subHead = git(path.join(cwd, 'sub'), ['rev-parse', 'HEAD']).trim();

  const { routes, webServer } = makeHarness();
  registerRoutes(webServer, { sessions: { get: () => ({ header: { cwd } }) } });
  const handler = routes[0].handler;

  // Without root: not a repo, but candidates point at the subfolder.
  const res = mockRes();
  await handler(mockReq('/threadtrail/sess-2/records.json'), res);
  assert.equal(res.status, 200);
  const body = res.body() as { isRepo: boolean; root: string; candidates: string[] };
  assert.equal(body.isRepo, false);
  assert.equal(body.root, '');
  assert.deepEqual(body.candidates, ['sub']);

  // With root=sub: the subfolder's records.
  const res2 = mockRes();
  await handler(mockReq('/threadtrail/sess-2/records.json?root=sub'), res2);
  assert.equal(res2.status, 200);
  const body2 = res2.body() as { isRepo: boolean; root: string; records: Array<{ id: string; subject?: string }> };
  assert.equal(body2.isRepo, true);
  assert.equal(body2.root, 'sub');
  assert.equal(body2.records[1].subject, 'sub commit');

  // Diff under the subfolder root.
  await fs.writeFile(path.join(cwd, 'sub', 'a.txt'), 'one\ntwo\n');
  const res3 = mockRes();
  await handler(mockReq(`/threadtrail/sess-2/diff.json?root=sub&from=${subHead}&to=${WORKTREE_ID}`), res3);
  assert.equal(res3.status, 200);
  assert.equal((res3.body() as { files: Array<{ path: string }> }).files[0].path, 'a.txt');

  // Traversal is rejected.
  const res4 = mockRes();
  await handler(mockReq('/threadtrail/sess-2/records.json?root=../..'), res4);
  assert.equal(res4.status, 400);

  // A non-repo root diffs 400, not 500.
  const res5 = mockRes();
  await handler(mockReq(`/threadtrail/sess-2/diff.json?from=${subHead}&to=${WORKTREE_ID}`), res5);
  assert.equal(res5.status, 400);
});
