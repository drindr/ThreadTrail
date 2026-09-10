import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

// Bundle real components, isolating only their store/children and React hooks.
const sources = Object.fromEntries(await Promise.all([
  ['DiffPanel', 'panel'], ['DiffOverlay', 'overlay'], ['RecordsList', 'records'],
].map(async ([name, file]) => {
  const { outputFiles } = await build({
    entryPoints: [new URL(`../src/components/${file}.tsx`, import.meta.url).pathname],
    bundle: true, write: false, format: 'cjs', platform: 'node',
    external: ['react', '../store.ts', './records.tsx', './diffview.tsx', '../icons.tsx'],
  });
  return [name, outputFiles[0].text];
})));

function setup(component = 'DiffPanel') {
  const calls = { resets: [], refreshes: [], fetches: [], subscriptions: 0, intervals: 0, listeners: [], observers: 0 };
  const state = { sessionId: 'session', records: null, recordsLoading: false, recordsError: null, overlayOpen: false };
  const hooks = [];
  const effects = [];
  const timers = new Map();
  let cursor = 0;
  let timerId = 0;
  let running = false;
  const sameDeps = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const react = {
    Fragment: Symbol('fragment'),
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useEffect(effect, deps) {
      const index = cursor++;
      if (!sameDeps(hooks[index]?.deps, deps)) {
        effects.push(() => {
          hooks[index]?.cleanup?.();
          hooks[index] = { deps, cleanup: effect() };
        });
      }
    },
    useRef(value) { return hooks[cursor++] ??= { current: value }; },
    useCallback(callback) { return callback; },
    useMemo(callback) { return callback(); },
  };
  const store = {
    reset: (id) => calls.resets.push(id),
    refresh: (id) => calls.refreshes.push(id),
    fetchRecords: (id) => calls.fetches.push(id),
    closeOverlay: () => { state.overlayOpen = false; },
    get: () => state,
  };
  const addEventListener = (name) => calls.listeners.push(name);
  class Observer {
    constructor() { calls.observers++; }
    observe() {}
    disconnect() {}
  }
  const modules = {
    react,
    '../store.ts': { diffStore: store, useDiffStore: () => state },
    './records.tsx': { CompareBar() {}, RecordsList() {} },
    './diffview.tsx': { DiffView() {} },
    '../icons.tsx': { backIcon() {}, expandIcon() {}, refreshIcon() {}, closeIcon() {} },
  };
  const module = { exports: {} };
  new Function('require', 'module', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'document', 'window', 'IntersectionObserver', sources[component])(
    (name) => { assert.ok(modules[name], `unexpected import ${name}`); return modules[name]; },
    module,
    () => { calls.intervals++; return 1; }, () => {},
    (callback) => { timers.set(++timerId, callback); return timerId; },
    (id) => timers.delete(id),
    { addEventListener, removeEventListener() {}, visibilityState: 'visible' },
    { addEventListener, removeEventListener() {}, IntersectionObserver: Observer },
    Observer,
  );
  const selectorHook = (selector) => {
    calls.subscriptions++;
    return selector({ current: 'fallback-session', running, isRunning: running, session: { running } });
  };
  const props = { sessionId: 'session', state, useSession: selectorHook, useSessions: selectorHook };
  return {
    calls, state, props,
    setRunning(value) { running = value; },
    render() {
      cursor = 0;
      const tree = module.exports[component](props);
      while (effects.length) effects.shift()();
      return tree;
    },
    flushTimers() {
      const callbacks = [...timers.values()];
      timers.clear();
      callbacks.forEach((callback) => callback());
    },
    unmount() { hooks.forEach((hook) => hook?.cleanup?.()); },
  };
}

function findButton(node, title) {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'button' && node.props.title === title) return node;
  for (const child of node.props?.children ?? []) {
    const found = findButton(child, title);
    if (found) return found;
  }
}

