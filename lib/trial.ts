import "server-only";

import { Prisma } from "@prisma/client";
import { resolveUserTier } from "./premium";

// Tier 1 trial — for all free users: 15 min/day per tool, never prioritized
// over Premium.
//
// Tier numbers (see the User.tier comment in prisma/schema.prisma):
//   0 = nothing / inline EXE-buyer license_only (findOrCreateUser pins 0)
//   1 = trial
//   5 = Premium  (2/3/4 reserved/unused)
export const TIER_TRIAL = 1;
export const TIER_PREMIUM = 5;

// Trial daily allowance per tool, in SECONDS. 15 minutes per tool per UTC day.
export const TRIAL_DAILY_SECONDS_PER_TOOL = 900;

// The codebase's established "today" reset boundary (UTC midnight), matching
// lib/agent.ts startOfTodayUTC / Mailbox.sentTodayDate. Do NOT invent a second
// (e.g. local-timezone) boundary. Kept local here (not imported from agent.ts)
// so the internal dispatch/drain routes don't transitively load the Channelry
// client at import time; keep this byte-for-byte identical to agent.ts.
export function startOfTodayUTC(): Date {
  return new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
}

// The "YYYY-MM-DD" (UTC) day a given timestamp belongs to — stored in
// ToolUsageLog.usedOn. Written at run COMPLETION using the day the run STARTED,
// so a long run spanning UTC midnight lands wholly on its start day.
export function trialDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function isPremiumTier(tier: number): boolean {
  return tier >= TIER_PREMIUM;
}

// Tool family for a dispatch lane. The web app has exactly TWO physical async
// pipelines, so there are exactly two web allowances:
//   - dispatch (lead extraction)  -> "extractor"
//   - mail-queue-drain (campaign) -> "mailer"  (see toolForCampaign below)
// "combined" and "automation" are BUILD_TARGET/EXE product constraints, NOT
// separate web pipelines — an automation-scheduled run or a combined flow
// PHYSICALLY executes one of these two pipelines, so it is metered under that
// pipeline's allowance (never double-counted, and a user can't spend the same
// tool twice under a different name).
export function toolForLane(lane: string): string | null {
  switch (lane) {
    case "light":
    case "heavy":
      return "extractor";
    default:
      return null;
  }
}

export const MAILER_TOOL = "mailer";

// The minute-level shape of what a metered run may record. Kept as plain fields
// (not a class) so both the dispatch route and the mail drain can call it.
export interface RecordedTrialRun {
  userId: string;
  tool: string;
  lane: string;
  elapsedSeconds: number;
  usedOn: string;
  jobId?: string | null;
}

/**
 * Remaining trial seconds for a user+tool on a given UTC day (0 when at/over the
 * 900s cap). Race-safe under concurrency: a SUM over append-only ToolUsageLog
 * rows, exactly like AiUsageLog (Task 40). Only meaningful for a non-Premium
 * user; Premium is exempt and never logs here, so this is only consulted after
 * an isPremiumTier check.
 */
export async function getRemainingTrialSeconds(
  tx: Prisma.TransactionClient,
  opts: { userId: string; tool: string; usedOn: string },
): Promise<number> {
  const agg = await tx.toolUsageLog.aggregate({
    where: { userId: opts.userId, tool: opts.tool, usedOn: opts.usedOn },
    _sum: { elapsedSeconds: true },
  });
  const used = agg._sum.elapsedSeconds ?? 0;
  return Math.max(0, TRIAL_DAILY_SECONDS_PER_TOOL - used);
}

/**
 * Records one completed metered run. Call inside the same transaction that
 * finalized the run so a crash between the state change and the tally can't
 * silently under-count a user's day.
 */
export async function recordTrialRun(
  tx: Prisma.TransactionClient,
  run: RecordedTrialRun,
): Promise<void> {
  await tx.toolUsageLog.create({
    data: {
      userId: run.userId,
      tool: run.tool,
      lane: run.lane,
      elapsedSeconds: Math.max(0, Math.round(run.elapsedSeconds)),
      usedOn: run.usedOn,
      jobId: run.jobId ?? null,
    },
  });
}

/**
 * Enforces the per-tool daily cap for one user/tool: true when the user may
 * dispatch another run today (they're Premium, or a trial user with time left),
 * false when a trial user has already used the day's allowance.
 */
export async function mayDispatchToolToday(
  tx: Prisma.TransactionClient,
  opts: { userId: string; tier: number; tool: string | null; usedOn: string },
): Promise<boolean> {
  if (!opts.tool) return true; // unknown lane — don't block on a mis-mapping
  if (isPremiumTier(opts.tier)) return true; // Premium is always exempt
  return (await getRemainingTrialSeconds(tx, {
    userId: opts.userId,
    tool: opts.tool,
    usedOn: opts.usedOn,
  })) > 0;
}

