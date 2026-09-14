import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";
import { SESSION_SAFE_SELECT } from "@/lib/browser-session-safe-select";
import { serializeSession } from "@/lib/browser-session-serialize";
import { browserRuntime, browserRuntimeAvailable } from "@/lib/browser-runtime";
import { getExitNode } from "@/lib/exit-nodes";
import { getAdminSettings } from "@/lib/admin-settings";
import {
  proxyServerValue as buildProxyArg,
  checkIpThroughProxy,
  checkDirectIp,
  type ProxyScheme,
  type ProxySpec,
} from "@/lib/browser-proxy";

// Task 46 — this used to be a hardcoded constant (each session is a full
// Neko/Chrome streaming container, the real RAM cost). Now admin-adjustable at
// runtime via AdminSetting.browserSessionsMaxConcurrent (default 3, matching
// the old constant exactly) plus a pause toggle (browserSessionsEnabled).

type SessionRow = NonNullable<
  Awaited<ReturnType<typeof prisma.browserSession.findFirst>>
>;

class AcquireConflictError extends Error {
  code = "PROFILE_IN_USE";
  constructor() {
    super("profile already in use");
  }
}

/** Resolve the concrete proxy the launched Chrome should be pointed at. */
function resolveProxy(
  proxyMode: "free" | "byo",
  exitNodeId: string | null,
  profile: { byoProxyHost: string | null; byoProxyPort: number | null; byoProxyScheme: string | null; byoProxyUsername: string | null; byoProxyAuth: string | null }
): { arg: string; spec: ProxySpec | null; byoSnapshot: Record<string, string | number | null> } {
  if (proxyMode === "free") {
    // No location picked (or none configured yet) — direct connection through
    // the server's own IP rather than blocking the user from launching at all.
    if (!exitNodeId) return { arg: "", spec: null, byoSnapshot: {} };
    const node = getExitNode(exitNodeId);
    if (!node) throw new Error("Selected exit node is not configured");
    const spec: ProxySpec = { scheme: node.scheme, host: node.host, port: node.port };
    return { arg: buildProxyArg(spec), spec, byoSnapshot: {} };
  }
  if (!profile.byoProxyHost || !profile.byoProxyPort || !profile.byoProxyScheme) {
    throw new Error("Add a BYO proxy to this profile first");
  }
  const scheme = profile.byoProxyScheme as ProxyScheme;
  const spec: ProxySpec = { scheme, host: profile.byoProxyHost, port: profile.byoProxyPort };
  return {
    arg: buildProxyArg(spec),
    spec,
    byoSnapshot: {
      byoProxyHost: profile.byoProxyHost,
      byoProxyPort: profile.byoProxyPort,
      byoProxyScheme: profile.byoProxyScheme,
      byoProxyUsername: profile.byoProxyUsername,
      byoProxyAuth: profile.byoProxyAuth,
    },
  };
}

// GET /api/browser-sessions — list the signed-in user's sessions.
export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const sessions = await prisma.browserSession.findMany({
    where: { userId: session.userId, hiddenAt: null },
    select: SESSION_SAFE_SELECT,
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json(sessions.map((s) => serializeSession(s as SessionRow)));
}

// POST /api/browser-sessions — start an interactive session.
// body: { profileId, proxyMode: "free" | "byo", exitNodeId? }
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { profileId?: string; proxyMode?: string; exitNodeId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const profileId = String(body.profileId ?? "").trim();
  const proxyMode: "free" | "byo" = body.proxyMode === "byo" ? "byo" : "free";
  const exitNodeId = body.exitNodeId ? String(body.exitNodeId) : null;
  if (!profileId) {
    return NextResponse.json({ error: "profileId is required" }, { status: 400 });
  }

  // Pro tier required (browser profiles are a Pro feature too).
  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { tier: true },
  });
  if (!user || user.tier < 1) {
    return NextResponse.json(
      { error: "Pro plan required to start a browser session" },
      { status: 403 }
    );
  }

  // The profile must belong to this user.
  const profile = await prisma.browserProfile.findFirst({
    where: { id: profileId, userId: session.userId },
  });
  if (!profile) {
    return NextResponse.json({ error: "Profile not found" }, { status: 404 });
  }

  // Task 46 — admin pause + admin-adjustable concurrency cap, across ALL users
  // (the subsystem must service this many Chrome/streaming processes). Existing
  // active sessions are never touched — pausing/lowering the cap only blocks NEW
  // starts.
  const adminSettings = await getAdminSettings();
  if (!adminSettings.browserSessionsEnabled) {
    return NextResponse.json(
      { error: "Browser sessions are temporarily paused by an admin." },
      { status: 409 }
    );
  }
  const maxConcurrentSessions = Math.max(1, adminSettings.browserSessionsMaxConcurrent);
  const active = await prisma.browserSession.count({
    where: { status: { in: ["starting", "running"] } },
  });
  if (active >= maxConcurrentSessions) {
    return NextResponse.json(
      {
        error: `Concurrency limit reached — ${maxConcurrentSessions} browser session${maxConcurrentSessions === 1 ? "" : "s"} already active. Stop one before starting another.`,
      },
      { status: 409 }
    );
  }

  // Resolve the proxy route before touching anything else.
  let resolved: { arg: string; spec: ProxySpec | null; byoSnapshot: Record<string, string | number | null> };
  try {
    resolved = resolveProxy(proxyMode, exitNodeId, profile);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Could not resolve proxy route" },
      { status: 400 }
    );
  }

  if (!browserRuntimeAvailable()) {
    return NextResponse.json(
      { error: "Browser runtime is not configured yet (BROWSER_SERVER_TOKEN unset)" },
      { status: 501 }
    );
  }
