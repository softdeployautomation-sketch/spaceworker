import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { decodeLicenseKey, exeLicenseSecret } from "@/lib/exe-license";
import { validateLicenseKey } from "@/lib/exe-license-validator";
import {
  bindExeLicenseToMachine,
  transferExeLicenseToMachine,
  LicenseBindError,
  LicenseTransferError,
} from "@/lib/exe-license-bind";

export const dynamic = "force-dynamic";

// POST /api/exe-license/auto-bind — body: { licenseKey, email, machineId, machineLabel?, confirmTransfer? }
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
// Fix (2026-09-20) — owner: "i need to be sure a user with the exe doesnt
// get using this exe without my consent... can only be transferred by
// revoking the previous one to get a new one". The route used to catch
// bindExeLicenseToMachine's "already_bound" error and silently call
// transferExeLicenseToMachine — the SAME function every comment in
// lib/exe-license-bind.ts documents as admin/support-only, precisely
// because it overwrites an existing binding with zero consent from whoever
// is actively using it. Confirmed live: the only gate was the key's
// signature + a matching email, both of which just sit in the plaintext key
// string — anyone holding a copy of a customer's key could silently steal
// the binding to their own machine. Now `confirmTransfer` must be explicitly
// true (only ever sent after the person on the NEW machine has seen an
// "already active on another device — move it here?" prompt and clicked
// through it — see LicenseActivationForm). Without it, an already-bound key
// is rejected exactly like bindExeLicenseToMachine already rejects it for
// every OTHER caller, with a distinguishable `code` so the client can offer
// that confirmation instead of a dead-end error.
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
  confirmTransfer: z.boolean().optional(),
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
    if (err instanceof LicenseBindError && err.code === "already_bound") {
      // Require an explicit, human confirmation before ever moving a
      // binding away from whoever is currently using it — see the file-top
      // comment. Key + email alone is not consent from the CURRENT device.
      if (!parsed.confirmTransfer) {
        return NextResponse.json(
          {
            error:
              "This license is already active on another device. If that device is no longer in use, you can move it here.",
            code: "already_bound",
          },
          { status: 409 },
        );
      }
      // The person on the NEW machine has now explicitly confirmed they want
      // to move the license here, knowing it will revoke the other device.
      // Same underlying transferExeLicenseToMachine the admin tool uses,
      // with its own audit row, just triggered by the licensee's own
      // deliberate action instead of an admin's.
      try {
        const transferred = await transferExeLicenseToMachine({
          exeLicenseId: license.id,
          newMachineId: parsed.machineId,
          newMachineLabel: parsed.machineLabel ?? undefined,
          note: "Self-service transfer: licensee confirmed moving this license to a new device.",
        });
        return NextResponse.json({ ok: true, boundLicenseKey: transferred.boundLicenseKey });
      } catch (transferErr) {
        if (transferErr instanceof LicenseTransferError) {
          return NextResponse.json({ error: transferErr.message }, { status: 400 });
        }
        throw transferErr;
      }
    }
    if (err instanceof LicenseBindError) {
      const status = err.code === "not_found" ? 404 : 400;
      return NextResponse.json({ error: err.message }, { status });
    }
    throw err;
  }
}