// ---------------------------------------------------------------------------
// Mailer (campaign send-engine) metering.
//
// A campaign's send "stretch" is one continuous window from when it ENTERS
// status "sending" (EmailCampaign.sendingStartedAt set at entry) to when it
// LEAVES "sending" (done / paused_deliverability / stopped — the caller that
// flips the status also finalizes the stretch here). While a stretch is
// in-flight it is NOT yet in ToolUsageLog, so the drain adds its in-flight
// seconds to the SUM when deciding whether to truncate today.
// ---------------------------------------------------------------------------

/**
 * Mailer seconds used today: the SUM over COMPLETED stretches in ToolUsageLog
 * plus the caller-supplied in-flight stretch currently sending (0 when none).
 * All in the SAME UTC day boundary (usedOn = trialDayKey(now)).
 */
export async function mailerSecondsUsedToday(
  tx: Prisma.TransactionClient,
  opts: { userId: string; usedOn: string; inFlightSeconds: number },
): Promise<number> {
  const agg = await tx.toolUsageLog.aggregate({
    where: { userId: opts.userId, tool: MAILER_TOOL, usedOn: opts.usedOn },
    _sum: { elapsedSeconds: true },
  });
  return (agg._sum.elapsedSeconds ?? 0) + Math.max(0, opts.inFlightSeconds);
}

/**
 * True when a trial user still has mailer time left today (or is Premium).
 * `inFlightSeconds` is the current stretch's elapsed time so far, so a
 * long-running campaign already counts against the day before it completes.
 */
export async function mailerWithinCapToday(
  tx: Prisma.TransactionClient,
  opts: { userId: string; tier: number; usedOn: string; inFlightSeconds: number },
): Promise<boolean> {
  if (isPremiumTier(opts.tier)) return true; // Premium is always exempt
  return (await mailerSecondsUsedToday(tx, opts)) < TRIAL_DAILY_SECONDS_PER_TOOL;
}

/**
 * Gate for entering "sending" (confirm-test, resuming from a pause, pinning,
 * or promoting an edited draft — every place a campaign transitions INTO
 * "sending"). `inFlightSeconds` must include every OTHER currently-sending
 * campaign this user owns (their stretches aren't in ToolUsageLog yet either),
 * so two campaigns started back-to-back can't jointly blow past the daily cap
 * before either one finishes. Callers own setting `sendingStartedAt` — this
 * only answers whether they may.
 */
export async function mayEnterSending(
  tx: Prisma.TransactionClient,
  opts: { userId: string; tier: number; excludeCampaignId: string },
): Promise<boolean> {
  if (isPremiumTier(opts.tier)) return true; // Premium is always exempt
  const now = new Date();
  const inFlight = await tx.emailCampaign.findMany({
    where: {
      userId: opts.userId,
      status: "sending",
      sendingStartedAt: { not: null },
      NOT: { id: opts.excludeCampaignId },
    },
    select: { sendingStartedAt: true },
  });
  const inFlightSeconds = inFlight.reduce(
    (sum, c) => sum + Math.max(0, (now.getTime() - c.sendingStartedAt!.getTime()) / 1000),
    0,
  );
  return mailerWithinCapToday(tx, {
    userId: opts.userId,
    tier: opts.tier,
    usedOn: trialDayKey(now),
    inFlightSeconds,
  });
}

/**
 * Finalizes a campaign's send stretch: records the elapsed window in
 * ToolUsageLog (trial users only — Premium is exempt and never logged) under
 * the day the stretch STARTED, then clears EmailCampaign.sendingStartedAt so a
 * later resume starts a fresh window. No-op safe when no marker is set. Call
 * inside the same transaction that flips the campaign out of "sending".
 */
export async function finalizeMailerStretch(
  tx: Prisma.TransactionClient,
  campaign: { id: string; userId: string; sendingStartedAt: Date | null },
): Promise<void> {
  if (!campaign.sendingStartedAt) return;
  const ownerTier = await resolveUserTier(tx, campaign.userId);
  if (ownerTier !== null && !isPremiumTier(ownerTier)) {
    await recordTrialRun(tx, {
      userId: campaign.userId,
      tool: MAILER_TOOL,
      lane: "mailer",
      elapsedSeconds: (Date.now() - campaign.sendingStartedAt.getTime()) / 1000,
      usedOn: trialDayKey(campaign.sendingStartedAt),
      jobId: campaign.id,
    });
  }
  await tx.emailCampaign.update({
    where: { id: campaign.id },
    data: { sendingStartedAt: null },
  });
}