test('panel resets once per session and never subscribes or automatically refreshes', () => {
  const ctx = setup();
  ctx.render();
  assert.deepEqual(ctx.calls.resets, ['session']);
  for (const running of [true, false, true, false]) {
    ctx.setRunning(running);
    ctx.render();
    ctx.flushTimers();
  }
  // Loading records may auto-open details, but must not cause another fetch.
  let opened = 0;
  ctx.props.openDetails = () => opened++;
  ctx.state.records = { isRepo: true, head: 'head', records: [], worktree: null };
  ctx.render();
  ctx.flushTimers();
  assert.equal(opened, 1);
  assert.deepEqual(ctx.calls.resets, ['session']);
  assert.deepEqual(ctx.calls.refreshes, []);
  assert.equal(ctx.calls.subscriptions, 0, 'running selector hooks must not be subscribed');
  assert.equal(ctx.calls.intervals, 0, 'no polling intervals');
  assert.deepEqual(ctx.calls.listeners, [], 'no visibility/focus event subscriptions');
  assert.equal(ctx.calls.observers, 0, 'no intersection observers');
  ctx.props.sessionId = 'next-session';
  ctx.render();
  assert.deepEqual(ctx.calls.resets, ['session', 'next-session']);
  ctx.unmount();
});

test('overlay mounting, opening and session changes never load until manual Refresh', () => {
  const ctx = setup('DiffOverlay');
  assert.equal(ctx.render(), null);
  ctx.state.overlayOpen = true;
  let tree = ctx.render();
  for (const running of [true, false]) {
    ctx.setRunning(running);
    tree = ctx.render();
    ctx.flushTimers();
  }
  assert.deepEqual(ctx.calls.fetches, []);
  assert.deepEqual(ctx.calls.refreshes, []);
  assert.deepEqual(ctx.calls.resets, []);
  assert.equal(ctx.calls.intervals, 0);
  assert.deepEqual(ctx.calls.listeners, []);
  assert.equal(ctx.calls.observers, 0);
  findButton(tree, 'Refresh').props.onClick();
  assert.deepEqual(ctx.calls.refreshes, ['session']);
  ctx.state.sessionId = 'next-session';
  tree = ctx.render();
  ctx.flushTimers();
  assert.deepEqual(ctx.calls.fetches, []);
  assert.deepEqual(ctx.calls.refreshes, ['session']);
  findButton(tree, 'Refresh').props.onClick();
  assert.deepEqual(ctx.calls.refreshes, ['session', 'next-session']);
  ctx.unmount();
});

function textContent(node) {
  if (typeof node === 'string') return node;
  return (node?.props?.children ?? []).map(textContent).join('');
}

test('records list distinguishes idle manual-load button from active loading', () => {
  const ctx = setup('RecordsList');
  let tree = ctx.render();
  assert.match(textContent(tree), /Load records and diff/);
  assert.match(textContent(tree), /Manual loading only/);
  assert.doesNotMatch(textContent(tree), /Loading records/);
  assert.deepEqual(ctx.calls.fetches, []);
  assert.deepEqual(ctx.calls.refreshes, []);
  const load = findButton(tree, undefined);
  assert.ok(load);
  load.props.onClick();
  assert.deepEqual(ctx.calls.refreshes, ['session']);
  ctx.state.recordsLoading = true;
  tree = ctx.render();
  assert.match(textContent(tree), /Loading records/);
  assert.equal(findButton(tree, undefined), undefined);
  assert.deepEqual(ctx.calls.refreshes, ['session']);
  ctx.state.recordsLoading = false;
  tree = ctx.render();
  assert.ok(findButton(tree, undefined), 'idle button returns when loading ends');
  ctx.unmount();
});

test('panel Refresh remains an explicit manual action for the current session', () => {
  const ctx = setup();
  let tree = ctx.render();
  assert.deepEqual(ctx.calls.refreshes, []);
  const refresh = findButton(tree, 'Refresh');
  assert.ok(refresh, 'manual Refresh button remains available');
  refresh.props.onClick();
  assert.deepEqual(ctx.calls.refreshes, ['session']);
  ctx.props.sessionId = 'next-session';
  tree = ctx.render();
  findButton(tree, 'Refresh').props.onClick();
  assert.deepEqual(ctx.calls.refreshes, ['session', 'next-session']);
  ctx.unmount();
});
