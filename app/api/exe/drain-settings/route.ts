import { NextResponse } from "next/server";

import { isLocalMailerRuntime } from "@/lib/exe-runtime";
import { getSession } from "@/lib/session";
import {
  readDrainSettings,
  triggerMailQueueDrain,
  writeDrainSettings,
} from "@/lib/local-exe-drain";

// TASK_201 S7 — drain settings for the standalone mailer EXE (owner directive
// 2026-10-10: "any drain settings will be added to the settings"). Local-only
// route: 404s on the hosted web app (isLocalExeRuntime() fail-closes), and even
// inside the EXE it requires the local session (which is always the one local
// user — see lib/local-exe-db.ts).

async function guard(): Promise<NextResponse | null> {
  if (!isLocalMailerRuntime()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

export async function GET(): Promise<NextResponse> {
  const blocked = await guard();
  if (blocked) return blocked;
  return NextResponse.json(await readDrainSettings());
}

export async function PUT(req: Request): Promise<NextResponse> {
  const blocked = await guard();
  if (blocked) return blocked;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const patch = (body ?? {}) as { autoDrain?: unknown; intervalSeconds?: unknown };
  if (patch.autoDrain !== undefined && typeof patch.autoDrain !== "boolean") {
    return NextResponse.json({ error: "autoDrain must be a boolean" }, { status: 400 });
  }
  if (patch.intervalSeconds !== undefined && !Number.isFinite(Number(patch.intervalSeconds))) {
    return NextResponse.json({ error: "intervalSeconds must be a number" }, { status: 400 });
  }
  const saved = await writeDrainSettings({
    autoDrain: patch.autoDrain as boolean | undefined,
    intervalSeconds: patch.intervalSeconds as number | undefined,
  });
  return NextResponse.json(saved);
}

/** "Drain now" — run one drain tick immediately (still fully gated internally). */
export async function POST(): Promise<NextResponse> {
  const blocked = await guard();
  if (blocked) return blocked;
  const result = await triggerMailQueueDrain();
  return NextResponse.json(
    { triggered: result.ok, status: result.status },
    { status: result.ok ? 200 : 502 },
  );
}
