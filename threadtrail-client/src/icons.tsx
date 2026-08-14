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

/** Clean (trash can). */
export function cleanIcon(size: number): ReactElement {
  return icon(
    [
      'M6.5 2.5h3M2.5 4h11M4 4l.7 9.2a1 1 0 0 0 1 .8h4.6a1 1 0 0 0 1-.8L12 4',
      'M6.5 7v4.5M9.5 7v4.5',
    ],
    size,
  );
}
