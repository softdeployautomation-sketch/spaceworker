import { NextResponse } from "next/server";
import { z } from "zod";

import { requireAdminSession } from "@/lib/admin-auth";
import { prisma } from "@/lib/prisma";
import {
  addUserDomain,
  listAllDomains,
  removeUserDomain,
} from "@/lib/hosting/domain-registry";

// TASK_157 Phase 4 — the ADMIN's view of the domain registry.
//
//   GET    -> EVERY domain, users' and platform's (this is the one place the
//              platform-only guard is NOT applied, so the owner can see and manage
//              the platform's own zones)
//   POST   -> add a domain ON A USER'S BEHALF (source: "manual")
//   DELETE -> remove any domain
//
// WHY AN ADMIN ROUTE EXISTS. The owner's rule is that users may only select domains
// they own. But a domain the user bought at an external registrar, or one they have
// not yet pointed at Cloudflare, cannot be self-added. This is the owner's path to
// attach one to a user — and it is deliberately the ONLY way a domain can be
// attributed to a user other than the one who added it.
//
// GUARDS, in order:
//   1. `requireAdminSession` — the same gate the caps route uses.
//   2. `ownerUserId` must be a REAL, existing user. Without this check an admin
//      typo would silently create a domain owned by nobody, which is a row that no
//      user can ever see or delete (the ownership filter needs a matching id) —
//      i.e. a domain permanently stuck in limbo. It is checked here so it fails
//      loudly and immediately instead.
//   3. `addUserDomain` then applies the same platform-wide rules as the user path:
//      Cloudflare's name rules, the reserved/platform-only denylists, and
//      claim-once. The admin does NOT get a bypass, because "only one owner per
//      apex" and "never `mainaccess.top`" are invariants of the data, not
//      preferences of a role.

export async function GET() {
  if (!(await requireAdminSession())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const domains = await listAllDomains();
  if (!domains.ok) {
    return NextResponse.json({ error: domains.message, code: domains.code }, { status: domains.status });
  }
  return NextResponse.json({ domains: domains.value });
}

const postSchema = z.object({
  domain: z.string().min(1).max(253),
  // The user this domain belongs to. REQUIRED: attributing a domain to nobody is
  // never a useful outcome, so the admin must name the owner.
  userId: z.string().min(1).max(200),
  label: z.string().max(120).optional(),
});

export async function POST(request: Request) {
  if (!(await requireAdminSession())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let parsed;
  try {
    parsed = postSchema.parse(await request.json());
  } catch (e) {
    const msg = e instanceof z.ZodError ? e.errors[0]?.message : "Invalid request body";
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  // Guard (2) — see the note above. Checked before insert, not after.
  const owner = await prisma.user.findUnique({ where: { id: parsed.userId }, select: { id: true } });
  if (!owner) {
    return NextResponse.json(
      { error: "That user does not exist.", code: "unknown_user" },
      { status: 400 }
    );
  }

  const added = await addUserDomain(parsed.userId, parsed.domain, { source: "manual" });
  if (!added.ok) {
    return NextResponse.json({ error: added.message, code: added.code }, { status: added.status });
  }

  if (parsed.label) {
    const relabelled = await prisma.userDomain.update({
      where: { id: added.value.id },
      data: { label: parsed.label },
    });
    return NextResponse.json({ domain: { ...added.value, label: relabelled.label } }, { status: 201 });
  }
  return NextResponse.json({ domain: added.value }, { status: 201 });
}

export async function DELETE(request: Request) {
  if (!(await requireAdminSession())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let id: string | null = null;
  // Guarded like DELETE in the platform-accounts route: the panel still renders
  // for a caller whose URL has no id, instead of the whole request exploding.
  try {
    id = new URL(request.url).searchParams.get("id");
  } catch {
    id = null;
  }
  if (!id) {
    return NextResponse.json({ error: "Which domain? Pass ?id=…", code: "missing_id" }, { status: 400 });
  }

  // `asAdmin` is the only reason removeUserDomain skips the ownership check, and
  // it is hard-coded TRUE here rather than taken from the request — an admin flag
  // that came from user input would be an authorization bypass.
  const result = await removeUserDomain("", id, { asAdmin: true });
  if (!result.ok) {
    return NextResponse.json({ error: result.message, code: result.code }, { status: result.status });
  }
  return NextResponse.json({ ok: true, id: result.value.id });
}