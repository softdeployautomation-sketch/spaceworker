import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { allowAndRecord, getClientIp } from "@/lib/rate-limit";
import { exeLicenseSecret } from "@/lib/exe-license";
import { validateLicenseKey } from "@/lib/exe-license-validator";
import { buildMailerSources, prismaMailerSourcesStore } from "@/lib/mailer-sources";

export const dynamic = "force-dynamic";

// TASK_201 S2 — the HOSTED half of the Mailer EXE's sources fetch. The split
// with app/api/exe/mailer/sources (the local half) is forced by physics, not
// taste: the Tauri-bundled runtime has NO DATABASE_URL and NO
// MAILBOX_ENCRYPTION_KEY (runtime-assemble.mjs scrubs both away), so the query
// and the decryption can only happen HERE, and the EXE receives plaintext over
// HTTPS — the owner-approved v1 tradeoff recorded in TASK_201 (server-proxy
// toggle deferred to v1.1).
//
// Auth posture: session-less, exactly like /api/exe-license/eligibility (the
// EXE has no web session) — email + licenseKey + product + machineId, then
// THREE layers of proof before any secret moves:
//   1. HMAC signature + expiry + machine binding of the presented key itself
//      (validateLicenseKey — the same offline validation the EXE runs locally,
//      re-run here because the EXE's word about its own key cannot be trusted
//      from outside).
//   2. A real ExeLicense row that this key is the CURRENT binding of, for this
//      user AND this product — unknown email and "no such license" return the
//      same body, never an existence oracle (eligibility's rule).
//   3. row.boundMachineId (when set) must be the requester's machineId —
//      defense in depth over the key's own machine_id payload: this route
//      returns DECRYPTED SMTP passwords, so it demands the strictest machine
//      proof anywhere in the exe-license family.
// Rate-limited per IP ("exe-mailer-sources", 60/hr — see lib/rate-limit.ts).

const bodySchema = z.object({
  email: z.string().trim().email(),
  licenseKey: z.string().trim().min(1),
  product: z.string().trim().min(1),
  machineId: z.string().trim().min(1),
});

// One body for every "you don't get the secrets" outcome — the shape
// eligibility established: the caller learns nothing about whether the email
// exists, which licenses it holds, or which of the three checks failed.
const DENIED = "License not valid for this product.";

export async function POST(req: Request) {
  const ip = await getClientIp();
  if (!(await allowAndRecord(ip, "exe-mailer-sources"))) {
    return NextResponse.json({ error: "Too many attempts. Please try again later." }, { status: 429 });
  }

  let parsed: z.infer<typeof bodySchema>;
  try {
    parsed = bodySchema.parse(await req.json());
  } catch (e) {
    const msg = e instanceof z.ZodError ? e.errors[0]?.message : "Invalid request body.";
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  // Layer 1 — the key itself. Unlike the row lookup below, this failure IS
  // surfaced verbatim (same as /api/exe-license/activate): "expired" and
  // "not valid for this computer" are things the user can ACT on, and the EXE
  // has no other way to hear them from the server side.
  let secret: string;
  try {
    secret = exeLicenseSecret();
  } catch {
    return NextResponse.json({ error: "Licensing is not configured." }, { status: 500 });
  }
  const machineId = parsed.machineId.toLowerCase();
  const validation = await validateLicenseKey(parsed.licenseKey, secret, {
    currentMachineId: machineId,
  });
  if (!validation.valid) {
    return NextResponse.json({ error: validation.error }, { status: 403 });
  }

  // Layer 2 — the row. Identical lookup to eligibility's, so a key that can
  // answer "am I eligible" can answer this; nothing new is accepted.
  const email = parsed.email.toLowerCase();
  const user = await db.user.findUnique({ where: { email }, select: { id: true } });
  if (!user) return NextResponse.json({ error: DENIED }, { status: 403 });

  const license = await db.exeLicense.findFirst({
    where: {
      userId: user.id,
      product: parsed.product,
      OR: [{ licenseKey: parsed.licenseKey }, { boundLicenseKey: parsed.licenseKey }],
    },
    select: { boundMachineId: true },
  });
  if (!license) return NextResponse.json({ error: DENIED }, { status: 403 });

  // Layer 3 — the machine, twice. The key payload already proved it (layer 1);
  // the row proves the binding ADMIN saw hasn't moved since (a transfer
  // rewrites boundMachineId, which then rejects the old device here even if
  // someone somehow still holds a key the signature accepts).
  if (license.boundMachineId && license.boundMachineId.toLowerCase() !== machineId) {
    return NextResponse.json({ error: DENIED }, { status: 403 });
  }

  const sources = await buildMailerSources(prismaMailerSourcesStore(db), user.id);
  return NextResponse.json(sources);
}
