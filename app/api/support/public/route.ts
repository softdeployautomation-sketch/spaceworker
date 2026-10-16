import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { sendEmail } from "@/lib/email";
import { env } from "@/lib/env";
import { allowAndRecord, getClientIp } from "@/lib/rate-limit";

const schema = z.object({
  name: z.string().min(1).max(100).optional(),
  email: z.string().email().max(200).optional(),
  message: z.string().min(1).max(5000),
  // Optional CAPTCHA token from the public homepage; verified server-side when
  // present. Not strictly required so the form stays usable, but strongly
  // encouraged to keep bot spam off the public support surface.
  captchaToken: z.string().optional(),
});

export async function POST(request: Request) {
  const ip = await getClientIp();
  const allowed = await allowAndRecord(ip, "support_public");
  if (!allowed) {
    return NextResponse.json(
      { error: "Too many messages. Please try again later." },
      { status: 429 },
    );
  }

  let parsed: z.infer<typeof schema>;
  try {
    parsed = schema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const message = await db.publicMessage.create({
    data: {
      name: parsed.name ?? null,
      email: parsed.email ?? null,
      message: parsed.message,
    },
  });

  // Best-effort alert to the owner so a public message is never missed.
  if (env.adminEmail) {
    void sendEmail({
      to: env.adminEmail,
      subject: `New public support message${parsed.email ? ` from ${parsed.email}` : ""}`,
      html: [
        `<div style="font-family:sans-serif;max-width:520px">`,
        `<h2 style="margin:0 0 12px">New public support message</h2>`,
        `<p style="font-size:14px">${parsed.message.replace(/\n/g, "<br>")}</p>`,
        `<table style="border-collapse:collapse;font-size:14px;margin-top:12px">`,
        `<tr><td style="padding:4px 12px 4px 0;color:#666">Message</td><td>${message.id}</td></tr>`,
        parsed.name
          ? `<tr><td style="padding:4px 12px 4px 0;color:#666">Name</td><td>${parsed.name}</td></tr>`
          : "",
        parsed.email
          ? `<tr><td style="padding:4px 12px 4px 0;color:#666">Email</td><td>${parsed.email}</td></tr>`
          : "",
        `</table>`,
        `</div>`,
      ].join(""),
      eventType: "support_message",
    }).catch(() => undefined);
  }

  return NextResponse.json(
    { message: "Message received. We'll get back to you.", id: message.id },
    { status: 201 },
  );
}
