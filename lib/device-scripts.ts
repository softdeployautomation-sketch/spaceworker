import "server-only";

import { db } from "./db";
import { runCommandNow } from "./device-tools";
import { deviceStatus } from "./devices";

// ---------------------------------------------------------------------------
// 2026-10-22 — saved device scripts.
//
// One execution path for BOTH device tiers: dispatch always goes through
// `runCommandNow`, which is the exact transport the console's Run-now uses.
// Vantra's `/action` owns the engine decision (TRMM agent → TRMM, Everwas UUID
// → Everwas `/command`, `node//` → MeshCentral), so a script written once runs
// on a public Everwas device and a private TRMM device with no branching here.
// ---------------------------------------------------------------------------

export const SCRIPT_SHELLS = ["powershell", "cmd"] as const;
export type ScriptShell = (typeof SCRIPT_SHELLS)[number];

export const SCRIPT_TRIGGERS = ["manual", "scheduled", "auto_enroll"] as const;
export type ScriptTrigger = (typeof SCRIPT_TRIGGERS)[number];

export const MAX_SCRIPT_BODY = 8000;
export const MAX_SCRIPT_TIMEOUT = 90;
export const MAX_RUN_DEVICES = 25;
// "Run now" answers inline for a small fan-out; anything larger is left to the
// 60-second sweep so the HTTP request never outlives the platform timeout.
const INLINE_DISPATCH_LIMIT = 6;
const DISPATCH_CONCURRENCY = 3;

export class ScriptInputError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

export interface ScriptInput {
  name: string;
  description?: string | null;
  shell: string;
  body: string;
  timeoutSeconds?: number;
}

export function normalizeScriptInput(input: ScriptInput) {
  const name = (input.name ?? "").trim();
  if (!name) throw new ScriptInputError("name_required");
  if (name.length > 120) throw new ScriptInputError("name_too_long");
  const body = input.body ?? "";
  if (!body.trim()) throw new ScriptInputError("body_required");
  if (body.length > MAX_SCRIPT_BODY) throw new ScriptInputError("body_too_long");
  const shell = (SCRIPT_SHELLS as readonly string[]).includes(input.shell)
    ? (input.shell as ScriptShell)
    : null;
  if (!shell) throw new ScriptInputError("shell_invalid");
  const timeoutSeconds = Math.min(
    MAX_SCRIPT_TIMEOUT,
    Math.max(1, Math.round(Number(input.timeoutSeconds) || 90)),
  );
  const description = (input.description ?? "").trim().slice(0, 500) || null;
  return { name, description, shell, body, timeoutSeconds };
}

export async function listScripts(userId: string) {
  return db.deviceScript.findMany({
    where: { userId, archivedAt: null },
    orderBy: { createdAt: "desc" },
    include: { autoRules: true },
  });
}

export async function createScript(userId: string, input: ScriptInput) {
  const data = normalizeScriptInput(input);
  return db.deviceScript.create({ data: { userId, ...data } });
}

export async function updateScript(
  userId: string,
  scriptId: string,
  input: ScriptInput,
) {
  const existing = await db.deviceScript.findFirst({
    where: { id: scriptId, userId, archivedAt: null },
    select: { id: true },
  });
  if (!existing) throw new ScriptInputError("script_not_found");
  const data = normalizeScriptInput(input);
  return db.deviceScript.update({ where: { id: scriptId }, data });
}

export async function archiveScript(userId: string, scriptId: string) {
  const res = await db.deviceScript.updateMany({
    where: { id: scriptId, userId, archivedAt: null },
    data: { archivedAt: new Date() },
  });
  if (!res.count) throw new ScriptInputError("script_not_found");
}

export interface CreateRunOptions {
  userId: string;
  scriptId: string;
  deviceIds: string[];
  trigger: ScriptTrigger;
  scheduledFor?: Date | null;
  autoRuleId?: string | null;
}

