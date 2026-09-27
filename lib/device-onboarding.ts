// TASK_128 — device onboarding quarantine ("one process at a time").
//
// Client-safe on purpose (no `server-only`, no DB): the Devices-page strip and
// the row badge import the display helper, and the internal sweep imports the
// decision function. This module owns the RULES and the COPY so the UI can
// never drift from the state machine; the sweep owns every write.
//
// The 20-minute window is ONE shared clock: hide@5 · stay-on@10 · move@15 ·
// released & fully private by 20. The move half is Vantra's own
// `AUTO_MOVE_DELAY_MINUTES` (15) — ONBOARDING_MOVE_MINUTES is DISPLAY only.
//
// Stage order is load-bearing, not cosmetic: the move's second step is a
// PowerShell run ON THE DEVICE, so stay-on@10 (which is what makes the move
// land) must precede it; and hide@5 is what stops a local user spotting and
// stopping the agent before the move.
//
// Quantisation is real and shown honestly: every stage fires on the first
// 5-minute sweep at/after its threshold, and t0 is itself up to one sweep late,
// so the UI shows a live relative time, never a promise of "exactly 15:00".

export const ONBOARDING_HIDE_MINUTES = 5;
export const ONBOARDING_STAY_ON_MINUTES = 10;
export const ONBOARDING_MOVE_MINUTES = 15; // DISPLAY only — the real move is Vantra's own clock
export const ONBOARDING_WINDOW_MINUTES = 20; // the total quarantine window
export const ONBOARDING_MAX_ATTEMPTS = 6;

export type OnboardingAction = "hide" | "stay_on" | "release" | "wait" | "terminal";

const MINUTE_MS = 60_000;

/**
 * The ONE pure decision the sweep makes. Rules evaluate top-down, first match
 * wins — this exact order is the spec:
 *   1. released/failed             -> terminal (never fires again)
 *   2. tier "private"              -> release (observed in the private org)
 *   3. elapsed < 5 min             -> wait
 *   4. hide not done               -> hide
 *   5. elapsed < 10 min            -> wait
 *   6. stay-on not done            -> stay_on (cannot fire before hide is done)
 *   7. elapsed >= 20 min           -> release
 *   8. otherwise                   -> wait
 * There is deliberately NO staleness/claimAt window: a row left in
 * hiding/staying_on with its `*DoneAt` null by a dead request is simply
 * re-claimed and re-run on the next sweep (the same unconditional rule as
 * Vantra's device-auto-move.ts:63-69 — one worker, one request).
 */
export function nextOnboardingAction(
  input: {
    status: string;
    tier: string;
    timerStartedAt: Date;
    hideDoneAt: Date | null;
    stayOnDoneAt: Date | null;
  },
  nowMs: number,
): OnboardingAction {
  if (input.status === "released" || input.status === "failed") return "terminal";
  if (input.tier === "private") return "release";
  const elapsedMs = nowMs - input.timerStartedAt.getTime();
  if (elapsedMs < ONBOARDING_HIDE_MINUTES * MINUTE_MS) return "wait";
  if (!input.hideDoneAt) return "hide";
  if (elapsedMs < ONBOARDING_STAY_ON_MINUTES * MINUTE_MS) return "wait";
  if (!input.stayOnDoneAt) return "stay_on";
  if (elapsedMs >= ONBOARDING_WINDOW_MINUTES * MINUTE_MS) return "release";
  return "wait";
}

/** A row that has left the window — the strip must render nothing for it. */
export function isOnboardingTerminal(status: string): boolean {
  return status === "released" || status === "failed";
}


/** The row shape the display helper needs (the API payload carries these). */
export interface OnboardingViewInput {
  status: string;
  tier: string;
  timerStartedAt: string | Date;
  hideDoneAt: string | Date | null;
  stayOnDoneAt: string | Date | null;
  releasedAt?: string | Date | null;
  /** Null for a free/trial account with no private org — step 4 says so. */
  destinationOrgId?: string | null;
  /**
   * Whether the device is reachable right now. The caller derives it with
   * `isDeviceOnline(device.lastSeenAt)` from `lib/devices.ts` and passes the
   * boolean in, so this module stays client-safe and never imports the
   * server-only module.
   */
  isOnline: boolean;
}

