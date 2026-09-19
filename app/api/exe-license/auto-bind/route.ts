import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { decodeLicenseKey, exeLicenseSecret } from "@/lib/exe-license";
import { validateLicenseKey } from "@/lib/exe-license-validator";
import { bindExeLicenseToMachine, LicenseBindError } from "@/lib/exe-license-bind";

export const dynamic = "force-dynamic";

// POST /api/exe-license/auto-bind — body: { licenseKey, email, machineId, machineLabel? }
//
// Self-service redesign (2026-09-19) — called by the DESKTOP EXE's local
// /api/exe-license/activate route, over the network, the first time someone
// activates with an UNBOUND (purchase-reference) key. Folds the separate
// "claim it on your Licenses page first" step into activation itself — the
// same one-machine-per-license invariant still applies (this just calls the
// existing bindExeLicenseToMachine, "already_bound" and all), so this is not
// a weaker guarantee, just fewer steps: whoever activates FIRST with a
// genuinely valid key + matching email wins the binding, exactly like a
// manual claim would.
//
// Not session-gated — the EXE has no web session to send. The key's
// signature (proves we genuinely issued it) plus the matching licensee email
// is the authorization, the same trust bar the offline activate route
// already applies before this is ever called.
const bodySchema = z.object({
  licenseKey: z.string().trim().min(1, "Missing license key."),
  email: z.string().trim().email("Missing a valid email."),
  machineId: z.string().trim().min(1, "Missing device ID."),
  machineLabel: z.string().trim().max(80).optional().nullable(),
});

export async function POST(req: Request) {
  let parsed: z.infer<typeof bodySchema>;
  try {
    parsed = bodySchema.parse(await req.json());
  } catch (e) {
    const msg = e instanceof z.ZodError ? e.errors[0]?.message : "Invalid request body.";
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  let secret: string;
  try {
    secret = exeLicenseSecret();
  } catch {
    return NextResponse.json({ error: "Licensing is not configured on the server." }, { status: 500 });
  }

  // Confirm the key was genuinely issued by us (same signature check the
  // offline validator does) before touching the database at all.
  const validation = await validateLicenseKey(parsed.licenseKey, secret, {});
  if (!validation.valid) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }
  const decoded = decodeLicenseKey(parsed.licenseKey);
  if (!decoded || decoded.licensee.trim().toLowerCase() !== parsed.email.trim().toLowerCase()) {
    return NextResponse.json({ error: "This key belongs to a different email." }, { status: 400 });
  }

  const license = await db.exeLicense.findUnique({ where: { licenseKey: parsed.licenseKey } });
  if (!license) {
    return NextResponse.json({ error: "No matching license found for that key." }, { status: 404 });
  }

  try {
    const bound = await bindExeLicenseToMachine({
      exeLicenseId: license.id,
      machineId: parsed.machineId,
      machineLabel: parsed.machineLabel ?? undefined,
    });
    return NextResponse.json({ ok: true, boundLicenseKey: bound.boundLicenseKey });
  } catch (err) {
    if (err instanceof LicenseBindError) {
      const status = err.code === "not_found" ? 404 : err.code === "already_bound" ? 409 : 400;
      return NextResponse.json({ error: err.message }, { status });
    }
    throw err;
  }
}