/**
 * Creates queued run rows for the given devices. Ownership of BOTH the script
 * and every device is re-checked here (never trusted from the request), and
 * duplicates are dropped so a double-clicked button does not double-run.
 *
 * `autoRuleId` is only set by the enrollment trigger, where the
 * (autoRuleId, deviceId) unique key is what makes repeated syncs idempotent.
 */
export async function createScriptRuns(opts: CreateRunOptions) {
  const script = await db.deviceScript.findFirst({
    where: { id: opts.scriptId, userId: opts.userId, archivedAt: null },
    select: { id: true },
  });
  if (!script) throw new ScriptInputError("script_not_found");

  const deviceIds = [...new Set(opts.deviceIds)].filter(Boolean);
  if (!deviceIds.length) throw new ScriptInputError("no_devices");
  if (deviceIds.length > MAX_RUN_DEVICES) throw new ScriptInputError("too_many_devices");

  const owned = await db.device.findMany({
    where: { id: { in: deviceIds }, userId: opts.userId, removedAt: null },
    select: { id: true },
  });
  if (owned.length !== deviceIds.length) throw new ScriptInputError("device_not_found");

  const data = owned.map((d) => ({
    scriptId: script.id,
    userId: opts.userId,
    deviceId: d.id,
    trigger: opts.trigger,
    scheduledFor: opts.scheduledFor ?? null,
    autoRuleId: opts.autoRuleId ?? null,
    status: "queued",
  }));

  if (opts.autoRuleId) {
    // Idempotent by design: the caller does not need the ids, and the
    // (autoRuleId, deviceId) unique key drops a second sync's insert.
    await db.deviceScriptRun.createMany({ data, skipDuplicates: true });
    return [];
  }

  // Insert one at a time so the returned ids are exactly this batch's rows —
  // re-querying by (script, devices, queued) would also match an older
  // scheduled run for the same pair and dispatch it early.
  const ids: string[] = [];
  for (const row of data) {
    const created = await db.deviceScriptRun.create({ data: row, select: { id: true } });
    ids.push(created.id);
  }
  return ids;
}

function isTransientStatus(value: string | undefined): boolean {
  return value === "offline" || value === "asleep" || value === "unknown";
}

/**
 * The single dispatcher. Safe to call concurrently: the status flip
 * queued → running is an atomic compare-and-set, so the inline "Run now" path
 * and the sweep can race without executing the same run twice.
 */
export async function dispatchScriptRun(runId: string): Promise<void> {
  const claimed = await db.deviceScriptRun.updateMany({
    where: { id: runId, status: "queued" },
    data: { status: "running", startedAt: new Date() },
  });
  if (!claimed.count) return;

  const run = await db.deviceScriptRun.findUnique({
    where: { id: runId },
    include: {
      script: { select: { body: true, shell: true, timeoutSeconds: true, archivedAt: true } },
      device: {
        select: {
          id: true,
          vantraAgentId: true,
          status: true,
          lastSeenAt: true,
          removedAt: true,
        },
      },
    },
  });
  if (!run) return;

  const finish = (
    status: "succeeded" | "failed" | "skipped",
    extra: { output?: string | null; exitCode?: number | null; error?: string | null },
  ) =>
    db.deviceScriptRun.update({
      where: { id: runId },
      data: {
        status,
        finishedAt: new Date(),
        output: extra.output ?? null,
        exitCode: extra.exitCode ?? null,
        error: extra.error ?? null,
      },
    });

  try {
    if (!run.script || run.script.archivedAt) throw new ScriptInputError("script_unavailable");
    if (run.device.removedAt) throw new ScriptInputError("device_removed");
    if (!run.device.vantraAgentId) throw new ScriptInputError("device_not_linked");
    if (isTransientStatus(deviceStatus(run.device))) {
      await finish("skipped", { error: "device_offline" });
      return;
    }
    const result = await runCommandNow({
      userId: run.userId,
      deviceId: run.deviceId,
      cmd: run.script.body,
      shell: run.script.shell,
      timeoutSeconds: run.script.timeoutSeconds,
      runAsUser: true,
      captureOutput: true,
    });
    const failed = typeof result.exitCode === "number" && result.exitCode !== 0;
    await finish(failed ? "failed" : "succeeded", {
      output: result.output,
      exitCode: result.exitCode ?? null,
      error: failed ? `exit_code_${result.exitCode}` : null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "run_failed";
    // A status the user can act on (offline device, removed script) is a skip,
    // not a failure — same distinction the onboarding sweep draws.
    const skippable =
      err instanceof ScriptInputError ||
      /offline|not found|device_unavailable/i.test(message);
    await finish(skippable ? "skipped" : "failed", {
      error: message.slice(0, 500),
    });
  }
}

export async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (;;) {
      const next = queue.shift();
      if (next === undefined) return;
      await fn(next);
    }
  });
  await Promise.all(workers);
}

