/**
 * SMTP provider quick-fill presets.
 *
 * WHY THIS IS DATA IN `lib/` AND NOT INSIDE THE COMPONENT: the whole value of a
 * preset is that it fills host + port + security TOGETHER. A preset with a host
 * but the wrong port is worse than no preset at all — it looks authoritative
 * while producing a connection the provider will never answer, which is exactly
 * the "Test connection sits on Testing… for two minutes" failure this codebase
 * has already been bitten by. Keeping the table as pure data outside the React
 * component makes that property something a test can pin (see
 * tests/smtp-provider-presets.test.ts) instead of something a reviewer has to
 * notice.
 *
 * The endpoints below are each provider's PUBLISHED submission endpoint, with
 * the handshake that provider actually offers:
 *   - 587 + STARTTLS is the submission standard (plaintext first, then upgrade).
 *   - 465 + implicit TLS is TLS from the first byte.
 * Both are correct; the send path keys off the PORT (lib/mailer-send.ts: 465 =>
 * implicit TLS, anything else => STARTTLS) — never off the label — so a preset
 * MUST set the port that matches its chosen handshake or the form will honestly
 * report a mismatch to the user.
 *
 * NO COMMERCIAL PRESET MAY USE `none` (unencrypted). That mode is the combination
 * behind the original incident: a relay that advertises no AUTH accepts the message
 * and drops it, while every connection test looks green. Commercial providers
 * always offer TLS, so offering "unencrypted" for one would only invite that bug
 * back. The single exception is the `internal: true` entry for the relay this
 * platform runs on its own machine — that one is loopback-only, so nothing off-box
 * can reach it, which makes "none" the right answer rather than a mistake.
 * `internal` exists so that exemption stays exactly one entry wide.
 */

export type PresetSecurityMode = "starttls" | "implicit" | "none";

export interface ProviderPreset {
  id: string;
  label: string;
  host: string;
  port: string;
  securityMode: PresetSecurityMode;
  /**
   * Set ONLY where the provider mandates a literal login instead of the user's
   * own mailbox address. Resend requires the word "resend" and SendGrid requires
   * "apikey" — neither is an address, and leaving the field empty would produce a
   * guaranteed auth failure. For every other provider the username IS the user's
   * own address, so we must not invent one.
   */
  fixedUser?: string;
  /**
   * Marks a relay that is OURS rather than a third-party provider. Two rules are
   * relaxed for these, and only these: such an entry may use `none` (it is
   * loopback-only, so nothing off-box can reach it), and its host is expected to be
   * a private address rather than a public provider endpoint. Nothing else may set
   * it, so the exemption stays one entry wide instead of spreading.
   */
  internal?: boolean;
  note: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "resend",
    label: "Resend",
    host: "smtp.resend.com",
    port: "465",
    securityMode: "implicit",
    fixedUser: "resend",
    note: "Username is the literal word \"resend\"; the password is your Resend API key (starts re_).",
  },
  {
    id: "brevo",
    label: "Brevo (Sendinblue)",
    host: "smtp-relay.brevo.com",
    port: "587",
    securityMode: "starttls",
    note: "Password is the SMTP key from Brevo → SMTP & API, not your account password.",
  },
  {
    id: "sendgrid",
    label: "SendGrid",
    host: "smtp.sendgrid.net",
    port: "587",
    securityMode: "starttls",
    fixedUser: "apikey",
    note: "Username is the literal word \"apikey\"; the password is your SendGrid API key.",
  },
  {
    id: "mailgun",
    label: "Mailgun",
    host: "smtp.mailgun.org",
    port: "587",
    securityMode: "starttls",
    note: "Login is the SMTP user shown in Mailgun → Sending → Domain settings.",
  },
  {
    id: "postmark",
    label: "Postmark",
    host: "smtp.postmarkapp.com",
    port: "587",
    securityMode: "starttls",
    note: "Username and password are both your Postmark Server API token.",
  },
  {
    id: "zoho",
    label: "Zoho Mail",
    host: "smtp.zoho.com",
    port: "465",
    securityMode: "implicit",
    note: "Use an app-specific password if 2FA is on your Zoho account.",
  },
  {
    id: "google",
    label: "Google Workspace / Gmail",
    host: "smtp.gmail.com",
    port: "587",
    securityMode: "starttls",
    note: "Requires 2-Step Verification plus an app password — a normal Google password is rejected.",
  },
  {
    id: "microsoft",
    label: "Microsoft 365 / Outlook",
    host: "smtp.office365.com",
    port: "587",
    securityMode: "starttls",
    note: "SMTP AUTH must be enabled on the mailbox by your Microsoft 365 admin.",
  },
  {
    id: "ses",
    label: "Amazon SES",
    host: "email-smtp.us-east-1.amazonaws.com",
    port: "587",
    securityMode: "starttls",
    note: "Replace us-east-1 with your SES region; login is the SMTP credential, not your AWS key.",
  },
  {
    id: "cpanel",
    label: "cPanel / shared hosting",
    host: "mail.yourdomain.com",
    port: "465",
    securityMode: "implicit",
    note: "Replace with your own domain. Create the mailbox in cPanel → Email Accounts first.",
  },
  {
    id: "relay",
    label: "This server's relay (local)",
    host: "127.0.0.1",
    port: "587",
    securityMode: "none",
    internal: true,
    // No fixedUser on purpose: the relay's login realm is whatever the operator set
    // when they installed it, so inventing a username here would produce a certain
    // auth failure on anyone else's deployment. The note tells the user what to ask
    // for instead, which is the only correct answer.
    note:
      "SpaceWorker's own relay on this machine — mail leaves from this server's IP, " +
      "so no provider account and no third-party server are involved. The username " +
      "and password are NOT your provider's: whoever installed the relay set them " +
      "(they are stored hashed in /etc/sasldb2). Port 587 with no encryption is " +
      "correct here because the relay only listens on loopback. If this host is " +
      "refused, the operator has not allowlisted it (SMTP_INTERNAL_RELAY_HOSTS).",
  },
];

/** The preset that fills a given host, if any. Used to keep the label honest. */
export function presetForHost(host: string): ProviderPreset | null {
  const normalized = host.trim().toLowerCase();
  if (!normalized) return null;
  return PROVIDER_PRESETS.find((p) => p.host.toLowerCase() === normalized) ?? null;
}
