/**
 * Small formatting / fetch helpers shared across the panel components.
 */

/** Fetch helper for the host routes (JSON in, parsed JSON out). */
export async function hostFetch(path: string, signal?: AbortSignal, options?: RequestInit): Promise<any> {
  return fetch(path, { signal, headers: { accept: 'application/json' }, ...options }).then((res) => {
    if (!res.ok) return res.json().then((b) => Promise.reject(new Error(b?.error || String(res.status))));
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
