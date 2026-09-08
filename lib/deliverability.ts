import "server-only";
import { prisma } from "@/lib/prisma";
import { transporterForMailbox, type TransporterMailbox } from "./mailer-send";
import { decryptSecret } from "./mailbox-crypto";
import { pollSeedMailbox } from "./imap";
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
}): Promise<{ outcome: DeliverabilityOutcome; checkId: string; error?: string }> {
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

  let found = false;
  let messages: string[] = [];
  let pollError: string | undefined;

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
    found = poll.found;
    messages = poll.messages;
    pollError = poll.error;
  }

  const outcome: DeliverabilityOutcome = !sendError && found ? "delivered" : "failed";
  const error =
    sendError ??
    (found ? undefined : (pollError ?? "Message not observed in the seed mailbox within the test window"));

  const check = await prisma.deliverabilityCheck.create({
    data: {
      campaignId: opts.campaignId,
      seedMailboxId: opts.seed.id,
      status: outcome,
      messageId: messages[0] ?? null,
      error,
      checkedAt: new Date(),
    },
  });

  return { outcome, checkId: check.id, error };
}