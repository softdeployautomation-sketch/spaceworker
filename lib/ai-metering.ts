import "server-only";

import { db } from "./db";

// ---------------------------------------------------------------------------
// TASK_152 M3 — the shared per-user daily AI-metering primitives.
//
// WHY THIS IS ITS OWN MODULE: two very different callers now spend against the
// SAME per-user daily AI cap — the Automations agent (lib/agent.ts) and the
// device-screen summary pass (lib/screenshot-summaries.ts). The rule must exist
// ONCE so neither can drift (TASK_127:50 — "any AI vision call this task adds
// MUST go through the same metered path, not a side channel"). Putting it here
// rather than in lib/agent.ts also keeps the summary path from importing
// lib/agent.ts's whole graph (deliverability, lead-selectable, agent-executor,
// approvals…), which a screen-monitoring route has no business pulling in.
//
// READING "TODAY" AS A SUM OVER AiUsageLog (never a mutable counter) is what
// makes it race-safe: two concurrent callers cannot both slip past the cap, and
// no second admission counter is introduced alongside lib/resource-governor.ts.
// ---------------------------------------------------------------------------

// Task 40 — the codebase's established "today" reset boundary, matching the
// mail-queue-drain convention (`new Date().toISOString().slice(0, 10)` = UTC
// "YYYY-MM-DD"). User AI daily caps reset at UTC midnight, exactly like
// Mailbox.sentTodayDate. Do NOT invent a second (e.g. local-timezone) boundary.
export function startOfTodayUTC(): Date {
  return new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
}

/** Today's REAL AI spend for a user — the SUM the per-user daily cap is measured against. */
export async function getUsedAiTodayHundredthsCent(userId: string): Promise<number> {
  const usedAgg = await db.aiUsageLog.aggregate({
    where: { userId, createdAt: { gte: startOfTodayUTC() } },
    _sum: { costHundredthsCent: true },
  });
  return usedAgg._sum.costHundredthsCent ?? 0;
}

/**
 * The ONE decision of whether a user has hit their daily AI cap. `cap` is
 * `User.aiDailyCapHundredthsCent` (callers fall back to 20000 when the user row
 * is missing — the same default lib/agent.ts has always used).
 */
export function aiCapReached(usedHundredthsCent: number, capHundredthsCent: number): boolean {
  return usedHundredthsCent >= capHundredthsCent;
}

/**
 * Append the REAL cost a completed AI call reported (never an estimate). Logs
 * only meaningful, positive spend — a 0-cost row is a no-op in the audit trail,
 * exactly as lib/agent.ts has always behaved. Shared so every metered caller
 * writes the same kind of row.
 */
export async function recordAiUsage(
  userId: string,
  costHundredthsCent: number,
  eventType: string,
): Promise<void> {
  if (typeof costHundredthsCent !== "number" || !(costHundredthsCent > 0)) return;
  await db.aiUsageLog.create({
    data: { userId, costHundredthsCent: Math.round(costHundredthsCent), eventType },
  });
}
