import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";
import { canUseExitNodes } from "@/lib/premium";
import { getExitNode } from "@/lib/exit-nodes";

// GET /api/settings/extract-region — the current saved value.
import { moduleToolsDenied } from "@/lib/module-gate";
export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { extractProxyRegion: true },
  });
  return NextResponse.json({ extractProxyRegion: user?.extractProxyRegion ?? null });
}

// PATCH /api/settings/extract-region — body: { region: string | null }
// The user's saved default region for lead-extraction jobs (premium),
// mirroring the mailbox sendRegion pattern exactly. Read at job-creation time
// (app/api/jobs/route.ts) and baked into that job's own params.proxyRegion —
// worker/automation.py's search_phase uses it as the FIRST-attempt route,
// with the existing block-detection fallback chain still covering it if that
// specific node is unavailable.
export async function PATCH(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const denied = await moduleToolsDenied(session.userId, "extractor");
  if (denied) return denied;

  let body: { region?: string | null };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const region = body.region && body.region.trim() ? body.region.trim() : null;
  if (region) {
    if (!(await canUseExitNodes(prisma, session.userId))) {
      return NextResponse.json({ error: "Regional extraction routing is a premium feature (or has been restricted)." }, { status: 403 });
    }
    if (!getExitNode(region)) {
      return NextResponse.json({ error: `Region "${region}" is not available right now.` }, { status: 400 });
    }
  }

  const user = await prisma.user.update({
    where: { id: session.userId },
    data: { extractProxyRegion: region },
    select: { extractProxyRegion: true },
  });

  return NextResponse.json(user);
}
