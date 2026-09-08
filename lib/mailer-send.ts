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
 * Shared by the mail-queue drain and the test-send-confirm route so the two
 * sending paths can never drift.
 */
export function transporterForMailbox(mailbox: TransporterMailbox): Transporter {
  const password = decryptSecret(
    mailbox.encryptedPassword,
    mailbox.passwordIv,
    mailbox.passwordTag
  );
  return nodemailer.createTransport({
    host: mailbox.host,
    port: mailbox.port,
    secure: mailbox.secure,
    auth: { user: mailbox.username, pass: password },
  });
}