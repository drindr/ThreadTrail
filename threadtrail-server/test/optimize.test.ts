import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CaptureStore, listFiles, MAX_LOAD_LINE_CHARS } from '../src/capture.ts';

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'threadtrail-opt-'));
}

async function write(rel: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(rel), { recursive: true });
  await fs.writeFile(rel, content, 'utf8');
}

test('new ops store diffs in the diff store, keeping ops and jsonl lean', async () => {
  const root = await tempDir();
  const ws = path.join(root, 'ws');
  await fs.mkdir(ws, { recursive: true });
  await write(path.join(ws, 'a.txt'), 'one\ntwo\nthree\n');

  const store = new CaptureStore({ root: path.join(root, 'data') });
  await store.init();
  const sc = store.getOrCreate('sess-1', ws);
  await sc.scan({ trigger: 'turn/start', atSeq: 1, turn: null, userMessageSeq: null, assistantSeqs: [] });

  await write(path.join(ws, 'a.txt'), 'one\ntwo\nCHANGED\n');
  const op = await sc.scan({ trigger: 'turn/end', atSeq: 3, turn: 1, userMessageSeq: 2, assistantSeqs: [] });
  assert.ok(op);
  const f = op.files[0];
  assert.equal(f.diff, null, 'diff must not be retained inline');
  assert.ok(f.diffSha, 'diff must be referenced into the diff store');
  assert.equal(f.added, 1);

  // the diff JSON lives on disk under the content-addressed name
  await fs.access(path.join(store.diffsDir, f.diffSha!));

  // the jsonl line is lean: no diff text embedded
  const text = await fs.readFile(sc.jsonlPath(), 'utf8');
  const line = text.trim();
  assert.ok(line.length < 2000, `jsonl line should be lean, got ${line.length} chars`);
  assert.ok(!line.includes('CHANGED'), 'diff text must not be embedded in the jsonl');

  // a fresh store over the same root replays the lean log; opRecord hydrates
  const store2 = new CaptureStore({ root: path.join(root, 'data') });
  await store2.init();
  const sc2 = store2.getOrCreate('sess-1', ws);
  await sc2.load();
  assert.equal(sc2.ops.length, 1);
  assert.equal(sc2.ops[0].files[0].diff, null);
  const full = await sc2.opRecord('op-1');
  assert.ok(full);
  assert.ok(full.files[0].diff?.some((l) => l.t === '+' && l.text.includes('CHANGED')));
  await fs.rm(root, { recursive: true, force: true });
});

test('load skips oversized legacy lines instead of OOMing', async () => {
  const root = await tempDir();
  const store = new CaptureStore({ root: path.join(root, 'data') });
  await store.init();
  const sid = 'sess-big';
  const base = {
    sessionId: sid, atSeq: 1, time: 1, trigger: 'turn/end',
    kind: 'agent' as const, turn: 1, step: null, userMessageSeq: 1, assistantSeqs: [],
  };
  const mk = (id: string, diffLine: string | null): unknown => ({
    id,
    ...base,
    files: [{
      path: 'x', sha: 's', prevSha: null, deleted: false, added: 1, removed: 0,
      diff: diffLine ? [{ t: '+', text: diffLine }] : null,
      oldRanges: [], newRanges: [],
    }],
  });
  const small1 = mk('op-1', null);
  // one pathological line far beyond MAX_LOAD_LINE_CHARS (and beyond V8's
  // string cap for the legacy inline-diff era)
  const huge = mk('op-2', 'x'.repeat(MAX_LOAD_LINE_CHARS + 4 * 1024 * 1024));
  const small3 = mk('op-3', null);
  const jl = path.join(store.sessionsDir, `${sid}.jsonl`);
  await fs.writeFile(jl, JSON.stringify(small1) + '\n' + JSON.stringify(huge) + '\n' + JSON.stringify(small3) + '\n', 'utf8');

  const sc = store.getOrCreate(sid, null);
  await sc.load();
  assert.equal(sc.ops.length, 2, 'the oversized op must be skipped, not crash the load');
  assert.deepEqual(sc.ops.map((o) => o.id), ['op-1', 'op-3']);
  assert.ok(sc.warnings.length > 0, 'skipped lines must surface as warnings');
  await fs.rm(root, { recursive: true, force: true });
});

