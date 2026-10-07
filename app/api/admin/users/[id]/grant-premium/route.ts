import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/admin-auth";
import { grantPremium, grantXDeviceTerm } from "@/lib/premium";

// POST /api/admin/users/[id]/grant-premium — body: { days?: number, tier?: 3|5 }
// Grants (or extends) time-limited premium for a user. A fresh grant on a
// free/trial user sets tier 5 + premiumExpiresAt ~30 days out; calling it again
// on an already-premium user STACKS (extends from max(now, current expiry)) so
// admins can "give more time" without resetting. Identical semantics to a real
// web-subscription payment (bumpWebTier) and to Vantra's extendPremium — the
// granted access is indistinguishable from paid premium. Grant-only, no revoke;
// premium lapses naturally via the expiry + check-on-read reversion.
//
// TASK_181 P3 (step 29) — `tier: 3` is the XDevice wrapper term: same stacking
// grant via grantXDeviceTerm, but the account lands on tier 3 (devices-only)
// instead of tier 5. This is the owner's admin surface to GRANT a first term
// and to EXTEND an active tier-3 term ("increase their monthly subscription
// duration") — the expiry stays server-side and is returned only to this
// admin caller, never to any end-user UI (owner: "never show it on ui how long
// the premium is for"). `tier: 5` (or omitted) = today's behavior, unchanged.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const isAdmin = await getAdminSession();
  if (!isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { id } = await params; // MUST await — async in Next.js 16

  let body: { days?: unknown; tier?: unknown };
  let days = 30; // matching Vantra's PREMIUM_DAYS_PER_CHARGE
  let tier = 5; // TASK_181: 3 = XDevice wrapper term, 5 = Premium (default)
  try {
    body = await req.json();
    if (body.days !== undefined) {
      const n = Number(body.days);
      if (!Number.isInteger(n) || n <= 0 || n > 3650) {
        return NextResponse.json(
          { error: "days must be an integer in 1..3650" },
          { status: 400 },
        );
      }
      days = n;
    }
    if (body.tier !== undefined) {
      const t = Number(body.tier);
      if (t !== 3 && t !== 5) {
        return NextResponse.json(
          { error: "tier must be 3 (XDevice) or 5 (Premium)" },
          { status: 400 },
        );
      }
      tier = t;
    }
  } catch {
    // no/empty body → default 30 days, tier 5
  }

  const exists = await prisma.user.findUnique({ where: { id }, select: { id: true } });
  if (!exists) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  // tier 3 → the XDevice term (never-lower-hard-rule inside: an ACTIVE tier-5
  // account is left untouched and null comes back). tier 5 → unchanged behavior.
  const premiumExpiresAt =
    tier === 3 ? await grantXDeviceTerm(id, days) : await grantPremium(id, days);
  const user = await prisma.user.findUnique({
    where: { id },
    select: { id: true, email: true, tier: true, premiumExpiresAt: true },
  });
  // Expiry echoed to the ADMIN caller only — no end-user surface renders it.
  return NextResponse.json({
    ...user,
    premiumExpiresAt: (premiumExpiresAt ?? user?.premiumExpiresAt)?.toISOString() ?? null,
  });
}