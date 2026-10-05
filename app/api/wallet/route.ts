import { NextResponse } from "next/server";

import { allowAndRecord, getClientIp } from "@/lib/rate-limit";
import { getCurrentUser } from "@/lib/session-user";
import { getWallet } from "@/lib/wallet";

export const dynamic = "force-dynamic";

// TASK_158 W2 — GET /api/wallet
//
// The authenticated read of the caller's own wallet. PLAN_TASK_158 §7 W2.
//
// THE USER ID COMES FROM THE SESSION ON THE REQUEST, AND FROM NOWHERE ELSE.
// There is no `?userId=` parameter to ignore and no body to read, because the
// tempting version of this route — "accept an id so the admin UI can reuse it" —
// is an account-takeover with a query string. `/api/admin/wallets` already exists
// for staff, and it does its own admin check. A route that can be pointed at
// somebody else's balance must not exist, so this one cannot be pointed at all.
// (Same rule as `app/api/support/tickets/route.ts`, and for the same reason.)
//
// EVERY FIGURE IS INTEGER CENTS. `getWallet()` returns them and this route
// passes them through unchanged. Formatting happens in the browser, in
// `components/wallet-balance.tsx`, and only for display — a formatted "$5.00"
// travelling back through an API is a float money bug waiting for a round trip.
//
// No new table and no migration: this is the read side of the W1 migration that
// is already deployed.
export async function GET() {
  const ip = await getClientIp();
  if (!(await allowAndRecord(ip, "wallet-read"))) {
    return NextResponse.json(
      { error: "Too many requests. Please try again shortly." },
      { status: 429 },
    );
  }

  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // A session can outlive its user: the cookie verifies, the row is gone (deleted
  // account, a restored backup). `getWallet` answers 404 for that rather than a
  // $0.00 balance, which would render as "you have no money" instead of "you are
  // signed in as nobody".
  const result = await getWallet(user.id);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.message, code: result.code },
      { status: result.status },
    );
  }

  return NextResponse.json({ wallet: result.value });
}