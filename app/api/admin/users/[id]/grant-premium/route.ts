import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/admin-auth";
import { grantPremium } from "@/lib/premium";

// POST /api/admin/users/[id]/grant-premium — body: { days?: number }
// Grants (or extends) time-limited premium for a user. A fresh grant on a
// free/trial user sets tier 5 + premiumExpiresAt ~30 days out; calling it again
// on an already-premium user STACKS (extends from max(now, current expiry)) so
// admins can "give more time" without resetting. Identical semantics to a real
// web-subscription payment (bumpWebTier) and to Vantra's extendPremium — the
// granted access is indistinguishable from paid premium. Grant-only, no revoke;
// premium lapses naturally via the expiry + check-on-read reversion.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const isAdmin = await getAdminSession();
  if (!isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { id } = await params; // MUST await — async in Next.js 16

  let body: { days?: unknown };
  let days = 30; // matching Vantra's PREMIUM_DAYS_PER_CHARGE
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
  } catch {
    // no/empty body → default 30 days
  }

  const exists = await prisma.user.findUnique({ where: { id }, select: { id: true } });
  if (!exists) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const premiumExpiresAt = await grantPremium(id, days);
  const user = await prisma.user.findUnique({
    where: { id },
    select: { id: true, email: true, tier: true, premiumExpiresAt: true },
  });
  return NextResponse.json({ ...user, premiumExpiresAt: premiumExpiresAt.toISOString() });
}