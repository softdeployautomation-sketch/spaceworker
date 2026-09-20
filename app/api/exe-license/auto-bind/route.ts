import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { decodeLicenseKey, exeLicenseSecret } from "@/lib/exe-license";
import { validateLicenseKey } from "@/lib/exe-license-validator";
import { getProduct } from "@/lib/products";
import { sendEmail, exeTransferCodeEmailHtml } from "@/lib/email";
import { issueVerificationCode, consumeVerificationCode } from "@/lib/verify-code";
import { allowAndRecord, getClientIp } from "@/lib/rate-limit";
import {
  bindExeLicenseToMachine,
  transferExeLicenseToMachine,
  LicenseBindError,
  LicenseTransferError,
} from "@/lib/exe-license-bind";

export const dynamic = "force-dynamic";

// POST /api/exe-license/auto-bind — body: { licenseKey, email, machineId, machineLabel?, transferCode? }
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
// Task 49 fix (2026-09-20, security audit) — the PREVIOUS version of this
// fix (2026-09-20 earlier the same day) required a `confirmTransfer: true`
// boolean before transferring an already-bound license. That looked like a
// real gate but wasn't one: `confirmTransfer` is just a client-supplied JSON
// field — anyone holding a copy of a customer's plaintext license key + the
// matching purchase email (leaked, phished, shared) could set it themselves
// with a single curl request and silently steal the binding, exactly the
// "no consent" scenario the owner asked to close ("i need to be sure a user
// with the exe doesnt get using this exe without my consent"). A client-
// asserted boolean can never BE consent.
//
// Real fix: when a key is already bound elsewhere, this route now emails a
// short confirmation code to the email BAKED INTO THE LICENSE KEY AT
// ISSUANCE (never the request body's email — that field is attacker-
// controlled, the key's embedded licensee is not) and requires that code on
// a follow-up request before calling transferExeLicenseToMachine. Reuses the
// same VerificationCode mechanism the signup flow already uses (lib/verify-
// code.ts), scoped by purpose ("exe_transfer") so it can never collide with
// an unrelated pending signup code for the same user. Rate-limited per IP so
// the code can't be brute-forced or the email-send spammed.
//
// Not session-gated — the EXE has no web session to send. The key's
// signature (proves we genuinely issued it) is what lets this route act at
// all; a transfer additionally requires proving control of the licensee's
// actual inbox, not just knowledge of two semi-public strings.
const bodySchema = z.object({
  licenseKey: z.string().trim().min(1, "Missing license key."),
  email: z.string().trim().email("Missing a valid email."),
  machineId: z.string().trim().min(1, "Missing device ID."),
  machineLabel: z.string().trim().max(80).optional().nullable(),
  transferCode: z.string().trim().optional(),
});

const TRANSFER_CODE_PURPOSE = "exe_transfer";

export async function POST(req: Request) {
  const ip = await getClientIp();
  const allowed = await allowAndRecord(ip, "exe-auto-bind");
  if (!allowed) {
    return NextResponse.json({ error: "Too many attempts. Please try again later." }, { status: 429 });
  }

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
      const productName = getProduct(license.product)?.name ?? license.product;
      const machineLabel = parsed.machineLabel?.trim() || parsed.machineId;

      if (!parsed.transferCode) {
        // No code presented yet — issue one and email it to the address
        // baked into the key at issuance (decoded.licensee), never the
        // request body's email. Best-effort send; a failure here must not
        // reveal whether the license exists differently than success would.
        const { code } = await issueVerificationCode(license.userId, TRANSFER_CODE_PURPOSE);
        try {
          await sendEmail({
            to: decoded.licensee,
            subject: `Confirm moving your ${productName} license`,
            html: exeTransferCodeEmailHtml({ productName, code, machineLabel }),
            eventType: "exe_transfer_code",
          });
        } catch (sendErr) {
          console.error(
            "[exe-license] transfer code issued but email failed:",
            sendErr instanceof Error ? sendErr.message : String(sendErr),
          );
        }
        return NextResponse.json(
          {
            error:
              "This license is already active on another device. We emailed a confirmation code to the account on file — enter it to move it here.",
            code: "already_bound",
          },
          { status: 409 },
        );
      }

      // A code was presented — it must actually match what was emailed to
      // the real licensee. This is the genuine consent check; everything
      // before it (key signature, email match) only established WHICH
      // license, never permission to move it.
      const result = await consumeVerificationCode(license.userId, parsed.transferCode, TRANSFER_CODE_PURPOSE);
      if (!result.ok) {
        const message =
          result.reason === "expired"
            ? "That code has expired — request a new one."
            : result.reason === "attempts_exhausted"
              ? "Too many incorrect attempts — request a new code."
              : result.reason === "no_code"
                ? "No pending confirmation for this license — request a new code."
                : "That code is incorrect.";
        return NextResponse.json({ error: message, code: "invalid_transfer_code" }, { status: 400 });
      }

      try {
        const transferred = await transferExeLicenseToMachine({
          exeLicenseId: license.id,
          newMachineId: parsed.machineId,
          newMachineLabel: parsed.machineLabel ?? undefined,
          note: "Self-service transfer: licensee confirmed via emailed code.",
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
