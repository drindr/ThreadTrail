/**
 * Helpers for reading conversation content back out of the session log
 * (dependency-free: usable by both the tool and the HTTP routes).
 */

/** One event of the session log, as far as prompt reading needs it. */
export interface SessionEvent {
  seq: number;
  type: string;
  data?: { content?: Array<{ type: string; text?: string }> };
}

/** The session-store face used for prompt lookups. */
export interface SessionsLike {
  get(sessionId: string): { events?: SessionEvent[] } | undefined;
}

/** Short preview of the human prompt that drove an op, from the session log. */
export async function promptPreview(
  sessions: SessionsLike | undefined,
  sessionId: string,
  seq: number | null | undefined,
): Promise<string | null> {
  if (seq == null) return null;
  try {
    const session = sessions?.get(sessionId);
    if (!session) return null;
    const ev = session.events?.find((e) => e.seq === seq && e.type === 'user/message');
    if (!ev) return null;
    const blocks = ev.data?.content ?? [];
    const text = blocks
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text ?? '')
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    return text.length > 300 ? text.slice(0, 300) + '…' : text || null;
  } catch {
    return null;
  }
}
