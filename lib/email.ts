import "server-only";

import { Resend } from "resend";

import { db } from "./db";
import { env } from "./env";
import { writeNotificationLog } from "./notification-log";

// Sentinel value used in non-production .env to allow a successful local build
// without a real Resend key. Treated as "not configured" at runtime.
export const RESEND_PLACEHOLDER = "re_local_dev_placeholder";

/**
 * Append-only audit record of a real notification send attempt (Task 8) —
 * delegated to the shared writer in lib/notification-log.ts so lib/notify.ts's
 * other channels log into the exact same table. Additive by design: a failure
 * to write the log row must never change the send outcome the caller observes.
 */
async function recordNotificationLog(entry: {
  eventType: string;
  recipient: string;
  outcome: "sent" | "failed";
  errorMessage?: string | null;
}): Promise<void> {
  try {
    // Best-effort link to the owning user — verification emails always target a
    // registered account and the recipient email is the natural key. writeNotificationLog
    // is already fully additive; the extra guard here keeps OUR lookup failure
    // from ever changing the send outcome the caller observes.
    const user = await db.user.findUnique({
      where: { email: entry.recipient },
      select: { id: true },
    });
    await writeNotificationLog({
      userId: user?.id ?? null,
      eventType: entry.eventType,
      // email.ts only ever records the email channel; cast is safe.
      channel: "email",
      recipient: entry.recipient,
      outcome: entry.outcome,
      errorMessage: entry.errorMessage ?? null,
    });
  } catch (err) {
    // Logging is strictly additive — never let it fail (or change the outcome
    // of) the actual send, which is what the caller depends on.
    console.error("Failed to write NotificationLog:", err);
  }
}

// Thin wrapper around Resend — for SpaceWorker's OWN transactional email only
// (signup/verification codes, plus an internal automation-needs-confirmation
// alert). Uses a SEPARATE Resend account/API key from Vantra's. Task 4's
// cold-outreach sending uses each customer's own SMTP and must never touch this
// account.
export async function sendEmail(opts: {
  to: string;
  subject: string;
  html: string;
  // Event type recorded on the NotificationLog audit row. Defaults to
  // "verification_code" (its original, and still most common, caller); other
  // internal senders (e.g. automation_needs_confirmation) pass their own so the
  // audit log names what actually happened instead of every row reading as a
  // verification email.
  eventType?: string;
}): Promise<void> {
  const eventType = opts.eventType ?? "verification_code";

  let outcome: "sent" | "failed" = "sent";
  let errorMessage: string | null = null;

  try {
    if (!env.resendApiKey || env.resendApiKey === RESEND_PLACEHOLDER) {
      // No real Resend key configured (e.g. local build). Fail loudly so the
      // caller can surface a helpful message, rather than leaking the raw error.
      throw new Error("RESEND_API_KEY is not configured — cannot send email");
    }
    const resend = new Resend(env.resendApiKey);
    const { error } = await resend.emails.send({
      from: env.emailFrom,
      to: [opts.to],
      subject: opts.subject,
      html: opts.html,
    });
    if (error) {
      throw new Error(`Resend error: ${error.message}`);
    }
  } catch (err) {
    outcome = "failed";
    errorMessage = err instanceof Error ? err.message : String(err);
    // Re-throw so the caller sees exactly the same behaviour it does today —
    // logging alongside must not swallow or mangle the original failure.
    throw err;
  } finally {
    await recordNotificationLog({
      eventType,
      recipient: opts.to,
      outcome,
      errorMessage,
    });
  }
}

export function verificationEmailHtml(code: string): string {
  return `<!doctype html>
<html>
  <body style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#f3f4f6;margin:0;padding:24px;">
    <div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px;border:1px solid #e5e7eb;">
      <p style="font-size:20px;font-weight:700;margin:0 0 16px;color:#111827;">Welcome to SpaceWorker</p>
      <p style="font-size:15px;line-height:1.6;color:#374151;margin:0 0 16px;">
        Your verification code is:
      </p>
      <p style="font-size:32px;font-weight:800;letter-spacing:8px;text-align:center;color:#4f46e5;margin:0 0 16px;">
        ${code}
      </p>
      <p style="font-size:13px;line-height:1.5;color:#6b7280;margin:0;">
        Enter this code on the verification screen to activate your account.
        It expires in 15 minutes. If you didn't request this, you can ignore this email.
      </p>
    </div>
  </body>
</html>`;
}

// Task 42, item 6 — the buyer's actual disclosure moment for the license term.
// Unlike the public store page (which deliberately shows only a price), this
// email must state the REAL 6-month expiry clearly, plus the honest status that
// the desktop build isn't downloadable yet.
export function exeLicenseIssuedEmailHtml(opts: {
  productName: string;
  licenseKey: string;
  expiresAt: Date;
  // Task 45 — single-use "view my license" claim link. When present (always, for
  // newly issued licenses) it lets an EXE-only buyer prove email ownership and
  // reach a narrow license_only session where they can see this key again.
  claimUrl?: string;
}): string {
  const plainDate = opts.expiresAt.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const claimSection = opts.claimUrl
    ? `<p style="font-size:14px;line-height:1.6;color:#374151;margin:0 0 16px;">
        Need to see your key again later? Open this link to view your licenses:<br/>
        <a href="${opts.claimUrl}" style="color:#4f46e5;word-break:break-all;">${opts.claimUrl}</a>
      </p>`
    : "";
  return `<!doctype html>
<html>
  <body style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#f3f4f6;margin:0;padding:24px;">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px;border:1px solid #e5e7eb;">
      <p style="font-size:20px;font-weight:700;margin:0 0 16px;color:#111827;">Your ${opts.productName} license is active</p>
      <p style="font-size:15px;line-height:1.6;color:#374151;margin:0 0 16px;">
        Thanks for your purchase. Your license key is below.
      </p>
      <p style="font-size:15px;line-height:1.6;color:#374151;margin:0 0 16px;">
        <strong style="color:#b91c1c;">Your license is valid for 6 months and expires on ${plainDate}.</strong>
        It will not renew automatically.
      </p>
      <p style="font-size:13px;line-height:1.6;color:#6b7280;margin:0 0 16px;">
        <strong>About the download:</strong> the desktop app build is not ready to download yet.
        Your key is already active and will work immediately the moment you download the app.
        We&rsquo;ll email you the download link as soon as the build is available — no need to do anything now.
      </p>
      <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:12px 16px;word-break:break-all;">
        <p style="font-size:12px;color:#6b7280;margin:0 0 6px;">Your license key</p>
        <p style="font-family:'SF Mono',Menlo,Consolas,monospace;font-size:12px;color:#111827;margin:0;">${opts.licenseKey}</p>
      </div>
      ${claimSection}
      <p style="font-size:13px;line-height:1.5;color:#6b7280;margin:12px 0 0;">
        Keep this email safe — it contains your only copy of the key.
      </p>
    </div>
  </body>
</html>`;
}