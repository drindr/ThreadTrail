/**
 * Regression tests for the off-main-thread diff parse: the store must hand the
 * raw diff text to a Worker (so a multi-megabyte hash + JSON.parse never
 * freezes the page), cancellation must drop late worker replies, and a broken
 * worker must fall back to main-thread parsing instead of failing the diff.
 *
 * Node has no global Worker, so these tests inject a FakeWorker whose "thread"
 * the test drives manually: a queued job only completes when flush() runs,
 * which is exactly how we prove the main thread stays responsive mid-parse.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

// Reference FNV-1a (must match src/diff-worker.ts).
function fnv1a(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

class FakeWorker {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.queue = [];
    this.listeners = {};
    this.terminated = false;
    FakeWorker.instances.push(this);
  }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  removeEventListener(type, fn) {
    const list = this.listeners[type] ?? [];
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }
  postMessage(msg) { this.queue.push(msg); }
  terminate() { this.terminated = true; }
  emit(type, event) { for (const fn of [...(this.listeners[type] ?? [])]) fn(event); }
  /** Complete the oldest queued job asynchronously, as a real worker would. */
  flush() {
    const msg = this.queue.shift();
    if (!msg) return false;
    setTimeout(() => {
      try {
        this.emit('message', { data: { id: msg.id, ok: true, hash: fnv1a(msg.text), diff: JSON.parse(msg.text) } });
      } catch (e) {
        this.emit('message', { data: { id: msg.id, ok: false, error: String(e) } });
      }
    }, 0);
    return true;
  }
}

globalThis.Worker = FakeWorker;

