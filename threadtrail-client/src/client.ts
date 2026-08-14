/**
 * ThreadTrail — browser half, entry module.
 *
 * Registers the details-column panel (timeline ⇄ worktree), the wide overlay
 * (`shell.overlay`), and the always-visible sidebar footer entry that makes
 * the workspace browsable before any modification. Bundled by esbuild into a
 * classic-script module-loader bundle (see `build/build.mjs`); `react` stays
 * external and resolves through the loader's module table at runtime.
 */

import { CSS } from './css.ts';
import { DeltaPanel } from './components/panel.tsx';
import { WorktreeOverlay } from './components/overlay.tsx';
import { WorktreeFooterAction } from './components/footer.tsx';
import { detectLang, createHighlighter } from './highlighter.tsx';

export { DeltaPanel, WorktreeOverlay, WorktreeFooterAction, detectLang, createHighlighter };

const NS = 'threadtrail';
const en = {
  'panel.title': 'ThreadTrail',
  'panel.subtitle': 'software is made between commits',
  'panel.refresh': 'Refresh',
  'panel.expand': 'Expand worktree',
  'panel.loading': 'Loading…',
  'panel.error': 'ThreadTrail host not reachable ({error})',
  'panel.tab.timeline': 'Timeline',
  'panel.tab.worktree': 'Worktree',
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
      DeltaPanel,
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
    WorktreeOverlay,
  );

  // Always-available worktree trigger in the sidebar footer. Before the
  // first modification the details column is hidden (the current session is
  // still blank), so this button is what lets the user browse the workspace
  // code from the very start.
  ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register(
      {
        name: 'sidebar.footer.action',
        id: 'threadtrail-worktree',
        locale: NS,
        inject: () => ({}),
      },
      WorktreeFooterAction,
    ),
  );
}
