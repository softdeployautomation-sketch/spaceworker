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
// Tier 1 trial — the "you're on Tier 1" welcome/upgrade notice sent (a) to every
// existing free account bumped in the backfill and (b) at every new signup.
// `verified` switches the call-to-action: unverified accounts are told to verify
// first (that's their gate to actually reach the dashboard), verified ones can
// start immediately. Free-form starting copy — adjust at the marketing layer.
export function tier1UpgradeEmailHtml(opts: { verified: boolean }): string {
  const actionLine = opts.verified
    ? `<p style="font-size:15px;line-height:1.6;color:#374151;margin:0 0 16px;">Verify you're set up and just log in — no card, no setup fee.</p>`
    : `<p style="font-size:15px;line-height:1.6;color:#374151;margin:0 0 16px;">First, verify your email address — it takes a minute and unlocks everything below.</p>`;
  return `<!doctype html>
<html>
  <body style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#f3f4f6;margin:0;padding:24px;">
    <div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px;border:1px solid #e5e7eb;">
      <p style="font-size:20px;font-weight:700;margin:0 0 16px;color:#111827;">You're on Tier 1 — try SpaceWorker free</p>
      <p style="font-size:15px;line-height:1.6;color:#374151;margin:0 0 16px;">
        You've been upgraded to Tier 1. That gets you <strong>15 minutes a day on every tool, free</strong> — no card required.
      </p>
      ${actionLine}
      <p style="font-size:14px;line-height:1.6;color:#374151;margin:0 0 16px;">
        Want unlimited access and top priority in the queue? Upgrade to Premium.
      </p>
      <p style="font-size:12px;line-height:1.5;color:#6b7280;margin:0;">
        Tier 1 trial usage has no effect on Premium accounts, and Premium work is always prioritized over trial work in the queue.
      </p>
    </div>
  </body>
</html>`;
}
// Unlike the public store page (which deliberately shows only a price), this
// email must state the REAL 6-month expiry clearly, plus the honest status that
// the desktop build isn't downloadable yet.
//
// Task 47 — the key issued at checkout is a PURCHASE REFERENCE, not an
// activation key. The email must not read as "enter this in the app" — an unbound
// key can't be used by the EXE (the activation route now rejects it). The real
// activation key comes from claiming the license to a device (admin tool or the
// buyer's own Licenses page via `claimUrl`).
export function exeLicenseIssuedEmailHtml(opts: {
  productName: string;
  licenseKey: string;
  expiresAt: Date;
  // Task 45 — single-use "view my license" claim link. When present (always, for
  // newly issued licenses) it lets an EXE-only buyer prove email ownership and
  // reach a narrow license_only session where they can claim / see this license.
  claimUrl?: string;
}): string {
  const plainDate = opts.expiresAt.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const claimSection = opts.claimUrl
    ? `<p style="font-size:14px;line-height:1.6;color:#374151;margin:0 0 16px;">
        <strong style="color:#111827;">Next step — get your activation key:</strong> once you've
        downloaded the app, run it, copy the <strong>Device ID</strong> it shows, then open this
        link to claim this license to that device and get the key to enter in the app:<br/>
        <a href="${opts.claimUrl}" style="color:#4f46e5;word-break:break-all;">${opts.claimUrl}</a>
        <span style="display:block;margin-top:4px;font-size:12px;color:#6b7280;">(If you already
        have a SpaceWorker account, sign in and go to the &ldquo;Licenses&rdquo; page instead.)</span>
      </p>`
    : `<p style="font-size:14px;line-height:1.6;color:#374151;margin:0 0 16px;">
        <strong style="color:#111827;">Next step — get your activation key:</strong> once you've
        downloaded the app, run it, copy the <strong>Device ID</strong> it shows, then sign in to
        your account&rsquo;s <strong>Licenses</strong> page and claim this license to that device.
        The page will give you the real activation key to enter in the app.
      </p>`;
  return `<!doctype html>
<html>
  <body style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#f3f4f6;margin:0;padding:24px;">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px;border:1px solid #e5e7eb;">
      <p style="font-size:20px;font-weight:700;margin:0 0 16px;color:#111827;">Your ${opts.productName} purchase is confirmed</p>
      <p style="font-size:15px;line-height:1.6;color:#374151;margin:0 0 16px;">
        Thanks for your purchase.
      </p>
      <p style="font-size:15px;line-height:1.6;color:#374151;margin:0 0 16px;">
        <strong style="color:#b91c1c;">Your license is valid for 6 months and expires on ${plainDate}.</strong>
        It will not renew automatically.
      </p>
      <p style="font-size:13px;line-height:1.6;color:#6b7280;margin:0 0 16px;">
        <strong>About the download:</strong> the desktop app build is not ready to download yet.
        We&rsquo;ll email you the download link as soon as the build is available — no need to do
        anything now.
      </p>
      <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:12px 16px;word-break:break-all;">
        <p style="font-size:12px;color:#6b7280;margin:0 0 6px;">
          Purchase reference (this is <strong style="color:#b91c1c;">not</strong> your activation key — use the next step below)
        </p>
        <p style="font-family:'SF Mono',Menlo,Consolas,monospace;font-size:12px;color:#111827;margin:0;">${opts.licenseKey}</p>
      </div>
      ${claimSection}
      <p style="font-size:13px;line-height:1.5;color:#6b7280;margin:12px 0 0;">
        Keep this email safe — the purchase reference it contains is your proof of purchase.
      </p>
    </div>
  </body>
</html>`;
}

