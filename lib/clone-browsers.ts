// Which browsers a clone can be asked for — the ONE place that says so.
//
// WHY THIS MODULE EXISTS
//
// The list used to live in four places that each made their own decision: the
// console picker, `app/api/devices/[deviceId]/clones/route.ts`, the orchestrator's
// validation and the transport's own guard. Four lists is three too many, and they
// had already drifted in a way nothing could report: the state pipe and the device
// engine had both learned **Brave**, while every door into the feature still refused
// it — so the capability was real, tested and unreachable, and a user simply could
// not pick the browser.
//
// The other half of the drift is quieter still. A clone always runs OUR browser (a
// pinned Chromium build, `lib/clone-browser-pin.ts`), so the source browser is a
// statement about what can be CARRIED, not about what will be launched:
//
//   chrome, edge, brave  → the profile loads, cookies come over CDP. Carriable.
//   firefox             → not Chromium; nothing can be carried. A clone for it is a
//                         FRESH session (the browser logs in for itself), which is a
//                         legitimate product, but it must never be offered as if the
//                         work PC's history were coming along.
//
// That second fact is why the two lists below are different lists rather than one.

/**
 * The browsers whose profile and cookies a clone can carry.
 *
 * Every one of these is Chromium, which is what makes the whole feature possible:
 * the same `User Data`/`Default` layout the device walks (`pkg/browser/source.go`),
 * the same App-Bound-Encryption cookie story (so cookies travel over CDP instead of
 * as files — see `michael/browser-clone/STATE-PIPE.md`), and the same version
 * convention (`Last Version`) the destination pin reads.
 *
 * This list MUST equal:
 *   - `STATE_SYNC_BROWSERS` in `lib/clone-state-sync-format.ts` (the wire vocabulary
 *     the device is asked with), and
 *   - the engine's walkable set (`engine/pkg/browser/walkable.go`).
 * `npm run check:clone-contract` fails when any of the three disagrees.
 */
export const CHROMIUM_BROWSERS = ["chrome", "edge", "brave"] as const;
export type ChromiumBrowser = (typeof CHROMIUM_BROWSERS)[number];

/** Source browsers a clone can be requested for but nothing can be carried from. */
export const NON_CARRIABLE_BROWSERS = ["firefox"] as const;
export type NonCarriableBrowser = (typeof NON_CARRIABLE_BROWSERS)[number];

/** Every browser a clone request may name. */
export const CLONE_BROWSERS = [...CHROMIUM_BROWSERS, ...NON_CARRIABLE_BROWSERS] as const;
export type CloneBrowser = (typeof CLONE_BROWSERS)[number];

const CLONE_BROWSER_SET: ReadonlySet<string> = new Set(CLONE_BROWSERS);
const CARRIABLE_SET: ReadonlySet<string> = new Set(CHROMIUM_BROWSERS);

/** True for any browser a clone may be requested for. Pure. */
export function isCloneBrowser(value: string): value is CloneBrowser {
  return CLONE_BROWSER_SET.has(value);
}

/**
 * True when this browser's profile state and cookies can actually travel.
 *
 * The check to use before promising anything: a `live` clone (cookies over CDP) and
 * a state sync both depend on it, and neither has a Firefox implementation.
 */
export function isCarriableBrowser(value: string): value is ChromiumBrowser {
  return CARRIABLE_SET.has(value);
}

/**
 * The ONE sentence that explains a non-carriable browser, or null when there is
 * nothing to explain.
 *
 * Shared rather than written out at each call site because the orchestrator and the
 * console must not describe the same refusal two different ways — one of them would
 * eventually promise something the other refuses.
 */
export function cloneBrowserCarryRefusal(browser: string): string | null {
  if (isCarriableBrowser(browser)) return null;
  return (
    `${browser} profiles cannot be carried: a clone runs a Chromium build, and ` +
    `history, bookmarks, tabs and cookies only load into the browser that wrote them. ` +
    `Use Chrome, Edge or Brave to carry a browser, or start a fresh session that signs in for itself.`
  );
}

/** The product label for a browser, for anything user-facing. */
export function cloneBrowserLabel(browser: string): string {
  switch (browser) {
    case "chrome":
      return "Chrome";
    case "edge":
      return "Edge";
    case "brave":
      return "Brave";
    case "firefox":
      return "Firefox";
    default:
      return browser;
  }
}
