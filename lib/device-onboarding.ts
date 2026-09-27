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
export const ONBOARDING_WINDOW_MINUTES = 20; // the PLAN — never a hard deadline (see GRACE)
/**
 * Slack after the plan, so a stage that runs late is never a failure. Owner
 * rule: "it's not necessarily for it to be exactly 20 mins — if anyone exceeds,
 * we just want to put a little wait in each process." So the window at 20 is
 * ADVISORY: a device that is still public at 20 keeps its row, keeps retrying,
 * and keeps reading honestly in the UI (`overrun`). Nothing fails on lateness.
 */
export const ONBOARDING_GRACE_MINUTES = 5;
/**
 * The hard ceiling = plan + three grace periods. Only here does a device that
 * is STILL public go terminal `failed` — and `failed` is never silent: the row
 * keeps a red badge and the page keeps an alert naming it.
 */
export const ONBOARDING_CEILING_MINUTES = ONBOARDING_WINDOW_MINUTES + ONBOARDING_GRACE_MINUTES * 3;
export const ONBOARDING_MAX_ATTEMPTS = 6;

/** Rendered wherever a quarantined device appears — the owner's own promise. */
export const ONBOARDING_ACCESSIBLE_NOTE =
  "You can keep using this device while it's being set up.";

export type OnboardingAction = "hide" | "stay_on" | "release" | "wait" | "fail" | "terminal";

const MINUTE_MS = 60_000;

