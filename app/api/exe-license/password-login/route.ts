import { NextResponse } from "next/server";
import { z } from "zod";

import { verifyPassword } from "@/lib/auth";
import { db } from "@/lib/db";
import { getProduct } from "@/lib/products";
import { allowAndRecord, getClientIp } from "@/lib/rate-limit";
import { keyExpiryIsAfter } from "@/lib/exe-license-bind";
import {
  bindExeLicenseToMachine,
  transferExeLicenseToMachine,
  LicenseBindError,
  LicenseTransferError,
} from "@/lib/exe-license-bind";

export const dynamic = "force-dynamic";

// POST /api/exe-license/password-login — body: { email, password, product, machineId, machineLabel?, confirmTransfer? }
//
// Owner-requested 2026-09-20: "i think we should make exe sign in optional
// to use either the password or license... any flow that would work
// seamless." Called by the DESKTOP EXE's local runtime (mirrors auto-bind's
// call shape exactly — same "already_bound requires confirmTransfer" contract,
// so the EXE's existing confirm-to-transfer UI works unchanged against this
// endpoint too), over the network, when someone chooses "sign in with email +
// password" instead of pasting a license key.
//
// Deliberately does NOT mint a new license for just any account with a valid
// password — that would hand out free EXE access to anyone who's ever signed
// up. It only looks up an EXISTING, non-expired ExeLicense already issued to
// this account for THIS product (via checkout or an admin issue) and binds/
// transfers it to this device, same as the license-key path does once you
// already have the key in hand. No license on file -> a clear error, not a
// silent mint.
const bodySchema = z.object({
  email: z.string().trim().email("Enter a valid email address."),
  password: z.string().min(1, "Enter your password."),
  product: z.string().trim().min(1, "Missing product."),
  machineId: z.string().trim().min(1, "Missing device ID."),
  machineLabel: z.string().trim().max(80).optional().nullable(),
  confirmTransfer: z.boolean().optional(),
});

export async function POST(req: Request) {
  const ip = await getClientIp();
  const allowed = await allowAndRecord(ip, "exe-password-login");
  if (!allowed) {
    return NextResponse.json({ error: "Too many sign-in attempts. Please try again later." }, { status: 429 });
  }

  let parsed: z.infer<typeof bodySchema>;
  try {
    parsed = bodySchema.parse(await req.json());
  } catch (e) {
    const msg = e instanceof z.ZodError ? e.errors[0]?.message : "Invalid request body.";
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  const product = getProduct(parsed.product);
  if (!product || product.kind !== "exe") {
    return NextResponse.json({ error: "Unknown SpaceWorker EXE product." }, { status: 400 });
  }

  const email = parsed.email.trim().toLowerCase();
  const user = await db.user.findUnique({ where: { email } });
  // Same generic message whether the account doesn't exist or the password is
  // wrong — never reveal which, exactly like the web login route.
  const genericError = () => NextResponse.json({ error: "Invalid email or password." }, { status: 401 });
  if (!user) return genericError();
  const validPassword = await verifyPassword(parsed.password, user.passwordHash);
  if (!validPassword) return genericError();

  const now = new Date();
  const rows = await db.exeLicense.findMany({
    where: { userId: user.id, product: product.id },
    orderBy: { issuedAt: "desc" },
  });
  const usable = rows.find((l) => keyExpiryIsAfter(l.licenseKey, now));
  if (!usable) {
    return NextResponse.json(
      { error: `No ${product.name} license found for this account. Buy one or ask an admin to issue one.` },
      { status: 404 },
    );
  }

  try {
    const bound = await bindExeLicenseToMachine({
      exeLicenseId: usable.id,
      machineId: parsed.machineId,
      machineLabel: parsed.machineLabel ?? undefined,
    });
    return NextResponse.json({ ok: true, boundLicenseKey: bound.boundLicenseKey });
  } catch (err) {
    if (err instanceof LicenseBindError && err.code === "already_bound") {
      // Same explicit-confirmation gate as auto-bind — a correct password
      // proves account ownership, not consent to kick another device off.
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
      try {
        const transferred = await transferExeLicenseToMachine({
          exeLicenseId: usable.id,
          newMachineId: parsed.machineId,
          newMachineLabel: parsed.machineLabel ?? undefined,
          note: "Self-service transfer: signed in with email + password and confirmed moving this license to a new device.",
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
