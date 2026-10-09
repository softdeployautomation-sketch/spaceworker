import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/admin-auth";
import { getAdminSettings } from "@/lib/admin-settings";
import { notifyUserInvoiceSent } from "@/lib/invoice-notify";
import { postInvoiceNoticeToUser } from "@/lib/support/tickets";

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
//   - `methods` defaults to the AdminSetting snapshot, but the support
//     composer's payment-details fields may OVERRIDE it explicitly (validated
//     key-by-key: three known chains, string or null) — an override beats the
//     snapshot, an unknown chain or unknown body key is a 400;
//   - `days` (TASK_187) is an optional admin term override: integer ≥ 1 only,
//     NULL/absent = the standard term; consumed ONLY by settleLinkedInvoice
//     and NEVER returned to the user (TASK_181);
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

// TASK_187 B2 (MONEY) — the composer's optional term override. `undefined` =
// leave as-is (on create: no override), `null` = clear an override on PATCH,
// integer ≥ 1 = the admin's term. 0, negatives, 1.5 and non-numbers are all
// refused HERE (route), with the DB CHECK as the second line of defense.
function parseDays(v: unknown): { ok: true; value: number | null | undefined } | { ok: false; error: string } {
  if (v === undefined) return { ok: true, value: undefined };
  if (v === null) return { ok: true, value: null };
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
    return { ok: false, error: "days must be a whole number ≥ 1 (or null to clear)" };
  }
  return { ok: true, value: v };
}

const METHOD_KEYS = ["btc", "usdt_trc20", "usdt_erc20"] as const;

// Optional override of the payout-address snapshot: exactly the three chains
// the composer knows, each a string or null (null = this chain is not offered
// on this invoice). Anything else — unknown key, number, nested object — is a
// 400: a mistyped destination would send money nowhere.
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

// Strict bodies (TASK_187): a typo'd key must be REFUSED, not silently ignored
// — otherwise "daysx: 45" would create a default-term invoice the admin thinks
// is overridden.
// `tier` is accepted-but-IGNORED (the plan derives it) — an existing contract
// (test: "a client-sent tier is ignored") must not start 400ing; every other
// unknown key still does.
const ALLOWED_KEYS = new Set(["plan", "amountUsd", "tier", "days", "methods"]);

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

// POST /api/admin/users/[id]/invoices — body: { plan, amountUsd?, days?, methods? }
export async function POST(req: Request, ctx: RouteContext) {
  const isAdmin = await getAdminSession();
  if (!isAdmin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id: userId } = await ctx.params;
  let body: { plan?: unknown; amountUsd?: unknown; tier?: unknown; days?: unknown; methods?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Strict: unknown keys are refused, never ignored (see ALLOWED_KEYS).
  const unknownKey = Object.keys(body).find((k) => !ALLOWED_KEYS.has(k));
  if (unknownKey) {
    return NextResponse.json({ error: `Unknown field: ${unknownKey}` }, { status: 400 });
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
  const days = parseDays(body.days);
  if (!days.ok) return NextResponse.json({ error: days.error }, { status: 400 });
  const methods = parseMethods(body.methods);
  if (!methods.ok) return NextResponse.json({ error: methods.error }, { status: 400 });

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true } });
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
      // null: an unconfigured chain simply isn't offered on this invoice. An
      // explicit composer override (TASK_187) is merged OVER the snapshot —
      // override beats snapshot, key by key.
      methods: {
        btc: settings.btcWallet,
        usdt_trc20: settings.usdtWallet,
        usdt_erc20: settings.usdtErc20Wallet,
        ...(methods.value ?? {}),
      },
      // TASK_187 — term override only when the admin sent one; absent key on
      // purpose, so the column keeps its NULL default ("standard term").
      ...(typeof days.value === "number" ? { days: days.value } : {}),
    },
  });

  // TASK_187 B3 — tell the user an invoice is waiting for them. Fire-and-forget
  // (same contract as the support/payment notifiers): the 201 above must not
  // depend on an email. notifyUserInvoiceSent skips non-email recipients and
  // .catch()es its own send; the outer try is belt-and-braces for a stub throw.
  try {
    notifyUserInvoiceSent({
      invoiceId: invoice.id,
      to: user.email,
      plan,
      amountUsd,
    });
  } catch {
    // Best-effort — invoice-notify already logged its own failure.
  }

  // TASK_194 S4 — land the invoice in the SUPPORT THREAD too. The button's
  // unread badge is derived from the thread's newest message, so a row-only
  // invoice was invisible there (owner: "it didn't show the notification on the
  // support button"). Same fire-and-forget contract as the email above: the 201
  // that already created the invoice can never be changed by this.
  try {
    const planLabel = plan === "premium_plus" ? "Premium Plus" : "Premium XDevice";
    void postInvoiceNoticeToUser(
      userId,
      invoice.id,
      "admin",
      `A ${planLabel} invoice for $${amountUsd} is waiting for you — open Billing to view and pay it.`,
    ).catch(() => {
      // Best-effort; support-tickets logs its own failures.
    });
  } catch {
    // Best-effort — never let a notice failure fail the invoice that was sent.
  }

  return NextResponse.json({ invoice }, { status: 201 });
}