// Atomically acquire the profile (guarded on status=idle) + create the session
  // row. On any conflict we bail cleanly without leaving a stale lock behind.
  let created: Awaited<ReturnType<typeof prisma.browserSession.create>>;
  try {
    created = await prisma.$transaction(async (tx) => {
      const acquired = await tx.browserProfile.updateMany({
        where: { id: profile.id, status: "idle" },
        data: { status: "in_use" },
      });
      if (acquired.count === 0) throw new AcquireConflictError();
      return tx.browserSession.create({
        data: {
          userId: session.userId,
          profileId: profile.id,
          status: "starting",
          proxyMode,
          exitNodeId: proxyMode === "free" ? exitNodeId : null,
          byoProxyHost: (resolved.byoSnapshot.byoProxyHost as string | null) ?? null,
          byoProxyPort: (resolved.byoSnapshot.byoProxyPort as number | null) ?? null,
          byoProxyScheme: (resolved.byoSnapshot.byoProxyScheme as string | null) ?? null,
          byoProxyUsername: (resolved.byoSnapshot.byoProxyUsername as string | null) ?? null,
          byoProxyAuth: (resolved.byoSnapshot.byoProxyAuth as string | null) ?? null,
        },
      });
    });
  } catch (e) {
    if (e instanceof AcquireConflictError) {
      return NextResponse.json(
        { error: "This profile is already in use by another job or session" },
        { status: 409 }
      );
    }
    throw e;
  }

  // Real "what's my IP" check through the actual route this session uses —
  // an audit trail resilient to later exit-node config changes (unlike
  // exitNodeId alone, which just points at whatever exit-nodes.ts says
  // "us"/"ca"/etc. means TODAY). Fired concurrently with the container
  // launch below so it adds no serial latency; best-effort — a failed
  // check never blocks the session from starting.
  const ipCheckPromise = (resolved.spec ? checkIpThroughProxy(resolved.spec) : checkDirectIp()).catch(
    () => null,
  );

  // Hand the process launch to the standalone browser subsystem.
  const runtimeStart = await browserRuntime.start({
    sessionId: created.id,
    userId: session.userId,
    profileDir: profile.dirPath,
    proxyServerValue: resolved.arg,
  });

  if (!runtimeStart.ok) {
    // Launch failed — release the profile and mark the session failed.
    await prisma.$transaction([
      prisma.browserSession.update({
        where: { id: created.id },
        // No info worth showing for a session that never even started —
        // hide it from the customer's list immediately (they already got the
        // error via this request's own response).
        data: { status: "failed", endedAt: new Date(), hiddenAt: new Date() },
      }),
      prisma.browserProfile.update({
        where: { id: profile.id },
        data: { status: "idle", lastUsedAt: new Date() },
      }),
    ]);
    return NextResponse.json(
      { error: `Failed to launch session: ${runtimeStart.error}` },
      { status: 502 }
    );
  }

  const data = runtimeStart.data as { containerId?: string; nekoPassword?: string | null } | undefined;
  const exitIpSnapshot = await ipCheckPromise;

  const running = await prisma.browserSession.update({
    where: { id: created.id },
    data: {
      status: "running",
      containerId: data?.containerId ?? null,
      nekoPassword: data?.nekoPassword ?? null,
      startedAt: new Date(),
      exitIpSnapshot,
    },
    select: SESSION_SAFE_SELECT,
  });

  return NextResponse.json(serializeSession(running as SessionRow), { status: 201 });
}