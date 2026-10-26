// TASK_244 — the "Open session" contract, in one place.
//
// The Open button used to `await` the lifecycle drive and a `/session` fetch
// before calling `window.open`, which browsers treat as outside the click and
// block (the "allow pop-ups" prompt). The button now navigates synchronously to
// `/clone/<id>`; that page owns the drive. These pure helpers keep the console
// and the session page agreeing on which states are openable and drivable, so
// they cannot drift apart again.

/** States where the session window has something useful to show (or to start). */
const OPENABLE_STATES = new Set(["requested", "ready", "launching", "active"]);

/**
 * States the session window may advance. `requested` is the first step and is
 * idempotent; `ready` launches; `launching` is safe because the server lock
 * serialises it. Never `awaiting_source`/`capturing` — advancing those would
 * ask for a second capture.
 */
const DRIVE_FROM_SESSION_STATES = new Set(["requested", "ready", "launching"]);

export function canOpenClone(status: string): boolean {
  return OPENABLE_STATES.has(status);
}

export function shouldDriveSession(status: string): boolean {
  return DRIVE_FROM_SESSION_STATES.has(status);
}

/** Why the button is (not) clickable, said in human words for the tooltip. */
export function cloneOpenTitle(status: string): string {
  if (status === "active") return "Open the cloned browser in a new tab";
  if (status === "ready") return "Open the session window — it launches the browser and updates itself";
  if (status === "launching") return "The browser is starting — open it now and watch it come up";
  if (status === "requested") return "Open the session window — it starts as soon as your PC is ready";
  return "The session opens once the browser is ready";
}
