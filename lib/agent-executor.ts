import "server-only";

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { createSearchJob } from "@/lib/create-search-job";
import { buildSearchQueries } from "@/lib/build-search-queries";
import { leadToRecipient, type RecipientInput } from "@/lib/campaign-recipients";
import { createCampaign } from "@/lib/campaign-create";
import {
  applyPinAndContinue,
  applySwitchSubject,
  runCampaignDiagnostics,
  DeliverabilityError,
  type DiagnosticsProbeOutcome,
} from "@/lib/deliverability";

// Task 38 — the kinds of pending agent action this executor can turn into a REAL
// thing on explicit human approval. job/campaign create objects; pin /
// switch_subject mutate a campaign's deliverability decision; diagnostics runs the
// isolation probes (seed-mailbox mode is the ONE autonomous agent action, override
// mode stays approval-gated).
//
// Task 92 — the device-layer kinds are RESERVED in the type now (plan §SCHEMA)
// so later tasks (93/94/96/97/98) extend the SAME union — but approving one
// still fails closed below until its real executor ships (never silently
// no-op, never fall through to executeJob).
export type AgentActionKind =
  | "job"
  | "campaign"
  | "pin"
  | "switch_subject"
  | "diagnostics"
  | "device"
  | "email-reply"
  | "power"
  | "wake"
  | "browser-clone"
  | "clone-control"
  | "lab-action";

// Kinds whose real executors have NOT shipped yet — approve is rejected with a
// clear 4xx rather than falling through to an unintended branch.
const RESERVED_ACTION_KINDS = new Set<AgentActionKind>([
  "device",
  "email-reply",
  "power",
  "wake",
  "browser-clone",
  "clone-control",
  "lab-action",
]);

// Task 31, item 3 — the approval EXECUTOR. This is the ONLY place a pending
// AgentPendingAction is turned into a REAL SearchJob / EmailCampaign, and it
// runs exclusively from the human Approve path (PATCH /api/agent/actions/[id]).
// It uses the same creation helpers POST /api/jobs and POST /api/campaigns use,
// so an approved agent plan is indistinguishable from a hand-built one.

export class AgentActionError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "AgentActionError";
    this.code = code;
    this.status = status;
  }
}

// The shared deliverability decision functions throw `DeliverabilityError` (with an
// HTTP status) so the REST routes map them cleanly. In the executor we translate to
// `AgentActionError` so the approve route's existing catch frees the proposal back
// to "pending" and returns the same user-visible 4xx message.
function throwDeliverability(err: unknown): never {
  if (err instanceof DeliverabilityError) {
    throw new AgentActionError("deliverability", err.message, err.status);
  }
  throw err;
}

function clamp(n: number | undefined, lo: number, hi: number): number | undefined {
  if (n === undefined || Number.isNaN(n)) return undefined;
  return Math.min(Math.max(lo, n), hi);
}

export interface ApproveResult {
  kind: AgentActionKind;
  executedJobId?: string;
  executedCampaignId?: string;
}

