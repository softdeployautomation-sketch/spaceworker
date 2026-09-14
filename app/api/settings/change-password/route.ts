import { NextResponse } from "next/server";
import { z } from "zod";

import { hashPassword, verifyPassword, getSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/session-user";
import { allowAndRecord, getClientIp } from "@/lib/rate-limit";

// Task 45 — in a "license_only" session (an EXE buyer who only ever got an
// inline account with an unknowable random password) the current password is
// irrelevant: the license_only session itself is the strongest proof of email
// ownership this account can offer (it's only ever issued to the person who
// opened the emailed single-use claim link). So in that scope we let them SET a
// real password without supplying the random one — which is the on-ramp to
// becoming a proper customer (item 4's upgrade path). For every "full" session
// we keep the strict current-password check, unchanged.
const schema = z.object({
  currentPassword: z.string().min(1, "Enter your current password").optional(),
  newPassword: z
    .string()
    .min(8, "New password must be at least 8 characters")
    .max(128, "New password must be at most 128 characters"),
});

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const session = await getSession();
  const isLicenseOnly = session?.scope === "license_only";

  const ip = await getClientIp();
  const allowed = await allowAndRecord(ip, "change-password");
  if (!allowed) {
    return NextResponse.json(
      { error: "Too many attempts. Please try again later." },
      { status: 429 },
    );
  }

  let parsed;
  try {
    parsed = schema.parse(await request.json());
  } catch (e) {
    const msg = e instanceof z.ZodError ? e.errors[0]?.message : "Invalid request body";
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  if (!isLicenseOnly) {
    // Full session — require and verify the current password (today's behaviour).
    const currentPassword = parsed.currentPassword;
    if (!currentPassword) {
      return NextResponse.json({ error: "Enter your current password" }, { status: 400 });
    }
    const valid = await verifyPassword(currentPassword, user.passwordHash);
    if (!valid) {
      return NextResponse.json({ error: "Current password is incorrect" }, { status: 400 });
    }
  }

  const passwordHash = await hashPassword(parsed.newPassword);
  await db.user.update({ where: { id: user.id }, data: { passwordHash } });

  return NextResponse.json({ ok: true });
}
