/**
 * The shared worktree store: one state feed for the details panel and the wide
 * overlay, with non-disruptive realtime refresh semantics (the open file's
 * content stays visible and the scroll position is kept while a refresh
 * loads). Consumed through `useWorktree()`.
 */

import { useSyncExternalStore } from 'react';
import { hostFetch } from './format.ts';
import type { FileData, TreeResult } from './types.ts';

export interface SelectionBox {
  startLine: number;
  endLine: number;
  snippet: string;
  x: number;
  y: number;
}

export interface WorktreeState {
  sessionId: string | null;
  tree: TreeResult | null;
  treeError: string | null;
  openPath: string | null;
  fileData: FileData | null;
  fileError: string | null;
  fileLoading: boolean;
  fileRefreshing: boolean;
  overlayOpen: boolean;
  overlayDismissed: boolean;
  selection: SelectionBox | null;
  noteDraft: string;
  saving: boolean;
}

const initialState: WorktreeState = {
  sessionId: null,
  tree: null,
  treeError: null,
  openPath: null,
  fileData: null,
  fileError: null,
  fileLoading: false,
  fileRefreshing: false,
  overlayOpen: false,
  overlayDismissed: false,
  selection: null,
  noteDraft: '',
  saving: false,
};

export interface WorktreeStoreApi {
  get(): WorktreeState;
  subscribe(fn: () => void): () => void;
  set(patch: Partial<WorktreeState>): void;
  reset(sessionId: string): void;
  fetchTree(sessionId: string): Promise<void>;
  openFile(sessionId: string, rel: string): Promise<void>;
  closeFile(): void;
  /** Realtime: re-read the open file when the agent works. */
  refreshOpen(sessionId: string): void;
  openOverlay(sessionId: string): void;
  closeOverlay(): void;
  addNote(sessionId: string): Promise<void>;
  deleteNote(sessionId: string, id: string): Promise<void>;
}

export const worktreeStore: WorktreeStoreApi = (() => {
  let state: WorktreeState = initialState;
  const listeners = new Set<() => void>();
  let fetchSeq = 0;

  const set = (patch: Partial<WorktreeState>): void => {
    state = { ...state, ...patch };
    listeners.forEach((l) => l());
  };

  return {
    get: () => state,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    set,
    reset(sessionId) {
      fetchSeq++;
      set({
        sessionId,
        tree: null,
        treeError: null,
        openPath: null,
        fileData: null,
        fileError: null,
        selection: null,
        noteDraft: '',
        saving: false,
        fileLoading: false,
        fileRefreshing: false,
        overlayOpen: false,
        overlayDismissed: false,
      });
      void this.fetchTree(sessionId);
    },
    async fetchTree(sessionId) {
      const seq = ++fetchSeq;
      set({ treeError: null });
      try {
        const t = await hostFetch(`/threadtrail/${encodeURIComponent(sessionId)}/tree.json`);
        if (seq !== fetchSeq) return;
        set({ tree: t as TreeResult, treeError: null });
      } catch (e) {
        if (seq === fetchSeq) set({ treeError: e instanceof Error ? e.message : String(e) });
      }
    },
    async openFile(sessionId, rel) {
      // Re-opening the file that is already on screen (the realtime refresh,
      // or a manual reload) must NOT blank the viewer: keep the current
      // content visible until the fresh copy arrives, so the reader's place
      // is not lost. Only the first open shows a loader.
      const refresh = state.openPath === rel && state.fileData !== null;
      const seq = ++fetchSeq;
      set(
        refresh
          ? { fileRefreshing: true }
          : { openPath: rel, fileData: null, fileError: null, fileLoading: true, fileRefreshing: false, selection: null, noteDraft: '' },
      );
      try {
        const d = await hostFetch(`/threadtrail/${encodeURIComponent(sessionId)}/file.json?path=${encodeURIComponent(rel)}`);
        if (seq !== fetchSeq) return;
        set(refresh ? { fileData: d as FileData, fileError: null, fileRefreshing: false } : { fileData: d as FileData, fileError: null, fileLoading: false, fileRefreshing: false });
      } catch (e) {
        if (seq === fetchSeq) {
          const message = e instanceof Error ? e.message : String(e);
          // On a refresh failure keep the last content and surface the error
          // instead of dropping the viewer.
          set(refresh ? { fileError: message, fileRefreshing: false } : { fileError: message, fileLoading: false, fileRefreshing: false });
        }
      }
    },
    closeFile() {
      set({ openPath: null, fileData: null, fileError: null, selection: null, noteDraft: '', fileRefreshing: false });
    },
    refreshOpen(sessionId) {
      if (state.openPath) void this.openFile(sessionId, state.openPath);
    },
    openOverlay(sessionId) {
      set({ overlayOpen: true, sessionId, overlayDismissed: false });
    },
    closeOverlay() {
      set({ overlayOpen: false, selection: null, noteDraft: '', overlayDismissed: true });
    },
    async addNote(sessionId) {
      const s = state;
      if (!s.selection || !s.noteDraft.trim() || s.saving) return;
      set({ saving: true });
      try {
        await hostFetch(`/threadtrail/${encodeURIComponent(sessionId)}/notes`, undefined, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            path: s.openPath,
            startLine: s.selection.startLine,
            endLine: s.selection.endLine,
            snippet: s.selection.snippet,
            note: s.noteDraft,
          }),
        });
        set({ saving: false, selection: null, noteDraft: '' });
        if (s.openPath) void this.openFile(sessionId, s.openPath);
      } catch (e) {
        set({ saving: false, fileError: `note failed: ${e instanceof Error ? e.message : String(e)}` });
      }
    },
    async deleteNote(sessionId, id) {
      const s = state;
      try {
        await hostFetch(`/threadtrail/${encodeURIComponent(sessionId)}/notes/${encodeURIComponent(id)}`, undefined, { method: 'DELETE' });
        if (s.openPath) void this.openFile(sessionId, s.openPath);
      } catch (e) {
        set({ fileError: `delete failed: ${e instanceof Error ? e.message : String(e)}` });
      }
    },
  };
})();

export function useWorktree(): WorktreeState {
  // Third arg (getServerSnapshot) keeps react-dom/server renders happy;
  // the browser ignores it (client-only rendering).
  return useSyncExternalStore(worktreeStore.subscribe, worktreeStore.get, worktreeStore.get);
}
