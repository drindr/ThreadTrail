/**
 * Line-diff primitives: unified-diff computation, changed-line ranges, and
 * the bounded LCS used behind it. Pure functions — no I/O, no capture state.
 */

import type { DiffLine, LineRange } from './types.ts';

/** Line counts above this skip the LCS diff and emit a whole-file replace. */
export const LCS_MAX_LINES = 800;

/**
 * Compute a line diff between two texts.
 * @returns added/removed counts plus a line-marker list.
 */
export function computeDiff(oldText: string, newText: string): { added: number; removed: number; lines: DiffLine[] } {
  // Split on newlines and drop the artifact empty element from a trailing
  // newline — a trailing '\n' is a property of the file, not an extra line.
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  if (a.length && a[a.length - 1] === '') a.pop();
  if (b.length && b[b.length - 1] === '') b.pop();
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) suffix++;
  const midA = a.slice(prefix, a.length - suffix);
  const midB = b.slice(prefix, b.length - suffix);

  const lines: DiffLine[] = [];
  for (let i = 0; i < prefix; i++) lines.push({ t: ' ', text: a[i] });
  if (midA.length === 0) {
    for (const x of midB) lines.push({ t: '+', text: x });
  } else if (midB.length === 0) {
    for (const x of midA) lines.push({ t: '-', text: x });
  } else if (midA.length <= LCS_MAX_LINES && midB.length <= LCS_MAX_LINES) {
    for (const { t, text } of lcsDiff(midA, midB)) lines.push({ t, text });
  } else {
    for (const x of midA) lines.push({ t: '-', text: x });
    for (const x of midB) lines.push({ t: '+', text: x });
  }
  for (let i = a.length - suffix; i < a.length; i++) lines.push({ t: ' ', text: a[i] });

  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.t === '+') added++;
    else if (l.t === '-') removed++;
  }
  return { added, removed, lines };
}

/**
 * Compute old/new line ranges covered by a diff's changed runs (unified-diff
 * hunk semantics): each contiguous run of `+`/`-` lines becomes one range on
 * each side. Used to anchor code to conversation ("which lines did this op
 * touch") and to highlight changed lines in the worktree viewer.
 */
export function computeRanges(lines: DiffLine[]): { oldRanges: LineRange[]; newRanges: LineRange[] } {
  const oldRanges: LineRange[] = [];
  const newRanges: LineRange[] = [];
  let oldLine = 1;
  let newLine = 1;
  let runOldStart = 0;
  let runNewStart = 0;
  let oldTouched = false;
  let newTouched = false;
  let inRun = false;
  const closeRun = () => {
    if (!inRun) return;
    if (oldTouched) oldRanges.push({ start: runOldStart, end: oldLine - 1 });
    if (newTouched) newRanges.push({ start: runNewStart, end: newLine - 1 });
    inRun = false;
  };
  for (const l of lines) {
    if (l.t === ' ') {
      closeRun();
      oldLine++;
      newLine++;
    } else {
      if (!inRun) {
        inRun = true;
        runOldStart = oldLine;
        runNewStart = newLine;
        oldTouched = false;
        newTouched = false;
      }
      if (l.t === '-') {
        oldTouched = true;
        oldLine++;
      } else {
        newTouched = true;
        newLine++;
      }
    }
  }
  closeRun();
  return { oldRanges, newRanges };
}

/** LCS diff of two line arrays (n*m DP over Int32 rows, memory-bounded by caller). */
export function lcsDiff(a: string[], b: string[]): DiffLine[] {
  const n = a.length;
  const m = b.length;
  const rows = [new Int32Array(m + 1)];
  for (let i = 1; i <= n; i++) {
    const prev = rows[i - 1];
    const cur = new Int32Array(m + 1);
    const ai = a[i - 1];
    for (let j = 1; j <= m; j++) {
      cur[j] = ai === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    rows.push(cur);
  }
  const out: DiffLine[] = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      out.push({ t: ' ', text: a[i - 1] });
      i--;
      j--;
    } else if (rows[i - 1][j] >= rows[i][j - 1]) {
      out.push({ t: '-', text: a[i - 1] });
      i--;
    } else {
      out.push({ t: '+', text: b[j - 1] });
      j--;
    }
  }
  while (i > 0) {
    out.push({ t: '-', text: a[i - 1] });
    i--;
  }
  while (j > 0) {
    out.push({ t: '+', text: b[j - 1] });
    j--;
  }
  return out.reverse();
}
