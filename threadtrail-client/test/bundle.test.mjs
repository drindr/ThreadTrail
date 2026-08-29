import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const bundlePath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'client.js');

test('bundle registers under the module-loader contract and apply() registers the slots', () => {
  const src = readFileSync(bundlePath, 'utf8');

  // Stub the loader + the modules the factory requires at runtime.
  const seeds = new Map([
    [
      'react',
      {
        createElement: () => null,
        Fragment: Symbol('fragment'),
        useState: () => [undefined, () => {}],
        useEffect: () => {},
        useCallback: () => {},
        useMemo: () => {},
        useRef: () => ({ current: null }),
        useSyncExternalStore: () => undefined,
      },
    ],
  ]);

  let factory = null;
  globalThis.window = {
    __ModuleLoader__: {
      load({ id, factory: f }) {
        assert.equal(id, 'threadtrail-client');
        factory = f;
      },
    },
  };
  globalThis.document = {
    createElement: () => ({ setAttribute() {}, remove() {} }),
    head: { appendChild() {} },
    // The mobile details-page opt-in effect tags <html> (dsh-mobile contract).
    documentElement: { setAttribute() {}, removeAttribute() {} },
  };
  (0, eval)(src);

  assert.ok(factory, 'bundle did not register a factory');
  const exports = factory((spec) => {
    if (!seeds.has(spec)) throw new Error(`unexpected require("${spec}")`);
    return seeds.get(spec);
  });

  for (const k of ['apply', 'DiffPanel', 'DiffOverlay', 'DiffFooterAction', 'detectLang', 'createHighlighter', 'inject']) {
    assert.ok(k in exports, `bundle should export ${k}`);
  }
  assert.equal(typeof exports.apply, 'function');

  // apply() must register the details panel, the overlay, and the footer action.
  const registrations = [];
  const ctx = {
    effect: (fn) => fn(),
    locale: { register: () => {} },
    layout: { openDetails: () => {} },
    slots: {
      inject(name, thunk) {
        registrations.push({ kind: 'inject', name, thunk });
      },
      register(opts, comp) {
        registrations.push({ kind: 'register', name: opts.name, id: opts.id, comp });
      },
    },
  };
  exports.apply(ctx);
  for (const r of registrations) {
    if (r.kind === 'inject') {
      const thunk = r.thunk();
      if (typeof thunk === 'function') thunk();
    }
  }
  assert.ok(registrations.some((r) => r.name === 'details' && r.comp === exports.DiffPanel), 'details panel not registered');
  assert.ok(
    registrations.some((r) => r.name === 'shell.overlay' && r.id === 'threadtrail-overlay' && r.comp === exports.DiffOverlay),
    'overlay not registered',
  );
  assert.ok(
    registrations.some((r) => r.name === 'sidebar.footer.action' && r.id === 'threadtrail-diff' && r.comp === exports.DiffFooterAction),
    'footer action not registered',
  );

  // No font-dependent glyph icons should remain in the bundle.
  for (const glyph of ['⛶', '↻', '✕']) {
    assert.ok(!src.includes(glyph), `bundle must not contain the glyph ${glyph}`);
  }
});
