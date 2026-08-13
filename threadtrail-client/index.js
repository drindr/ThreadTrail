/**
 * ThreadTrail — node half (host row).
 *
 * The browser bundle lives at exports["./client"] and is served by the
 * modules node half (dsh.client declaration). Routes are registered by
 * threadtrail-server, so this half is intentionally a no-op: it only needs to
 * be a valid cordis plugin for the loader to apply.
 */
export const name = 'threadtrail-client';

export function apply() {}
