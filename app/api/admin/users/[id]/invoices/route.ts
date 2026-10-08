import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/admin-auth";
import { getAdminSettings } from "@/lib/admin-settings";

// TASK_184 B3 (MONEY) — send a premium-plan invoice to a user.
//
// The bridge between a premium-request ticket (B2's flagged queue rows) and an
// actual payment: the admin picks a plan, the amount comes PRE-FILLED with the
// configured default for that plan (editable — owner: "the pricing will be at
// the default price we set for each but i can edit before sending"), and the
// payout addresses are SNAPSHOT onto the invoice so the user can pay the exact
// invoice they were shown.
//
// Money rules enforced here, never trusted from the client:
//   - `tier` is DERIVED from `plan` server-side (a body tier is ignored);
//   - `amountUsd` defaults to the AdminSetting price for the plan and, if the
//     admin overrides it, is validated (finite, > 0, ≤ 100000 sanity cap);
//   - `methods` is read from AdminSetting at send time, never from the body;
//   - ONE open invoice per user — a second send 400s and the admin edits the
//     existing one instead (otherwise a user could be shown two contradictory
//     amounts for the same plan).
//
// The plan constants live here and in PATCH's sibling — the DB CHECK pins the
// same two strings, so an unknown plan cannot enter the table at all.

const PLANS = {
  premium_plus: 5, // Premium Plus — every web module
  premium_xdevice: 3, // Premium XDevice — devices only
} as const;
type PlanName = keyof typeof PLANS;

const AMOUNT_MAX_USD = 100000; // sanity cap, not a pricing decision

function parsePlan(v: unknown): PlanName | null {
  return typeof v === "string" && v in PLANS ? (v as PlanName) : null;
}

/** Shared validation for POST and PATCH — one place, both routes. */
function parseAmount(v: unknown): { ok: true; value: number } | { ok: false; error: string } {
  if (v === undefined) return { ok: true, value: NaN }; // caller supplies default
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > AMOUNT_MAX_USD) {
    return { ok: false, error: `amountUsd must be a number in 0..${AMOUNT_MAX_USD}` };
  }
  return { ok: true, value: n };
}

type RouteContext = { params: Promise<{ id: string }> };

// GET /api/admin/users/[id]/invoices — the admin form's list (open invoice +
// history) for one user. User-side visibility is the billing page's own
// session-scoped read (B4), never this route.
export async function GET(_req: Request, ctx: RouteContext) {
  const isAdmin = await getAdminSession();
  if (!isAdmin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id: userId } = await ctx.params;
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

  const invoices = await prisma.premiumInvoice.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({ invoices });
}

// POST /api/admin/users/[id]/invoices — body: { plan, amountUsd? }
export async function POST(req: Request, ctx: RouteContext) {
  const isAdmin = await getAdminSession();
  if (!isAdmin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id: userId } = await ctx.params;
  let body: { plan?: unknown; amountUsd?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const plan = parsePlan(body.plan);
  if (!plan) {
    return NextResponse.json(
      { error: `plan must be one of: ${Object.keys(PLANS).join(", ")}` },
      { status: 400 },
    );
  }
  const amount = parseAmount(body.amountUsd);
  if (!amount.ok) return NextResponse.json({ error: amount.error }, { status: 400 });

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

  const existing = await prisma.premiumInvoice.findFirst({
    where: { userId, status: "open" },
    select: { id: true },
  });
  if (existing) {
    return NextResponse.json(
      { error: "User already has an open invoice — edit that one instead", invoiceId: existing.id },
      { status: 400 },
    );
  }

  const settings = await getAdminSettings();
  const amountUsd = Number.isNaN(amount.value)
    ? plan === "premium_plus"
      ? settings.webSubscriptionPriceUsd
      : settings.xdevicePriceUsd
    : amount.value;

  const invoice = await prisma.premiumInvoice.create({
    data: {
      userId,
      plan,
      tier: PLANS[plan], // derived here — NEVER from the body
      amountUsd,
      // Snapshot of the configured payout addresses at send time. Null stays
      // null: an unconfigured chain simply isn't offered on this invoice.
      methods: {
        btc: settings.btcWallet,
        usdt_trc20: settings.usdtWallet,
        usdt_erc20: settings.usdtErc20Wallet,
      },
    },
  });
  return NextResponse.json({ invoice }, { status: 201 });
}
