/**
 * ThreadTrail — server half.
 *
 * Captures every file edit of a session's workspace between turns (the
 * "software is made between commits" granularity), links each change to the
 * conversation that produced it, and exposes:
 *   - the `threadtrail` query tool to the agent,
 *   - `/threadtrail/...` HTTP routes (digest / op detail / non-destructive
 *     rewind / clean) to the browser panel (registered only when
 *     `ctx.webServer` exists, so the plugin also composes on headless).
 */

import { CaptureStore } from './capture.ts';
import { threadtrailTool } from './tool.ts';
import { registerRoutes } from './routes.ts';
import type { SessionStoreLike } from './routes.ts';

/** The harness plugin context, typed to the small surface we use. */
interface PluginCtx {
  on(event: string, listener: (...args: any[]) => void): void;
  tools: { register(tool: unknown): void };
  get(name: string): unknown;
  sessions: SessionStoreLike;
  logger?: { warn?: (...args: unknown[]) => void };
}

export const inject = ['sessions', 'tools'];

export function apply(ctx: PluginCtx): Promise<void> {
  // Canonical harness home (DSH_HOME, or ~/.dsh) — DSH_HOME is not exported
  // into the web app process, so a bare env fallback would land in ~/threadtrail.
  const store = new CaptureStore();

  const ready = store.init().then(() => {
    // ── session lifecycle ────────────────────────────────────────────────
    ctx.on('session/created', (session) => {
      store.getOrCreate((session as { id: string }).id, (session as { header?: { cwd?: string | null } }).header?.cwd ?? null);
    });
    ctx.on('session/disposed', (session) => {
      store.dispose((session as { id: string }).id);
    });

    // ── capture at turn boundaries ───────────────────────────────────────
    ctx.on('session/event', (session, event) => {
      handleEvent(store, session, event).catch((err) => {
        ctx.logger?.warn?.(`threadtrail capture error: ${err instanceof Error ? err.stack ?? err : err}`);
      });
    });

    // ── agent query tool ─────────────────────────────────────────────────
    ctx.tools.register(threadtrailTool({ store, sessions: ctx.sessions }));

    // ── browser routes (web profile only) ────────────────────────────────
    const webServer = ctx.get('webServer');
    if (webServer) {
      registerRoutes(webServer as import('./routes.ts').WebServerLike, { store, sessions: ctx.sessions });
    }
  });

  return ready;
}

/** One session event, as the capture wiring reads it. */
interface SessionEventLike {
  type: string;
  seq: number;
  data?: { turn?: number };
}

/** Fold session events into capture state. */
async function handleEvent(store: CaptureStore, session: unknown, event: SessionEventLike): Promise<void> {
  const sc = store.getOrCreate((session as { id: string }).id, (session as { header?: { cwd?: string | null } }).header?.cwd ?? null);
  if (!sc.cwd) return; // sessions without a workspace are not captured

  switch (event.type) {
    case 'user/message':
      sc.lastUserSeq = event.seq;
      break;
    case 'assistant/message':
      {
        const turn = event.data?.turn;
        if (turn == null) break;
        const list = sc.assistantSeqs.get(turn) ?? [];
        list.push(event.seq);
        sc.assistantSeqs.set(turn, list);
      }
      break;
    case 'turn/start':
      // Record manual edits made since the last scan, before the agent works.
      await sc.scan({
        trigger: 'turn/start',
        atSeq: event.seq,
        turn: null,
        userMessageSeq: sc.lastUserSeq,
        assistantSeqs: [],
      });
      break;
    case 'turn/end':
      {
        const turn = event.data?.turn ?? null;
        const assistantSeqs = turn == null ? [] : (sc.assistantSeqs.get(turn) ?? []);
        if (turn != null) sc.assistantSeqs.delete(turn);
        await sc.scan({
          trigger: 'turn/end',
          atSeq: event.seq,
          turn,
          userMessageSeq: sc.lastUserSeq,
          assistantSeqs,
        });
      }
      break;
    default:
      break;
  }
}
