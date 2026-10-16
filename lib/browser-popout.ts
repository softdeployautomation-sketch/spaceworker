// TASK_212 D3 — pop-out target builder + same-origin guard (PURE).
//
// Owner: "the controllers are not present in the open in new tab". Instead of
// opening the raw Neko URL (which carries no SpaceWorker chrome), the panel
// opens OUR wrapper route /browser-popout/<sessionId>, which re-mints the
// connectUrl server-side after auth + ownership checks and renders the same
// mouse/keyboard controls around the stream (see
// components/remote-viewer-controls.tsx).
//
// Why a route and not a ?url= param: connectUrl embeds Neko's auto-login
// credentials (usr/pwd — lib/browser-session-serialize.ts). A query param
// would leak them into browser history, Referer headers and server logs; a
// server route keeps them server-side and hands the frame a first-party URL.
//
// This module is deliberately pure (no server-only import, no DOM) so tests
// can pin both the href shape and the guard the wrapper relies on.

/** The wrapper-route href for a session's pop-out tab. */
export function popoutHrefFor(sessionId: string): string {
  return `/browser-popout/${encodeURIComponent(sessionId)}`;
}

/**
 * Same-origin guard (TASK_208 gate precedent): the frame the wrapper embeds
 * MUST be built on our own origin (APP_BASE_URL), because the whole control
 * model (installTouchControls → __swKey/__swMouse injection) depends on the
 * /browser/<id>/ proxy being same-origin. A connectUrl on any other host is
 * refused rather than embedded blind — injection would silently fail there
 * and the user would get a stream with dead controls and no explanation.
 */
export function isSameOriginConnectUrl(
  connectUrl: string,
  appBaseUrl: string
): boolean {
  try {
    const url = new URL(connectUrl);
    const base = new URL(appBaseUrl);
    return url.origin === base.origin;
  } catch {
    return false; // unparseable → refuse, never embed blind
  }
}