export interface OnboardingView {
  step: 1 | 2 | 3 | 4;
  title: string;
  detail: string;
  /** ms left in the 20-minute window (never negative). */
  remainingMs: number;
  /** ms since timerStartedAt (for "the next device starts in ~N min"). */
  elapsedMs: number;
  /** The coming stage for the "next:" part of the strip; null on step 4. */
  next: string | null;
  /** True when the current stage is due but the device has not been seen. */
  waitingForDevice: boolean;
}

function toDate(value: string | Date | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value : new Date(value);
}

/**
 * The ONE display helper. All strip copy comes from here — the component must
 * never hard-code a stage name. Strings are the spec's, verbatim.
 */
export function onboardingView(row: OnboardingViewInput, nowMs: number): OnboardingView {
  const startedMs = (toDate(row.timerStartedAt) ?? new Date(nowMs)).getTime();
  const elapsedMs = Math.max(0, nowMs - startedMs);
  const remainingMs = Math.max(0, ONBOARDING_WINDOW_MINUTES * MINUTE_MS - elapsedMs);

  const terminalOrPrivate =
    row.tier === "private" || row.status === "released" || row.status === "failed";
  let step: 1 | 2 | 3 | 4;
  if (terminalOrPrivate) step = 4;
  else if (elapsedMs < ONBOARDING_HIDE_MINUTES * MINUTE_MS) step = 1;
  else if (elapsedMs < ONBOARDING_STAY_ON_MINUTES * MINUTE_MS) step = 2;
  else if (elapsedMs < ONBOARDING_MOVE_MINUTES * MINUTE_MS) step = 3;
  else step = 4;

  const action = nextOnboardingAction(
    {
      status: row.status,
      tier: row.tier,
      timerStartedAt: toDate(row.timerStartedAt) ?? new Date(nowMs),
      hideDoneAt: toDate(row.hideDoneAt),
      stayOnDoneAt: toDate(row.stayOnDoneAt),
    },
    nowMs,
  );
  const waitingForDevice = (action === "hide" || action === "stay_on") && !row.isOnline;

  if (step === 1) {
    return {
      step: 1,
      title: "Quarantined",
      detail: "waiting for the first check-in",
      remainingMs,
      elapsedMs,
      next: "hide",
      waitingForDevice,
    };
  }
  if (step === 2) {
    return {
      step: 2,
      title: "Hiding the agent",
      detail: "so it can't be stopped from the machine",
      remainingMs,
      elapsedMs,
      next: "stay on",
      waitingForDevice,
    };
  }
  if (step === 3) {
    return {
      step: 3,
      title: "Staying awake",
      detail: "keeping it reachable for the move",
      remainingMs,
      elapsedMs,
      next: "move",
      waitingForDevice,
    };
  }
  return {
    step: 4,
    title: "Moving to your private agent",
    detail: row.destinationOrgId
      ? "almost done"
      : "stays on your public agent — no private agent on this plan",
    remainingMs,
    elapsedMs,
    next: null,
    waitingForDevice,
  };
}

/**
 * "~6 min left" / "in a few minutes" / "any moment now" — the honest relative
 * time the strip shows (never "exactly 15:00").
 */
export function formatOnboardingCountdown(remainingMs: number): string {
  if (remainingMs <= 0) return "any moment now";
  if (remainingMs < MINUTE_MS) return "in a few minutes";
  return `~${Math.max(1, Math.round(remainingMs / MINUTE_MS))} min left`;
}

/** "~2 min" — how long until the next device's first stage is due. */
export function formatOnboardingEta(ms: number): string {
  if (ms <= 0) return "any moment now";
  if (ms < MINUTE_MS) return "a few seconds";
  return `~${Math.max(1, Math.round(ms / MINUTE_MS))} min`;
}
