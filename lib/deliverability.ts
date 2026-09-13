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

// Delay between the SMTP send and the IMAP poll. Provider delivery isn't instant;
// this needs to be long enough to be meaningful but short enough that the manual
// confirm flow doesn't hang a request. We deliberately don't add retries here —
// a failed poll is surfaced to the user and they can re-run the test.
const TEST_CONFIRM_DELAY_MS = 20_000;

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
  seed: SeedMailboxRow;
}): Promise<{ outcome: DeliverabilityOutcome; checkId: string; landedIn: "inbox" | "spam" | "unknown"; error?: string }> {
  const since = new Date(Date.now() - 120_000); // generous window for clock skew
  // Unique per-test-send marker so the IMAP poll can tie a found message back to
  // exactly this send. The seed mailbox is a single row shared across all users,
  // so "anything arrived" is not proof THIS campaign delivered — the token is.
  const token = `swtest-${randomBytes(12).toString("hex")}`;
  let sendError: string | undefined;

  try {
    const transport = transporterForMailbox(opts.mailbox);
    await transport.sendMail({
      from: opts.mailbox.fromAddress || opts.mailbox.username,
      to: opts.seed.username,
      subject: `${renderMerge(opts.variant.subject, {})} [SW test ${token}]`,
      html: renderMerge(opts.variant.bodyHtml, {}),
      headers: { "X-SpaceWorker-Test": token },
    });
  } catch (e) {
    sendError = e instanceof Error ? e.message : "Test send failed at SMTP";
  }

  await new Promise((r) => setTimeout(r, TEST_CONFIRM_DELAY_MS));

  let messages: string[] = [];
  let pollError: string | undefined;
  // Task 29, item 6 — where the test message actually landed (inbox / spam /
  // unknown), passed straight through from the spam-aware IMAP poll.
  let landedIn: "inbox" | "spam" | "unknown" = "unknown";

  if (!sendError) {
    const seedPassword = decryptSecret(
      opts.seed.encryptedPassword,
      opts.seed.passwordIv,
      opts.seed.passwordTag
    );
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
  const outcome: DeliverabilityOutcome = !sendError && landedIn === "inbox" ? "delivered" : "failed";
  const error =
    sendError ??
    (landedIn === "inbox"
      ? undefined
      : landedIn === "spam"
        ? "Test message was delivered to the Spam/Junk folder, not the inbox — sending is blocked until this is resolved."
        : (pollError ?? "Message not observed in the seed mailbox within the test window"));

  const check = await prisma.deliverabilityCheck.create({
    data: {
      campaignId: opts.campaignId,
      seedMailboxId: opts.seed.id,
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

  const seed = await resolveSeedMailbox(opts.userId);
  if (!seed) {
    return { outcome: "failed", landedIn: "unknown", checkId: "", error: "No test mailbox configured" };
  }

  const r = await runTestSend({ campaignId: opts.campaignId, mailbox, variant, seed });
  return { outcome: r.outcome, landedIn: r.landedIn, checkId: r.checkId, error: r.error };
}