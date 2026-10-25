// TASK_242 — client-safe presentation rules for the clone-setup card.
//
// WHY THIS EXISTS: the card's red headline (`setupErr`) is only reset when a
// NEW setup starts, so a transient dispatch failure — "This device is currently
// offline." — stayed on screen forever, next to a green/ready card, after the
// device was provably online again. That is the "it says offline while the PC
// is up" report: the machine never went off, one command blipped.
//
// Keep this module free of `server-only` / node imports: it is imported by the
// client component. Pure functions only, so the rule is unit-tested directly.

/** Does an error headline claim the DEVICE is offline (rather than a step failing)? */
export function isOfflineHeadline(err: string): boolean {
  return /offline/i.test(err);
}

/**
 * The error line to show after a fresh status read.
 *
 * A fresh `online === true` read PROVES an "offline" headline is stale — the
 * condition that produced it is gone — so it must be dropped. Every other
 * error is kept: "setup_already_running" or a bundle problem is still true
 * whether or not the PC is online, and hiding it would lose the fixable reason.
 */
export function staleOfflineErrCleared(online: boolean, prev: string): string {
  return online && isOfflineHeadline(prev) ? "" : prev;
}