export async function approvePendingAction(opts: {
  userId: string;
  actionId: string;
}): Promise<ApproveResult> {
  const rows = await prisma.agentPendingAction.updateMany({
    where: {
      id: opts.actionId,
      userId: opts.userId,
      status: "pending",
      expiresAt: { gt: new Date() },
    },
    data: { status: "approved" },
  });
  if (rows.count === 0) {
    throw new AgentActionError(
      "not_pending",
      "This proposal is no longer pending — it may already be approved, rejected, or expired.",
      409
    );
  }

  const action = await prisma.agentPendingAction.findUnique({ where: { id: opts.actionId } });
  if (!action) throw new AgentActionError("not_found", "Proposal not found.", 404);

  // Task 92 — reserved device-layer kinds fail closed here until their real
  // executor ships (Tasks 93/94/96/97/98). The approve route's catch frees
  // the proposal back to "pending" so nothing is lost.
  if (RESERVED_ACTION_KINDS.has(action.kind as AgentActionKind)) {
    throw new AgentActionError(
      "not_yet_executable",
      "This action type is reserved and cannot be approved yet — its executor ships in a later task.",
      400,
    );
  }

  if (action.kind === "campaign") {
    const id = await executeCampaign(opts.userId, action.payload as Record<string, unknown>);
    await prisma.agentPendingAction.update({
      where: { id: action.id },
      data: { status: "executed", executedCampaignId: id },
    });
    return { kind: "campaign", executedCampaignId: id };
  }

  // Task 38 — deliverability actions. Each calls the SAME lib/deliverability.ts
  // implementation the human REST route uses, so an approved agent decision is
  // indistinguishable from a hand-built one. All three resolve to an
  // executedCampaignId so the chat panel's poll-after-approve reports the
  // campaign's live status/pinnedOverride/subjects (or diagnostics results).
  if (action.kind === "pin") {
    const payload = action.payload as Record<string, unknown>;
    const campaignId = String(payload.campaign_id ?? "").trim();
    if (!campaignId) throw new AgentActionError("invalid_payload", "No campaign was proposed for the pin.", 400);
    try {
      await applyPinAndContinue(campaignId, {
        userId: opts.userId,
        subject: String(payload.subject ?? "").trim(),
        bodyHtml: typeof payload.body_html === "string" ? payload.body_html : "",
        fromAddress: String(payload.from_address ?? "").trim() || undefined,
        pinCount: typeof payload.pin_count === "number" ? payload.pin_count : undefined,
      });
    } catch (err) {
      throwDeliverability(err);
    }
    await prisma.agentPendingAction.update({
      where: { id: action.id },
      data: { status: "executed", executedCampaignId: campaignId },
    });
    return { kind: "pin", executedCampaignId: campaignId };
  }

  if (action.kind === "switch_subject") {
    const payload = action.payload as Record<string, unknown>;
    const campaignId = String(payload.campaign_id ?? "").trim();
    if (!campaignId) throw new AgentActionError("invalid_payload", "No campaign was proposed for the subject switch.", 400);
    // The branch (initial gate vs batch pause) is resolved from the campaign's
    // live status — same decision the route used to compute before delegating.
    const c = await prisma.emailCampaign.findFirst({
      where: { id: campaignId, userId: opts.userId },
      select: { status: true },
    });
    if (!c) throw new AgentActionError("not_found", "Campaign not found.", 404);
    try {
      await applySwitchSubject(campaignId, {
        userId: opts.userId,
        fromInitialGate: c.status === "pending_test_confirm",
      });
    } catch (err) {
      throwDeliverability(err);
    }
    await prisma.agentPendingAction.update({
      where: { id: action.id },
      data: { status: "executed", executedCampaignId: campaignId },
    });
    return { kind: "switch_subject", executedCampaignId: campaignId };
  }

  if (action.kind === "diagnostics") {
    const payload = action.payload as Record<string, unknown>;
    const campaignId = String(payload.campaign_id ?? "").trim();
    if (!campaignId) throw new AgentActionError("invalid_payload", "No campaign was proposed for diagnostics.", 400);
    const keys = normStringArray(payload.keys);
    // Reuse payload as the pollable result sink: nothing else reads payload after
    // execution, and it avoids a schema migration for a nullable result column.
    let results: DiagnosticsProbeOutcome[];
    try {
      ({ results } = await runCampaignDiagnostics({
        campaignId,
        userId: opts.userId,
        keys,
      }));
    } catch (err) {
      throwDeliverability(err);
    }
    await prisma.agentPendingAction.update({
      where: { id: action.id },
      data: {
        status: "executed",
        executedCampaignId: campaignId,
        payload: {
          ...(action.payload as Record<string, unknown>),
          diagnosticsResults: results as DiagnosticsProbeOutcome[],
        } as unknown as Prisma.InputJsonValue,
      },
    });
    return { kind: "diagnostics", executedCampaignId: campaignId };
  }

  const jobId = await executeJob(opts.userId, action.payload as Record<string, unknown>);
  await prisma.agentPendingAction.update({
    where: { id: action.id },
    data: { status: "executed", executedJobId: jobId },
  });
  return { kind: "job", executedJobId: jobId };
}

function normStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const v of value) {
    const s = typeof v === "string" ? v.trim() : "";
    if (s) out.push(s);
  }
  return out;
}

async function executeJob(userId: string, payload: Record<string, unknown>): Promise<string> {
  const findTerms = normStringArray(payload.find_terms);
  const locationTerms = normStringArray(payload.location_terms);
  const emailDomains = normStringArray(payload.email_domains);
  const queries = buildSearchQueries(findTerms, locationTerms);
  if (queries.length === 0) {
    throw new AgentActionError("invalid_payload", "No usable search terms were proposed.", 400);
  }

  const params: Record<string, unknown> = {};
  const maxResults = clamp(
    typeof payload.min_results === "number" ? payload.min_results : undefined,
    1,
    100000
  );
  const maxDurationMinutes = clamp(
    typeof payload.max_duration_minutes === "number" ? payload.max_duration_minutes : undefined,
    1,
    180
  );
  if (maxResults !== undefined) params.maxResults = maxResults;
  if (maxDurationMinutes !== undefined) params.maxDurationMinutes = maxDurationMinutes;
  if (emailDomains.length > 0) params.emailDomains = emailDomains;
  params.queries = queries;
  params.resultMode = "namesEmails";
  if (findTerms.length > 0) params.findTerms = findTerms;
  if (locationTerms.length > 0) params.locationTerms = locationTerms;
  params.template = "lead";

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { tier: true } });

  const job = await createSearchJob({
    userId,
    query: queries.length === 1 ? queries[0] : queries.join(" | "),
    template: "lead",
    params: params as Prisma.InputJsonValue,
    lane: "light",
    priorityTier: user?.tier ?? 0,
  });
  return job.id;
}

async function executeCampaign(userId: string, payload: Record<string, unknown>): Promise<string> {
  const searchJobId = String(payload.search_job_id ?? "").trim();
  const name = String(payload.name ?? "").trim();
  const subject = String(payload.subject ?? "").trim();
  const bodyHtml = String(payload.body_html ?? "").trim();
  if (!searchJobId || !name || !subject || !bodyHtml) {
    throw new AgentActionError(
      "invalid_payload",
      "The proposed campaign is missing its source job, name, subject or body.",
      400
    );
  }

  const ownedJob = await prisma.searchJob.findFirst({
    where: { id: searchJobId, userId },
    select: { id: true },
  });
  if (!ownedJob) {
    throw new AgentActionError("not_found", "The proposed source search job was not found.", 404);
  }

  const leads = await prisma.lead.findMany({
    where: { searchJobId, userId, validationStatus: "valid", email: { not: null } },
    select: { email: true, businessName: true, contactName: true, phone: true, website: true },
  });
  const seen = new Set<string>();
  const recipients: RecipientInput[] = [];
  for (const l of leads) {
    const r = leadToRecipient(l);
    if (!r || seen.has(r.email.toLowerCase())) continue;
    seen.add(r.email.toLowerCase());
    recipients.push({ email: r.email, variables: r.variables });
  }
  if (recipients.length === 0) {
    throw new AgentActionError(
      "no_recipients",
      "That job has no validated leads to send to yet. Let the extraction finish first.",
      400
    );
  }

  // Mailboxes: the ones the agent named if it did, otherwise the user's own.
  let mailboxIds = normStringArray(payload.mailbox_ids);
  if (mailboxIds.length > 0) {
    const owned = await prisma.mailbox.findMany({
      where: { id: { in: mailboxIds }, userId },
      select: { id: true },
    });
    mailboxIds = owned.map((m) => m.id);
  }
  if (mailboxIds.length === 0) {
    const all = await prisma.mailbox.findMany({ where: { userId }, select: { id: true } });
    mailboxIds = all.map((m) => m.id);
  }
  if (mailboxIds.length === 0) {
    throw new AgentActionError(
      "no_mailboxes",
      "No sending mailbox is configured. Add one first, then approve the campaign.",
      400
    );
  }

  const created = await createCampaign({
    userId,
    name,
    mailboxIds,
    subjects: [subject],
    bodies: [bodyHtml],
    recipients,
    searchJobId,
  });
  return created.campaign.id;
}

