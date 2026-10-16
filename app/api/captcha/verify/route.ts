import { NextResponse } from "next/server";
import { z } from "zod";

import { verifyCaptcha } from "@/lib/captcha";

const schema = z.object({
  token: z.string().min(1),
  selected: z.array(z.number().int().min(0).max(8)).max(9),
});

export async function POST(request: Request) {
  let parsed: z.infer<typeof schema>;
  try {
    parsed = schema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const ok = await verifyCaptcha(parsed.token, parsed.selected);
  if (!ok) {
    return NextResponse.json({ error: "Invalid or expired CAPTCHA." }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
