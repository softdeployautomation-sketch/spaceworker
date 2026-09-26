import { NextResponse } from "next/server";

import { db } from "@/lib/db";
import { getSession } from "@/lib/session";
import { type CloneView, isCloneState, listClones, requestClone } from "@/lib/clone";

export const dynamic = "force-dynamic";

// TASK_110 (bit B4) — Browser Clone API, device side (the console's clone tab).
//   GET  ?role=source|destination|any&status=<state>&limit=50
//        → clone history for THIS device, newest first (the UI's history list).
//   POST { egress, browser?, profile?, destinationDeviceId?, sessionMode? }
//        → start a clone. 201 created · 202 when the governor queued it.
//
// Route rules (TASK_110) this file implements:
// 1. Thin — validation, auth, owner-scope, error mapping only. The lifecycle,
//    EVERY gate and EVERY audit row live in lib/clone.ts (TASK_109); this route
//    writes no audit row on purpose (a second row per transition makes the
//    trail useless).
// 2. Gating is server-side and the orchestrator owns it: requestClone() refuses
//    un-entitled users, `direct` egress without premium while
//    cloneDirectEgressPremiumOnly is on, a paused feature, an unowned or
//    unlinked device, a missing relay and a missing hosted clone PC — it audits
//    each refusal, then throws its human reason. This route only TRANSLATES
//    that refusal into an explicit HTTP status (403/404/409/400), never a silent
//    success and never a second gate that could drift from the audited one.
// 3. Owner-scope: the source device is resolved from session.userId inside
//    requestClone; a device that is not the caller's is 404, never 403.
// 4. Clean errors: reasons are sanitised, so no raw upstream body (HTML) can
//    ever reach the client — the UI copy keys on `reason`, never on `error`.
// 5. The governor's queue is a 202 with the reason, not an error.
//
// `pendingActionId` is deliberately NOT accepted from the body: an
// agent-initiated clone goes through its own proposal rail (Task 93) and a
// client must never be able to inject an approval id.

const ROLES = new Set(["source", "destination", "any"]);
const BROWSERS = new Set(["chrome", "edge", "firefox"]);

/** Never let a raw upstream body (HTML) reach the client (rule 4). */
function sanitize(message: string): string {
  return /<!DOCTYPE|<html/i.test(message)
    ? "clone_unavailable: the agent answered with an HTML page (deploy outdated?) — check the Vantra deploy."
    : message;
}

function unknownMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Refusal → HTTP translation. The orchestrator throws the human reason (and
 * audits it); this table is the ONLY mapping, so an unknown refusal can degrade
 * to a 500 but can never be mistaken for a success.
 */
const REFUSALS: readonly { pattern: RegExp; code: string; status: number }[] = [
  { pattern: /paused by the administrator/, code: "clone_sessions_paused", status: 403 },
  { pattern: /not included in your current plan/, code: "browser_clone_not_in_plan", status: 403 },
  { pattern: /Premium feature/, code: "direct_egress_requires_premium", status: 403 },
  { pattern: /not linked to the agent/, code: "device_not_linked", status: 404 },
  { pattern: /does not belong to your account/, code: "not_found", status: 404 },
  { pattern: /No egress relay is registered/, code: "relay_not_registered", status: 409 },
  { pattern: /No hosted clone PC is available/, code: "no_hosted_clone_device", status: 409 },
  {
    pattern: /different devices|same PC it captures from|must be a hosted clone PC|Egress must be|Unsupported browser|Profile name may only/,
    code: "clone_refused",
    status: 400,
  },
];

/** Database/unknown failure — no internals, no HTML, always JSON. */
function failure(err: unknown): NextResponse {
  const raw = unknownMessage(err);
  const rule = REFUSALS.find((r) => r.pattern.test(raw));
  if (rule) {
    return NextResponse.json({ error: rule.code, reason: sanitize(raw) }, { status: rule.status });
  }
  // Unknown/DB failure: never echo engine internals (file paths, SQL, Prisma
  // invocation dumps) — a generic reason plus a stable code. The detail is in
  // the server log, not the response.
  return NextResponse.json(
    { error: "clone_request_failed", reason: "The clone service could not start that request." },
    { status: 500 },
  );
}

/**
 * Human copy for a governor hold (the raw reason rides along as `queueReason`).
 * TASK_105 — when the governor is ON and the request holds a real queue row, the
 * copy leads with the honest place in line ("Waiting for a free slot — 2 ahead
 * of you"), which is what the task's acceptance asks the user to see. With the
 * governor OFF (position 0/absent) this is byte-identical to pre-TASK_105 copy.
 */
