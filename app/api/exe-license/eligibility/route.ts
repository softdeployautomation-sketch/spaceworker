import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { allowAndRecord, getClientIp } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

// Fixed 2026-09-21 (owner: "unbind doesn't mean revoke") — the SpaceWorker
// EXE previously had NO way to notice server-side revocation once activated:
// app/api/exe-license/status/route.ts validated the stored key purely
// offline, so admin Unbind/Delete cleared the server record but an
// already-running device kept working indefinitely. This route is the
// missing piece — a faithful port of Vantra's
// app/api/exe-license/eligibility/route.ts, which has done exactly this job
// there since 2026-09-18.
//
// POST body: { email, licenseKey, product }. Answers "is THIS EXACT key
// still the license's current binding" — true after a normal claim (the key
// IS boundLicenseKey), false after Unbind/Delete/Transfer-to-a-different-
// machine (boundLicenseKey no longer matches, or the row is gone).
//
// Not session-gated (the EXE has no web session) — rate-limited per IP
// instead, same posture as the other public exe-license routes.
const bodySchema = z.object({
  email: z.string().trim().email(),
  licenseKey: z.string().trim().min(1),
  product: z.string().trim().min(1),
});

export async function POST(req: Request) {
  const ip = await getClientIp();
  if (!(await allowAndRecord(ip, "exe-license-eligibility"))) {
    return NextResponse.json({ error: "Too many attempts. Please try again later." }, { status: 429 });
  }

  let parsed: z.infer<typeof bodySchema>;
  try {
    parsed = bodySchema.parse(await req.json());
  } catch (e) {
    const msg = e instanceof z.ZodError ? e.errors[0]?.message : "Invalid request body.";
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  const email = parsed.email.toLowerCase().trim();
  const user = await db.user.findUnique({ where: { email }, select: { id: true } });
  if (!user) {
    // Unknown account — same shape as ineligible, never an existence oracle.
    return NextResponse.json({ eligible: false });
  }

  // Match either the ORIGINAL unbound key (never claimed) or the CURRENT
  // bound key — exactly what a device presenting its stored key needs
  // checked. A key that matches neither (unbound/deleted/superseded by a
  // transfer to a different machine) is no longer this license's binding.
  const license = await db.exeLicense.findFirst({
    where: {
      userId: user.id,
      product: parsed.product,
      OR: [{ licenseKey: parsed.licenseKey }, { boundLicenseKey: parsed.licenseKey }],
    },
    select: { id: true },
  });

  return NextResponse.json({ eligible: license !== null });
}
