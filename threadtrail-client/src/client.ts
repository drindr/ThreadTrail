/**
 * ThreadTrail — browser half, entry module.
 *
 * Registers the details-column panel (record picker + git diff), the wide
 * overlay (`shell.overlay`), and the always-visible sidebar footer entry that
 * opens the compare view. Bundled by esbuild into a classic-script
 * module-loader bundle (see `build/build.mjs`); `react` stays external and
 * resolves through the loader's module table at runtime.
 */

import { CSS } from './css.ts';
import { DiffPanel } from './components/panel.tsx';
import { DiffOverlay } from './components/overlay.tsx';
import { DiffFooterAction } from './components/footer.tsx';
import { detectLang, createHighlighter } from './highlighter.tsx';

export { DiffPanel, DiffOverlay, DiffFooterAction, detectLang, createHighlighter };

const NS = 'threadtrail';
const en = {
  'panel.title': 'ThreadTrail',
  'panel.subtitle': 'git log · compare records',
  'panel.refresh': 'Refresh',
  'panel.expand': 'Expand to wide view',
  'panel.loading': 'Loading…',
  'panel.error': 'ThreadTrail host not reachable ({error})',
};
const zh = en; // same key set; English text for now

export const inject = ['slots', 'locale', 'layout'];

/** The harness client context, typed to the small surface we use. */
interface ClientCtx {
  effect(fn: () => void | (() => void), label?: string): void;
  locale: { register(ns: string, dicts: Record<string, Record<string, string>>): void };
  slots: {
    inject(name: string, thunk: () => unknown): void;
    register(opts: Record<string, unknown>, component: unknown): void;
  };
  layout: { openDetails(): void };
}

export function apply(ctx: ClientCtx): void {
  ctx.effect(() => {
    ctx.locale.register(NS, { zh, en });
  }, 'threadtrail-client: dictionaries');
  ctx.effect(() => {
    // Owned stylesheet (the loader removes <style data-plugin> on reload).
    const style = document.createElement('style');
    style.setAttribute('data-plugin', 'threadtrail-client');
    style.textContent = CSS;
    document.head.appendChild(style);
    return () => style.remove();
  }, 'threadtrail-client: styles');

  // The `details` column is declared session-scoped by ui-layout; this
  // panel is its occupant. openDetails comes from the layout service so the
  // panel can open the column when a session is selected.
  ctx.slots.inject('details', () =>
    ctx.slots.register(
      {
        name: 'details',
        locale: NS,
        // shadows ui-conversation's details registration (priority 0);
        // lowest priority renders in a single slot. Bump back if both must coexist.
        priority: -1,
        inject: () => ({ openDetails: () => ctx.layout.openDetails() }),
      },
      DiffPanel,
    ),
  );

  // The wide overlay (additive list slot; floats over the whole app).
  ctx.slots.register(
    {
      name: 'shell.overlay',
      id: 'threadtrail-overlay',
      locale: NS,
      inject: () => ({}),
    },
    DiffOverlay,
  );

  // Always-available entry in the sidebar footer. Before the first message
  // the details column is hidden (the current session is still blank), so
  // this button is what opens the compare view from the very start.
  ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register(
      {
        name: 'sidebar.footer.action',
        id: 'threadtrail-diff',
        locale: NS,
        inject: () => ({}),
      },
      DiffFooterAction,
    ),
  );
}
