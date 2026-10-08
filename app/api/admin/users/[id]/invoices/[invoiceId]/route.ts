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

// TASK_187 B2 (MONEY) — same validators as POST (duplicated the way PLANS /
// AMOUNT_MAX_USD already are: sibling routes, no shared module, so a test can
// load either in isolation).
function parseDays(v: unknown): { ok: true; value: number | null | undefined } | { ok: false; error: string } {
  if (v === undefined) return { ok: true, value: undefined };
  if (v === null) return { ok: true, value: null }; // explicit clear → standard term
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
    return { ok: false, error: "days must be a whole number ≥ 1 (or null to clear)" };
  }
  return { ok: true, value: v };
}

const METHOD_KEYS = ["btc", "usdt_trc20", "usdt_erc20"] as const;

function parseMethods(
  v: unknown
): { ok: true; value: Record<string, string | null> | undefined } | { ok: false; error: string } {
  if (v === undefined) return { ok: true, value: undefined };
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    return { ok: false, error: "methods must be an object of payment details" };
  }
  const out: Record<string, string | null> = {};
  for (const [k, val] of Object.entries(v)) {
    if (!(METHOD_KEYS as readonly string[]).includes(k)) {
      return { ok: false, error: `methods.${k} is not a known payment method` };
    }
    if (val !== null && typeof val !== "string") {
      return { ok: false, error: `methods.${k} must be a string address or null` };
    }
    out[k] = val;
  }
  return { ok: true, value: out };
}

const ALLOWED_KEYS = new Set(["plan", "amountUsd", "days", "methods"]);

type RouteContext = { params: Promise<{ id: string; invoiceId: string }> };

// PATCH /api/admin/users/[id]/invoices/[invoiceId] — body: { amountUsd?, plan?, days?, methods? }
// At least one field must be present. `plan` present-but-invalid is a 400
// (never silently dropped), and an UNKNOWN key is a 400 too (TASK_187 strict
// bodies — a typo'd field must not look like a successful edit on money).
// `days: null` clears a term override back to the standard term; `methods` is
// only ever an EXPLICIT edit — a plan/amount change still never re-snapshots
// addresses on its own (the user may already be looking at the invoice).
export async function PATCH(req: Request, ctx: RouteContext) {
  const isAdmin = await getAdminSession();
  if (!isAdmin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id: userId, invoiceId } = await ctx.params;
  let body: { plan?: unknown; amountUsd?: unknown; days?: unknown; methods?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const unknownKey = Object.keys(body).find((k) => !ALLOWED_KEYS.has(k));
  if (unknownKey) {
    return NextResponse.json({ error: `Unknown field: ${unknownKey}` }, { status: 400 });
  }

  const hasAmount = body.amountUsd !== undefined;
  const hasPlan = body.plan !== undefined;
  const hasDays = body.days !== undefined;
  const hasMethods = body.methods !== undefined;
  if (!hasAmount && !hasPlan && !hasDays && !hasMethods) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const data: { amountUsd?: number; plan?: string; tier?: number; days?: number | null; methods?: Record<string, string | null> } = {};

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

  if (hasDays) {
    const days = parseDays(body.days);
    if (!days.ok) return NextResponse.json({ error: days.error }, { status: 400 });
    // number = set the override, null = clear it back to the standard term.
    data.days = days.value ?? null;
  }

  const methods = parseMethods(body.methods);
  if (!methods.ok) return NextResponse.json({ error: methods.error }, { status: 400 });

  const invoice = await prisma.premiumInvoice.findUnique({
    where: { id: invoiceId },
    select: { id: true, userId: true, status: true, methods: true },
  });
  // 404 before the ownership check would leak existence across users, but this
  // route is admin-only (403 above), so the simple checks are fine.
  if (!invoice || invoice.userId !== userId) {
    return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
  }
  if (invoice.status !== "open") {
    return NextResponse.json({ error: "Invoice is already settled" }, { status: 409 });
  }

  // Explicit methods edit merges over the CURRENT stored snapshot (chains the
  // admin didn't mention keep their values; a typed null hides that chain).
  if (hasMethods) {
    const base =
      invoice.methods !== null && typeof invoice.methods === "object" && !Array.isArray(invoice.methods)
        ? (invoice.methods as Record<string, string | null>)
        : {};
    data.methods = { ...base, ...(methods.value ?? {}) };
  }

  const updated = await prisma.premiumInvoice.update({
    where: { id: invoiceId },
    data,
  });
  return NextResponse.json({ invoice: updated });
}

// POST .../invoices/[invoiceId]/settle is B4 (payment approval). Nothing else
// mutates a paid row — see the model comment.
