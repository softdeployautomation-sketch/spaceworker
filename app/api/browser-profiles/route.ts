import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";
import { createProfileDir } from "@/lib/browser-profiles";
import { PROFILE_SAFE_SELECT } from "@/lib/browser-profile-safe-select";
import { moduleToolsDenied } from "@/lib/module-gate";

// GET /api/browser-profiles — list the signed-in user's profiles.
export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const profiles = await prisma.browserProfile.findMany({
    where: { userId: session.userId },
    select: PROFILE_SAFE_SELECT,
    orderBy: { createdAt: "asc" },
  });

  // Serialize Date fields as ISO strings.
  return NextResponse.json(
    profiles.map((p) => ({
      ...p,
      lastUsedAt: p.lastUsedAt?.toISOString() ?? null,
      createdAt: p.createdAt.toISOString(),
    }))
  );
}

// POST /api/browser-profiles — body: { name: string }. `browser` module required.
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // TASK_184 A6.2 — browser is a MODULE: the `browser` entitlement key decides
  // (tier 5 or an explicit grant), never a tier number. Tier-3 Premium XDevice
  // and free tier 1 both get 403 browser_required.
  const denied = await moduleToolsDenied(session.userId, "browser");
  if (denied) return denied;

  let body: { name?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const name = String(body.name ?? "").trim();
  if (!/^[\w\s-]{1,50}$/.test(name)) {
    return NextResponse.json(
      { error: "Name must be 1-50 characters (letters, numbers, spaces, hyphens or underscores)" },
      { status: 400 }
    );
  }

  const existing = await prisma.browserProfile.count({
    where: { userId: session.userId, name },
  });
  if (existing > 0) {
    return NextResponse.json(
      { error: "A profile with that name already exists" },
      { status: 400 }
    );
  }

  // 1. Create the DB record — Prisma generates the cuid id.
  const profile = await prisma.browserProfile.create({
    data: { userId: session.userId, name, dirPath: "pending" }, // temporary placeholder
  });

  // 2. Create the directory using the real id.
  try {
    const dirPath = await createProfileDir(profile.id);
    // 3. Update the record with the real dirPath.
    await prisma.browserProfile.update({
      where: { id: profile.id },
      data: { dirPath },
    });
  } catch (e) {
    console.error("Failed to create profile directory", e);
    await prisma.browserProfile.delete({ where: { id: profile.id } }).catch(() => {});
    return NextResponse.json(
      { error: "Failed to create profile directory" },
      { status: 500 }
    );
  }

  // 4. Return the safe fields.
  const result = await prisma.browserProfile.findUnique({
    where: { id: profile.id },
    select: PROFILE_SAFE_SELECT,
  });

  return NextResponse.json(
    result
      ? {
          ...result,
          lastUsedAt: result.lastUsedAt?.toISOString() ?? null,
          createdAt: result.createdAt.toISOString(),
        }
      : null,
    { status: 201 }
  );
}