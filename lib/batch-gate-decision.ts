// TASK_150 T3 — decide what a batch boundary MEANS, before anything renders it.
//
// WHY THIS IS ITS OWN MODULE: the drain used to collapse the whole boundary into
// one boolean —
//
//     const safe = probe.landedIn === "inbox";   // app/api/internal/mail-queue-drain/route.ts
//
// — and everything else followed from `!safe`: write status "paused_deliverability"
// and notify the owner that the check "could not be verified to have reached the
// inbox". That is right for the automated seed-mailbox path, where "unknown"
// genuinely means the automated check could not confirm placement. It is WRONG for
// the human-assisted path (EmailCampaign.testRecipientOverride): there is no IMAP
// account watching an arbitrary human inbox, so lib/deliverability.ts pins
// landedIn to "unknown" by design in that mode — `probe.landedIn` can never be
// "inbox" there, so `safe` could never be true and every batch boundary was
// announced to the user as a FAILED deliverability check. The user explicitly
// asked for "use my test email"; in exchange the SMTP send succeeded and the check
// that structurally cannot run was reported as having failed. Confirmed in the
// code 2026-09-30 (TASK_150 §2.3, mechanism (a)).
//
// The fix is to name the three real outcomes separately so each gets its own copy,
// and so "manual boundary" can never be mistaken for "failed check" again. This is
// a DECISION, not a rendering: keeping it pure means the invariant
//
//     override mode resolves to human-confirm, NEVER to a failed check
//
// is pinned by a unit test rather than by re-reading a 500-line route handler.
//
// The paused STATUS VALUE is deliberately untouched: callers still write
// "paused_deliverability", so app/api/campaigns/[id]/deliverability-decision and
// the INITIAL pending_test_confirm gate keep working exactly as they do today.
// Only the naming of WHY the boundary happened changes.

/** Which mechanism the NEXT batch boundary will be judged by. */
export type TestGateMode = "auto" | "manual";

export type BatchGateLandedIn = "inbox" | "spam" | "unknown";

export type BatchGateDecision =
  // Auto-verified cleanly — send the next batch immediately, exactly as today.
  | { action: "continue"; mode: "auto" }
  // Human-assisted mode: this boundary is the owner's turn to confirm, not a
  // failure. `recipient` is where the test message went, so the copy can name it.
  | { action: "human_confirm"; mode: "manual"; recipient: string }
  // The automated check really ran and did not pass. A real pause, real reason.
  | { action: "pause_failed"; mode: "auto"; landedIn: "spam" | "unknown" };

/**
 * Classify a batch boundary. Pure — no DB, no env, no time.
 *
 * Order matters: manual mode is decided FIRST and on its own terms. It must never
 * consult `landedIn`, because `landedIn` is structurally "unknown" there and
 * reading it is precisely the bug this module exists to prevent. A blank or
 * whitespace-only override is not a mode — it falls through to the automated
 * path, so a cleared override never keeps the campaign in a manual gate the user
 * cannot see in the UI.
 */
export function decideBatchGate(input: {
  overrideRecipient?: string | null;
  landedIn: BatchGateLandedIn;
}): BatchGateDecision {
  const recipient = input.overrideRecipient?.trim();
  if (recipient) return { action: "human_confirm", mode: "manual", recipient };
  if (input.landedIn === "inbox") return { action: "continue", mode: "auto" };
  return { action: "pause_failed", mode: "auto", landedIn: input.landedIn };
}
