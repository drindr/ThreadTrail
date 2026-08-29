/**
 * ThreadTrail — server half.
 *
 * Serves the git-diff comparison the browser panel renders: the comparable
 * records of a session's workspace (every commit, plus the uncommitted
 * worktree state treated as one record) and the unified diff between any two
 * of them. Routes live under `/threadtrail/...`.
 */

import { registerRoutes } from './routes.ts';
import type { SessionStoreLike, WebServerLike } from './routes.ts';

/**
 * The harness plugin context, typed to the small surface we use. `inject` is
 * cordis' deferred-service helper: the callback starts once the named
 * services are active, and never runs where they do not exist (headless
 * profiles have no webServer). A bare `ctx.get('webServer')` at apply time
 * races service activation and silently registers nothing — do not use it.
 */
interface PluginCtx {
  sessions: SessionStoreLike;
  inject(names: string[], callback: (ctx: { webServer: WebServerLike }) => void): void;
}

export const inject = ['sessions'];

export function apply(ctx: PluginCtx): void {
  ctx.inject(['webServer'], ({ webServer }) => {
    registerRoutes(webServer, { sessions: ctx.sessions });
  });
}
