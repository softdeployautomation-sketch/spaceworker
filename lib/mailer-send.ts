import "server-only";
import nodemailer, { type Transporter } from "nodemailer";
import { decryptSecret } from "./mailbox-crypto";

export interface TransporterMailbox {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  encryptedPassword: string;
  passwordIv: string;
  passwordTag: string;
  // The address to actually send AS. null/undefined means "same as username" —
  // normal for every non-relay mailbox. Set it for a relay like Resend, where the
  // SMTP login is a fixed account but mail is sent as a specific address.
  fromAddress?: string | null;
}

/**
 * Build a nodemailer SMTP transport from a stored (encrypted) mailbox row.
 * Shared by the mail-queue drain, the test-send-confirm route, AND the
 * mailbox "Test" button route so none of the three sending/verifying paths
 * can drift from each other or from correct TLS negotiation.
 *
 * `secure` here is deliberately NOT taken from the stored `mailbox.secure`
 * checkbox value. Confirmed live: a real Brevo SMTP relay account
 * (smtp-relay.brevo.com:587) failed with "SSL routines:
 * tls_validate_record_header:wrong version number" -- the classic symptom of
 * sending a TLS ClientHello to a server that expects a plaintext SMTP
 * greeting first. Nodemailer's `secure: true` means IMPLICIT TLS (the
 * connection is TLS from the first byte) -- correct ONLY for port 465. Port
 * 587 (what Brevo, Gmail, and most providers actually use) is STARTTLS: the
 * client connects in plaintext, then explicitly upgrades via the STARTTLS
 * command. The "Use TLS" checkbox defaulting to checked meant EVERY mailbox
 * added on port 587 was silently attempting the wrong handshake style,
 * regardless of what the user selected -- this wasn't specific to Brevo, it
 * would misfire for any provider a user points at 587 or 25 the same way.
 * The fix is universal SMTP convention, not a per-provider special case:
 * port 465 => implicit TLS; everything else => STARTTLS, enforced (not
 * merely opportunistic) via `requireTLS` so a misconfigured server fails
 * loudly instead of silently sending credentials in plaintext.
 */
export function transporterForMailbox(mailbox: TransporterMailbox): Transporter {
  const password = decryptSecret(
    mailbox.encryptedPassword,
    mailbox.passwordIv,
    mailbox.passwordTag
  );
  const implicitTls = mailbox.port === 465;
  return nodemailer.createTransport({
    host: mailbox.host,
    port: mailbox.port,
    secure: implicitTls,
    requireTLS: !implicitTls,
    auth: { user: mailbox.username, pass: password },
  });
}