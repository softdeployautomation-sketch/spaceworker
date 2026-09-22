import "server-only";

import { db } from "./db";
import { channelryAiChat } from "./channelry-ai";
import { notifyUser } from "./notify";
import { recordAgentActionAudit } from "./devices";

// Task 92 — the nightly assistant digest. Pulls the user's real activity
// (jobs, campaigns, device events, entitlement changes), asks Channelry for a
// short prose summary via the SAME runAgentTurn pipeline as chat (so cost is
// attributed to the per-user daily cap and AiUsageLog), pins the result as an
// assistant message in the user's AgentThread, stores an ActivityRollup, and
// fans out through notifyUser (email / Telegram / agent-thread per prefs).
//
// Idempotency: one rollup per (userId, UTC day) — a re-fired sweep returns
// "already_done" without spending anything.

function utcDayStart(date = new Date()): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export interface DigestResult {
  status: "generated" | "already_done" | "skipped";
  reason?: string;
  rollupId?: string;
}

/**
 * Build (or return the existing) digest for `user` covering the PREVIOUS UTC
 * day. Called by the digest-sweep internal route for each eligible user.
 */
export async function buildDailyDigest(userId: string): Promise<DigestResult> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, digestEnabled: true },
  });
  if (!user) return { status: "skipped", reason: "user_not_found" };
  if (!user.digestEnabled) return { status: "skipped", reason: "digest_disabled" };

  // The digest covers the previous UTC day; rollupDate keys on THAT day's
  // midnight so a double-fired sweep dedupes exactly.
  const now = new Date();
  const today = utcDayStart(now);
  const rollupDate = new Date(today.getTime() - 24 * 60 * 60 * 1000);
  const dayEnd = today; // exclusive upper bound

  const existing = await db.activityRollup.findUnique({
    where: { userId_rollupDate: { userId, rollupDate } },
  });
  if (existing) return { status: "already_done", rollupId: existing.id };

  const windowStart = rollupDate;
  const windowEnd = dayEnd;

  // --- Collect the day's real activity -----------------------------------
  const [jobs, campaigns, deviceEvents, entitlements, payments] = await Promise.all([
    db.searchJob.count({ where: { userId, createdAt: { gte: windowStart, lt: windowEnd } } }),
    db.emailCampaign.count({ where: { userId, createdAt: { gte: windowStart, lt: windowEnd } } }),
    db.deviceAudit.findMany({
      where: { device: { userId }, createdAt: { gte: windowStart, lt: windowEnd } },
      select: { event: true, actor: true },
    }),
    db.userEntitlement.findMany({ where: { userId } }),
    db.payment.findMany({
      where: { userId, createdAt: { gte: windowStart, lt: windowEnd } },
      select: { amountUsd: true, status: true, product: true },
    }),
  ]);

  const deviceEventCounts: Record<string, number> = {};
  for (const e of deviceEvents) deviceEventCounts[e.event] = (deviceEventCounts[e.event] ?? 0) + 1;
  const liveEntitlements = entitlements.filter((e) => !e.revokedAt).map((e) => e.key);

  // --- Ask Channelry for the prose (plain mode — NOT a chat turn, so the
  // chat thread stays clean; cost is still logged to AiUsageLog verbatim).
  const activity = [
    `Search jobs created: ${jobs}`,
    `Email campaigns created: ${campaigns}`,
    `Device events: ${
      Object.keys(deviceEventCounts).length
        ? Object.entries(deviceEventCounts).map(([k, v]) => `${k}=${v}`).join(", ")
        : "none"
    }`,
    `Entitlements now active: ${liveEntitlements.length ? liveEntitlements.join(", ") : "none"}`,
    `Payments recorded: ${payments.length ? payments.map((p) => `${p.product} ${p.status} $${p.amountUsd.toFixed(2)}`).join("; ") : "none"}`,
  ].join("\n");

  const SYSTEM_PROMPT =
    "You write concise daily digests for a productivity/cybersecurity workspace user. " +
    "Based ONLY on the provided activity data: max 120 words, plain text, no markdown headings. " +
    "Lead with the most important item; explicitly say if nothing notable happened. " +
    "Never invent activity that is not in the data. Do not propose any action.";

  let digestText = "No activity worth reporting today.";
  let costHundredthsCent = 0;
  try {
    const result = await channelryAiChat({
      system: SYSTEM_PROMPT,
      user: `Produce today's digest from this activity:\n${activity}`,
      max_tokens: 400,
      external_user_id: userId,
    });
    if (result.content.trim().length > 0) digestText = result.content.trim();
    const realCost = result.usage?.cost_hundredths_cent;
    if (typeof realCost === "number" && realCost > 0) {
      costHundredthsCent = Math.round(realCost);
      // Same append-only REAL-cost discipline as runAgentTurn's agent_turn rows.
      await db.aiUsageLog.create({
        data: { userId, costHundredthsCent: costHundredthsCent, eventType: "assistant_digest" },
      });
    }
  } catch (err) {
    // Digest is best-effort: fall back to the raw-count digest rather than
    // failing the sweep (the sweep is external and just logs outcomes).
    console.error("[digest] channelry call failed, using raw fallback:", err);
    digestText = `Yesterday: ${jobs} search job(s), ${campaigns} campaign(s), ${
      Object.values(deviceEventCounts).reduce((a, b) => a + b, 0)
    } device event(s). AI summary unavailable.`;
  }

  // --- Deliver: notifyUser fans out to email/Telegram/agent thread per the
  // user's prefs (the agent-thread channel pins the digest into the existing
  // chat thread — no separate manual pin, no empty bubbles).
  const digestHeader = `📅 Daily digest — ${rollupDate.toISOString().slice(0, 10)}`;
  const thread = await db.agentThread.findFirst({ where: { userId } });

  await notifyUser(userId, {
    eventType: "assistant_digest",
    subject: "Your SpaceWorker daily digest",
    emailHtml: `<p>${digestText.replace(/\n/g, "<br/>")}</p>`,
    telegramText: `${digestHeader}\n\n${digestText}`,
    agentText: `${digestHeader}\n\n${digestText}`,
  });

  const rollup = await db.activityRollup.create({
    data: {
      userId,
      rollupDate,
      digestText,
      agentThreadId: thread?.id ?? null,
      aiCostHundredthsCent: costHundredthsCent,
      deliveredChannels: [],
    },
  });

  await recordAgentActionAudit({
    userId,
    action: "assistant_digest",
    status: "executed",
    initiatingChannel: "system",
    detail: { rollupId: rollup.id, aiCostHundredthsCent: costHundredthsCent },
  });

  return { status: "generated", rollupId: rollup.id };
}