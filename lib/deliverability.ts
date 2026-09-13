import "server-only";
import { prisma } from "@/lib/prisma";
import { transporterForMailbox, type TransporterMailbox } from "./mailer-send";
import { decryptSecret } from "./mailbox-crypto";
import { pollSeedMailbox } from "./imap";
import { resolveSeedMailbox } from "./seed-mailbox";
import { renderMerge } from "./render-merge";
import { randomBytes } from "crypto";

export type DeliverabilityOutcome = "delivered" | "failed";

export interface SeedMailboxRow extends TransporterMailbox {
  id: string;
  secure: boolean;
}

// A single 20s-then-check was confirmed live (2026-09-13) to be too short:
// Gmail's spam classification can take well longer than that to actually file a
// message into [Gmail]/Spam — a real test was directly confirmed sitting in
// Spam by the user ~9 minutes after send, while our one-shot poll at 20s found
// nothing in either INBOX or Spam and reported landedIn:"unknown". Retrying
// across a longer window catches the common case (classification finishing
// within ~2 minutes) without hanging the request indefinitely; nginx's proxy
// for this app has a 3600s read timeout, so there's ample headroom to wait
// longer than 20s synchronously. A case that's still unresolved after this
// window falls through to the same landedIn:"unknown" human-check path as
// before — this raises the odds of an automated answer, it doesn't remove the
// fallback.
const POLL_INTERVAL_MS = 20_000;
const POLL_ATTEMPTS = 6; // 6 * 20s = 120s total

/**
 * Send one test message (a campaign's own template/variant) from a customer
 * mailbox to a platform-owned seed mailbox, then poll the seed mailbox via IMAP
 * to confirm the message actually landed. Records a `DeliverabilityCheck` (the
 * audit-trail mirror of this codebase's `PaymentVerificationAttempt` pattern) and
 * returns the outcome. Only a "delivered" check can unlock a real send.
 */
export async function runTestSend(opts: {
  campaignId: string;
  mailbox: TransporterMailbox;
  variant: { subject: string; bodyHtml: string };
  // Exactly one of these is provided. `seed` = a registered, IMAP-pollable
  // SeedMailbox (platform default or a user's own) — placement is verified
  // automatically. `overrideRecipient` = a plain ad-hoc address with no IMAP
  // access — the human-assisted fallback: "delivered" means the SMTP send
  // succeeded, nothing more; the human checks their own inbox before clicking
  // Confirm, and landedIn always stays "unknown" (never auto-verified "inbox"),
  // which is what keeps the batch gate pausing on every batch for this mode.
  seed?: SeedMailboxRow | null;
  overrideRecipient?: string | null;
  // Task 32 — optional explicit From address for this probe (overrides the
  // mailbox's normal fromAddresses[0] rotation). Used when a user (or an agent)
  // is live-testing an edited draft and wants to see it send as a specific From.
  from?: string;
}): Promise<{ outcome: DeliverabilityOutcome; checkId: string; landedIn: "inbox" | "spam" | "unknown"; error?: string }> {
  const since = new Date(Date.now() - 120_000); // generous window for clock skew
  const isOverride = !!opts.overrideRecipient;
  const toAddress = opts.overrideRecipient || opts.seed?.username;
  if (!toAddress) {
    return { outcome: "failed", checkId: "", landedIn: "unknown", error: "No test destination configured" };
  }
  // Unique per-test-send marker so the IMAP poll can tie a found message back to
  // exactly this send — needed because the seed mailbox is a single row shared
  // across all users, so "anything arrived" isn't proof THIS campaign delivered.
  // Override mode has no poll at all (no IMAP account to search), so the token
  // serves no purpose there and is left out of the subject entirely — the whole
  // point of testing against a human's own inbox is to see the REAL subject a
  // recipient would get, not one visibly tagged as a test.
  const token = `swtest-${randomBytes(12).toString("hex")}`;
  let sendError: string | undefined;

  try {
    const transport = transporterForMailbox(opts.mailbox);
    await transport.sendMail({
      // Task 30, item 4 — a test send is a one-shot per mailbox (no per-recipient
      // rotation has run here), so use the mailbox's first configured From
      // address (empty list => send as the SMTP username). Task 32 — an explicit
      // probe `from` override (live draft test) wins when provided.
      from: opts.from ?? (opts.mailbox.fromAddresses?.[0] || opts.mailbox.username),
      to: toAddress,
      subject: isOverride
        ? renderMerge(opts.variant.subject, {})
        : `${renderMerge(opts.variant.subject, {})} [SW test ${token}]`,
      html: renderMerge(opts.variant.bodyHtml, {}),
      headers: isOverride ? {} : { "X-SpaceWorker-Test": token },
    });
  } catch (e) {
    sendError = e instanceof Error ? e.message : "Test send failed at SMTP";
  }

  let messages: string[] = [];
  let pollError: string | undefined;
  // Task 29, item 6 — where the test message actually landed (inbox / spam /
  // unknown), passed straight through from the spam-aware IMAP poll. Stays
  // "unknown" for the whole override-recipient path — there's no mailbox to poll.
  let landedIn: "inbox" | "spam" | "unknown" = "unknown";

  if (!sendError && !isOverride && opts.seed) {
    const seedPassword = decryptSecret(
      opts.seed.encryptedPassword,
      opts.seed.passwordIv,
      opts.seed.passwordTag
    );
    for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      const poll = await pollSeedMailbox(
        {
          host: opts.seed.host,
          port: opts.seed.port,
          secure: opts.seed.secure,
          username: opts.seed.username,
          password: seedPassword,
        },
        since,
        token
      );
      messages = poll.messages;
      pollError = poll.error;
      landedIn = poll.landedIn;
      // Stop as soon as the message shows up anywhere (inbox or spam) — no need
      // to keep polling once we have a real answer. Keep retrying on "unknown"
      // (not found yet, or a transient IMAP error) until the window runs out.
      if (landedIn !== "unknown") break;
    }
  }

  // Task 29, item 6 — landing in the Spam/Junk folder must NOT count as a passed
  // gate. `found` alone is true for either INBOX or Spam (pollSeedMailbox's
  // definition), so gating on `found` would let a spam-filtered test message
  // unlock a real send. Only an INBOX landing is "delivered"; spam and unknown are
  // both "failed", exactly like "not found anywhere" was treated before this
  // feature existed — this is what keeps confirm-test's existing
  // `status !== "delivered"` check (and the campaign detail page's Confirm-button
  // gate, which reads the same field) correctly blocking on a spam result without
  // needing to change either of them.
  //
  // The one deliberate exception: override-recipient mode has no IMAP account to
  // verify placement with at all, so it trusts the human instead — a successful
  // SMTP send is "delivered" there, full stop. This still isn't a free pass on
  // sends in general: the batch gate below reads landedIn (always "unknown" in
  // this mode), not outcome, so a real send still pauses for human review on
  // every batch — only the ONE-TIME initial test-send-confirm gate treats
  // override "delivered" as enough to unlock, matching "the human already
  // looked at it and clicked Confirm."
  const outcome: DeliverabilityOutcome = isOverride
    ? (sendError ? "failed" : "delivered")
    : (!sendError && landedIn === "inbox" ? "delivered" : "failed");
  const error =
    sendError ??
    (isOverride
      ? undefined
      : landedIn === "inbox"
        ? undefined
        : landedIn === "spam"
          ? "Test message was delivered to the Spam/Junk folder, not the inbox — sending is blocked until this is resolved."
          : (pollError ?? "Message not observed in the seed mailbox within the test window"));

  const check = await prisma.deliverabilityCheck.create({
    data: {
      campaignId: opts.campaignId,
      seedMailboxId: opts.seed?.id ?? null,
      overrideRecipient: opts.overrideRecipient ?? null,
      status: outcome,
      landedIn,
      messageId: messages[0] ?? null,
      error,
      checkedAt: new Date(),
    },
  });

  return { outcome, checkId: check.id, landedIn, error };
}