export interface ExecutedActionStatus {
  kind: AgentActionKind;
  status: string;
  executedJobId: string | null;
  executedCampaignId: string | null;
  job?: {
    status: string;
    ledCount: number;
    validCount: number;
    invalidCount: number;
    uncheckedCount: number;
  };
  campaign?: { id: string };
  // Task 38 — deliverability outcomes: the campaign's live status after a pin /
  // switch / diagnostics approval, plus its pinned override window, and (for
  // diagnostics) the probe results stored back into the action's payload.
  campaignStatus?: string;
  pinnedOverride?: Record<string, unknown> | null;
  subjects?: string[];
  diagnosticsResults?: DiagnosticsProbeOutcome[];
}

// Poll helper for the chat panel: given an executed action, return its live
// outcome (job status + validation split, or the created campaign id).
export async function executedActionStatus(opts: {
  userId: string;
  actionId: string;
}): Promise<ExecutedActionStatus | null> {
  const action = await prisma.agentPendingAction.findFirst({
    where: { id: opts.actionId, userId: opts.userId, status: "executed" },
  });
  if (!action) return null;

  const base: ExecutedActionStatus = {
    kind: action.kind as AgentActionKind,
    status: action.status,
    executedJobId: action.executedJobId,
    executedCampaignId: action.executedCampaignId,
  };

  if (action.kind === "campaign") {
    if (action.executedCampaignId) base.campaign = { id: action.executedCampaignId };
    return base;
  }

  // Task 38 — pin / switch_subject / diagnostics all resolve to a campaign; report
  // its live status + pinned window (and, for diagnostics, the stored probe results).
  if (
    action.kind === "pin" ||
    action.kind === "switch_subject" ||
    action.kind === "diagnostics"
  ) {
    if (action.executedCampaignId) {
      const cmp = await prisma.emailCampaign.findUnique({
        where: { id: action.executedCampaignId },
        select: { status: true, pinnedOverride: true, subjects: true },
      });
      if (cmp) {
        base.campaignStatus = cmp.status;
        base.pinnedOverride = (cmp.pinnedOverride as Record<string, unknown> | null) ?? null;
        if (Array.isArray(cmp.subjects)) base.subjects = cmp.subjects;
      }
    }
    if (action.kind === "diagnostics") {
      const payload = (action.payload ?? {}) as Record<string, unknown>;
      if (Array.isArray(payload.diagnosticsResults)) {
        base.diagnosticsResults = payload.diagnosticsResults as DiagnosticsProbeOutcome[];
      }
    }
    return base;
  }

  if (action.executedJobId) {
    const job = await prisma.searchJob.findUnique({
      where: { id: action.executedJobId },
      select: { status: true, _count: { select: { leads: true } } },
    });
    if (job) {
      const [valid, invalid, unchecked] = await Promise.all([
        prisma.lead.count({ where: { searchJobId: action.executedJobId, validationStatus: "valid" } }),
        prisma.lead.count({
          where: { searchJobId: action.executedJobId, validationStatus: "invalid" },
        }),
        prisma.lead.count({
          where: { searchJobId: action.executedJobId, validationStatus: "unchecked" },
        }),
      ]);
      base.job = {
        status: job.status,
        ledCount: job._count.leads,
        validCount: valid,
        invalidCount: invalid,
        uncheckedCount: unchecked,
      };
    }
  }
  return base;
}