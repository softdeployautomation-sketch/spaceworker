import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { createSearchJob } from "@/lib/create-search-job";
import { buildSearchQueries } from "@/lib/build-search-queries";
import { createCampaign } from "@/lib/campaign-create";
import { leadToRecipient, type RecipientInput } from "@/lib/campaign-recipients";

// Task 27, Part B — the run orchestrator shared by POST /api/automations/[id]/run
// and the internal daily sweep. There is deliberately NO new extraction or send
// logic here: extraction reuses createSearchJob (the same code POST /api/jobs
// calls) and the send phase reuses createCampaign (the same transaction
// POST /api/campaigns performs). This file only owns the state transitions.

export type RunStatus = "running" | "needs_confirmation" | "done" | "failed" | "stopped";

export interface AutomationShape {
  id: string;
  userId: string;
  name: string;
  leadSource: string;
  findTerms: string[];
  locationTerms: string[];
  params?: Prisma.JsonValue | null;
  personalListId: string | null;
  campaignTemplateId: string;
  mailboxIds: string[];
  triggerMode: string;
}

// Every send-phase recipient source honors the same deliverability filter the
// Task 26 leads-to-mailer picker enforces server-side: only VALIDATED leads,
// computed per run so a silently-broken pipeline can't queue junk addresses.
async function resolveRunRecipients(
  userId: string,
  searchJobId: string,
): Promise<RecipientInput[]> {
  const leads = await prisma.lead.findMany({
    where: { searchJobId, userId, validationStatus: "valid", email: { not: null } },
    select: { email: true, businessName: true, contactName: true, phone: true, website: true },
  });
  const seen = new Set<string>();
  const out: RecipientInput[] = [];
  for (const l of leads) {
    const r = leadToRecipient(l);
    if (!r) continue;
    const key = r.email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

async function loadTemplateCampaign(campaignTemplateId: string, userId: string) {
  return prisma.emailCampaign.findFirst({
    where: { id: campaignTemplateId, userId },
    include: { variants: { orderBy: { createdAt: "asc" }, select: { subject: true, bodyHtml: true } } },
  });
}

// Best-effort in-app alert: writes a NotificationLog row so the dashboard can
// surface "this daily automation needs your confirmation." Real external email
// delivery is a handoff follow-up (see plan) — the row is the audit + in-app
// signal that should never fail the run itself.
async function notifyNeedsConfirmation(runId: string, userId: string, automationName: string) {
  void runId;
  await prisma.notificationLog
    .create({
      data: { userId, eventType: "automation_needs_confirmation", channel: "email", recipient: automationName, outcome: "sent" },
    })
    .catch(() => {});
}

// Advance a run whose extraction SearchJob is done into its send phase.
//  - manual: clone the campaign template + queue now (still gated by the
//    campaign's own pending_test_confirm -> test-send-confirm flow, so nothing
//    sends unattended), mark the run done.
//  - daily: STOP at needs_confirmation and notify — never clone/send unattended;
//    the user's explicit confirm makes the clone happen later.
async function processSendPhase(
  runId: string,
  automation: AutomationShape,
): Promise<void> {
  const run = await prisma.campaignAutomationRun.findUnique({ where: { id: runId } });
  if (!run || !run.searchJobId) return;

  const recipients = await resolveRunRecipients(automation.userId, run.searchJobId);
  if (recipients.length === 0) {
    await prisma.campaignAutomationRun.update({
      where: { id: runId },
      data: {
        status: "failed",
        errorMessage: "Extraction finished but produced zero validated leads to send.",
        leadsExtracted: 0,
        extractionCompletedAt: new Date(),
        completedAt: new Date(),
      },
    });
    return;
  }

  if (automation.triggerMode === "daily") {
    await prisma.campaignAutomationRun.update({
      where: { id: runId },
      data: {
        status: "needs_confirmation",
        leadsExtracted: recipients.length,
        extractionCompletedAt: new Date(),
      },
    });
    await notifyNeedsConfirmation(runId, automation.userId, automation.name);
    return;
  }

  const template = await loadTemplateCampaign(automation.campaignTemplateId, automation.userId);
  if (!template || template.variants.length === 0) {
    await prisma.campaignAutomationRun.update({
      where: { id: runId },
      data: {
        status: "failed",
        errorMessage: "The campaign template used by this automation no longer has any subject/body variants.",
        leadsExtracted: recipients.length,
        extractionCompletedAt: new Date(),
        completedAt: new Date(),
      },
    });
    return;
  }

  const result = await createCampaign({
    userId: automation.userId,
    name: `${automation.name} (run ${runId.slice(-8)})`,
    mailboxIds: automation.mailboxIds,
    variants: template.variants,
    recipients,
    rotateEvery: template.rotateEvery,
    searchJobId: run.searchJobId,
  });

  await prisma.campaignAutomationRun.update({
    where: { id: runId },
    data: {
      status: "done",
      campaignId: result.campaign.id,
      leadsExtracted: recipients.length,
      emailsSent: result.recipientCount,
      emailsSentByMailbox: result.byMailbox as Prisma.InputJsonValue,
      extractionCompletedAt: new Date(),
      completedAt: new Date(),
    },
  });
}

// Create a run and start it. For extraction sources this enqueues a real SearchJob
// (async); for personal-list sources there's nothing to run, so it goes straight
// to the send phase.
export async function kickOffRun(automation: AutomationShape): Promise<{ runId: string }> {
  const run = await prisma.campaignAutomationRun.create({
    data: { automationId: automation.id, leadSource: automation.leadSource, status: "running" },
    select: { id: true },
  });
  await prisma.campaignAutomation.update({
    where: { id: automation.id },
    data: { lastRunAt: new Date(), runCount: { increment: 1 } },
  });

  if (automation.leadSource === "personal_list") {
    if (!automation.personalListId) {
      await prisma.campaignAutomationRun.update({
        where: { id: run.id },
        data: { status: "failed", errorMessage: "This automation has no personal list selected.", completedAt: new Date() },
      });
      return { runId: run.id };
    }
    await prisma.campaignAutomationRun.update({
      where: { id: run.id },
      data: { searchJobId: automation.personalListId },
    });
    await processSendPhase(run.id, automation);
    return { runId: run.id };
  }

  const queries = buildSearchQueries(automation.findTerms, automation.locationTerms);
  if (queries.length === 0) {
    await prisma.campaignAutomationRun.update({
      where: { id: run.id },
      data: { status: "failed", errorMessage: "This automation has no Find/Location terms to run.", completedAt: new Date() },
    });
    return { runId: run.id };
  }

  const user = await prisma.user.findUnique({
    where: { id: automation.userId },
    select: { tier: true },
  });
  const rawParams = (automation.params ?? {}) as Record<string, unknown>;
  const engine = rawParams.engine === "google" ? "google" : "duckduckgo";
  const lane = engine === "google" ? "heavy" : "light";
  const params = {
    ...rawParams,
    queries,
    findTerms: automation.findTerms,
    locationTerms: automation.locationTerms,
    template: "lead",
  } as Prisma.InputJsonValue;

  const job = await createSearchJob({
    userId: automation.userId,
    query: queries.length === 1 ? queries[0] : queries.join(" | "),
    template: "lead",
    params,
    lane,
    priorityTier: user?.tier ?? 0,
  });

  await prisma.campaignAutomationRun.update({
    where: { id: run.id },
    data: { searchJobId: job.id },
  });

  return { runId: run.id };
}

// The user's explicit "yes, send" for a daily run paused at needs_confirmation.
// Guards the transition so a run can only be confirmed once.
export async function confirmDailyRun(
  automationId: string,
  runId: string,
  ownerUserId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const run = await prisma.campaignAutomationRun.findUnique({
    where: { id: runId },
    include: { automation: true },
  });
  if (!run || run.automationId !== automationId || run.automation.userId !== ownerUserId) {
    return { ok: false, error: "Not found" };
  }
  if (run.status !== "needs_confirmation") {
    return { ok: false, error: `This run is not awaiting confirmation (status: ${run.status}).` };
  }
  if (!run.searchJobId) {
    return { ok: false, error: "This run has no leads to send." };
  }

  const automation: AutomationShape = run.automation;
  const recipients = await resolveRunRecipients(ownerUserId, run.searchJobId);
  if (recipients.length === 0) {
    await prisma.campaignAutomationRun.update({
      where: { id: runId },
      data: { status: "failed", errorMessage: "No validated leads remain on this run to send.", completedAt: new Date() },
    });
    return { ok: false, error: "No validated leads remain on this run to send." };
  }

  const template = await loadTemplateCampaign(automation.campaignTemplateId, ownerUserId);
  if (!template || template.variants.length === 0) {
    return { ok: false, error: "The campaign template used by this automation no longer has subject/body variants." };
  }

  const result = await createCampaign({
    userId: ownerUserId,
    name: `${automation.name} (run ${runId.slice(-8)})`,
    mailboxIds: automation.mailboxIds,
    variants: template.variants,
    recipients,
    rotateEvery: template.rotateEvery,
    searchJobId: run.searchJobId,
  });

  await prisma.campaignAutomationRun.update({
    where: { id: runId },
    data: {
      status: "done",
      campaignId: result.campaign.id,
      leadsExtracted: recipients.length,
      emailsSent: result.recipientCount,
      emailsSentByMailbox: result.byMailbox as Prisma.InputJsonValue,
      completedAt: new Date(),
    },
  });

  return { ok: true };
}

// Internal sweep step 1 — promote runs whose extraction SearchJob finished.
export async function sweepAdvanceFinishedRuns(): Promise<number> {
  const runs = await prisma.campaignAutomationRun.findMany({
    where: { status: "running", searchJobId: { not: null } },
    select: { id: true, searchJobId: true, automation: true },
  });
  let advanced = 0;
  for (const r of runs) {
    if (!r.searchJobId) continue;
    const job = await prisma.searchJob.findUnique({
      where: { id: r.searchJobId },
      select: { status: true, error: true },
    });
    if (!job) continue;
    if (job.status === "done" || job.status === "stopped") {
      await processSendPhase(r.id, r.automation);
      advanced++;
    } else if (job.status === "failed") {
      await prisma.campaignAutomationRun.update({
        where: { id: r.id },
        data: { status: "failed", errorMessage: job.error ?? "Extraction failed.", completedAt: new Date() },
      });
      advanced++;
    }
    // queued/running/paused: leave for a later sweep tick
  }
  return advanced;
}

// Internal sweep step 2 — create runs for daily automations due in the current
// UTC hour, skipping any that already have a run started within this hour so a
// sweep firing more than once can't double-fire a daily automation.
export async function sweepCreateDueDailyRuns(): Promise<number> {
  const hour = new Date();
  const scheduleHour = hour.getUTCHours();
  const hourStart = new Date(Date.UTC(hour.getUTCFullYear(), hour.getUTCMonth(), hour.getUTCDate(), scheduleHour, 0, 0));

  const due = await prisma.campaignAutomation.findMany({
    where: { triggerMode: "daily", scheduleEnabled: true, scheduleHour },
  });

  let created = 0;
  for (const automation of due) {
    const already = await prisma.campaignAutomationRun.findFirst({
      where: { automationId: automation.id, startedAt: { gte: hourStart } },
      select: { id: true },
    });
    if (already) continue;
    await kickOffRun(automation);
    created++;
  }
  return created;
}