import "server-only";

import { Resend } from "resend";

import { env } from "./env";

// Sentinel value used in non-production .env to allow a successful local build
// without a real Resend key. Treated as "not configured" at runtime.
export const RESEND_PLACEHOLDER = "re_local_dev_placeholder";

// Thin wrapper around Resend — for SpaceWorker's OWN transactional email only
// (signup/verification codes). Uses a SEPARATE Resend account/API key from
// Vantra's. Task 4's cold-outreach sending uses each customer's own SMTP and
// must never touch this account.
export async function sendEmail(opts: {
  to: string;
  subject: string;
  html: string;
}): Promise<void> {
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