// 2026-09-20 — owner: an admin-issued license for an email with no existing
// account should "just work like a real signup", not silently require one to
// already exist. lib/find-or-create-user.ts creates the account (unknowable
// random password — nobody signs in with it); this is the actual welcome
// message that account's owner ever sees, so it reads as a real welcome, not
// a purchase receipt. The claim link IS the account access: opening it proves
// email ownership and grants a license_only session, from which Settings
// already lets them set a real password with no "current password" needed
// (see app/api/settings/change-password/route.ts) — so this is a genuine,
// working "set your password" flow, not a promise of one.
export function exeLicenseWelcomeEmailHtml(opts: {
  productName: string;
  licenseKey: string;
  expiresAt: Date;
  claimUrl: string;
}): string {
  const plainDate = opts.expiresAt.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  return `<!doctype html>
<html>
  <body style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#f3f4f6;margin:0;padding:24px;">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px;border:1px solid #e5e7eb;">
      <p style="font-size:20px;font-weight:700;margin:0 0 16px;color:#111827;">Welcome to SpaceWorker</p>
      <p style="font-size:15px;line-height:1.6;color:#374151;margin:0 0 16px;">
        An account has been set up for you with a ${opts.productName} license, valid until
        <strong style="color:#b91c1c;">${plainDate}</strong>.
      </p>
      <p style="font-size:14px;line-height:1.6;color:#374151;margin:0 0 16px;">
        <strong style="color:#111827;">Get started:</strong> open the link below to access your
        account — from there you can view your license, set a password for future sign-ins, and
        get the activation key for the desktop app.<br/>
        <a href="${opts.claimUrl}" style="color:#4f46e5;word-break:break-all;">${opts.claimUrl}</a>
      </p>
      <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:12px 16px;word-break:break-all;">
        <p style="font-size:12px;color:#6b7280;margin:0 0 6px;">
          Purchase reference (this is <strong style="color:#b91c1c;">not</strong> your activation key — use the link above)
        </p>
        <p style="font-family:'SF Mono',Menlo,Consolas,monospace;font-size:12px;color:#111827;margin:0;">${opts.licenseKey}</p>
      </div>
      <p style="font-size:13px;line-height:1.5;color:#6b7280;margin:12px 0 0;">
        Keep this email safe — the link above is single-use and tied to this account.
      </p>
    </div>
  </body>
</html>`;
}

// Task 49 security fix (2026-09-20) — a `confirmTransfer: true` boolean in a
// POST body is not real consent: anyone holding a copy of a customer's
// license key + matching email could set it and silently steal the device
// binding, exactly the "no consent" scenario this session's earlier fix was
// supposed to close. Real consent requires something only the licensee's own
// inbox can produce — this code, sent to the email baked into the license
// key at issuance (never the request body's email, so an attacker can't
// redirect it to themselves).
export function exeTransferCodeEmailHtml(opts: { productName: string; code: string; machineLabel: string }): string {
  return `<!doctype html>
<html>
  <body style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#f3f4f6;margin:0;padding:24px;">
    <div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px;border:1px solid #e5e7eb;">
      <p style="font-size:18px;font-weight:700;margin:0 0 12px;color:#111827;">Move your ${opts.productName} license?</p>
      <p style="font-size:14px;line-height:1.6;color:#374151;margin:0 0 16px;">
        Someone requested to activate your license on a new device (&ldquo;${opts.machineLabel}&rdquo;). If this
        is you, enter this code in the app to confirm:
      </p>
      <p style="font-size:32px;font-weight:700;letter-spacing:4px;text-align:center;margin:0 0 16px;color:#111827;">
        ${opts.code}
      </p>
      <p style="font-size:13px;line-height:1.6;color:#6b7280;margin:0;">
        Expires in 15 minutes. If you didn&rsquo;t request this, ignore this email — your license stays exactly
        where it is; nothing changes until this code is entered.
      </p>
    </div>
  </body>
</html>`;
}

export function exeTransferCompletedEmailHtml(opts: { productName: string; machineLabel: string }): string {
  return `<!doctype html>
<html>
  <body style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#f3f4f6;margin:0;padding:24px;">
    <div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px;border:1px solid #e5e7eb;">
      <p style="font-size:18px;font-weight:700;margin:0 0 12px;color:#111827;">Your ${opts.productName} license moved devices</p>
      <p style="font-size:14px;line-height:1.6;color:#374151;margin:0 0 16px;">
        Your license is now active on &ldquo;${opts.machineLabel}&rdquo;. It's no longer active on its previous
        device.
      </p>
      <p style="font-size:13px;line-height:1.6;color:#6b7280;margin:0;">
        Didn&rsquo;t do this? Contact support right away.
      </p>
    </div>
  </body>
</html>`;
}