// TASK_226 — pure helpers behind the campaign "stall visibility" UI.
//
// WHY THIS EXISTS: a campaign that stops moving used to show nothing but
// "sending" — the only place answers lived was the drain journal on the box
// (journalctl -u mail-queue-drain). The live incident of 2026-10-18 (Sblast1,
// 100 soft failures, 0 sent all day behind a US exit node) made that gap
// owner-facing: nobody could see WHY nothing was going out.
//
// Everything here is deliberately pure and import-free so the status→copy
// mapping, the exit-node region labels, and the failure-grouping/serialization
// can be unit-tested with zero stubbing (HOW_WE_MOVE_FAST §4). The API route
// (app/api/campaigns/[id]/stall-info/route.ts) does the fetching and calls
// buildStallPayload; the campaign page renders the result. READ-ONLY
// visibility — no behavior change to the drain lives here or there.

// ---------------------------------------------------------------------------
// Status → plain-language explanation
// ---------------------------------------------------------------------------

export type StallTone = "info" | "warning" | "danger" | "quiet";

export interface StallExplanation {
  tone: StallTone;
  title: string;
  message: string;
}

export interface StallStatusContext {
  // paused_deliverability + testRecipientOverride set — a batch boundary in
  // manual test mode (the owner's TURN, not a failed check — TASK_150 T3).
  manualBoundary: boolean;
  // Any test recipient override active on this campaign.
  testOverrideActive: boolean;
}

