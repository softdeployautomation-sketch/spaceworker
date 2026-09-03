import "server-only";
import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY!);

export function verificationEmailHtml(code: string): string {
  return `
<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8">
    <style>
      body { font-family: system-ui, -apple-system, sans-serif; background: #f9fafb; padding: 20px; }
      .container { max-width: 500px; margin: 0 auto; background: white; padding: 30px; border-radius: 8px; }
      h1 { color: #111827; margin: 0 0 20px 0; }
      .code { background: #f3f4f6; padding: 15px; border-radius: 6px; text-align: center; font-size: 24px; letter-spacing: 2px; font-family: monospace; margin: 20px 0; }
      .footer { color: #6b7280; font-size: 12px; margin-top: 30px; }
    </style>
  </head>
  <body>
    <div class="container">
      <h1>Verify your email</h1>
      <p>Your verification code is:</p>
      <div class="code">${code}</div>
      <p>This code expires in 15 minutes.</p>
      <div class="footer">
        <p>If you didn't request this code, you can safely ignore this email.</p>
      </div>
    </div>
  </body>
</html>
  `;
}

export async function sendVerificationEmail(to: string, code: string): Promise<void> {
  await resend.emails.send({
    from: "SpaceWorker <noreply@spaceworker.io>",
    to,
    subject: "Your SpaceWorker verification code",
    html: verificationEmailHtml(code),
  });
}

export async function sendEmail(to: string, subject: string, html: string): Promise<void> {
  await resend.emails.send({
    from: "SpaceWorker <noreply@spaceworker.io>",
    to,
    subject,
    html,
  });
}