// A diff payload large enough to stand in for a freeze-inducing response.
const bigLine = { t: '+', text: 'const value = "' + 'x'.repeat(80) + '"; // some highlighted code' };
function bigDiffText(lines = 40000) {
  const diff = { files: [], truncated: false };
  for (let f = 0; f < 20; f++) {
    const file = { path: `src/file-${f}.ts`, oldPath: null, status: 'modified', binary: false, added: lines / 20, removed: 0, hunks: [] };
    for (let h = 0; h < 10; h++) {
      file.hunks.push({ oldStart: h * 200, oldLines: 0, newStart: h * 200, newLines: lines / 200, header: '', lines: Array(lines / 200).fill(bigLine) });
    }
    diff.files.push(file);
  }
  return JSON.stringify(diff);
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

// --- Unit level: parseDiffResponse against the FakeWorker ------------------

const { parseDiffResponse } = await import('../src/diff-worker.ts');

test('large diff is hashed and parsed in the worker while the event loop stays free', async () => {
  const text = bigDiffText();
  const before = FakeWorker.instances.length;
  const promise = parseDiffResponse(text);
  const worker = FakeWorker.instances.at(-1);
  assert.equal(FakeWorker.instances.length, before + 1, 'a worker must be created');
  assert.equal(worker.queue.length, 1, 'the raw text must be posted to the worker');
  assert.equal(worker.queue[0].text.length, text.length, 'the worker receives the full payload');
  // While the worker "computes" (job queued, not flushed), the main thread
  // must keep processing callbacks — this is the no-freeze guarantee.
  let ticks = 0;
  for (let i = 0; i < 10; i++) { await tick(); ticks++; }
  assert.equal(ticks, 10);
  worker.flush();
  const parsed = await promise;
  assert.equal(parsed.hash, fnv1a(text));
  assert.equal(parsed.diff.files.length, 20);
});

test('abort during worker compute rejects and drops the late reply', async () => {
  const controller = new AbortController();
  const worker = FakeWorker.instances.at(-1);
  const promise = parseDiffResponse(bigDiffText(20000), controller.signal);
  assert.equal(worker.queue.length, 1);
  controller.abort();
  await assert.rejects(promise, /Aborted/);
  // The worker thread finishes anyway — its reply must be dropped, never delivered.
  worker.flush();
  await tick();
  await tick();
  assert.equal(worker.queue.length, 0);
});

test('a broken worker falls back to main-thread parsing instead of failing', async () => {
  const text = bigDiffText(20000);
  const promise = parseDiffResponse(text);
  const worker = FakeWorker.instances.at(-1);
  worker.emit('error', { message: 'worker script blocked by CSP' });
  const parsed = await promise;
  assert.equal(parsed.hash, fnv1a(text));
  assert.equal(parsed.diff.files.length, 20);
  assert.equal(worker.terminated, true);
  // And the dead worker is never used again.
  const count = FakeWorker.instances.length;
  await parseDiffResponse(text);
  assert.equal(FakeWorker.instances.length, count);
});

// --- Store level: the real TS store driven through the worker path ----------

const { outputFiles } = await build({
  entryPoints: [new URL('../src/store.ts', import.meta.url).pathname],
  bundle: true, write: false, format: 'cjs', platform: 'node', external: ['react'],
});
const source = outputFiles[0].text;
const records = (head = 'head', changed = 1) => ({ head, records: [], worktree: { changed, untracked: 0 }, candidates: [] });

function setup() {
  const calls = [];
  const fetch = (url, options) => new Promise((resolve, reject) => {
    calls.push({ url, signal: options.signal, reject,
      respond: (body, status = 200) => resolve(new Response(JSON.stringify(body), { status })),
      raw: (body) => resolve(new Response(body)),
    });
  });
  const module = { exports: {} };
  new Function('require', 'fetch', 'module', source)(() => ({ useSyncExternalStore() {} }), fetch, module);
  const store = module.exports.diffStore;
  store.set({ sessionId: 'session' });
  return { store, calls, by: (kind) => calls.filter((call) => call.url.includes(`/${kind}.json`)) };
}

async function loaded() {
  const ctx = setup();
  const promise = ctx.store.fetchRecords('session');
  await tick();
  ctx.by('records')[0].respond(records());
  await promise;
  await tick();
  return ctx;
}

test('store keeps the page responsive while a large diff computes in the worker', async () => {
  const { store, by } = await loaded();
  const workersBefore = FakeWorker.instances.length;
  const text = bigDiffText();
  const pending = store.fetchDiff('session');
  by('diff')[0].raw(text);
  await tick();
  const worker = FakeWorker.instances.at(-1);
  assert.equal(FakeWorker.instances.length, workersBefore + 1, 'the store must use the worker path');
  assert.equal(worker.queue.at(-1).text.length, text.length);
  // The diff is "computing": loading flags on, previous state untouched, and
  // the event loop keeps turning (no multi-second JSON.parse on this thread).
  assert.equal(store.get().diffLoading, true);
  assert.equal(store.get().diff, null);
  let ticks = 0;
  for (let i = 0; i < 20; i++) { await tick(); ticks++; }
  assert.equal(ticks, 20);
  assert.equal(store.get().diff, null);
  worker.flush();
  await pending;
  assert.equal(store.get().diff.files.length, 20);
  assert.equal(store.get().diffLoading, false);
});

test('store: abort during worker compute never delivers the stale diff', async () => {
  const { store, by } = await loaded();
  const stale = store.fetchDiff('session');
  by('diff')[0].raw(bigDiffText(20000));
  await tick();
  const worker = FakeWorker.instances.at(-1);
  assert.equal(worker.queue.length, 1);
  // Change the selection mid-compute: the in-flight request must be aborted.
  store.pickFrom('session', 'different');
  assert.equal(by('diff')[0].signal.aborted, true);
  const latest = store.fetchDiff('session');
  await tick();
  by('diff')[1].raw(JSON.stringify({ files: [], label: 'new selection' }));
  await tick();
  // The stale worker job finishes late — after the fresh one was queued.
  worker.flush(); // stale reply: must be dropped
  await stale;
  worker.flush(); // fresh reply
  await latest;
  assert.equal(store.get().diff.label, 'new selection');
  assert.equal(store.get().diffError, null);
  assert.equal(store.get().diffLoading, false);
});

test('store: identical refresh through the worker preserves diff identity', async () => {
  const { store, by } = await loaded();
  const text = bigDiffText(20000);
  const first = store.fetchDiff('session');
  by('diff')[0].raw(text);
  await tick();
  const worker = FakeWorker.instances.at(-1);
  worker.flush();
  await first;
  const original = store.get().diff;
  const refresh = store.fetchDiff('session');
  assert.equal(store.get().diffRefreshing, true);
  await tick();
  by('diff')[1].raw(text);
  await tick();
  worker.flush();
  await refresh;
  assert.strictEqual(store.get().diff, original, 'byte-identical poll must not replace the rendered diff');
  assert.equal(store.get().diffRefreshing, false);
});
