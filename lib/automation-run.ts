import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { createSearchJob } from "@/lib/create-search-job";
import { buildSearchQueries } from "@/lib/build-search-queries";
import { createCampaign } from "@/lib/campaign-create";
import { leadToRecipient, type RecipientInput } from "@/lib/campaign-recipients";
import { sendEmail } from "@/lib/email";
import { env } from "@/lib/env";
import { usableTemplateWhere } from "@/lib/campaign-templates";

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
  // Task 29, item 2 — personal_list runs may now pull from MULTIPLE uploaded
  // lists (was a single personalListId). A run resolves validated leads from
  // every one of these SearchJob ids, deduping by email across all of them.
  personalListIds: string[];
  campaignTemplateId: string;
  mailboxIds: string[];
  triggerMode: string;
}

// Every send-phase recipient source honors the same deliverability filter the
// Task 26 leads-to-mailer picker enforces server-side: only VALIDATED leads,
// computed per run so a silently-broken pipeline can't queue junk addresses.
// Task 29, item 2: `jobIds` is an array so a personal_list run MERGES the
// validated leads of every selected uploaded list — deduping by email ACROSS
// the whole set, not just within one job.
async function resolveRunRecipients(
  userId: string,
  jobIds: string[],
): Promise<RecipientInput[]> {
  const leads = await prisma.lead.findMany({
    where: { searchJobId: { in: jobIds }, userId, validationStatus: "valid", email: { not: null } },
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
  // Tier (a): the user's own campaign. Tier (b): a system-owned ready-made
  // template (identical clone via createCampaign — this function only needs to
  // LOCATE it, ownership/authoring is the picker's concern).
  return prisma.emailCampaign.findFirst({
    where: await usableTemplateWhere(campaignTemplateId, userId),
    include: { variants: { orderBy: { createdAt: "asc" }, select: { subject: true, bodyHtml: true } } },
  });
}

// Real external notification when a daily run reaches needs_confirmation. Sends
// SpaceWorker's OWN transactional email (lib/email.ts sendEmail — the same
// separate Resend account used for verification codes, never the customer SMTP)
// to the automation owner and records an accurate audit row via sendEmail's
// internal recordNotificationLog. Best-effort by design: a notification failure
// must never fail the run itself, so the send is wrapped and any error is
// swallowed (sendEmail already logged the failed attempt as outcome:"failed"
// for the audit trail).
async function notifyNeedsConfirmation(runId: string, automation: AutomationShape) {
  // Thread the real recipient through: the owner's verified email, looked up via
  // automation.userId -> User.email (the function no longer hardcodes an
  // in-app-only row that falsely claimed outcome:"sent").
  const user = await prisma.user.findUnique({
    where: { id: automation.userId },
    select: { email: true },
  });
  if (!user?.email) return; // no reachable owner — the run's state is the signal

  const runLink = `${env.appBaseUrl}/dashboard/automations/${automation.id}/runs/${runId}`;
  try {
    await sendEmail({
      to: user.email,
      subject: `SpaceWorker: "${automation.name}" needs your confirmation`,
      html: automationNeedsConfirmationEmailHtml(automation.name, runLink),
      eventType: "automation_needs_confirmation",
    });
  } catch {
    // Best-effort — swallow; sendEmail already recorded the failure to
    // NotificationLog (outcome:"failed") and must not block the run.
  }
}

function automationNeedsConfirmationEmailHtml(automationName: string, runLink: string): string {
  return `<!doctype html>
<html>
  <body style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#f3f4f6;margin:0;padding:24px;">
    <div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px;border:1px solid #e5e7eb;">
      <p style="font-size:20px;font-weight:700;margin:0 0 16px;color:#111827;">SpaceWorker automations</p>
      <p style="font-size:15px;line-height:1.6;color:#374151;margin:0 0 16px;">
        Your daily automation <strong>${escapeHtml(automationName)}</strong> has finished extracting leads and is
        waiting on your approval before anything is sent. No email has gone out yet.
      </p>
      <p style="margin:0 0 16px;">
        <a href="${escapeHtml(runLink)}" style="display:inline-block;background:#4f46e5;color:#ffffff;text-decoration:none;border-radius:8px;padding:12px 18px;font-size:14px;font-weight:600;">Review &amp; confirm this run</a>
      </p>
      <p style="font-size:13px;line-height:1.5;color:#6b7280;margin:0;">
        If this wasn't you or you didn't expect it, you can pause the automation from the Automations tab. This is a
        SpaceWorker system notification sent via our own transactional email account.
      </p>
    </div>
  </body>
</html>`;
}

// Minimal HTML-escaping so an automation name / link can't inject markup into
// the notification email.
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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
  if (!run) return;
  // Task 29, item 2 — personal_list runs source from EVERY selected uploaded
  // list; extract runs source from the run's single extraction SearchJob.
  const jobIds =
    automation.leadSource === "personal_list"
      ? automation.personalListIds
      : run.searchJobId ? [run.searchJobId] : [];
  if (jobIds.length === 0) return;

  const recipients = await resolveRunRecipients(automation.userId, jobIds);
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
    await notifyNeedsConfirmation(runId, automation);
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
    if (automation.personalListIds.length === 0) {
      await prisma.campaignAutomationRun.update({
        where: { id: run.id },
        data: { status: "failed", errorMessage: "This automation has no personal lists selected.", completedAt: new Date() },
      });
      return { runId: run.id };
    }
    // The run row keeps a single searchJobId for backward compatibility/display
    // (first selected list); the send phase resolves recipients from the full
    // personalListIds array in processSendPhase.
    await prisma.campaignAutomationRun.update({
      where: { id: run.id },
      data: { searchJobId: automation.personalListIds[0] },
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
  // Confirm-run path: the run row carries a single searchJobId (for personal_list
  // it's the FIRST selected list); resolve validated leads across whatever list ids
  // apply here so multi-list automations resolve correctly.
  const jobIds = automation.leadSource === "personal_list"
    ? automation.personalListIds
    : [run.searchJobId];
  const recipients = await resolveRunRecipients(ownerUserId, jobIds);
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