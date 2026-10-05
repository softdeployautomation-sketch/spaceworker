import { NextResponse } from "next/server";
import { getAdminSession } from "@/lib/admin-auth";
import { grantBalance } from "@/lib/wallet";

// POST /api/admin/wallet/grant — body: { userId, amountCents, note, idempotencyKey }
//
// PLAN_TASK_167 W3. The one route an admin uses to move a balance by hand.
//
// THE ORDER OF THE FIRST TWO STATEMENTS IS THE POINT (plan §3.1). The admin
// session is checked BEFORE `req.json()` is ever called, because parsing a body
// is work done on behalf of whoever sent it: a non-admin must not be able to make
// this server do anything at all, let alone hold a parsed object describing how
// much money to mint. The 403 is returned from an unread request.
//
// WHY `adminId` IS NOT IN THE CONTRACT. The body's fields are
// userId/amountCents/note/idempotencyKey and the admin is taken from the SESSION,
// so there is no field a caller can set to forge attribution. A body-supplied
// `adminId` would be the single most damaging thing this route could accept: it
// would let one admin write another admin's name on a balance change, which is
// worse than an unattributed one because it is a false attribution wearing the
// shape of an audit trail.
export async function POST(req: Request) {
  const session = await getAdminSession();
  if (!session) {
    // Deliberately before any body handling. See above.
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: {
    userId?: unknown;
    amountCents?: unknown;
    note?: unknown;
    idempotencyKey?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  // `Number(...)` rather than a typeof check, because a JSON amount is a number
  // and an HTML form field is a string; accepting both here means the route does
  // not care which caller shape arrived. It is NOT a coercion that can launder a
  // float: `Number("12.5")` stays 12.5, and `grantBalance` refuses any
  // non-integer, so no float ever reaches the ledger (plan §3.5). `Number("")` is
  // 0 and `Number("  ")` is 0, both caught by the zero check as a missing amount
  // rather than silently becoming a real grant of nothing.
  const amountCents = Number(body.amountCents);
  if (!Number.isFinite(amountCents)) {
    return NextResponse.json({ error: "Invalid amount" }, { status: 400 });
  }
  if (typeof body.userId !== "string" || body.userId.trim().length === 0) {
    return NextResponse.json({ error: "userId is required" }, { status: 400 });
  }
  if (typeof body.note !== "string") {
    return NextResponse.json({ error: "A note is required" }, { status: 400 });
  }
  // Optional. The UNIQUE index on the column is the real guard (see `move()`);
  // this is only so a client retrying the SAME logical request — an admin
  // double-clicking Save, a flaky admin-panel fetch — cannot produce two credits.
  const idempotencyKey =
    typeof body.idempotencyKey === "string" && body.idempotencyKey.trim().length > 0
      ? body.idempotencyKey.trim().slice(0, 200)
      : undefined;

  const result = await grantBalance({
    userId: body.userId.trim(),
    amountCents,
    adminId: session.sub,
    note: body.note,
    idempotencyKey,
  });

  if (!result.ok) {
    // Two ways a replay is refused, and they are different faults:
    //   * `idempotency_key_conflict` — the key exists but belongs to ANOTHER user.
    //     That is a caller bug (or an attack), and `move()` has already turned it
    //     into a named 409 rather than a silent cross-account success.
    //   * a same-user replay comes back `ok` with `replayed: true`, because the
    //     UNIQUE index did its job and the money moved exactly once. That is
    //     correct for a webhook, but an admin form asked to "grant once" and told
    //     "done" twice is indistinguishable from two real grants, so it is
    //     answered 409 here. The guard stays the index either way; this is only
    //     the shape of the answer.
    if (result.code === "idempotency_key_conflict" || result.code === "payment_already_credited") {
      return NextResponse.json({ error: result.message }, { status: 409 });
    }
    // Everything else keeps the service's own status, so the panel shows the real
    // reason (unknown user, no note, bad amount) instead of a generic failure.
    return NextResponse.json({ error: result.message }, { status: result.status });
  }

  if (result.value.replayed) {
    return NextResponse.json(
      { error: "That grant was already applied — nothing was credited twice." },
      { status: 409 },
    );
  }

  return NextResponse.json({
    ok: true,
    kind: result.value.kind,
    amountCents: result.value.amountCents,
    balanceCents: result.value.balanceCents,
  });
}
