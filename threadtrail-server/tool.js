/**
 * The agent-facing `threadtrail` tool: lets the model itself draw on the captured
 * history — "what did I change in this session", "why was this line written",
 * "rewind to that point" — the ThreadTrail idea that agents pick up the context
 * behind the code they are touching.
 */

import { defineTool } from '@deepseek-ai/dsh-tools';
import path from 'node:path';
import { promptPreview } from './messages.js';

const ACTIONS = [
  ['status', 'Report capture status for the current session (or all sessions).'],
  ['list', 'List captured ops (file changes between turns) for a session, newest first.'],
  ['where', 'Given a file path, list every op that touched it plus the prompts that drove them (code -> conversation).'],
  ['why', 'Given an op id or turn number, show what changed and the conversation behind it (conversation -> code).'],
  ['rewind', 'Materialize the workspace state right after an op into a fresh directory under <cwd>/.threadtrail/rewinds (non-destructive).'],
].map(([name, description]) => ({ name, description }));

export function threadtrailTool({ store, sessions }) {
  return defineTool({
    name: 'threadtrail',
    description:
      'Query the ThreadTrail operation log of this session: every file edit between turns, ' +
      'linked to the conversation that produced it. Use it to answer "what changed here", ' +
      '"why was this line written", or to materialize the code as it was at any past point. ' +
      `Actions: ${ACTIONS.map((a) => `${a.name} (${a.description})`).join('; ')}.`,
    parameters: {
      action: {
        type: 'string',
        required: true,
        description: 'One of: ' + ACTIONS.map((a) => a.name).join(', '),
      },
      sessionId: {
        type: 'string',
        description: 'Session id (defaults to the current session).',
      },
      path: {
        type: 'string',
        description: 'File path (relative to the workspace root) for action=where.',
      },
      opId: {
        type: 'string',
        description: 'Op id like op-3 for action=why / action=rewind.',
      },
      turn: {
        type: 'integer',
        description: 'Turn number for action=why.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      try {
        const sessionId = args.sessionId || exec?.agent?.sessionId || null;
        return await run(args, sessionId, store, sessions);
      } catch (err) {
        return `threadtrail error: ${err && err.message ? err.message : String(err)}`;
      }
    },
  });
}

async function run(args, sessionId, store, sessions) {
  const action = args.action;
  if (action === 'status') {
    const rows = [];
    for (const [id, sc] of store.sessions) {
      rows.push(`- ${id}  cwd=${sc.cwd ?? '(none)'}  ops=${sc.ops.length}`);
    }
    return `ThreadTrail capture root: ${store.root}\nSessions tracked: ${store.sessions.size}\n${rows.join('\n') || '  (no sessions yet — capture starts at the next turn boundary)'}`;
  }

  if (!sessionId) return 'No session id available (run from a session, or pass sessionId).';
  const sc = store.get(sessionId);
  if (!sc) {
    store.getOrCreate(sessionId, null);
  }
  const cap = store.get(sessionId);
  if (!cap) return 'Session not tracked.';
  await cap.load();

  if (action === 'list') {
    const limit = 200;
    const ops = cap.ops.slice(-limit).reverse();
    if (ops.length === 0) return 'No ops captured yet in this session (changes are recorded at turn boundaries).';
    const lines = ops.map((o) => {
      const files = o.files.map((f) => `${f.path}${f.deleted ? ' (deleted)' : ` +${f.added}/-${f.removed ?? 0}`}`).join(', ');
      return `${o.id} turn=${o.turn ?? 'manual'} trigger=${o.trigger} atSeq=${o.atSeq} promptSeq=${o.userMessageSeq ?? '-'}: ${files}`;
    });
    return `Ops (${cap.ops.length} total, showing last ${Math.min(limit, ops.length)}):\n` + lines.join('\n');
  }

  if (action === 'where') {
    const rel = String(args.path ?? '').replace(/^\.\//, '');
    if (!rel) return 'action=where requires a path.';
    const digest = cap.digest();
    const opIds = digest.fileIndex[rel];
    if (!opIds || opIds.length === 0) return `No captured edits touch ${rel} yet.`;
    const out = [`Edits to ${rel} (${opIds.length}):`];
    for (const opId of opIds) {
      const o = cap.ops.find((x) => x.id === opId);
      if (!o) continue;
      const prompt = await promptPreview(sessions, sessionId, o.userMessageSeq);
      out.push(
        `- ${opId} turn=${o.turn ?? 'manual'} at ${new Date(o.time).toISOString()} ` +
        `(${o.files.map((f) => (f.path === rel ? `+${f.added}/-${f.removed ?? 0}${f.deleted ? ' deleted' : ''}` : '')).join('') || 'touched'})` +
        (prompt ? `\n    prompt: ${prompt}` : ''),
      );
    }
    return out.join('\n');
  }

  if (action === 'why') {
    const opId = args.opId;
    const turn = args.turn;
    let op = null;
    if (opId) op = cap.ops.find((o) => o.id === opId);
    else if (turn != null) op = cap.ops.filter((o) => o.turn === turn).at(-1);
    if (!op) {
      const ids = cap.ops.map((o) => o.id).slice(-20).join(', ');
      return `Op not found. Known op ids (last 20): ${ids || '(none yet)'}.`;
    }
    const prompt = await promptPreview(sessions, sessionId, op.userMessageSeq);
    const files = op.files.map((f) => {
      if (f.deleted) return `  - ${f.path} (deleted, was sha ${f.prevSha?.slice(0, 8) ?? '?'})`;
      const diffText = (f.diff || []).slice(0, 60).map((l) => `${l.t}${l.text}`).join('\n');
      const more = (f.diff?.length ?? 0) > 60 ? `\n  … (${f.diff.length - 60} more diff lines)` : '';
      return `  - ${f.path} +${f.added}/-${f.removed}\n${diffText}${more}`;
    }).join('\n');
    return [
      `Op ${op.id} — turn=${op.turn ?? 'manual'}, trigger=${op.trigger}, at ${new Date(op.time).toISOString()}`,
      `Prompt that drove it (seq ${op.userMessageSeq ?? '-'}): ${prompt ?? '(none captured)'}`,
      `Assistant message seqs in that turn: ${op.assistantSeqs.join(', ') || '(none)'}`,
      `Files changed:\n${files || '  (none)'}`,
    ].join('\n');
  }

  if (action === 'rewind') {
    const opId = args.opId;
    if (!opId) return 'action=rewind requires opId.';
    if (!cap.cwd) return 'Session has no workspace to rewind into.';
    const target = pathJoinSafe(cap.cwd, `.threadtrail/rewinds/${opId}-${Date.now()}`);
    const result = await cap.rewind(opId, target);
    return `Materialized workspace state after ${opId} into ${result.target}\n` +
      result.files.map((f) => `  ${f.state === 'deleted' ? '(absent)' : 'written'} ${f.path}`).join('\n') +
      `\n${result.files.length} files. This is a delta snapshot: files never touched by captured history are not copied.`;
  }

  return `Unknown action "${action}". Actions: ${ACTIONS.map((a) => a.name).join(', ')}.`;
}

function pathJoinSafe(base, rel) {
  // rel is internally constructed (never user-controlled paths join here directly)
  return path.join(base, rel);
}