test('cache directories and chrome-data prefixes are excluded from capture', async () => {
  const root = await tempDir();
  const ws = path.join(root, 'ws');
  await fs.mkdir(path.join(ws, '.npm-tmp', 'x'), { recursive: true });
  await fs.mkdir(path.join(ws, '.pnpm-store', 'y'), { recursive: true });
  await fs.mkdir(path.join(ws, 'chrome-data1', 'z'), { recursive: true });
  await write(path.join(ws, 'main.js'), 'x\n');
  await write(path.join(ws, '.npm-tmp', 'x', 'big.json'), 'junk\n');
  await write(path.join(ws, '.pnpm-store', 'y', 'pkg.js'), 'junk\n');
  await write(path.join(ws, 'chrome-data1', 'z', 'profile'), 'junk\n');

  const files = await listFiles(ws);
  assert.deepEqual(files.map((f) => path.relative(ws, f)), ['main.js']);
  await fs.rm(root, { recursive: true, force: true });
});

test('load migrates fat legacy inline diffs to the diff store', async () => {
  const root = await tempDir();
  const store = new CaptureStore({ root: path.join(root, 'data') });
  await store.init();
  const sid = 'sess-legacy';
  const bigDiff = Array.from({ length: 6000 }, (_, i) => ({ t: '+' as const, text: `line ${i} ${'x'.repeat(200)}` }));
  const rec = {
    id: 'op-1', sessionId: sid, atSeq: 1, time: 1, trigger: 'turn/end',
    kind: 'agent' as const, turn: 1, step: null, userMessageSeq: 1, assistantSeqs: [],
    files: [{
      path: 'big', sha: 's', prevSha: null, deleted: false, added: 6000, removed: 0,
      diff: bigDiff, oldRanges: [], newRanges: [],
    }],
  };
  await fs.writeFile(path.join(store.sessionsDir, `${sid}.jsonl`), JSON.stringify(rec) + '\n', 'utf8');

  const sc = store.getOrCreate(sid, null);
  await sc.load();
  assert.equal(sc.ops.length, 1);
  const f = sc.ops[0].files[0];
  assert.equal(f.diff, null, 'migrated inline diff must not stay in memory');
  assert.ok(f.diffSha);
  const hydrated = await sc.opRecord('op-1');
  assert.ok(hydrated);
  assert.ok(hydrated.files[0].diff && hydrated.files[0].diff.length === 6000);
  await fs.rm(root, { recursive: true, force: true });
});

test('small legacy inline diffs stay inline and are not migrated', async () => {
  const root = await tempDir();
  const store = new CaptureStore({ root: path.join(root, 'data') });
  await store.init();
  const sid = 'sess-small';
  const rec = {
    id: 'op-1', sessionId: sid, atSeq: 1, time: 1, trigger: 'turn/end',
    kind: 'agent' as const, turn: 1, step: null, userMessageSeq: 1, assistantSeqs: [],
    files: [{
      path: 'a', sha: 's', prevSha: null, deleted: false, added: 1, removed: 1,
      diff: [{ t: '-', text: 'old' }, { t: '+', text: 'new' }],
      oldRanges: [{ start: 1, end: 1 }], newRanges: [{ start: 1, end: 1 }],
    }],
  };
  await fs.writeFile(path.join(store.sessionsDir, `${sid}.jsonl`), JSON.stringify(rec) + '\n', 'utf8');

  const sc = store.getOrCreate(sid, null);
  await sc.load();
  const f = sc.ops[0].files[0];
  assert.equal(f.diffSha, undefined);
  assert.ok(Array.isArray(f.diff) && f.diff.length === 2);
  await fs.rm(root, { recursive: true, force: true });
});
