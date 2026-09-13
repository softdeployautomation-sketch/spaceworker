import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";
import {
  buildIsolationProbes,
  DeliverabilityError,
  runCampaignDiagnostics,
} from "@/lib/deliverability";

// Task 33 — the isolation ladder. This is the API primitive the "Run
// diagnostics" panel (and later the AI agent) uses to figure out WHICH element
// (subject, body, or From address) is actually triggering spam filtering.
//
// It builds the campaign's 4 probes (subject-only / body-only / empty-body /
// from-only — one variable changed, the other two constant), runs each through
// the exact same runTestSend primitive the test-send route uses (a live probe,
// no persistence), and returns each probe's outcome + the exact content it was
// tested as, so the caller can both see at a glance which one came back clean
// and pin that exact proven combination if it wants to.
//
// By default all 4 probes run; pass { keys: ["subject", "emptyBody"] } to run a
// subset (the UI runs one probe per request so each has its own Run button and
// its own speed — the empty-body probe returns fast, while a seed-mailbox probe
// can wait up to ~2 minutes for the IMAP poll).
//
// Deliberately plain, human-and-agent-agnostic REST (same session auth as every
// other campaign route in this app): the agent's autonomy calibration lives in
// the agent's own conversation logic, not here (see TASK_33 §3).
//
// GET  — returns just the probe definitions (metadata) so the UI can render the
//        checklist without running anything.
// POST — actually runs the requested probe(s) (a live test-send through
//        runTestSend) and returns each probe's outcome plus the exact content it
//        was tested as.

async function loadProbeMeta({ id, userId }: { id: string; userId: string }) {
  const campaign = await prisma.emailCampaign.findFirst({
    where: { id, userId },
    include: { variants: { orderBy: { createdAt: "asc" }, select: { subject: true, bodyHtml: true } } },
  });
  if (!campaign) return null;

  const mailboxes = await prisma.mailbox.findMany({
    where: { id: { in: campaign.mailboxIds }, userId, active: true },
    orderBy: { createdAt: "asc" },
  });
  // Isolation demands a single sender held constant across probes — testing
  // every mailbox for every probe would conflate mailbox/sender reputation with
  // the variable being isolated. Use the campaign's PRIMARY (first) mailbox.
  const primary = mailboxes[0];
  const probes = buildIsolationProbes({
    subjects: campaign.subjects ?? [],
    bodies: campaign.bodies ?? [],
    variants: campaign.variants.map((v) => ({ subject: v.subject, bodyHtml: v.bodyHtml })),
    fromAddresses: primary ? primary.fromAddresses : [],
  });
  return { campaign, primary, probes, overrideRecipient: campaign.testRecipientOverride?.trim() || null };
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const ctx = await loadProbeMeta({ id, userId: session.userId });
  if (!ctx) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ probes: ctx.probes });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;

  let reqBody: { keys?: unknown } = {};
  try {
    reqBody = await req.json();
  } catch {
    reqBody = {};
  }
  const requestedKeys =
    Array.isArray(reqBody.keys)
      ? reqBody.keys.filter((k): k is string => typeof k === "string")
      : undefined;

  // The actual probe build + seed/override routing + per-probe test-send lives in
  // the shared lib/deliverability.ts runner (Task 38) — the AI agent's autonomous
  // seed-mailbox read and this human UI call the EXACT same code.
  try {
    const { results } = await runCampaignDiagnostics({
      campaignId: id,
      userId: session.userId,
      keys: requestedKeys,
    });
    return NextResponse.json({ results });
  } catch (err) {
    if (err instanceof DeliverabilityError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}