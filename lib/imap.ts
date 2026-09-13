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
  // Task 29, item 6 — where the matched test message landed:
  //   "inbox"   — found in INBOX.
  //   "spam"    — found in the Spam/Junk-equivalent folder (or the message was
  //               absent from both INBOX and a spam folder we did search, i.e.
  //               it did not reach the inbox — still treated as "not safe").
  //   "unknown" — we could not verify placement (provider exposes no spam folder,
  //               or it couldn't be selected/authenticated). Forces a human check.
  landedIn: "inbox" | "spam" | "unknown";
  messages: string[]; // best-effort Message-IDs (empty if none / unavailable)
  error?: string;
}

// Search one folder for messages since `since`, optionally filtered to those
// whose subject contains `matchToken`, returning best-effort Message-IDs.
async function searchFolderForToken(
  client: ImapFlow,
  path: string,
  since: Date,
  matchToken?: string,
): Promise<string[]> {
  const lock = await client.getMailboxLock(path);
  try {
    const uids = await client.search({ since }, { uid: true });
    if (!uids || uids.length === 0) return [];
    const messages: string[] = [];
    const fetched = client.fetch(uids, { envelope: true, uid: true });
    for await (const msg of fetched) {
      // A unique per-test-send token ties a found message back to the exact
      // test-send that triggered this check. A shared seed mailbox means "anything
      // arrived since `since`" could be someone else's test landing in the same
      // window. Requiring the token (stamped into the subject at send time) is what
      // proves THIS campaign's message actually arrived.
      if (matchToken) {
        const subject = msg.envelope?.subject ?? "";
        if (!subject.includes(matchToken)) continue;
      }
      // Best-effort identifier: the envelope's Message-ID if present, else the UID.
      const rawMid = msg.envelope?.messageId?.trim();
      messages.push(rawMid ?? `imap-uid:${msg.uid}`);
    }
    return messages;
  } finally {
    lock.release();
  }
}

// Resolve a spam-equivalent folder path, provider-generically:
//   1. Prefer the IMAP SPECIAL-USE "\Junk" flag (RFC 6154) advertised by
//      client.list() — Gmail, Outlook, and most modern providers advertise this.
//   2. Fall back to common literal folder names ("Spam", "Junk", "[Gmail]/Spam", …).
// Returns null when no spam-equivalent folder is advertised/found — the caller
// then reports landedIn:"unknown" rather than failing the whole check.
async function resolveSpamFolderPath(client: ImapFlow): Promise<string | null> {
  try {
    const mailboxes = await client.list();
    if (!mailboxes || mailboxes.length === 0) return null;

    const junk = mailboxes.find((m) => (m.specialUse ?? "").toUpperCase() === "\\JUNK");
    if (junk?.path) return junk.path;

    const fallbackRoots = ["[Gmail]/Spam", "Spam", "Junk", "Junk E-mail", "Spam Folder", "Bulk Mail"];
    const lower = (s: string) => s.toLowerCase();
    const fallback = mailboxes.find((m) => {
      const path = lower(m.path ?? "");
      const name = lower(m.name ?? "");
      return fallbackRoots.some((r) => lower(r) === path || name.endsWith(lower(r)))
        || /spam|junk|bulk mail/.test(path);
    });
    return fallback?.path ?? null;
  } catch {
    // list() failed (provider quirk) — treat as "cannot detect", not a hard error.
    return null;
  }
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

    // 1) Check INBOX first — the happy path.
    let inboxMessages: string[] = [];
    try {
      inboxMessages = await searchFolderForToken(client, "INBOX", since, matchToken);
    } catch (err) {
      return {
        found: false,
        landedIn: "unknown",
        messages: [],
        error: err instanceof Error ? err.message : "IMAP INBOX poll failed",
      };
    }
    if (inboxMessages.length > 0) return { found: true, landedIn: "inbox", messages: inboxMessages };

    // 2) Not in INBOX — hunt for the Spam/Junk-equivalent folder and check there.
    const spamPath = await resolveSpamFolderPath(client);
    if (!spamPath) {
      // Provider exposes no detectable spam folder — we cannot confirm placement.
      return { found: false, landedIn: "unknown", messages: [] };
    }
    let spamMessages: string[] = [];
    try {
      spamMessages = await searchFolderForToken(client, spamPath, since, matchToken);
    } catch (err) {
      // Couldn't select/authenticate the spam folder — can't verify placement.
      return {
        found: false,
        landedIn: "unknown",
        messages: [],
        error: err instanceof Error ? err.message : "IMAP spam-folder poll failed",
      };
    }
    if (spamMessages.length > 0) return { found: true, landedIn: "spam", messages: spamMessages };

    // 3) Neither INBOX nor Spam — the message wasn't observed anywhere in the window.
    return { found: false, landedIn: "unknown", messages: [] };
  } catch (err) {
    return {
      found: false,
      landedIn: "unknown",
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