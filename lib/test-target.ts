// Task 144 — decide which address a campaign's deliverability tests go to.
//
// WHY THIS IS ITS OWN MODULE: this rule is one line long but it decided a real
// user-visible bug, and it needs to be testable without booting a route handler
// or a database. Before this existed, the ONLY way to set a test target was the
// `manualInsert.useAsTestTarget` flag — which *also* queued that address as a
// real recipient. A user who just wanted to eyeball tests in their own inbox
// therefore received the actual campaign as well: confirmed live 2026-09-29, one
// Comcast address got 4 tests plus 3 queue sends in four minutes, all with
// identical subject and body. Test targets and queue recipients are now
// independent, and this function is what keeps them from disagreeing.
//
// Precedence: an explicit standalone target wins. That matters because the two
// inputs can arrive together, and silently preferring the legacy nested flag
// would send tests to an address the user never typed into the new field.

/**
 * Deliberately permissive local-part/domain check — the same shape lib/mailer
 * and the test-send route already apply. It exists to reject obvious typos
 * ("you@", "you@example"), not to re-implement RFC 5322.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type TestTargetResolution =
  | { testRecipientOverride: string | null; error?: undefined }
  | { testRecipientOverride: null; error: string };

export function resolveTestTarget(input: {
  /** Task 144 — the standalone "send my tests to this inbox" field. */
  standalone?: string | null;
  /** The legacy nested manualInsert email, used only when it also opted in. */
  manualInsertEmail?: string | null;
  manualInsertUseAsTestTarget?: boolean;
}): TestTargetResolution {
  const standalone = input.standalone?.trim() ?? "";
  if (standalone) {
    // Validated here rather than trusted: this value is echoed back into
    // test-send requests as an envelope recipient.
    if (!EMAIL_RE.test(standalone)) {
      return { testRecipientOverride: null, error: "Enter a valid test email address" };
    }
    return { testRecipientOverride: standalone };
  }

  const legacy = input.manualInsertEmail?.trim() ?? "";
  if (input.manualInsertUseAsTestTarget === true && legacy) {
    // Same validation as the standalone field — the legacy path had none, so it
    // could previously store a malformed target that every test-send then failed
    // against with no explanation.
    if (!EMAIL_RE.test(legacy)) {
      return { testRecipientOverride: null, error: "Enter a valid test email address" };
    }
    return { testRecipientOverride: legacy };
  }

  return { testRecipientOverride: null };
}
