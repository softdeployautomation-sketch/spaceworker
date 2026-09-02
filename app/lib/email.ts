import "server-only";
import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY!);

export async function sendVerificationEmail(to: string, code: string): Promise<void> {
  await resend.emails.send({
    from: "SpaceWorker <noreply@spaceworker.io>",
    to,
    subject: "Your SpaceWorker verification code",
    text: `Your verification code is: ${code}\n\nThis code expires in 15 minutes.`,
  });
}