// TASK_228 — onboarding: the HIDE only (owner redesign 2026-10-19).
//
// The quarantine is GONE. A new device stays a first-class PUBLIC device for as
// long as the owner wants it; moving to private is now an explicit human action
// (the per-device "Move to private" button → /api/devices/[id]/move-to-private
// → Vantra's internal /move route). The ONLY automation left is the agent-hide,
// and it must run cleanly without ever touching the agent process:
//   - `buildHideAgentScript` is cosmetic by design (service DisplayName +
//     registry Description + uninstall-entry visibility). It never stops or
//     restarts the agent, and this task adds no stay-on/move stage — the old
//     auto-move (which rewrote the agent's BaseURL and force-restarted
//     `tacticalrmm`) was what killed boxes mid-move (triage 2026-10-19);
//   - hide fires at +60 seconds after the onboarding timer starts, on the first
//     sweep tick that finds the device freshly checked in (owner: "on the first
//     minute, or the second"). The sweep timer runs every 60s (box config);
//   - an offline device — including the `vantra_503: This device is currently
//     offline` transport error — is NOT a failure and burns NO attempt: the
//     hide simply retries next tick. Only a GENUINE attempted-and-failed hide
//     (script output FAIL, or a non-offline transport error) counts toward
//     ONBOARDING_MAX_ATTEMPTS, which turns the row red `failed`. A failed hide
//     is cosmetic-only anyway: the device stays fully usable and the owner can
//     still move it manually.
//
// Client-safe by design (no `server-only`, no DB): the Devices-page row badge
// and the sweep both import from here, so the UI can never drift from the rules.

/** Hide fires this many seconds after the timer starts (owner: first/second minute). */
export const ONBOARDING_HIDE_AFTER_SECONDS = 60;
/** Genuinely ATTEMPTED-AND-FAILED hides before the row turns red `failed`. */
export const ONBOARDING_MAX_ATTEMPTS = 10;

export type OnboardingAction = "hide";

/** The subset of a DeviceOnboarding row the rules read. */
export type OnboardingRow = {
  status: string;
  timerStartedAt: Date;
  hideDoneAt: Date | null;
  releasedAt: Date | null;
  attempts: number;
  lastError: string | null;
};

/** released/failed never fire again (failed stays visible as a red badge). */
export function isOnboardingTerminal(status: string): boolean {
  return status === "released" || status === "failed";
}

/**
 * The ONE pure decision the sweep makes. Top-down, first match wins:
 *   1. terminal or hide already done -> null (nothing left to fire)
 *   2. elapsed < 60s                 -> null (the quiet first minute)
 *   3. otherwise                     -> hide
 * Offline/503 is deliberately NOT part of this rule: it is the caller's skip
 * (freshness gate + error classification in the sweep) and never a burn.
 */
export function nextOnboardingAction(
  row: Pick<OnboardingRow, "status" | "timerStartedAt" | "hideDoneAt"> &
    Partial<Pick<OnboardingRow, "attempts" | "releasedAt">>,
  now: number,
): { action: "hide" } | null {
  if (isOnboardingTerminal(row.status)) return null;
  if (row.hideDoneAt) return null;
  const elapsedMs = now - row.timerStartedAt.getTime();
  if (elapsedMs < ONBOARDING_HIDE_AFTER_SECONDS * 1000) return null;
  return { action: "hide" };
}

export type OnboardingLabel = { text: string; tone: "pending" | "failed" };

/**
 * The row's compact badge, driven by the same inputs as the sweep so no two
 * surfaces can disagree:
 *   - released (or hide done, awaiting the sweep's release write) -> null —
 *     a finished device renders NO pill (owner 2026-09-27: quiet when settled);
 *   - failed                                        -> red "Hide failed";
 *   - the quiet first minute                       -> null (nothing to say);
 *   - due, retrying after genuine failures         -> amber "Hiding agent · retry N";
 *   - due                                          -> amber "Hiding agent…".
 */
export function onboardingRowLabel(
  row: Pick<OnboardingRow, "status" | "timerStartedAt" | "hideDoneAt" | "attempts"> &
    Partial<Pick<OnboardingRow, "releasedAt">>,
  now: number,
): OnboardingLabel | null {
  if (row.status === "failed") return { text: "Hide failed", tone: "failed" };
  if (isOnboardingTerminal(row.status)) return null;
  if (row.hideDoneAt) return null; // hide ran; the sweep releases the row next tick
  const elapsedMs = now - row.timerStartedAt.getTime();
  if (elapsedMs < ONBOARDING_HIDE_AFTER_SECONDS * 1000) return null;
  if (row.attempts > 0) {
    return { text: `Hiding agent · retry ${row.attempts}`, tone: "pending" };
  }
  return { text: "Hiding agent…", tone: "pending" };
}
