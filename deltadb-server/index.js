/**
 * DeltaDB-lite — server half.
 *
 * Captures every file edit of a session's workspace between turns (the
 * "software is made between commits" granularity), links each change to the
 * conversation that produced it, and exposes:
 *   - the `deltadb` query tool to the agent,
 *   - `/deltadb/...` HTTP routes (digest / op detail / non-destructive rewind)
 *     to the browser panel (registered only when `ctx.webServer` exists, so
 *     the plugin also composes on the headless profile).
 */

import { CaptureStore } from './capture.js';
import { deltadbTool } from './tool.js';
import { registerRoutes } from './routes.js';

export const inject = ['sessions', 'tools'];

export function apply(ctx) {
  // Canonical harness home (DSH_HOME, or ~/.dsh) — DSH_HOME is not exported
  // into the web app process, so a bare env fallback would land in ~/deltadb.
  const store = new CaptureStore();

  const ready = store.init().then(() => {
    // ── session lifecycle ────────────────────────────────────────────────
    ctx.on('session/created', (session) => {
      store.getOrCreate(session.id, session.header?.cwd ?? null);
    });
    ctx.on('session/disposed', (session) => {
      store.dispose(session.id);
    });

    // ── capture at turn boundaries ───────────────────────────────────────
    ctx.on('session/event', (session, event) => {
      handleEvent(store, session, event).catch((err) => {
        ctx.logger?.warn?.(`deltadb capture error: ${err?.stack ?? err}`);
      });
    });

    // ── agent query tool ─────────────────────────────────────────────────
    ctx.tools.register(deltadbTool({ store, sessions: ctx.sessions }));

    // ── browser routes (web profile only) ────────────────────────────────
    const webServer = ctx.get('webServer');
    if (webServer) {
      registerRoutes(webServer, { store, sessions: ctx.sessions });
    }
  });

  return ready;
}

/** Fold session events into capture state. */
async function handleEvent(store, session, event) {
  const sc = store.getOrCreate(session.id, session.header?.cwd ?? null);
  if (!sc.cwd) return; // sessions without a workspace are not captured

  switch (event.type) {
    case 'user/message':
      sc.lastUserSeq = event.seq;
      break;
    case 'assistant/message':
      {
        const turn = event.data.turn;
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
        const turn = event.data.turn;
        const assistantSeqs = sc.assistantSeqs.get(turn) ?? [];
        sc.assistantSeqs.delete(turn);
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
