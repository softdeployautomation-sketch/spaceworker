import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/admin-auth";

// TASK_184 B3 (MONEY) — re-edit an invoice the admin already sent, while it is
// still `open` (owner: "i can edit before sending to that user... and re-edit
// while the invoice is still open"). Once paid it is FROZEN: editing a settled
// invoice would rewrite payment evidence.
//
// Same money rules as POST (amount validated, tier derived from plan, methods
// untouched — the address snapshot belongs to the moment of sending; a plan
// switch does NOT re-snapshot because the user may already be looking at the
// invoice, and changing the destination mid-flight is worse than stale chains).

const PLANS = {
  premium_plus: 5,
  premium_xdevice: 3,
} as const;
type PlanName = keyof typeof PLANS;

const AMOUNT_MAX_USD = 100000;

type RouteContext = { params: Promise<{ id: string; invoiceId: string }> };

// PATCH /api/admin/users/[id]/invoices/[invoiceId] — body: { amountUsd?, plan? }
// At least one field must be present. Unknown/absent fields are ignored
// individually; `plan` present-but-invalid is a 400 (never silently dropped).
export async function PATCH(req: Request, ctx: RouteContext) {
  const isAdmin = await getAdminSession();
  if (!isAdmin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id: userId, invoiceId } = await ctx.params;
  let body: { plan?: unknown; amountUsd?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const hasAmount = body.amountUsd !== undefined;
  const hasPlan = body.plan !== undefined;
  if (!hasAmount && !hasPlan) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const data: { amountUsd?: number; plan?: string; tier?: number } = {};

  if (hasPlan) {
    if (typeof body.plan !== "string" || !(body.plan in PLANS)) {
      return NextResponse.json(
        { error: `plan must be one of: ${Object.keys(PLANS).join(", ")}` },
        { status: 400 },
      );
    }
    const plan = body.plan as PlanName;
    data.plan = plan;
    data.tier = PLANS[plan]; // re-derived with the plan — never read from body
  }

  if (hasAmount) {
    const n = Number(body.amountUsd);
    if (!Number.isFinite(n) || n <= 0 || n > AMOUNT_MAX_USD) {
      return NextResponse.json(
        { error: `amountUsd must be a number in 0..${AMOUNT_MAX_USD}` },
        { status: 400 },
      );
    }
    data.amountUsd = n;
  }

  const invoice = await prisma.premiumInvoice.findUnique({
    where: { id: invoiceId },
    select: { id: true, userId: true, status: true },
  });
  // 404 before the ownership check would leak existence across users, but this
  // route is admin-only (403 above), so the simple checks are fine.
  if (!invoice || invoice.userId !== userId) {
    return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
  }
  if (invoice.status !== "open") {
    return NextResponse.json({ error: "Invoice is already settled" }, { status: 409 });
  }

  const updated = await prisma.premiumInvoice.update({
    where: { id: invoiceId },
    data,
  });
  return NextResponse.json({ invoice: updated });
}

// POST .../invoices/[invoiceId]/settle is B4 (payment approval). Nothing else
// mutates a paid row — see the model comment.
