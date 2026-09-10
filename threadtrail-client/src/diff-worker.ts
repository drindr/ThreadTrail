/**
 * Large-diff parsing worker: hashing and JSON.parse are CPU-bound and can be
 * tens of megabytes; doing them on the main thread freezes the whole GUI.
 * This module keeps that work off the UI thread when Web Workers are
 * available, and falls back to main-thread parsing when they are not.
 */

import type { DiffResult } from './types.ts';

interface ParsedDiff {
  diff: DiffResult;
  hash: number;
}

function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

interface WorkerRequest {
  id: number;
  text: string;
}

interface WorkerResponse {
  id: number;
  ok: boolean;
  hash?: number;
  diff?: DiffResult;
  error?: string;
}

let worker: Worker | null | undefined;
let workerUrl: string | undefined;
let nextId = 0;
const pending = new Map<number, { resolve: (parsed: ParsedDiff) => void; reject: (error: Error) => void }>();

function workerCode(): string {
  return `
function fnv1a(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
self.onmessage = (event) => {
  const { id, text } = event.data;
  try {
    const diff = JSON.parse(text);
    const hash = fnv1a(text);
    self.postMessage({ id, ok: true, hash, diff });
  } catch (error) {
    self.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};
`;
}

/** The worker is broken (load error, CSP block, …): reject in-flight work so
 *  the caller falls back to the main thread, and never use it again. */
function killWorker() {
  if (!worker) return;
  try {
    worker.terminate();
  } catch { /* ignore */ }
  worker = null;
  if (workerUrl && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(workerUrl);
  workerUrl = undefined;
  const stuck = [...pending.values()];
  pending.clear();
  for (const entry of stuck) entry.reject(new Error('diff worker failed'));
}

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  worker = null;
  try {
    if (typeof Worker === 'undefined' || typeof Blob === 'undefined' || typeof URL.createObjectURL !== 'function') return null;
    workerUrl = URL.createObjectURL(new Blob([workerCode()], { type: 'text/javascript' }));
    const w = new Worker(workerUrl);
    w.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
      const data = event.data;
      if (!data) return;
      const entry = pending.get(data.id);
      if (!entry) return; // aborted or superseded — drop the late reply
      pending.delete(data.id);
      if (data.ok) entry.resolve({ diff: data.diff as DiffResult, hash: data.hash as number });
      else entry.reject(new Error(data.error ?? 'diff parse failed'));
    });
    w.addEventListener('error', killWorker);
    worker = w;
  } catch {
    worker = null;
  }
  return worker;
}

/** Main-thread compute — the graceful fallback (tests/jsdom, no Workers). */
function parseOnMainThread(text: string): ParsedDiff {
  return { diff: JSON.parse(text) as DiffResult, hash: fnv1a(text) };
}

/** AbortSignal-aware off-thread parse with main-thread fallback. */
export async function parseDiffResponse(text: string, signal?: AbortSignal): Promise<ParsedDiff> {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const w = getWorker();
  if (!w) {
    return parseOnMainThread(text);
  }
  try {
    return await new Promise<ParsedDiff>((resolve, reject) => {
      const id = nextId++;
      const onAbort = () => {
        pending.delete(id);
        reject(new DOMException('Aborted', 'AbortError'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      pending.set(id, {
        resolve: (parsed) => { signal?.removeEventListener('abort', onAbort); resolve(parsed); },
        reject: (error) => { signal?.removeEventListener('abort', onAbort); reject(error); },
      });
      w.postMessage({ id, text } satisfies WorkerRequest);
    });
  } catch (error) {
    // A dead worker must not fail the diff: recompute on the main thread.
    if (worker === null && !signal?.aborted) return parseOnMainThread(text);
    throw error;
  }
}
