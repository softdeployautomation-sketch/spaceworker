import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdminSession } from "@/lib/admin-auth";
import {
  grantEntitlement,
  revokeEntitlement,
  listEffectiveEntitlements,
  isEntitlementKey,
} from "@/lib/entitlements";
import { recordAgentActionAudit } from "@/lib/devices";

// Task 92 — admin grant/revoke/list for UserEntitlement (plan §COMMERCIAL C1:
// "Admin grant/revoke per user"). Every mutation is audited. Tier 5 premium
// implicitly covers every key (see lib/entitlements.ts), so a grant is only
// needed to outlive a premium downgrade.

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: RouteContext) {
  const isAdmin = await requireAdminSession();
  if (!isAdmin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  // NOTE: the slug is [id] to match the sibling grant-premium/tier routes —
  // Next.js forbids different slug names at the same dynamic level.
  const { id: userId } = await ctx.params;
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true } });
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

  const effective = await listEffectiveEntitlements(userId);
  return NextResponse.json({ user: { id: user.id, email: user.email }, ...effective });
}

export async function POST(req: Request, ctx: RouteContext) {
  const isAdmin = await requireAdminSession();
  if (!isAdmin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id: userId } = await ctx.params;
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const key = body.key;
  if (!isEntitlementKey(key)) {
    return NextResponse.json(
      { error: `key must be one of: extractor, mailer, assistant, devices, cyberlab` },
      { status: 400 },
    );
  }
  const expiresInDays =
    typeof body.expiresInDays === "number" && body.expiresInDays > 0
      ? Math.floor(body.expiresInDays)
      : undefined;

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

  await grantEntitlement({ userId, key, source: "admin_grant", expiresInDays });
  await recordAgentActionAudit({
    userId,
    action: "entitlement_grant",
    status: "executed",
    initiatingChannel: "api",
    approvalChannel: "admin",
    detail: { key, expiresInDays: expiresInDays ?? null },
  });
  return NextResponse.json({ ok: true, granted: key });
}

export async function DELETE(req: Request, ctx: RouteContext) {
  const isAdmin = await requireAdminSession();
  if (!isAdmin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id: userId } = await ctx.params;
  const key = new URL(req.url).searchParams.get("key");
  if (!isEntitlementKey(key)) {
    return NextResponse.json({ error: "key query param required" }, { status: 400 });
  }

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

  await revokeEntitlement(userId, key);
  await recordAgentActionAudit({
    userId,
    action: "entitlement_revoke",
    status: "executed",
    initiatingChannel: "api",
    approvalChannel: "admin",
    detail: { key },
  });
  return NextResponse.json({ ok: true, revoked: key });
}