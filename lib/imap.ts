import "server-only";
import { ImapFlow } from "imapflow";

/**
 * IMAP deliverability poll for the Mailer's test-send-confirm gate.
 *
 * After SpaceWorker sends a test message from a customer mailbox to a
 * platform-owned SeedMailbox, this polls the seed mailbox via IMAP to confirm the
 * message actually arrived (nodemailer's `verify()` only proves the SMTP
 * handshake, not that the message lands anywhere). We use imapflow: it's actively
 * maintained, Promise-first, and handles modern providers' quirks better than the
 * older node-imap (which is effectively in maintenance mode).
 *
 * The seed mailbox is a single row shared across all users, so "any message
 * received since `since`" is NOT enough to prove a specific campaign delivered —
 * another user's test landing in the same inbox could masquerade as this one.
 * Each test-send therefore stamps a unique token into the subject and a custom
 * `X-SpaceWorker-Test` header; `matchToken` must match before a message counts as
 * found. Message-IDs (of matched messages) are captured for the DeliverabilityCheck
 * audit trail.
 */

export interface ImapConnectionConfig {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
}

export interface ImapPollResult {
  found: boolean;
  messages: string[]; // best-effort Message-IDs (empty if none / unavailable)
  error?: string;
}

export async function pollSeedMailbox(
  config: ImapConnectionConfig,
  since: Date,
  matchToken?: string
): Promise<ImapPollResult> {
  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.username, pass: config.password },
    // The seed mailbox is ops-owned with a handful of messages — no need for an
    // aggressive reconnect policy; fail the poll fast and surface the result.
    logger: false,
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      const uids = await client.search({ since }, { uid: true });
      if (!uids || uids.length === 0) return { found: false, messages: [] };
      const messages: string[] = [];
      const fetched = client.fetch(uids, { envelope: true, uid: true });
      for await (const msg of fetched) {
        // A unique per-test-send token ties a found message back to the exact
        // test-send that triggered this check. The seed mailbox is a single row
        // shared across all users, so "anything arrived since `since`" could be
        // someone else's test landing in the same window. Requiring the token
        // (stamped into the subject line at send time) is what proves THIS
        // campaign's message actually arrived.
        if (matchToken) {
          const subject = msg.envelope?.subject ?? "";
          if (!subject.includes(matchToken)) continue;
        }
        // Best-effort identifier: the envelope's Message-ID if present, else the
        // UID. Only messages matching the token (if any) land here.
        const rawMid = msg.envelope?.messageId?.trim();
        messages.push(rawMid ?? `imap-uid:${msg.uid}`);
      }
      return { found: messages.length > 0, messages };
    } finally {
      lock.release();
    }
  } catch (err) {
    return {
      found: false,
      messages: [],
      error: err instanceof Error ? err.message : "IMAP poll failed",
    };
  } finally {
    try {
      await client.logout();
    } catch {
      // Best-effort teardown.
    }
  }
}