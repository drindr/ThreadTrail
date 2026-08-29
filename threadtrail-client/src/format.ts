/**
 * Small formatting / fetch helpers shared across the panel components.
 */

/** Fetch helper for the host routes (JSON in, parsed JSON out). */
export async function hostFetch(path: string, signal?: AbortSignal, options?: RequestInit): Promise<any> {
  return fetch(path, { signal, headers: { accept: 'application/json' }, ...options }).then(async (res) => {
    if (!res.ok) {
      // Error bodies are not always JSON (an unmounted route falls through to
      // the shell's empty 404) — surface the HTTP status instead of a
      // JSON.parse error.
      const text = await res.text().catch(() => '');
      let message = text.trim();
      try {
        message = JSON.parse(message)?.error || message;
      } catch {
        /* not JSON — use the raw text */
      }
      throw new Error(message || `HTTP ${res.status}`);
    }
    return res.json();
  });
}

export function fmtTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}
