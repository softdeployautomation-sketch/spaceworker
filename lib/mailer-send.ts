import "server-only";
import nodemailer, { type Transporter } from "nodemailer";
import { decryptSecret } from "./mailbox-crypto";
import { validatePublicSmtpHost } from "./smtp-host-guard";

export interface TransporterMailbox {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  encryptedPassword: string;
  passwordIv: string;
  passwordTag: string;
  // Task 30, item 4 — the addresses to send AS. Empty/absent [] means "same as
  // username" — normal for every non-relay mailbox. Populated for a relay like
  // Resend (fixed SMTP login, specific send addresses). For the mail-queue drain,
  // each queued item's resolvedFromAddress (chosen from this array at queue-build
  // time) takes precedence; this is the fallback used by one-shot test sends.
  fromAddresses?: string[];
  // Task 26, Piece 5a — explicit opt-in to NO TLS (self-hosted/internal relays on
  // port 25 that genuinely don't support encryption). Default false; see the big
  // comment on transporterForMailbox below for why a separate flag (not the port)
  // is how "user really wants unencrypted" is represented.
  allowInsecure?: boolean;
}

export interface SmtpTransportOptions {
  host: string;
  port: number;
  username: string;
  password: string;
  // Task 26, Piece 5a — the ONLY way to disable enforced TLS. See the
  // transporterForMailbox comment above; this exists for self-hosted/internal
  // relays that genuinely don't speak any TLS (port 25 "None" mode).
  allowInsecure?: boolean;
}

/**
 * Build a nodemailer SMTP transport from raw connection options — the shared
 * single source of truth for correct TLS negotiation. Used for BOTH stored
 * mailboxes (transporterForMailbox below) and the pre-save "Test connection"
 * button (app/api/mailboxes/test-connection/route.ts), whose inputs are raw
 * form values, not yet persisted / encrypted. Keeping the logic in this one
 * helper means the test the user gets before saving is byte-identical to the
 * connection a real send will use.
 *
 * `secure` here is deliberately NOT taken from any stored checkbox value.
 * Confirmed live: a real Brevo SMTP relay account (smtp-relay.brevo.com:587)
 * failed with "SSL routines: tls_validate_record_header:wrong version number"
 * -- the classic symptom of sending a TLS ClientHello to a server that expects
 * a plaintext SMTP greeting first. Nodemailer's `secure: true` means IMPLICIT
 * TLS (the connection is TLS from the first byte) -- correct ONLY for port
 * 465. Port 587 (what Brevo, Gmail, and most providers actually use) is
 * STARTTLS: the client connects in plaintext, then explicitly upgrades via the
 * STARTTLS command. The old single "Use TLS" checkbox defaulting to checked
 * meant EVERY mailbox added on port 587 was silently attempting the wrong
 * handshake style. The fix is universal SMTP convention, not a per-provider
 * special case: port 465 => implicit TLS; everything else => STARTTLS,
 * enforced (not merely opportunistic) via `requireTLS` so a misconfigured
 * server fails loudly instead of silently sending credentials in plaintext.
 * The one deliberate exception is allowInsecure (the explicit "None" mode),
 * which relaxes requireTLS for genuinely unencrypted internal relays.
 */
export function buildSmtpTransport(opts: SmtpTransportOptions): Transporter {
  const implicitTls = opts.port === 465;
  return nodemailer.createTransport({
    host: opts.host,
    port: opts.port,
    secure: implicitTls,
    requireTLS: !implicitTls && !opts.allowInsecure,
    auth: { user: opts.username, pass: opts.password },
  });
}

export async function transporterForMailbox(mailbox: TransporterMailbox): Promise<Transporter> {
  // Task 51 — guard the REAL send path too, not just save/test time. Save-time
  // validation (app/api/mailboxes/route.ts) stops NEW private-IP mailboxes from
  // being stored, but a mailbox saved before the fix could otherwise drive an
  // outbound connection straight at an internal address. Resolve + validate the
  // host here before building any transport, then connect.
  await validatePublicSmtpHost(mailbox.host);
  const password = decryptSecret(
    mailbox.encryptedPassword,
    mailbox.passwordIv,
    mailbox.passwordTag
  );
  return buildSmtpTransport({
    host: mailbox.host,
    port: mailbox.port,
    username: mailbox.username,
    password,
    allowInsecure: mailbox.allowInsecure,
  });
}