/**
 * The shared diff-compare store: one state feed for the details panel and the
 * wide overlay. Holds the record list (commits + the uncommitted worktree
 * record), the user's two picked records, and the diff between them, with
 * non-disruptive realtime refresh semantics (the rendered diff stays visible
 * while a refresh loads).
 */

import { useSyncExternalStore } from 'react';
import { hostFetch, hostFetchText } from './format.ts';
import { EMPTY_ID, WORKTREE_ID } from './types.ts';
import type { DiffResult, RecordsResult } from './types.ts';

/** FNV-1a over the raw response text — cheap identity check so a poll that
 *  returns byte-identical diff content never touches the rendered tree. */
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export interface DiffState {
  sessionId: string | null;
  /** The active comparison root (workspace-relative subfolder, '' = root). */
  root: string;
  /** Workspace-level subfolder repositories, cached for the root switcher. */
  rootCandidates: string[];
  records: RecordsResult | null;
  recordsError: string | null;
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
  /** Realtime: re-read records (and the open diff) when the agent works. */
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
  let fetchSeq = 0;
  /** Identity of the last applied diff body — a poll that returns the same
   *  bytes for the same comparison keeps the rendered tree untouched. */
  let lastDiffKey: string | null = null;
  let lastDiffHash = 0;

  const set = (patch: Partial<DiffState>): void => {
    state = { ...state, ...patch };
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
      fetchSeq++;
      lastDiffKey = null;
      set({ ...initialState, sessionId });
      void this.fetchRecords(sessionId);
    },
    async fetchRecords(sessionId) {
      const seq = ++fetchSeq;
      // DSH ≥ 0.1.2 materializes host session bindings lazily: right after the
      // client opens a session, `sessions.get(id)?.header?.cwd` on the host can
      // still be null and records.json answers 400 "session has no workspace".
      // That is transient — retry a few times before surfacing the error,
      // otherwise the panel never loads (and the details column never
      // auto-opens) for freshly clicked sessions.
      const delays = [0, 400, 900, 1600, 3000, 5000];
      for (let attempt = 0; attempt < delays.length; attempt++) {
        if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
        if (seq !== fetchSeq) return;
        try {
          const r = (await hostFetch(
            `/threadtrail/${encodeURIComponent(sessionId)}/records.json${state.root ? `?root=${encodeURIComponent(state.root)}` : ''}`,
          )) as RecordsResult;
          if (seq !== fetchSeq) return;
          const patch: Partial<DiffState> = { records: r, recordsError: null };
          // Cache the workspace-level repository list for the root switcher
          // (a subfolder response only knows its own children).
          if (!state.root) patch.rootCandidates = r.candidates ?? [];
          // Default comparison on first load: HEAD -> uncommitted worktree,
          // when there is anything uncommitted to look at.
          if (!state.from && !state.to && r.head && r.worktree && r.worktree.changed + r.worktree.untracked > 0) {
            patch.from = r.head;
            patch.to = WORKTREE_ID;
          }
          set(patch);
          if (state.from && state.to) void this.fetchDiff(sessionId);
          return;
        } catch (e) {
          if (seq !== fetchSeq) return;
          if (attempt === delays.length - 1) set({ recordsError: e instanceof Error ? e.message : String(e) });
        }
      }
    },
    refresh(sessionId) {
      // fetchRecords chains fetchDiff when both records are picked.
      void this.fetchRecords(sessionId);
    },
    viewRecord(sessionId, id) {
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
      let { from, to } = state;
      from = from === id ? null : id;
      if (from && from === to) to = null; // never compare a record to itself
      set({ from, to, diff: from && to ? state.diff : null, diffError: null });
      if (from && to) void this.fetchDiff(sessionId);
    },
    pickTo(sessionId, id) {
      let { from, to } = state;
      to = to === id ? null : id;
      if (to && to === from) from = null;
      set({ from, to, diff: from && to ? state.diff : null, diffError: null });
      if (from && to) void this.fetchDiff(sessionId);
    },
    selectRoot(sessionId, root) {
      if (state.root === root) return;
      // A different root means different records: clear the comparison.
      set({ root, from: null, to: null, diff: null, diffError: null, diffLoading: false, diffRefreshing: false, records: null, recordsError: null });
      void this.fetchRecords(sessionId);
    },
    swap(sessionId) {
      const { from, to } = state;
      if (!from || !to) return;
      set({ from: to, to: from });
      void this.fetchDiff(sessionId);
    },
    clearSelection() {
      fetchSeq++;
      lastDiffKey = null;
      set({ from: null, to: null, diff: null, diffError: null, diffLoading: false, diffRefreshing: false });
    },
    async fetchDiff(sessionId) {
      const { from, to } = state;
      if (!from || !to) return;
      const seq = ++fetchSeq;
      const refreshing = state.diff !== null;
      set(refreshing ? { diffRefreshing: true } : { diff: null, diffError: null, diffLoading: true, diffRefreshing: false });
      const key = `${from}->${to}@${state.root}`;
      try {
        // Raw text first: a poll whose body is byte-identical to what is on
        // screen skips the state write entirely, so the rendered diff (the
        // expensive, per-line highlighted tree) is never reconciled for
        // nothing.
        const text = await hostFetchText(
          `/threadtrail/${encodeURIComponent(sessionId)}/diff.json?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}${state.root ? `&root=${encodeURIComponent(state.root)}` : ''}`,
        );
        if (seq !== fetchSeq) return;
        const hash = fnv1a(text);
        if (refreshing && key === lastDiffKey && hash === lastDiffHash) {
          set({ diffRefreshing: false });
          return;
        }
        lastDiffKey = key;
        lastDiffHash = hash;
        set({ diff: JSON.parse(text) as DiffResult, diffError: null, diffLoading: false, diffRefreshing: false });
      } catch (e) {
        if (seq === fetchSeq) {
          const message = e instanceof Error ? e.message : String(e);
          set(refreshing ? { diffError: message, diffRefreshing: false } : { diffError: message, diffLoading: false, diffRefreshing: false });
        }
      }
    },
    openOverlay(sessionId) {
      set({ overlayOpen: true });
      if (state.sessionId !== sessionId) this.reset(sessionId);
      else if (!state.records && !state.recordsError) void this.fetchRecords(sessionId);
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
