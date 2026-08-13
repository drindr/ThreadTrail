import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CaptureStore, computeDiff, computeRanges, sha256 } from '../capture.js';

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'threadtrail-test-'));
}

async function write(rel, content) {
  await fs.mkdir(path.dirname(rel), { recursive: true });
  await fs.writeFile(rel, content, 'utf8');
}

test('computeDiff handles add, remove, modify, and empty base', () => {
  const add = computeDiff('', 'a\nb\n');
  assert.equal(add.added, 2);
  assert.equal(add.removed, 0);

  const rem = computeDiff('a\nb\nc\n', 'a\nc\n');
  assert.equal(rem.removed, 1);
  assert.equal(rem.added, 0);
  assert.deepEqual(rem.lines.filter((l) => l.t !== ' ').map((l) => l.text), ['b']);

  const mod = computeDiff('one\ntwo\nthree\n', 'one\nTWO\nthree\n');
  assert.equal(mod.added, 1);
  assert.equal(mod.removed, 1);

  const same = computeDiff('x\ny\n', 'x\ny\n');
  assert.equal(same.added + same.removed, 0);
});

test('computeRanges maps diff runs to old/new line numbers', () => {
  // one\n two\n three\n  ->  one\n TWO\n three\n
  const diff = computeDiff('one\ntwo\nthree\n', 'one\nTWO\nthree\n');
  const { oldRanges, newRanges } = computeRanges(diff.lines);
  assert.deepEqual(oldRanges, [{ start: 2, end: 2 }]);
  assert.deepEqual(newRanges, [{ start: 2, end: 2 }]);

  // multi-line insert between context lines: no old lines touched
  const d2 = computeDiff('a\nb\n', 'a\nx\ny\nb\n');
  const r2 = computeRanges(d2.lines);
  assert.deepEqual(r2.oldRanges, []);
  assert.deepEqual(r2.newRanges, [{ start: 2, end: 3 }]);

  // whole-file replace produces one run
  const d3 = computeDiff('p\nq\n', 'r\ns\n');
  const r3 = computeRanges(d3.lines);
  assert.deepEqual(r3.oldRanges, [{ start: 1, end: 2 }]);
  assert.deepEqual(r3.newRanges, [{ start: 1, end: 2 }]);
});

test('captures edits between turn boundaries and attributes them', async () => {
  const root = await tempDir();
  const ws = path.join(root, 'ws');
  await fs.mkdir(ws, { recursive: true });
  await write(path.join(ws, 'a.txt'), 'hello\nworld\n');

  const store = new CaptureStore({ root: path.join(root, 'data') });
  await store.init();
  const sc = store.getOrCreate('sess-1', ws);

  // baseline scan (turn/start of turn 1) — nothing to record
  await sc.scan({ trigger: 'turn/start', atSeq: 1, turn: null, userMessageSeq: null, assistantSeqs: [] });
  assert.equal(sc.ops.length, 0);

  // agent edits a.txt and adds b.txt, then turn ends
  await write(path.join(ws, 'a.txt'), 'hello\nworld\nchanged\n');
  await write(path.join(ws, 'b.txt'), 'new file\n');
  const op = await sc.scan({ trigger: 'turn/end', atSeq: 5, turn: 1, userMessageSeq: 3, assistantSeqs: [4] });

  assert.ok(op);
  assert.equal(op.id, 'op-1');
  assert.equal(op.turn, 1);
  assert.equal(op.kind, 'agent');
  assert.equal(op.userMessageSeq, 3);
  assert.deepEqual(op.assistantSeqs, [4]);
  assert.equal(op.atSeq, 5);
  const paths = op.files.map((f) => f.path).sort();
  assert.deepEqual(paths, ['a.txt', 'b.txt']);
  const a = op.files.find((f) => f.path === 'a.txt');
  assert.equal(a.added, 1);
  assert.equal(a.removed, 0);
  // line ranges: 'hello\nworld\n' -> 'hello\nworld\nchanged\n' appends line 3
  assert.deepEqual(a.newRanges, [{ start: 3, end: 3 }]);
  assert.deepEqual(a.oldRanges, []);
  const b = op.files.find((f) => f.path === 'b.txt');
  assert.equal(b.prevSha, null);
  assert.deepEqual(b.newRanges, [{ start: 1, end: 1 }]);

  // second turn: agent edits b.txt; a.txt untouched
  await write(path.join(ws, 'b.txt'), 'new file\nedited\n');
  const op2 = await sc.scan({ trigger: 'turn/end', atSeq: 9, turn: 2, userMessageSeq: 7, assistantSeqs: [8] });
  assert.equal(op2.id, 'op-2');
  assert.deepEqual(op2.files.map((f) => f.path), ['b.txt']);
  assert.deepEqual(op2.files[0].newRanges, [{ start: 2, end: 2 }]);

  // worktree browser: tree + readFile + per-file op history
  const tree = await sc.tree();
  assert.deepEqual(tree.files.map((f) => f.path).sort(), ['a.txt', 'b.txt']);
  const file = await sc.readFile('a.txt');
  assert.equal(file.content, 'hello\nworld\nchanged\n');
  assert.equal(file.lines, 3);
  const ops = sc.fileOps('b.txt');
  assert.deepEqual(ops.map((o) => o.opId), ['op-1', 'op-2']);
  assert.deepEqual(ops[1].files[0].newRanges, [{ start: 2, end: 2 }]);

  const digest = sc.digest();
  assert.equal(digest.ops.length, 2);
  assert.deepEqual(digest.fileIndex['a.txt'], ['op-1']);
  assert.deepEqual(digest.fileIndex['b.txt'], ['op-1', 'op-2']);

  // persistence: a fresh store over the same root replays the log
  const store2 = new CaptureStore({ root: path.join(root, 'data') });
  await store2.init();
  const sc2 = store2.getOrCreate('sess-1', ws);
  await sc2.load();
  assert.equal(sc2.ops.length, 2);
  assert.equal(sc2.opCounter, 2);
  await fs.rm(root, { recursive: true, force: true });
});

