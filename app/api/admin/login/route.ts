import { NextResponse } from "next/server";
import { z } from "zod";

import {
  adminConfigured,
  setAdminSessionCookie,
  verifyAdminPasscode,
} from "@/lib/admin-auth";
import { allowAndRecord, getClientIp } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const loginSchema = z.object({
  passcode: z.string().min(1, "Passcode is required"),
});

export async function POST(request: Request) {
  // Fails closed when ADMIN_TOKEN is unset — the panel is never open.
  if (!adminConfigured()) {
    return NextResponse.json(
      { error: "The admin panel is not configured." },
      { status: 503 },
    );
  }

  const ip = await getClientIp();
  const allowed = await allowAndRecord(ip, "admin-login");
  if (!allowed) {
    return NextResponse.json(
      { error: "Too many login attempts. Please try again later." },
      { status: 429 },
    );
  }

  let parsed;
  try {
    parsed = loginSchema.parse(await request.json());
  } catch (e) {
    const msg =
      e instanceof z.ZodError ? e.errors[0]?.message : "Invalid request body.";
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  if (!verifyAdminPasscode(parsed.passcode)) {
    return NextResponse.json(
      { error: "Invalid admin passcode." },
      { status: 401 },
    );
  }

  await setAdminSessionCookie();
  return NextResponse.json({ ok: true });
}