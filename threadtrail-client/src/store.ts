/**
 * The shared diff-compare store: one state feed for the details panel and the
 * wide overlay. Holds the record list (commits + the uncommitted worktree
 * record), the user's two picked records, and the diff between them, with
 * non-disruptive manual refresh semantics (the rendered diff stays visible
 * while a refresh loads).
 */

import { useSyncExternalStore } from 'react';
import { hostFetch, hostFetchText } from './format.ts';
import { parseDiffResponse } from './diff-worker.ts';
import { EMPTY_ID, WORKTREE_ID } from './types.ts';
import type { DiffResult, RecordsResult } from './types.ts';

export interface DiffState {
  sessionId: string | null;
  /** The active comparison root (workspace-relative subfolder, '' = root). */
  root: string;
  /** Workspace-level subfolder repositories, cached for the root switcher. */
  rootCandidates: string[];
  records: RecordsResult | null;
  recordsError: string | null;
  recordsLoading: boolean;
  /** The two records the user compares (record ids: a commit sha or 'worktree'). */
  from: string | null;
  to: string | null;
  diff: DiffResult | null;
  diffError: string | null;
  diffLoading: boolean;
  /** True while a refetch runs with the previous diff still on screen. */
  diffRefreshing: boolean;
  overlayOpen: boolean;
}

const initialState: DiffState = {
  sessionId: null,
  root: '',
  rootCandidates: [],
  records: null,
  recordsError: null,
  recordsLoading: false,
  from: null,
  to: null,
  diff: null,
  diffError: null,
  diffLoading: false,
  diffRefreshing: false,
  overlayOpen: false,
};

export interface DiffStoreApi {
  get(): DiffState;
  subscribe(fn: () => void): () => void;
  set(patch: Partial<DiffState>): void;
  reset(sessionId: string): void;
  fetchRecords(sessionId: string): Promise<void>;
  /** Explicitly re-read records and the selected diff on user request. */
  refresh(sessionId: string): void;
  /**
   * View a record git-log style: a commit against its first parent (the root
   * commit against the empty tree), the worktree against HEAD.
   */
  viewRecord(sessionId: string, id: string): void;
  /** Toggle a record as the "from" base of the comparison. */
  pickFrom(sessionId: string, id: string): void;
  /** Toggle a record as the "to" target of the comparison. */
  pickTo(sessionId: string, id: string): void;
  swap(sessionId: string): void;
  /** Switch the comparison root to a subfolder (or back with ''). */
  selectRoot(sessionId: string, root: string): void;
  clearSelection(): void;
  fetchDiff(sessionId: string): Promise<void>;
  openOverlay(sessionId: string): void;
  closeOverlay(): void;
}

