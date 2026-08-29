/**
 * Panel icon set — hand-written inline SVGs (stroke: currentColor) so every
 * icon button renders identically on every platform, with no font-dependent
 * glyphs (U+26F6 "⛶" and friends are missing from many system fonts).
 */

import { createElement } from 'react';
import type { ReactElement, SVGProps } from 'react';

function icon(paths: string[], size: number, extra?: SVGProps<SVGSVGElement>): ReactElement {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...extra}
    >
      {paths.map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  );
}

/** Expand (four corners). */
export function expandIcon(size: number): ReactElement {
  return icon(['M2 2h4M2 2v4M10 2h4M14 2v4M2 10v4M2 14h4M10 14h4M14 14v-4'], size);
}

/** Refresh (circular arrow). */
export function refreshIcon(size: number): ReactElement {
  return icon(['M13 8a5 5 0 1 1-1.5-3.5M13.5 2v3.5h-3.5'], size);
}

/** Close (×). */
export function closeIcon(size: number): ReactElement {
  return icon(['M4 4l8 8M12 4l-8 8'], size, { strokeLinecap: 'round' });
}

/** Swap the two compared records (two opposing arrows). */
export function swapIcon(size: number): ReactElement {
  return icon(['M2 5h9M8 2l3 3-3 3M14 11H5M8 8l-3 3 3 3'], size);
}

/** Clear the selection (× in a circle). */
export function clearIcon(size: number): ReactElement {
  return icon(['M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13z', 'M5.5 5.5l5 5M10.5 5.5l-5 5'], size);
}

/** Chevron (collapse/expand toggle). */
export function chevronIcon(size: number): ReactElement {
  return icon(['M4 6l4 4 4-4'], size);
}

/** Back (left chevron) — the mobile return-to-chat affordance. */
export function backIcon(size: number): ReactElement {
  return icon(['M10 4l-4 4 4 4'], size);
}