test('rewind materializes the state right after an op (including later edits and deletes)', async () => {
  const root = await tempDir();
  const ws = path.join(root, 'ws');
  await fs.mkdir(ws, { recursive: true });
  await write(path.join(ws, 'keep.txt'), 'v0\n');

  const store = new CaptureStore({ root: path.join(root, 'data') });
  await store.init();
  const sc = store.getOrCreate('sess-1', ws);
  await sc.scan({ trigger: 'turn/start', atSeq: 1, turn: null, userMessageSeq: null, assistantSeqs: [] });

  await write(path.join(ws, 'keep.txt'), 'v1\n');
  await write(path.join(ws, 'gone.txt'), 'temp\n');
  const op1 = await sc.scan({ trigger: 'turn/end', atSeq: 3, turn: 1, userMessageSeq: 2, assistantSeqs: [] });

  await write(path.join(ws, 'keep.txt'), 'v2\n');
  await fs.rm(path.join(ws, 'gone.txt'));
  await sc.scan({ trigger: 'turn/end', atSeq: 6, turn: 2, userMessageSeq: 5, assistantSeqs: [] });

  const target = path.join(root, 'rewind1');
  const r1 = await sc.rewind(op1.id, target);
  assert.equal(await fs.readFile(path.join(target, 'keep.txt'), 'utf8'), 'v1\n');
  assert.equal(await fs.readFile(path.join(target, 'gone.txt'), 'utf8'), 'temp\n');

  const target2 = path.join(root, 'rewind2');
  const r2 = await sc.rewind('op-2', target2);
  assert.equal(await fs.readFile(path.join(target2, 'keep.txt'), 'utf8'), 'v2\n');
  assert.ok(r2.files.some((f) => f.path === 'gone.txt' && f.state === 'deleted'));
  await fs.rm(root, { recursive: true, force: true });
});

test('manual edits between turns are captured at the next turn/start as kind manual', async () => {
  const root = await tempDir();
  const ws = path.join(root, 'ws');
  await fs.mkdir(ws, { recursive: true });
  await write(path.join(ws, 'a.txt'), 'one\n');

  const store = new CaptureStore({ root: path.join(root, 'data') });
  await store.init();
  const sc = store.getOrCreate('sess-1', ws);
  await sc.scan({ trigger: 'turn/start', atSeq: 1, turn: null, userMessageSeq: null, assistantSeqs: [] });

  // human edits between turns
  await write(path.join(ws, 'a.txt'), 'one\ntwo\n');
  const op = await sc.scan({ trigger: 'turn/start', atSeq: 10, turn: null, userMessageSeq: 8, assistantSeqs: [] });
  assert.ok(op);
  assert.equal(op.kind, 'manual');
  assert.equal(op.turn, null);
  await fs.rm(root, { recursive: true, force: true });
});

test('ignores node_modules/.git and captures deletes', async () => {
  const root = await tempDir();
  const ws = path.join(root, 'ws');
  await fs.mkdir(path.join(ws, 'node_modules/pkg'), { recursive: true });
  await fs.mkdir(path.join(ws, '.git'), { recursive: true });
  await write(path.join(ws, 'src.js'), 'x\n');
  await write(path.join(ws, 'node_modules/pkg/index.js'), 'junk\n');
  await write(path.join(ws, '.git/config'), 'junk\n');

  const store = new CaptureStore({ root: path.join(root, 'data') });
  await store.init();
  const sc = store.getOrCreate('sess-1', ws);
  await sc.scan({ trigger: 'turn/start', atSeq: 1, turn: null, userMessageSeq: null, assistantSeqs: [] });

  await fs.rm(path.join(ws, 'src.js'));
  await write(path.join(ws, 'src.js'), 'y\n');
  const op = await sc.scan({ trigger: 'turn/end', atSeq: 3, turn: 1, userMessageSeq: 2, assistantSeqs: [] });
  assert.ok(op);
  const s = op.files.find((f) => f.path === 'src.js');
  assert.equal(s.added, 1);
  assert.equal(s.removed, 1);
  assert.ok(!op.files.some((f) => f.path.includes('node_modules') || f.path.includes('.git')));
  await fs.rm(root, { recursive: true, force: true });
});

test('content-addressed blobs dedupe identical content', async () => {
  const root = await tempDir();
  const store = new CaptureStore({ root: path.join(root, 'data') });
  await store.init();
  const sha1 = await store.getOrCreate('s', null) && null;
  const content = 'identical\n';
  const sc = store.getOrCreate('sess-1', null);
  const s1 = await sc.writeBlob(content);
  const s2 = await sc.writeBlob(content);
  assert.equal(s1, s2);
  assert.equal(s1, sha256(content));
  await fs.rm(root, { recursive: true, force: true });
});
