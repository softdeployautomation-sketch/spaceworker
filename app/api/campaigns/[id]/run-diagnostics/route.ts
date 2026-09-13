import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";
import { runTestSend, buildIsolationProbes } from "@/lib/deliverability";
import { resolveSeedMailbox } from "@/lib/seed-mailbox";

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

type ProbeMeta = {
  key: string;
  label: string;
  description: string;
  variant: { subject: string; bodyHtml: string };
  from: string | null;
  available: boolean;
  unavailableReason?: string;
};
type ProbeOutcome = ProbeMeta & { outcome: string | null; landedIn: string | null; error?: string };

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

  const ctx = await loadProbeMeta({ id, userId: session.userId });
  if (!ctx) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const { campaign, primary, probes, overrideRecipient } = ctx;
  if (!primary) {
    return NextResponse.json({ error: "No active sending mailbox on this campaign" }, { status: 400 });
  }

  const selected = requestedKeys ? probes.filter((p) => requestedKeys.includes(p.key)) : probes;
  if (selected.length === 0) {
    return NextResponse.json({ error: "No matching probes" }, { status: 400 });
  }

  const seed = overrideRecipient ? null : await resolveSeedMailbox(session.userId);
  if (!overrideRecipient && !seed) {
    return NextResponse.json(
      { error: "No seed/test mailbox is configured — a real one is required to run diagnostics" },
      { status: 400 }
    );
  }

  const runProbe = (probe: ProbeMeta): Promise<ProbeOutcome> => {
    if (!probe.available) {
      return Promise.resolve({ ...probe, outcome: null, landedIn: null, error: probe.unavailableReason });
    }
    return runTestSend({
      campaignId: campaign.id,
      mailbox: primary,
      variant: probe.variant,
      ...(overrideRecipient ? { overrideRecipient } : { seed: seed! }),
      ...(probe.from ? { from: probe.from } : {}),
    })
      .then((r) => ({ ...probe, outcome: r.outcome, landedIn: r.landedIn, error: r.error }))
      .catch((e) => ({
        ...probe,
        outcome: "failed",
        landedIn: "unknown",
        error: e instanceof Error ? e.message : "Probe failed at SMTP",
      }));
  };

  let results: ProbeOutcome[];
  if (overrideRecipient) {
    // Override mode: a human is going to eyeball their own inbox, so pace the
    // probes like the test-send route does (3-6s between sends) rather than
    // dropping 4 look-alike test emails in the same second.
    results = [];
    for (const probe of selected) {
      if (results.length > 0) await new Promise((r) => setTimeout(r, 3_000 + Math.random() * 4_000));
      results.push(await runProbe(probe));
    }
  } else {
    results = await Promise.all(selected.map(runProbe));
  }

  return NextResponse.json({ results });
}