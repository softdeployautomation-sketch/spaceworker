import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { getProduct } from "@/lib/products";
import { allowAndRecord, getClientIp } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

// POST /api/exe-license/trial-ping — body: { machineId, product, trialStartedAt, machineLabel? }
//
// Owner-requested 2026-09-20: "a subtab showing every free users device
// active for that 24hrs". The EXE's silent 24h trial (lib/license-state.ts)
// is otherwise entirely local-only — the admin has no visibility into it at
// all. Called fire-and-forget from the EXE-local /api/exe-license/status
// route whenever a device reports inTrial:true; a failure here must never
// affect the trial gate itself (the caller doesn't even await this).
//
// Not session-gated — the EXE has no web session. Low-stakes: this only
// ever writes "a machine is trying this product's trial", never anything
// that grants access or reveals anything about another account. Upserts on
// (machineId, product) so repeated pings from the same install just refresh
// lastSeenAt instead of piling up rows.
const bodySchema = z.object({
  machineId: z.string().trim().min(1),
  product: z.string().trim().min(1),
  trialStartedAt: z.string().trim().min(1),
  machineLabel: z.string().trim().max(80).optional().nullable(),
});

export async function POST(req: Request) {
  // Task 52 — intentionally unauthenticated endpoint (the EXE has no web
  // session), so an IP-based rate limit is the only knob: enough headroom for
  // one ping per real device per session while blocking a machineId-spam script
  // from growing ExeTrialSession unbounded and polluting the admin trial view.
  const ip = await getClientIp();
  const allowed = await allowAndRecord(ip, "trial-ping");
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

  const product = getProduct(parsed.product);
  if (!product || product.kind !== "exe") {
    return NextResponse.json({ error: "Unknown product." }, { status: 400 });
  }

  const startedAt = new Date(parsed.trialStartedAt);
  if (Number.isNaN(startedAt.getTime())) {
    return NextResponse.json({ error: "Invalid trialStartedAt." }, { status: 400 });
  }

  const machineId = parsed.machineId.trim().toLowerCase();
  await db.exeTrialSession.upsert({
    where: { machineId_product: { machineId, product: product.id } },
    create: {
      machineId,
      product: product.id,
      machineLabel: parsed.machineLabel?.trim() || null,
      startedAt,
      lastSeenAt: new Date(),
    },
    update: {
      lastSeenAt: new Date(),
      // machineLabel can change (renamed device) — keep it current; startedAt
      // never changes once set (the trial's actual start, not this ping's time).
      ...(parsed.machineLabel?.trim() ? { machineLabel: parsed.machineLabel.trim() } : {}),
    },
  });

  return NextResponse.json({ ok: true });
}
