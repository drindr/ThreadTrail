/**
 * Helpers for reading conversation content back out of the session log
 * (dependency-free: usable by both the tool and the HTTP routes).
 */

/** Short preview of the human prompt that drove an op, from the session log. */
export async function promptPreview(sessions, sessionId, seq) {
  if (seq == null) return null;
  try {
    const session = sessions.get(sessionId);
    if (!session) return null;
    const ev = session.events.find((e) => e.seq === seq && e.type === 'user/message');
    if (!ev) return null;
    const blocks = ev.data?.content ?? [];
    const text = blocks
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    return text.length > 300 ? text.slice(0, 300) + '…' : text || null;
  } catch {
    return null;
  }
}
