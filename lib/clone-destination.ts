import "server-only";

import { db } from "./db";

// TASK_118 B8-1 — the clone DESTINATION as a real, selectable row.
//
// WHAT WAS WRONG (measured 2026-09-25, tracker B8): `Device.deviceKind =
// "hosted"` was **read in exactly one place** (`admin/clone-limits`, to count a
// pool) and **written NOWHERE**. So the pool was permanently 0, and because the
// picker also filtered `vantraAgentId: { not: null }` — which a browser we run
// ourselves can never satisfy — the destination could never be selected. That
// is why the owner's Start button kept answering "no hosted clone PC is
// available" no matter what was set up on their side.
//
// WHAT THIS IS, IN PLAIN WORDS (owner's design): the clone's browser runs in
// **our** Neko browser on **our** server — one browser, one Chrome profile per
// clone job, with that job's traffic leaving through the user's own device via
// the relay. It is NOT a second PC belonging to the user, and never the
// customer's machine. This module creates the `Device` row that REPRESENTS our
// browser, because `CloneJob.destinationDeviceId` is a foreign key to `Device`.
//
// The row is infrastructure, not something the user owns: it carries no agent
// (`vantraAgentId = null`) by design, and `app/api/devices/route.ts` hides
// `deviceKind: "hosted"` from the device list so it never appears as a PC the
// user thinks they have to look after.

/** Shown in copy that names the destination; keep it user-facing and plain. */
export const HOSTED_DESTINATION_NAME = "SpaceWorker browser";

/**
 * Idempotently create this account's hosted destination row and return its id.
 *
 * Idempotent by find-then-create on `(userId, deviceKind = "hosted")`. A plain
 * `upsert` is not usable here because `Device` has no unique constraint on that
 * pair, and adding one would be a schema migration for a value we control.
 *
 * Called from the two places that DECIDE a clone (the setup read model behind
 * the console card, and the Start gate), so the card and the gate always judge
 * the same reality. Safe to call on a poll: after the first call it is a single
 * indexed read and writes nothing.
 */
export async function ensureHostedDestination(userId: string): Promise<string> {
  const existing = await db.device.findFirst({
    where: { userId, deviceKind: "hosted" },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  if (existing) return existing.id;

  const created = await db.device.create({
    data: {
      userId,
      name: HOSTED_DESTINATION_NAME,
      deviceKind: "hosted",
      // No `vantraAgentId` — deliberate, and the reason the old picker could
      // never see this row. Liveness of our own browser is not a heartbeat
      // question: it is answered by the browser subsystem's health and by the
      // relay probe, both of which fail closed at launch time.
      status: "online",
      osName: "Linux (SpaceWorker hosted)",
      lastSeenAt: new Date(),
    },
    select: { id: true },
  });
  return created.id;
}