// Maps a campaign status to the plain-language "why isn't anything moving"
// explanation rendered in the stall banner. Returns null for statuses where
// nothing is expected to move on its own (draft / done / stopped) — the
// banner renders nothing rather than restating the badge.
//
// The 60s/50-item figures are the drain's real operational shape (systemd
// timer, ≤50 items/tick — see app/api/internal/mail-queue-drain/route.ts):
// a user staring at a frozen-looking page needs to know the queue IS checked
// on a schedule, and that "checked but parked" is a normal state.
export function stallExplanation(status: string, ctx: StallStatusContext): StallExplanation | null {
  switch (status) {
    case "pending_test_confirm":
      return {
        tone: "info",
        title: "Waiting for your test confirmation",
        message:
          "Waiting for you to confirm the test email before the full send starts. Nothing sends until that step passes.",
      };
    case "paused_deliverability":
      return ctx.manualBoundary
        ? {
            // Manual test mode: the boundary is the owner's turn, never a
            // failure framing (TASK_150 T3). "Checkpoint" language so a pause
            // here doesn't read as a stall.
            tone: "warning",
            title: "Paused at a checkpoint — your turn",
            message:
              "Paused at a 50-recipient checkpoint — click resume to continue (by design while test recipients are active). " +
              "The queue drains every 60s; nothing sends while paused.",
          }
        : {
            tone: "danger",
            title: "Paused — waiting for you",
            message:
              "Paused: waiting for your resume. The queue drains every 60s; nothing sends while paused.",
          };
    case "paused_manual":
      return {
        tone: "quiet",
        title: "Paused by you",
        message:
          "You paused this campaign. The queue drains every 60s; nothing sends until you resume.",
      };
    case "sending":
      return ctx.testOverrideActive
        ? {
            // The test-override hint (§3.4) folded into the sending copy: a
            // pause at a 50-boundary in this mode is EXPECTED, not a stall.
            tone: "info",
            title: "Sending — with confirmation checkpoints",
            message:
              "Sending. While a test recipient is active, sends pause at every 50-recipient checkpoint for your " +
              "confirmation — a pause at a boundary is expected, not a failure.",
          }
        : {
            tone: "info",
            title: "Sending",
            message:
              "Sending. The queue drains every 60 seconds (up to 50 items per tick); temporary failures retry " +
              "automatically with backoff.",
          };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Send-region labels (the exact field that caused the 2026-10-18 stall)
// ---------------------------------------------------------------------------

// Static label map mirroring lib/exit-nodes.ts's registered metadata (us/ca/uk).
// Deliberately NOT imported from there: that module resolves live endpoints
// from env at load time, and the UI only needs the human label. An unregistered
// region still renders honestly (naming the region) instead of hiding it.
const EXIT_NODE_LABELS: Record<string, string> = {
  us: "US exit node (New York)",
  ca: "Canada exit node (Toronto)",
  uk: "UK exit node (London)",
};

// "direct from server" vs "via US exit node (New York)" — the rendering of
// Mailbox.sendRegion. null/empty = direct (the default and the state that
// fixed the live stall). Never returns an empty string so the UI always

// ---------------------------------------------------------------------------
// Failure grouping
// ---------------------------------------------------------------------------

export interface StallFailureRow {
  error: string;
  category: string | null;
  // true = the item went back to "queued" with a nextAttemptAt backoff window
  // (soft_bounce/rate_limited); false = terminal (hard_bounce/auth_failed/other).
  retryable: boolean;
}

export interface StallFailureGroup {
  error: string;
  category: string | null;
  count: number;
  retryable: boolean;
}

const MAX_ERROR_TEXT = 160;

// Groups raw per-item failures into "N × same error" rows, biggest bucket
// first. A group is retryable if ANY member is (one message that mostly
// hard-bounced but soft-bounced a few times still deserves the "will retry"
// hint for the retrying subset — the count shown is the whole group, so
// claiming "will not retry" would be wrong for those rows). Long provider
// error strings are truncated for rendering only, never at grouping time.
export function groupStallFailures(rows: StallFailureRow[], limit = 5): StallFailureGroup[] {
  const byError = new Map<string, StallFailureGroup>();
  for (const row of rows) {
    const key = (row.error ?? "").trim() || "Unknown error";
    const existing = byError.get(key);
    if (existing) {
      existing.count += 1;
      existing.retryable = existing.retryable || row.retryable;
    } else {
      byError.set(key, {
        error: key,
        category: row.category,
        count: 1,
        retryable: row.retryable,
      });
    }
  }
  return [...byError.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, Math.max(1, limit))
    .map((g) => ({
      ...g,
      error: g.error.length > MAX_ERROR_TEXT ? `${g.error.slice(0, MAX_ERROR_TEXT)}…` : g.error,
    }));
}

// ---------------------------------------------------------------------------
// Payload serialization (the shape GET /api/campaigns/[id]/stall-info returns)
// ---------------------------------------------------------------------------

export interface StallCounts {
  total: number;
  queued: number;
  // Queued items carrying a nextAttemptAt backoff window — "failed but will
  // retry", deliberately counted INSIDE queued (the drain re-selects them from
  // the queued set) and surfaced separately so a retry backlog is visible.
  retryScheduled: number;
  sent: number;
  failed: number;
}

export interface StallMailboxRow {
  label: string;
  host: string;
  sendRegion: string | null;
}

export interface StallPayload {
  counts: StallCounts;
  lastSentAt: string | null;
  nextRetryAt: string | null;
  failureGroups: StallFailureGroup[];
  mailboxes: (StallMailboxRow & { regionText: string })[];
}

// Single serialization point so the no-PII guarantee (§6: NO toEmail in the
// new payload) is testable in one place — the input rows deliberately carry
// no recipient address, and this function can only echo the fields typed
// above. Tests assert the JSON round-trip never contains "toEmail".
export function buildStallPayload(input: {
  counts: StallCounts;
  lastSentAt: Date | null;
  nextRetryAt: Date | null;
  failureRows: StallFailureRow[];
  mailboxes: StallMailboxRow[];
}): StallPayload {
  return {
    counts: input.counts,
    lastSentAt: input.lastSentAt ? input.lastSentAt.toISOString() : null,
    nextRetryAt: input.nextRetryAt ? input.nextRetryAt.toISOString() : null,
    failureGroups: groupStallFailures(input.failureRows),
    mailboxes: input.mailboxes.map((m) => ({
      label: m.label,
      host: m.host,
      sendRegion: m.sendRegion,
      regionText: regionText(m.sendRegion),
    })),
  };
}
// states a path.
export function regionText(sendRegion: string | null | undefined): string {
  if (!sendRegion) return "direct from server";
  return `via ${EXIT_NODE_LABELS[sendRegion] ?? `${sendRegion} exit node`}`;
}