function queueMessage(reason?: string, position?: number): string {
  if (reason === "clone_sessions_paused") return "Browser clone is paused by the administrator.";
  if (reason?.startsWith("per_user_cap")) {
    return "You already have a live clone — this one is queued and starts when that session ends.";
  }
  if (typeof position === "number" && position > 0) {
    return `Waiting for a free slot — ${position} ahead of you.`;
  }
  if (!reason) return "All clone slots are busy — this clone is queued and will start automatically.";
  return `All clone slots are busy right now — this clone is queued and will start automatically (${reason}).`;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ deviceId: string }> },
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { deviceId } = await params;

  const url = new URL(req.url);
  const role = url.searchParams.get("role") ?? "source";
  if (!ROLES.has(role)) {
    return NextResponse.json(
      { error: "bad_role", reason: "role must be source, destination or any." },
      { status: 400 },
    );
  }
  const statusFilter = url.searchParams.get("status");
  if (statusFilter && !isCloneState(statusFilter)) {
    return NextResponse.json(
      { error: "bad_status", reason: "Unknown clone status filter." },
      { status: 400 },
    );
  }
  const limitRaw = Number(url.searchParams.get("limit"));
  const limit =
    Number.isFinite(limitRaw) && limitRaw >= 1 ? Math.min(Math.floor(limitRaw), 200) : 50;

  try {
    // Ownership gate FIRST (rule 3) — a device that is not the caller's gets the
    // same 404 as a missing id; never a 403 that confirms it exists.
    const device = await db.device.findFirst({
      where: { id: deviceId, userId: session.userId },
      select: { id: true, name: true },
    });
    if (!device) {
      return NextResponse.json({ error: "not_found", reason: "No such device." }, { status: 404 });
    }

    const filters = statusFilter ? { status: statusFilter } : {};
    let clones: CloneView[];
    if (role === "any") {
      // A clone involves two devices: `any` answers "everything this machine
      // took part in" (source = captured from, destination = hosted clone PC).
      const [asSource, asDestination] = await Promise.all([
        listClones(session.userId, { ...filters, sourceDeviceId: deviceId, limit }),
        listClones(session.userId, { ...filters, destinationDeviceId: deviceId, limit }),
      ]);
      const byId = new Map<string, CloneView>();
      for (const clone of [...asSource.clones, ...asDestination.clones]) byId.set(clone.id, clone);
      clones = [...byId.values()]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit);
    } else {
      const scope =
        role === "destination" ? { destinationDeviceId: deviceId } : { sourceDeviceId: deviceId };
      clones = (await listClones(session.userId, { ...filters, ...scope, limit })).clones;
    }

    // `deleted` is a tombstone (TASK_112's sweep removes the row), not history.
    clones = clones.filter((clone) => clone.status !== "deleted");

    return NextResponse.json({
      ok: true,
      deviceId,
      deviceName: device.name,
      role,
      clones,
    });
  } catch (err) {
    return failure(err);
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ deviceId: string }> },
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { deviceId } = await params;

  let body: {
    egress?: unknown;
    browser?: unknown;
    profile?: unknown;
    destinationDeviceId?: unknown;
    sessionMode?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const egress = body.egress;
  if (egress !== "relay" && egress !== "direct") {
    return NextResponse.json({ error: "egress must be relay or direct." }, { status: 400 });
  }
  if (
    body.browser !== undefined &&
    !(typeof body.browser === "string" && BROWSERS.has(body.browser))
  ) {
    return NextResponse.json({ error: "browser must be chrome, edge or firefox." }, { status: 400 });
  }
  if (body.profile !== undefined && typeof body.profile !== "string") {
    return NextResponse.json({ error: "profile must be a string." }, { status: 400 });
  }
  if (
    body.destinationDeviceId !== undefined &&
    !(typeof body.destinationDeviceId === "string" && body.destinationDeviceId.length > 0)
  ) {
    return NextResponse.json({ error: "destinationDeviceId must be a device id." }, { status: 400 });
  }
  // TASK_119: sessionMode validation (optional, defaults to "fresh" in requestClone).
  if (
    body.sessionMode !== undefined &&
    !(typeof body.sessionMode === "string" && ["fresh", "live"].includes(body.sessionMode))
  ) {
    return NextResponse.json({ error: "sessionMode must be 'fresh' or 'live'." }, { status: 400 });
  }
  // An empty/blank profile means "use the engine default", not a blank name.
  // The format rule itself lives in the orchestrator (PROFILE_NAME_RE).
  const profile =
    typeof body.profile === "string" && body.profile.trim() ? body.profile.trim() : undefined;

  try {
    const result = await requestClone({
      userId: session.userId,
      sourceDeviceId: deviceId,
      ...(typeof body.destinationDeviceId === "string"
        ? { destinationDeviceId: body.destinationDeviceId }
        : {}),
      egress,
      ...(typeof body.browser === "string"
        ? { browser: body.browser as "chrome" | "edge" | "firefox" }
        : {}),
      ...(profile ? { profile } : {}),
      ...(typeof body.sessionMode === "string"
        ? { sessionMode: body.sessionMode as "fresh" | "live" }
        : {}),
    });

    if (result.queued) {
      // Governor hold — honest state, not an error (rule 5 / TASK_105 seam).
      return NextResponse.json(
        {
          ok: true,
          cloneId: result.cloneId,
          status: result.status,
          queued: true,
          queueReason: result.queueReason,
          // TASK_105 — the place in line, when the governor is on and the hold
          // is a persisted queue row (absent otherwise, so the UI copy falls
          // back to exactly what it said before this task).
          ...(result.queuePosition ? { queuePosition: result.queuePosition } : {}),
          ...(result.queueEtaSeconds ? { etaSeconds: result.queueEtaSeconds } : {}),
          message: queueMessage(result.queueReason, result.queuePosition),
        },
        { status: 202 },
      );
    }

    return NextResponse.json(
      {
        ok: true,
        cloneId: result.cloneId,
        status: result.status,
        queued: false,
        message: "Clone requested — it starts as soon as the work PC and its relay are ready.",
      },
      { status: 201 },
    );
  } catch (err) {
    return failure(err);
  }
}
