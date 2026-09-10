import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

// Exercise the real TS store and fetch helpers without installing React or
// relying on a previously built production bundle. Every test gets a new store.
const { outputFiles } = await build({
  entryPoints: [new URL('../src/store.ts', import.meta.url).pathname],
  bundle: true, write: false, format: 'cjs', platform: 'node', external: ['react'],
});
const source = outputFiles[0].text;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const records = (head = 'head', changed = 1) => ({ head, records: [], worktree: { changed, untracked: 0 }, candidates: [] });
const diff = (label = 'current') => ({ files: [], label });

function setup() {
  const calls = [];
  const fetch = (url, options) => new Promise((resolve, reject) => {
    // Deliberately allow late responses after abort: generation guards must
    // work even when the transport/body reader cannot honor cancellation.
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

test('polls faster than a slow diff coalesce without starvation or records invalidation', async () => {
  const { store, by } = await loaded();
  const original = by('diff')[0];
  const pending = store.fetchDiff('session');
  assert.strictEqual(store.fetchDiff('session'), pending);
  for (let i = 0; i < 5; i++) {
    const poll = store.fetchRecords('session');
    store.refresh('session');
    assert.strictEqual(store.fetchRecords('session'), poll);
    await tick();
    by('records').at(-1).respond(records());
    await poll;
  }
  assert.equal(by('diff').length, 1);
  assert.equal(original.signal.aborted, false);
  original.respond(diff());
  await pending;
  assert.equal(store.get().diff.label, 'current');
  assert.equal(store.get().diffLoading, false);
  assert.equal(store.get().diffRefreshing, false);
});

test('slow records and diff finish independently in either order', async () => {
  const { store, by } = await loaded();
  const poll = store.fetchRecords('session');
  const pending = store.fetchDiff('session');
  await tick();
  by('diff')[0].respond(diff());
  await pending;
  by('records')[1].respond(records('new-head'));
  await poll;
  assert.equal(store.get().records.head, 'new-head');
  assert.equal(store.get().diff.label, 'current');
  await tick();
  by('diff')[1].respond(diff());
  await store.fetchDiff('session');
});

test('root switch aborts both channels and ignores late results/errors', async () => {
  const { store, by } = await loaded();
  const oldDiff = store.fetchDiff('session');
  const oldRecords = store.fetchRecords('session');
  await tick();
  const recordCall = by('records')[1];
  const diffCall = by('diff')[0];
  store.selectRoot('session', 'nested/repo');
  assert.equal(recordCall.signal.aborted, true);
  assert.equal(diffCall.signal.aborted, true);
  assert.equal(store.get().diffLoading, false);
  await tick();
  const latest = store.fetchRecords('session');
  assert.match(by('records')[2].url, /root=nested%2Frepo/);
  by('records')[2].respond(records('root-head', 0));
  await latest;
  recordCall.respond(records('stale'));
  diffCall.reject(new Error('stale diff error'));
  await Promise.all([oldRecords, oldDiff]);
  assert.equal(store.get().records.head, 'root-head');
  assert.equal(store.get().diff, null);
  assert.equal(store.get().diffError, null);
  assert.equal(store.get().recordsError, null);
});

test('session reset cancels both channels, even when switching back to the same key', async () => {
  const { store, by } = await loaded();
  const oldDiff = store.fetchDiff('session');
  const oldRecords = store.fetchRecords('session');
  await tick();
  const oldRecordCall = by('records')[1];
  store.reset('other');
  const otherRecords = store.fetchRecords('other');
  await tick();
  const otherCall = by('records')[2];
  store.reset('session');
  const latest = store.fetchRecords('session');
  await tick();
  assert.equal(oldRecordCall.signal.aborted, true);
  assert.equal(otherCall.signal.aborted, true);
  assert.equal(by('diff')[0].signal.aborted, true);
  oldRecordCall.reject(new Error('stale records error'));
  otherCall.respond(records('other'));
  by('diff')[0].respond(diff('stale'));
  by('records')[3].respond(records('latest', 0));
  await Promise.all([oldDiff, oldRecords, otherRecords, latest]);
  assert.equal(store.get().sessionId, 'session');
  assert.equal(store.get().records.head, 'latest');
  assert.equal(store.get().recordsError, null);
  assert.equal(store.get().diff, null);
});

test('selection change aborts old diff; its failure cannot stop the new loading state', async () => {
  const { store, by } = await loaded();
  const old = store.fetchDiff('session');
  store.pickFrom('session', 'different');
  const latest = store.fetchDiff('session');
  await tick();
  assert.equal(by('diff')[0].signal.aborted, true);
  by('diff')[0].reject(new Error('old failure'));
  await old;
  assert.equal(store.get().diffLoading, true);
  assert.equal(store.get().diffError, null);
  by('diff')[1].respond(diff('new selection'));
  await latest;
  assert.equal(store.get().diff.label, 'new selection');
});

test('clear selection cancels diff but preserves records and does not auto-reselect', async () => {
  const { store, by } = await loaded();
  const pending = store.fetchDiff('session');
  const poll = store.fetchRecords('session');
  await tick();
  store.clearSelection();
  assert.equal(by('diff')[0].signal.aborted, true);
  assert.equal(by('records')[1].signal.aborted, false);
  by('diff')[0].respond(diff('late'));
  by('records')[1].respond(records('new-head'));
  await Promise.all([pending, poll]);
  assert.equal(store.get().records.head, 'new-head');
  assert.equal(store.get().from, null);
  assert.equal(store.get().to, null);
  assert.equal(store.get().diff, null);
  assert.equal(store.get().diffLoading, false);
  assert.equal(store.get().diffRefreshing, false);
  assert.equal(by('diff').length, 1);
});

test('toggling to a partial selection clears loading and blocks late diff writes', async () => {
  const { store, by } = await loaded();
  const pending = store.fetchDiff('session');
  store.pickTo('session', store.get().to);
  assert.equal(by('diff')[0].signal.aborted, true);
  by('diff')[0].reject(new Error('late'));
  await pending;
  assert.equal(store.get().to, null);
  assert.equal(store.get().diff, null);
  assert.equal(store.get().diffLoading, false);
  assert.equal(store.get().diffError, null);
});

test('identical refresh preserves diff identity and clears previous errors/loading', async () => {
  const { store, by } = await loaded();
  const first = store.fetchDiff('session');
  by('diff')[0].respond(diff());
  await first;
  const original = store.get().diff;
  const failure = store.fetchDiff('session');
  await tick();
  by('diff')[1].respond({ error: 'temporary failure' }, 500);
  await failure;
  assert.equal(store.get().diffError, 'temporary failure');
  assert.strictEqual(store.get().diff, original);
  const retry = store.fetchDiff('session');
  assert.equal(store.get().diffRefreshing, true);
  assert.equal(store.get().diffError, null);
  await tick();
  by('diff')[2].respond(diff());
  await retry;
  assert.strictEqual(store.get().diff, original);
  assert.equal(store.get().diffError, null);
  assert.equal(store.get().diffLoading, false);
  assert.equal(store.get().diffRefreshing, false);
});

test('malformed diff cannot poison the identical-response cache', async () => {
  const { store, by } = await loaded();
  let pending = store.fetchDiff('session');
  by('diff')[0].respond(diff());
  await pending;
  for (let i = 1; i <= 2; i++) {
    pending = store.fetchDiff('session');
    await tick();
    by('diff')[i].raw('not json');
    await pending;
    assert.ok(store.get().diffError);
    assert.equal(store.get().diffRefreshing, false);
  }
});

test('reset, overlay opening and session switches stay idle until a manual load', async () => {
  const { store, calls, by } = setup();
  store.reset('session');
  store.openOverlay('session');
  assert.equal(store.get().overlayOpen, true);
  store.closeOverlay();
  store.openOverlay('other');
  assert.equal(store.get().overlayOpen, true);
  assert.equal(store.get().sessionId, 'other');
  store.reset('third');
  await tick();
  assert.equal(calls.length, 0);
  assert.equal(store.get().recordsLoading, false);
  assert.equal(store.get().diffLoading, false);
  assert.equal(store.get().records, null);
  store.refresh('third');
  assert.equal(store.get().recordsLoading, true);
  const pending = store.fetchRecords('third');
  await tick();
  assert.equal(calls.length, 1);
  by('records')[0].respond(records('manual', 0));
  await pending;
  assert.equal(store.get().recordsLoading, false);
  assert.equal(store.get().records.head, 'manual');
});

test('stale records completion cannot clear a newer manual load indicator', async () => {
  const { store, by } = setup();
  const old = store.fetchRecords('session');
  await tick();
  store.reset('new');
  assert.equal(store.get().recordsLoading, false);
  const latest = store.fetchRecords('new');
  await tick();
  by('records')[0].respond(records('old', 0));
  await old;
  assert.equal(store.get().recordsLoading, true);
  by('records')[1].respond(records('new', 0));
  await latest;
  assert.equal(store.get().recordsLoading, false);
});

test('records retry delay is cancelled on reset rather than delaying the new context', async () => {
  const { store, by } = setup();
  const pending = store.fetchRecords('session');
  await tick();
  by('records')[0].respond({ error: 'session has no workspace' }, 400);
  await tick();
  store.reset('new-session');
  await pending;
  assert.equal(store.get().recordsLoading, false);
  assert.equal(by('records').length, 1);
  const latest = store.fetchRecords('new-session');
  await tick();
  assert.equal(by('records').length, 2);
  by('records')[1].respond(records('new', 0));
  await latest;
  assert.equal(store.get().records.head, 'new');
});
