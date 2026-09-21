import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { getProduct } from "@/lib/products";
import { allowAndRecord, getClientIp } from "@/lib/rate-limit";
import { TRIAL_HOURS } from "@/lib/license-state";

export const dynamic = "force-dynamic";

// POST /api/exe-license/trial-ping — body:
//   { machineId, product, trialStartedAt?, email?, machineLabel? }
//
// Task 58 — this is now THE single place ExeTrialSession rows are created, and
// an email is REQUIRED to create a new one (the owner's 2026-09-21 direction:
// no more anonymous first launch — "email binds with the free for 24hrs until
// the premium comes in if they pay"). It is the authoritative source of truth
// for a trial's `startedAt`, so a returning machine (even one whose local state
// file was deleted) is reflected its TRUE original start here, never a fresh 24h.
//
// Behavior on (machineId, product):
//   - Existing row -> refresh lastSeenAt (+ machineLabel), return the row's
//     authoritative startedAt/trialEndsAt. incoming email/trialStartedAt are
//     IGNORED (first-wins) so neither the clock nor identity can be reset.
//   - No existing row:
//       * email present  -> create (startedAt = now authoritative) + return it.
//       * email absent   -> 400 "email required" — a trial cannot start without it.
//
// Not session-gated — the EXE has no web session. Low-stakes: writes "a machine
// is trying this product's trial" + the identity that started it. Upserts on
// (machineId, product) so repeat calls refresh lastSeenAt, never pile up rows.
const bodySchema = z.object({
  machineId: z.string().trim().min(1),
  product: z.string().trim().min(1),
  trialStartedAt: z.string().trim().min(1).optional(),
  email: z.string().trim().email().optional(),
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

  const machineId = parsed.machineId.trim().toLowerCase();

  const startSeconds = (d: Date) => Math.floor(d.getTime() / 1000);
  const secondsLeft = (startedAt: Date) =>
    Math.max(0, TRIAL_HOURS * 60 * 60 - (Math.floor(Date.now() / 1000) - startSeconds(startedAt)));
  const endIso = (startedAt: Date) =>
    new Date(startedAt.getTime() + TRIAL_HOURS * 60 * 60 * 1000).toISOString();

  const existing = await db.exeTrialSession.findUnique({
    where: { machineId_product: { machineId, product: product.id } },
  });

  if (existing) {
    // Keeps status/lastSeen fresh; never touches startedAt or email (first-wins).
    await db.exeTrialSession.update({
      where: { id: existing.id },
      data: {
        lastSeenAt: new Date(),
        ...(parsed.machineLabel?.trim() ? { machineLabel: parsed.machineLabel.trim() } : {}),
      },
    });
    return NextResponse.json({
      ok: true,
      created: false,
      startedAt: existing.startedAt.toISOString(),
      trialEndsAt: endIso(existing.startedAt),
      trialSecondsLeft: secondsLeft(existing.startedAt),
      email: existing.email ?? null,
    });
  }

  // New (machineId, product) — an email is mandatory to START a trial.
  if (!parsed.email) {
    return NextResponse.json(
      { error: "An email is required to start a free trial." },
      { status: 400 },
    );
  }

  const startedAt = parsed.trialStartedAt ? new Date(parsed.trialStartedAt) : new Date();
  if (Number.isNaN(startedAt.getTime())) {
    return NextResponse.json({ error: "Invalid trialStartedAt." }, { status: 400 });
  }

  const row = await db.exeTrialSession.create({
    data: {
      machineId,
      product: product.id,
      email: parsed.email.toLowerCase().trim(),
      machineLabel: parsed.machineLabel?.trim() || null,
      startedAt,
      lastSeenAt: new Date(),
    },
  });

  return NextResponse.json({
    ok: true,
    created: true,
    startedAt: row.startedAt.toISOString(),
    trialEndsAt: endIso(row.startedAt),
    trialSecondsLeft: secondsLeft(row.startedAt),
    email: row.email,
  });
}