export const diffStore: DiffStoreApi = (() => {
  let state: DiffState = initialState;
  const listeners = new Set<() => void>();
  type Request = { key: string; controller: AbortController; promise: Promise<void> };
  let recordsRequest: Request | null = null;
  let diffRequest: Request | null = null;
  let autoSelect = true;
  const recordsKey = (s: DiffState) => JSON.stringify([s.sessionId, s.root]);
  const diffKey = (s: DiffState) => JSON.stringify([s.sessionId, s.root, s.from, s.to]);
  const cancelRecords = () => {
    const request = recordsRequest;
    recordsRequest = null;
    request?.controller.abort();
  };
  const cancelDiff = () => {
    const request = diffRequest;
    diffRequest = null;
    request?.controller.abort();
  };
  // Aborting a context also cancels records' lazy-session retry delay.
  const delay = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    if (signal.aborted) done();
  });
  /** Identity of the last applied diff body — a poll that returns the same
   *  bytes for the same comparison keeps the rendered tree untouched. */
  let lastDiffKey: string | null = null;
  let lastDiffHash = 0;

  const set = (patch: Partial<DiffState>): void => {
    const next = { ...state, ...patch };
    if (recordsKey(next) !== recordsKey(state)) {
      cancelRecords();
      next.recordsLoading = false;
    }
    if (diffKey(next) !== diffKey(state)) {
      cancelDiff();
      lastDiffKey = null;
      next.diffLoading = false;
      next.diffRefreshing = false;
      next.diffError = null;
    }
    if (Object.keys(next).every((key) => Object.is(next[key as keyof DiffState], state[key as keyof DiffState]))) return;
    state = next;
    listeners.forEach((l) => l());
  };

  const api: DiffStoreApi = {
    get: () => state,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    set,
    reset(sessionId) {
      cancelRecords();
      cancelDiff();
      autoSelect = true;
      lastDiffKey = null;
      set({ ...initialState, sessionId });
    },
    fetchRecords(sessionId) {
      if (sessionId !== state.sessionId) return Promise.resolve();
      const root = state.root;
      const key = recordsKey(state);
      if (recordsRequest?.key === key) return recordsRequest.promise;
      cancelRecords();
      const request: Request = { key, controller: new AbortController(), promise: Promise.resolve() };
      recordsRequest = request;
      const current = () => recordsRequest === request && !request.controller.signal.aborted;
      // Start in a microtask so even synchronous subscribers share this promise.
      request.promise = Promise.resolve().then(async () => {
        // DSH ≥ 0.1.2 materializes host session bindings lazily: right after the
        // client opens a session, `sessions.get(id)?.header?.cwd` on the host can
        // still be null and records.json answers 400 "session has no workspace".
        // Retry before surfacing the error; repeated polls join this retry chain.
        const delays = [0, 400, 900, 1600, 3000, 5000];
        for (let attempt = 0; attempt < delays.length; attempt++) {
          if (attempt > 0) await delay(delays[attempt], request.controller.signal);
          if (!current()) return;
          try {
            const r = (await hostFetch(
              `/threadtrail/${encodeURIComponent(sessionId)}/records.json${root ? `?root=${encodeURIComponent(root)}` : ''}`,
              request.controller.signal,
            )) as RecordsResult;
            if (!current()) return;
            const patch: Partial<DiffState> = { records: r, recordsError: null };
            // Cache the workspace-level repository list for the root switcher
            // (a subfolder response only knows its own children).
            if (!root) patch.rootCandidates = r.candidates ?? [];
            // Default comparison on first load, unless explicitly deselected.
            if (autoSelect && !state.from && !state.to && r.head && r.worktree && r.worktree.changed + r.worktree.untracked > 0) {
              patch.from = r.head;
              patch.to = WORKTREE_ID;
            }
            set(patch);
            if (state.from && state.to) void this.fetchDiff(sessionId);
            return;
          } catch (e) {
            if (!current()) return;
            if (attempt === delays.length - 1) set({ recordsError: e instanceof Error ? e.message : String(e) });
          }
        }
      }).finally(() => {
        if (recordsRequest === request) {
          recordsRequest = null;
          set({ recordsLoading: false });
        }
      });
      set({ recordsLoading: true, recordsError: null });
      return request.promise;
    },
    refresh(sessionId) {
      // fetchRecords chains fetchDiff when both records are picked.
      void this.fetchRecords(sessionId);
    },
    viewRecord(sessionId, id) {
      if (sessionId !== state.sessionId) return;
      autoSelect = false;
      const records = state.records;
      if (!records || id === EMPTY_ID) return;
      let from: string;
      if (id === WORKTREE_ID) {
        from = records.head ?? EMPTY_ID;
      } else {
        const rec = records.records.find((r) => r.id === id);
        if (!rec) return;
        from = rec.parent ?? EMPTY_ID;
      }
      set({ from, to: id, diffError: null });
      void this.fetchDiff(sessionId);
    },
    pickFrom(sessionId, id) {
      if (sessionId !== state.sessionId) return;
      autoSelect = false;
      let { from, to } = state;
      from = from === id ? null : id;
      if (from && from === to) to = null; // never compare a record to itself
      set({ from, to, diff: from && to ? state.diff : null, diffError: null });
      if (from && to) void this.fetchDiff(sessionId);
    },
    pickTo(sessionId, id) {
      if (sessionId !== state.sessionId) return;
      autoSelect = false;
      let { from, to } = state;
      to = to === id ? null : id;
      if (to && to === from) from = null;
      set({ from, to, diff: from && to ? state.diff : null, diffError: null });
      if (from && to) void this.fetchDiff(sessionId);
    },
    selectRoot(sessionId, root) {
      if (sessionId !== state.sessionId || state.root === root) return;
      autoSelect = true;
      // A different root means different records: clear the comparison.
      set({ root, from: null, to: null, diff: null, diffError: null, diffLoading: false, diffRefreshing: false, records: null, recordsError: null });
      void this.fetchRecords(sessionId);
    },
    swap(sessionId) {
      if (sessionId !== state.sessionId) return;
      const { from, to } = state;
      if (!from || !to) return;
      set({ from: to, to: from });
      void this.fetchDiff(sessionId);
    },
    clearSelection() {
      autoSelect = false;
      cancelDiff();
      lastDiffKey = null;
      set({ from: null, to: null, diff: null, diffError: null, diffLoading: false, diffRefreshing: false });
    },
    fetchDiff(sessionId) {
      const { from, to, root } = state;
      if (sessionId !== state.sessionId || !from || !to) return Promise.resolve();
      const key = diffKey(state);
      if (diffRequest?.key === key) return diffRequest.promise;
      cancelDiff();
      const request: Request = { key, controller: new AbortController(), promise: Promise.resolve() };
      diffRequest = request;
      const current = () => diffRequest === request && !request.controller.signal.aborted;
      const refreshing = state.diff !== null;
      request.promise = Promise.resolve().then(async () => {
        if (!current()) return;
        try {
          // Keep the parsed diff's identity on byte-identical polls: only the
          // loading flags change, not the expensive rendered diff tree.
          const text = await hostFetchText(
            `/threadtrail/${encodeURIComponent(sessionId)}/diff.json?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}${root ? `&root=${encodeURIComponent(root)}` : ''}`,
            request.controller.signal,
          );
          if (!current()) return;
          // Hash/parse off the main thread when possible so large diffs do not
          // freeze the whole page while "Computing diff" is on screen.
          const parsed = await parseDiffResponse(text, request.controller.signal);
          if (!current()) return;
          if (refreshing && key === lastDiffKey && parsed.hash === lastDiffHash) {
            set({ diffError: null, diffLoading: false, diffRefreshing: false });
            return;
          }
          lastDiffKey = key;
          lastDiffHash = parsed.hash;
          set({ diff: parsed.diff, diffError: null, diffLoading: false, diffRefreshing: false });
        } catch (e) {
          if (current()) {
            const message = e instanceof Error ? e.message : String(e);
            set({ diffError: message, diffLoading: false, diffRefreshing: false });
          }
        }
      }).finally(() => { if (diffRequest === request) diffRequest = null; });
      set(refreshing ? { diffRefreshing: true, diffLoading: false, diffError: null } : { diff: null, diffError: null, diffLoading: true, diffRefreshing: false });
      return request.promise;
    },
    openOverlay(sessionId) {
      if (state.sessionId !== sessionId) this.reset(sessionId);
      set({ overlayOpen: true });
    },
    closeOverlay() {
      set({ overlayOpen: false });
    },
  };
  return api;
})();

export function useDiffStore(): DiffState {
  // Third arg (getServerSnapshot) keeps react-dom/server renders happy;
  // the browser ignores it (client-only rendering).
  return useSyncExternalStore(diffStore.subscribe, diffStore.get, diffStore.get);
}
