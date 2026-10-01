// TASK_150 T5 — which addresses ONE manual test send fans out to.
//
// WHY THIS EXISTS. A test send could previously target exactly ONE address: the
// campaign's active `testRecipientOverride`, or a one-shot `to` string. The owner
// asked for "multiple test emails, with the choice of sending a test to all of
// them or to a selected subset" (TASK_150 §1 item 3). The address LIST already
// existed (`EmailCampaign.testRecipientPool`) and so did the shortlist UI — what
// was missing was any way to say "send this one test to all of these". Confirmed
// live in simulation 2026-09-30: passing three addresses silently sent ONE
// message, to the campaign's single active target, because a non-string `to` was
// ignored and the stored single target won.
//
// Kept as its own pure module (no prisma, no route imports) for the same reason
// lib/test-target.ts is one: the precedence rules below are user-visible and must
// be unit-testable without a database or a booted server.
//
// PRECEDENCE, highest first:
//   1. an explicit one-shot `to` — a string (one address, unchanged behaviour) or
//      an array (many). The caller is saying "send THIS test to THESE addresses",
//      so it wins over anything stored, exactly as the single-string `to` did.
//   2. the persisted multi-selection (`EmailCampaign.testRecipientSelection`) —
//      the ticked subset of the pool. It outranks the single active target,
//      because a user who ticked two boxes and pressed Send means those two.
//   3. the single active target (`testRecipientOverride`) — today's behaviour, and
//      what keeps every existing caller (and the drain's batch probe) working
//      unchanged.
//   4. nothing -> the caller falls back to the seed-mailbox path.
//
// An EMPTY selection is treated as "not set", never as "send to nobody": a
// campaign whose selection was never touched behaves exactly as it did before.

/** Mirrors the cap the test-recipient route already enforces on the pool. */
export const MAX_TEST_SEND_RECIPIENTS = 20;

/**
 * Deliberately light shape check — the identical one the test-recipient route
 * applies to the pool (kept here so the two can never drift). The real proof an
 * address works is the send itself, not a regex: this catches typos and stray
 * whitespace and still permits internal-only addresses like user@localhost.
 */
export function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+$/.test(value);
}

/**
 * Trim, drop blanks and non-strings, de-duplicate case-insensitively (keeping the
 * first spelling) and clamp to the cap. The same normalisation the pool already
 * went through — a one-shot array must not be able to smuggle in blanks.
 */
export function normalizeRecipientList(input: unknown, max = MAX_TEST_SEND_RECIPIENTS): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of input) {
    const value = typeof entry === "string" ? entry.trim() : "";
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= max) break;
  }
  return out;
}

export type PlannedRecipient = {
  email: string;
  /**
   * Shape-only verdict. A malformed address is NOT rejected up front: one bad
   * address must never stop the others being tested, so it is carried through and
   * reported (and recorded) as its own failure — see the route's fan-out.
   */
  valid: boolean;
};

export type TestSendPlan =
  | { mode: "seed" }
  | { mode: "override"; recipients: PlannedRecipient[] }
  | { mode: "error"; error: string; status: number };

export function planTestSendRecipients(input: {
  /** The request's one-shot `to`: a string, an array, or absent. */
  to?: unknown;
  /** EmailCampaign.testRecipientSelection — the persisted ticked subset. */
  selection?: unknown;
  /** EmailCampaign.testRecipientOverride — the persisted single active target. */
  active?: string | null;
}): TestSendPlan {
  const { to } = input;

  if (typeof to === "string") {
    const email = to.trim();
    // A blank string means "no override passed", which is exactly what the route
    // itself passed before this existed (its local default was "").
    if (email) {
      if (!looksLikeEmail(email)) {
        return { mode: "error", error: "Enter a valid test email address", status: 400 };
      }
      return { mode: "override", recipients: [{ email, valid: true }] };
    }
  } else if (Array.isArray(to)) {
    const emails = normalizeRecipientList(to);
    if (emails.length === 0) {
      // Never fall through to the stored target: an array the caller built and we
      // ignored is precisely the silent-wrong-recipient bug this feature removes.
      return { mode: "error", error: "Provide at least one test address", status: 400 };
    }
    return {
      mode: "override",
      recipients: emails.map((email) => ({ email, valid: looksLikeEmail(email) })),
    };
  } else if (to !== undefined && to !== null) {
    // A number/object was silently ignored before (and the stored target won);
    // say so instead of sending somewhere the caller did not ask for.
    return {
      mode: "error",
      error: "`to` must be an email address or an array of email addresses",
      status: 400,
    };
  }

  const selected = normalizeRecipientList(input.selection);
  if (selected.length > 0) {
    return {
      mode: "override",
      recipients: selected.map((email) => ({ email, valid: looksLikeEmail(email) })),
    };
  }

  const active = typeof input.active === "string" ? input.active.trim() : "";
  if (active) {
    return { mode: "override", recipients: [{ email: active, valid: looksLikeEmail(active) }] };
  }

  return { mode: "seed" };
}
