import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

// Regression tests for the progressive diff renderer: an expanded huge file
// must render a small window first and append chunks per frame, never
// materializing (and syntax-highlighting) every line in a single commit.
// Bundles the real diffview.tsx and drives it with a minimal hook harness,
// isolating only react, the store, the highlighter and the icons.
const { outputFiles } = await build({
  entryPoints: [new URL('../src/components/diffview.tsx', import.meta.url).pathname],
  bundle: true, write: false, format: 'cjs', platform: 'node',
  external: ['react', '../store.ts', '../highlighter.tsx', '../icons.tsx'],
});
const source = outputFiles[0].text;

// INITIAL_LINES (120) and CHUNK_LINES (400) from diffview.tsx, with slack so
// the test survives small retunes while still proving chunking.
const MAX_INITIAL_WINDOW = 150;
const MAX_CHUNK = 450;

function makeFile(path, hunkSizes) {
  let added = 0;
  let removed = 0;
  return {
    path, oldPath: null, status: 'modified', binary: false, truncated: false,
    get added() { return added; }, get removed() { return removed; },
    hunks: hunkSizes.map((count, i) => ({
      oldStart: 1 + i * 100000, oldLines: count, newStart: 1 + i * 100000, newLines: count, header: `hunk-${i}`,
      lines: Array.from({ length: count }, (_, li) => {
        const t = li % 3 === 0 ? '+' : li % 3 === 1 ? '-' : ' ';
        if (t === '+') added++;
        if (t === '-') removed++;
        return { t, text: `const v${i}_${li} = ${li};` };
      }),
    })),
  };
}