/**
 * The ONE pure decision the sweep makes. Rules evaluate top-down, first match
 * wins — this exact order is the spec:
 *   1. released/failed             -> terminal (never fires again)
 *   2. tier "private"              -> release (observed in the private org = the move landed)
 *   3. no destination, past plan   -> release (free/trial: nothing to move, NEVER a failure)
 *   4. elapsed < 5 min             -> wait
 *   5. hide not done               -> hide
 *   6. elapsed < 10 min            -> wait
 *   7. stay-on not done            -> stay_on (cannot fire before hide is done)
 *   8. elapsed >= 35 min ceiling   -> fail (past the plan AND its grace, still public)
 *   9. otherwise                   -> wait (this is the 20..35 overrun: still working)
 *
 * Grace, not a deadline (rule 9): the 20-minute window is the PLAN. A device
 * still public at 20 is NOT released and NOT failed — it keeps its row, keeps
 * being retried by Vantra's own poller, and the UI says so (`overrun`). Only
 * the 35-minute ceiling turns that into a terminal `failed`.
 *
 * Offline is not a failure either: a due stage whose device is not reachable
 * returns its action anyway, and the CALLER skips without burning an attempt
 * (see the sweep) — so an offline box retries on every cycle until the box
 * comes back, which is what the owner asked for.
 *
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
    /** Null for a free/trial account — the move will never happen. */
    destinationOrgId?: string | null;
  },
  nowMs: number,
): OnboardingAction {
  if (input.status === "released" || input.status === "failed") return "terminal";
  if (input.tier === "private") return "release";
  const elapsedMs = nowMs - input.timerStartedAt.getTime();
  // Free/trial: nothing is going to move, so the window ends as a clean release
  // with the device public. Nothing is hidden for a move that can never happen.
  if (input.destinationOrgId === null && elapsedMs >= ONBOARDING_WINDOW_MINUTES * MINUTE_MS) {
    return "release";
  }
  if (elapsedMs < ONBOARDING_HIDE_MINUTES * MINUTE_MS) return "wait";
  if (!input.hideDoneAt) return "hide";
  if (elapsedMs < ONBOARDING_STAY_ON_MINUTES * MINUTE_MS) return "wait";
  if (!input.stayOnDoneAt) return "stay_on";
  if (elapsedMs >= ONBOARDING_CEILING_MINUTES * MINUTE_MS) return "fail";
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
  /** ms left in the 20-minute PLAN (never negative; 0 while `overrun`). */
  remainingMs: number;
  /** ms since timerStartedAt (for "the next device starts in ~N min"). */
  elapsedMs: number;
  /** The coming stage for the "next:" part of the strip; null on step 4. */
  next: string | null;
  /**
   * ms until the next stage is DUE (hide/stay-on/move). Null once every stage
   * is behind us — the strip then falls back to the window/overrun wording.
   * This is the honest number to show, because it is the next thing that will
   * actually happen, not the end of the plan.
   */
  nextStageInMs: number | null;
  /** True when the current stage is due but the device has not been seen. */
  waitingForDevice: boolean;
  /**
   * Past the 20-minute plan and still public — NOT a failure. The owner's rule:
   * a device that exceeds the plan just gets "a little wait", so the row stays
   * live and keeps retrying until the ceiling.
   */
  overrun: boolean;
  /** Terminal failure — the row keeps a red badge and a page alert, never silent. */
  failed: boolean;
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
  const failed = row.status === "failed";
  // Past the plan, still public, still live — the "little wait" state.
  const overrun = !terminalOrPrivate && elapsedMs >= ONBOARDING_WINDOW_MINUTES * MINUTE_MS;
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
      destinationOrgId: row.destinationOrgId,
    },
    nowMs,
  );
  const waitingForDevice = (action === "hide" || action === "stay_on") && !row.isOnline;
  // The next stage threshold still ahead of us, if any (never for a terminal row).
  const stageMarks = [
    ONBOARDING_HIDE_MINUTES,
    ONBOARDING_STAY_ON_MINUTES,
    ONBOARDING_MOVE_MINUTES,
  ];
  const nextMark = stageMarks.find((m) => m * MINUTE_MS > elapsedMs);
  const nextStageInMs = terminalOrPrivate || nextMark === undefined ? null : nextMark * MINUTE_MS - elapsedMs;

  if (step === 1) {
    return {
      step: 1,
      title: "Quarantined",
      detail: "waiting for the first check-in",
      remainingMs,
      elapsedMs,
      next: "hide",
      nextStageInMs,
      waitingForDevice,
      overrun,
      failed,
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
      nextStageInMs,
      waitingForDevice,
      overrun,
      failed,
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
      nextStageInMs,
      waitingForDevice,
      overrun,
      failed,
    };
  }
  return {
    step: 4,
    title: failed ? "Setup didn't finish" : "Moving to your private agent",
    detail: failed
      ? "still on your public agent — you can keep using it"
      : row.destinationOrgId
        ? overrun
          ? "taking a little longer than usual — still working, nothing is lost"
          : "almost done"
        : "stays on your public agent — no private agent on this plan",
    remainingMs,
    elapsedMs,
    next: null,
    nextStageInMs,
    waitingForDevice,
    overrun,
    failed,
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

/**
 * The ONE clock string for a running window — shared by the Devices strip and
 * the console card so the two can never disagree. It never promises an exact
 * time: a blocked stage says it is waiting, and a window past the plan says so
 * instead of counting up from zero.
 */
export function onboardingClockText(view: OnboardingView): string {
  if (view.failed) return "stopped";
  if (view.waitingForDevice) return "waiting for the device";
  if (view.overrun) return "taking a little longer than usual";
  if (view.nextStageInMs !== null) return formatOnboardingEta(view.nextStageInMs);
  return formatOnboardingCountdown(view.remainingMs);
}

/**
 * The row pill ("Quarantine · 12:30"). Null when there is nothing to say.
 * `failed` is deliberately NOT null: the owner's rule is that no device may
 * fail silently, so a device that never moved keeps a red label instead of
 * quietly reverting to a bare `Public`.
 */
export function onboardingRowLabel(
  row: { status: string; timerStartedAt: string | Date },
  nowMs: number,
): string | null {
  if (row.status === "failed") return "Setup failed";
  if (isOnboardingTerminal(row.status)) return null;
  const startedMs = (toDate(row.timerStartedAt) ?? new Date(nowMs)).getTime();
  const elapsedMs = nowMs - startedMs;
  if (elapsedMs >= ONBOARDING_WINDOW_MINUTES * MINUTE_MS) return "Quarantine · taking longer";
  const leftMs = Math.max(0, ONBOARDING_WINDOW_MINUTES * MINUTE_MS - elapsedMs);
  const totalSeconds = Math.round(leftMs / 1000);
  return `Quarantine · ${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, "0")}`;
}