/** Dispatch a freshly created batch inline (bounded) and leave the rest to the sweep. */
export async function dispatchScriptRunsNow(runIds: string[]): Promise<void> {
  await runWithConcurrency(runIds.slice(0, INLINE_DISPATCH_LIMIT), DISPATCH_CONCURRENCY, (id) =>
    dispatchScriptRun(id).catch(() => undefined),
  );
}

/**
 * The sweep body: claim every due queued run. Scheduled/auto rows become due at
 * `scheduledFor`; manual rows are picked up here only if the inline path never
 * claimed them (API crash / oversized fan-out), after a short grace period.
 */
export async function dispatchDueScriptRuns(limit = 6): Promise<number> {
  const now = new Date();
  const grace = new Date(now.getTime() - 15_000);
  const due = await db.deviceScriptRun.findMany({
    where: {
      status: "queued",
      OR: [
        { scheduledFor: { not: null, lte: now } },
        { scheduledFor: null, createdAt: { lte: grace } },
      ],
    },
    orderBy: [{ scheduledFor: "asc" }, { createdAt: "asc" }],
    select: { id: true },
    take: limit,
  });
  await runWithConcurrency(due.map((r) => r.id), DISPATCH_CONCURRENCY, (id) =>
    dispatchScriptRun(id).catch(() => undefined),
  );
  return due.length;
}

/**
 * Enrollment trigger, called from syncDevices() for every public-tier device it
 * upserts. Only devices that appeared AFTER the rule was created fire (an
 * existing fleet never gets a retroactive run when a rule is saved), and the
 * (autoRuleId, deviceId) unique key guarantees exactly one fire per device even
 * though several syncs can run concurrently. Never throws: a broken rule must
 * not take device sync down with it.
 */
export async function enqueueAutoScriptRuns(opts: {
  userId: string;
  deviceId: string;
  tier: string;
  deviceCreatedAt: Date;
}): Promise<number> {
  try {
    if (opts.tier !== "public" && opts.tier !== "private") return 0;
    const rules = await db.deviceScriptAutoRule.findMany({
      where: { userId: opts.userId, enabled: true },
      select: { id: true, scriptId: true, targetTier: true, delayMinutes: true, createdAt: true },
    });
    if (!rules.length) return 0;
    const now = new Date();
    const data = rules
      .filter((r) => r.targetTier === "any" || r.targetTier === opts.tier)
      .filter((r) => opts.deviceCreatedAt.getTime() >= r.createdAt.getTime())
      .map((r) => ({
        scriptId: r.scriptId,
        userId: opts.userId,
        deviceId: opts.deviceId,
        trigger: "auto_enroll",
        scheduledFor: new Date(now.getTime() + Math.max(0, r.delayMinutes) * 60_000),
        autoRuleId: r.id,
        status: "queued",
      }));
    if (!data.length) return 0;
    const res = await db.deviceScriptRun.createMany({ data, skipDuplicates: true });
    return res.count;
  } catch (err) {
    console.warn(
      `[device-scripts] auto-enroll enqueue failed for device ${opts.deviceId}:`,
      err instanceof Error ? err.message : err,
    );
    return 0;
  }
}