function setup(hunkSizes, path = 'src/big.ts') {
  const file = makeFile(path, hunkSizes);
  const totalLines = hunkSizes.reduce((a, b) => a + b, 0);

  // Fake animation frames: the module prefers requestIdleCallback, so it is
  // passed as undefined to force the deterministic rAF path.
  const rafQueue = new Map();
  let rafId = 0;
  const requestAnimationFrame = (cb) => { rafQueue.set(++rafId, cb); return rafId; };
  const cancelAnimationFrame = (id) => { rafQueue.delete(id); };

  // Minimal hook runtime: one hook context per keyed component instance,
  // synchronous re-render on setState, effects flushed after each render.
  const ctxs = new Map();
  const stack = [];
  const pendingEffects = [];
  const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const current = () => stack[stack.length - 1];
  let rerender;
  const react = {
    Fragment: Symbol('fragment'),
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    memo: (fn) => fn,
    useCallback: (cb) => cb,
    useState(initial) {
      const ctx = current();
      const index = ctx.cursor++;
      if (!(index in ctx.hooks)) ctx.hooks[index] = { value: typeof initial === 'function' ? initial() : initial };
      const hook = ctx.hooks[index];
      return [hook.value, (next) => {
        const value = typeof next === 'function' ? next(hook.value) : next;
        if (Object.is(value, hook.value)) return;
        hook.value = value;
        rerender();
      }];
    },
    useEffect(effect, deps) {
      const ctx = current();
      const index = ctx.cursor++;
      const prev = ctx.hooks[index];
      if (!sameDeps(prev?.deps, deps)) {
        pendingEffects.push(() => {
          prev?.cleanup?.();
          // Store the new deps BEFORE running the effect: a setState inside
          // the effect re-renders synchronously here, and that nested render
          // must observe the new deps (as in React) instead of re-queueing
          // the effect and spawning a duplicate chunk chain.
          const record = { deps, cleanup: undefined };
          ctx.hooks[index] = record;
          record.cleanup = effect() || undefined;
        });
      }
    },
    useMemo(factory, deps) {
      const ctx = current();
      const index = ctx.cursor++;
      const prev = ctx.hooks[index];
      if (prev && sameDeps(prev.deps, deps)) return prev.value;
      const value = factory();
      ctx.hooks[index] = { deps, value };
      return value;
    },
  };

  let highlightCalls = 0;
  const modules = {
    react,
    '../store.ts': { diffStore: { fetchDiff: () => Promise.resolve() } },
    '../highlighter.tsx': {
      detectLang: () => 'ts',
      createHighlighter: () => (text) => { highlightCalls++; return [{ t: 'k', text }]; },
      renderTokens: (tokens) => [{ type: 'span', props: { className: 'tok', children: [tokens.map((t) => t.text).join('')] } }],
    },
    '../icons.tsx': { chevronIcon: () => null, refreshIcon: () => null },
  };
  const module = { exports: {} };
  new Function('require', 'module', 'requestIdleCallback', 'requestAnimationFrame', 'cancelAnimationFrame', source)(
    (name) => { assert.ok(modules[name], `unexpected import ${name}`); return modules[name]; },
    module, undefined, requestAnimationFrame, cancelAnimationFrame,
  );
  const { DiffView } = module.exports;

  // Resolve function components down to plain { type, className, onClick,
  // children } nodes, running hooks against per-instance contexts.
  function resolve(el, key) {
    if (el == null || typeof el !== 'object') return el;
    // React children nest arrays arbitrarily (map results, IIFE chunks).
    if (Array.isArray(el)) return { type: 'array', children: el.map((c, i) => resolve(c, `${key}/${i}`)) };
    if (typeof el.type === 'function') {
      let ctx = ctxs.get(key);
      if (!ctx) ctxs.set(key, (ctx = { hooks: [], cursor: 0 }));
      ctx.cursor = 0;
      stack.push(ctx);
      let out;
      try { out = el.type(el.props); } finally { stack.pop(); }
      return resolve(out, key);
    }
    const children = el.props?.children;
    const list = Array.isArray(children) ? children : children == null ? [] : [children];
    return {
      type: el.type,
      className: el.props?.className,
      onClick: el.props?.onClick,
      children: list.map((c, i) => resolve(c, `${key}/${c && typeof c === 'object' && !Array.isArray(c) && c.props?.key != null ? c.props.key : i}`)),
    };
  }

  const state = {
    from: { id: 'from' }, to: { id: 'to' },
    diff: { files: [file], truncated: false },
    diffError: null, diffLoading: false, diffRefreshing: false,
  };
  let tree;
  rerender = () => {
    tree = resolve(DiffView({ state, sessionId: 'session' }), 'root');
    let effect;
    while ((effect = pendingEffects.shift())) effect();
  };

  function walk(node, fn) {
    if (node == null || typeof node !== 'object') return;
    fn(node);
    for (const child of node.children ?? []) walk(child, fn);
  }
  const countLines = () => {
    let n = 0;
    walk(tree, (node) => { if (typeof node.className === 'string' && node.className.startsWith('ddb-line ddb-line-')) n++; });
    return n;
  };
  const text = () => {
    let s = '';
    const collect = (node) => {
      if (typeof node === 'string') { s += node; return; }
      if (node == null || typeof node !== 'object') return;
      for (const child of node.children ?? []) collect(child);
    };
    collect(tree);
    return s;
  };
  const fileHead = () => {
    let head;
    walk(tree, (node) => { if (!head && typeof node.className === 'string' && node.className.includes('ddb-opfile-toggle')) head = node; });
    return head;
  };
  const flushFrame = () => {
    assert.ok(rafQueue.size > 0, 'expected a scheduled chunk frame');
    const callbacks = [...rafQueue.values()];
    rafQueue.clear();
    for (const cb of callbacks) cb();
  };
  return {
    state, file, totalLines, rafQueue, rerender, flushFrame, countLines, text, fileHead,
    highlightCalls: () => highlightCalls,
    hasTokens: () => { let found = false; walk(tree, (node) => { if (node.className === 'tok') found = true; }); return found; },
  };
}