/**
 * Task 29, item 6 — the batch-gate probe. After each batch a campaign drains, the
 * mail-queue drain calls this to re-verify deliverability on the campaign's test
 * mailbox (the user's own registered one, else the platform default). It sends one
 * real test message and returns where it landed ("inbox" => safe to continue the
 * next batch; "spam"/"unknown" => the drain should pause for a human). Uses the
 * campaign's first active mailbox as the sender, mirroring the manual test-send.
 */
export async function probeCampaignPlacement(opts: {
  campaignId: string;
  userId: string;
  mailboxes: TransporterMailbox[];
  subjects: string[];
  bodies: string[];
  variants?: { subject: string; bodyHtml: string }[];
  // Human-assisted fallback (see runTestSend) — when set, every batch probe
  // targets this address instead of a registered seed mailbox, and always
  // reports landedIn:"unknown", so the batch gate pauses for a human decision
  // after every batch rather than auto-continuing.
  overrideRecipient?: string | null;
}): Promise<{ outcome: DeliverabilityOutcome; landedIn: "inbox" | "spam" | "unknown"; checkId: string; error?: string }> {
  const mailbox = opts.mailboxes[0];
  if (!mailbox) return { outcome: "failed", landedIn: "unknown", checkId: "", error: "No sending mailbox available" };

  let variant: { subject: string; bodyHtml: string };
  if (opts.subjects.length > 0) {
    variant = { subject: opts.subjects[0], bodyHtml: opts.bodies.length > 0 ? opts.bodies[0] : "" };
  } else if (opts.variants && opts.variants.length > 0) {
    variant = opts.variants[0];
  } else {
    return { outcome: "failed", landedIn: "unknown", checkId: "", error: "Campaign has no content to test-send" };
  }

  if (opts.overrideRecipient) {
    const r = await runTestSend({ campaignId: opts.campaignId, mailbox, variant, overrideRecipient: opts.overrideRecipient });
    return { outcome: r.outcome, landedIn: r.landedIn, checkId: r.checkId, error: r.error };
  }

  const seed = await resolveSeedMailbox(opts.userId);
  if (!seed) {
    return { outcome: "failed", landedIn: "unknown", checkId: "", error: "No test mailbox configured" };
  }

  const r = await runTestSend({ campaignId: opts.campaignId, mailbox, variant, seed });
  return { outcome: r.outcome, landedIn: r.landedIn, checkId: r.checkId, error: r.error };
}