test('expanded huge file renders a small window first, then appends one chunk per frame', () => {
  const ctx = setup([400, 300, 300]); // 1000 lines, below the 1500 auto-collapse threshold
  ctx.rerender();
  const initial = ctx.countLines();
  assert.ok(initial > 0 && initial <= MAX_INITIAL_WINDOW, `first commit must render a small window, got ${initial}`);
  assert.equal(ctx.highlightCalls(), initial, 'only the rendered lines are syntax-highlighted');
  assert.ok(ctx.text().includes('Rendering diff…'), 'progress note shown while chunking');
  assert.ok(ctx.hasTokens(), 'highlight token spans preserved');

  let prev = initial;
  let frames = 0;
  while (ctx.countLines() < ctx.totalLines) {
    ctx.flushFrame();
    frames++;
    const now = ctx.countLines();
    assert.ok(now > prev, 'each frame appends lines');
    assert.ok(now - prev <= MAX_CHUNK, `each frame appends at most one chunk, got ${now - prev}`);
    prev = now;
  }
  assert.ok(frames >= 2, `rendering ${ctx.totalLines} lines must take several frames, took ${frames}`);
  assert.equal(ctx.rafQueue.size, 0, 'no frames scheduled after completion (no idle loop)');
  assert.ok(!ctx.text().includes('Rendering diff…'), 'progress note removed once complete');
  assert.ok(ctx.text().includes('const v2_299 = 299;'), 'last line of the last hunk rendered');
});

test('small file renders fully in the first commit and schedules nothing', () => {
  const ctx = setup([100]);
  ctx.rerender();
  assert.equal(ctx.countLines(), 100);
  assert.equal(ctx.highlightCalls(), 100);
  assert.equal(ctx.rafQueue.size, 0, 'no chunk frames for a file that fits the window');
  assert.ok(!ctx.text().includes('Rendering diff…'));
});

test('collapsing cancels pending chunks; re-expanding restarts from the window', () => {
  const ctx = setup([1000]);
  ctx.rerender();
  const initial = ctx.countLines();
  ctx.flushFrame();
  assert.ok(ctx.countLines() > initial);

  ctx.fileHead().onClick();
  assert.equal(ctx.countLines(), 0, 'collapsed file renders no lines');
  // Firing any still-queued callback must be a no-op and must not reschedule.
  const stale = [...ctx.rafQueue.values()];
  ctx.rafQueue.clear();
  for (const cb of stale) cb();
  assert.equal(ctx.countLines(), 0, 'stale chunk after collapse must not render');
  assert.equal(ctx.rafQueue.size, 0, 'stale chunk must not reschedule');

  ctx.fileHead().onClick();
  assert.equal(ctx.countLines(), initial, 're-expand starts from the small window again');
  while (ctx.countLines() < ctx.totalLines) ctx.flushFrame();
  assert.equal(ctx.countLines(), ctx.totalLines);
  assert.equal(ctx.rafQueue.size, 0);
});

test('file change resets the window and keeps exactly one live chunk chain', () => {
  const ctx = setup([1000]);
  ctx.rerender();
  ctx.flushFrame();
  assert.ok(ctx.countLines() > 120 || ctx.countLines() > 0);

  // Same path, bigger content: the effect must cancel the old chain and
  // restart from the initial window.
  ctx.state.diff = { files: [makeFile('src/big.ts', [1600])], truncated: false };
  ctx.rerender();
  assert.ok(ctx.countLines() <= MAX_INITIAL_WINDOW, `window resets on file change, got ${ctx.countLines()}`);
  assert.ok(ctx.rafQueue.size <= 2, 'at most one stale + one live callback queued');

  ctx.flushFrame(); // stale callback no-ops, live chain appends one chunk
  const after = ctx.countLines();
  assert.ok(after > 120 && after <= 120 + MAX_CHUNK, `one chunk appended, got ${after}`);
  assert.equal(ctx.rafQueue.size, 1, 'exactly one live chunk chain after the file change');

  while (ctx.countLines() < 1600) ctx.flushFrame();
  assert.equal(ctx.countLines(), 1600);
  assert.equal(ctx.rafQueue.size, 0);
});

test('very large diff starts collapsed and expands progressively on demand', () => {
  const ctx = setup([2000]); // above the 1500-line auto-collapse threshold
  ctx.rerender();
  assert.equal(ctx.countLines(), 0, 'large diff starts fully collapsed');
  assert.equal(ctx.rafQueue.size, 0, 'nothing scheduled while collapsed');

  ctx.fileHead().onClick();
  const initial = ctx.countLines();
  assert.ok(initial > 0 && initial <= MAX_INITIAL_WINDOW, `expanding a huge file renders a small window, got ${initial}`);
  while (ctx.countLines() < ctx.totalLines) ctx.flushFrame();
  assert.equal(ctx.countLines(), ctx.totalLines);
  assert.equal(ctx.rafQueue.size, 0);
});
