import "server-only";

// TASK_201 S7 — auto-drain for the standalone mailer EXE. On the VPS, the
// mail-queue drain is a systemd timer POSTing /api/internal/mail-queue-drain
// with the internal bearer token. The EXE has no systemd — so the bundled
// local server runs its own tick loop (started from instrumentation.ts), which
// hits the SAME internal route with the SAME bearer-auth shape, over loopback.
// The drain code path is therefore byte-identical to the hosted server: this
// module only replaces the timer.
//
// Owner directive (2026-10-10): "any drain settings will be added to the
// settings" — so on/off + interval live in a small JSON file next to the other
// per-machine state (NOT the database, so the DB can be wiped/reset without
// losing the user's sending preferences), surfaced on the Settings page via
// app/api/exe/drain-settings.

import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";

import { exeDataDir } from "./exe-data-dir";

export interface MailerDrainSettings {
  autoDrain: boolean;
  intervalSeconds: number;
}

export const DRAIN_SETTINGS_DEFAULTS: MailerDrainSettings = {
  // Default ON — a standalone sender expects campaigns to actually go out
  // without hunting for a start button (the drain itself is still fully gated:
  // only "sending" campaigns whose test-confirm gate passed ever dispatch).
  autoDrain: true,
  intervalSeconds: 60,
};
export const DRAIN_INTERVAL_MIN_SECONDS = 15;
export const DRAIN_INTERVAL_MAX_SECONDS = 3600;

export function drainSettingsPath(): string {
  return path.join(exeDataDir(), "mailer-drain-settings.json");
}

function clampInterval(raw: unknown): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return DRAIN_SETTINGS_DEFAULTS.intervalSeconds;
  return Math.min(DRAIN_INTERVAL_MAX_SECONDS, Math.max(DRAIN_INTERVAL_MIN_SECONDS, n));
}

/** Reads settings, falling back to defaults on missing/corrupt file. */
export async function readDrainSettings(): Promise<MailerDrainSettings> {
  try {
    const raw = await readFile(drainSettingsPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<MailerDrainSettings>;
    return {
      autoDrain: typeof parsed.autoDrain === "boolean" ? parsed.autoDrain : DRAIN_SETTINGS_DEFAULTS.autoDrain,
      intervalSeconds: clampInterval(parsed.intervalSeconds),
    };
  } catch {
    return { ...DRAIN_SETTINGS_DEFAULTS };
  }
}

/** Merges a partial patch and persists. Returns the stored settings. */
export async function writeDrainSettings(patch: {
  autoDrain?: boolean;
  intervalSeconds?: number;
}): Promise<MailerDrainSettings> {
  const current = await readDrainSettings();
  const next: MailerDrainSettings = {
    autoDrain: typeof patch.autoDrain === "boolean" ? patch.autoDrain : current.autoDrain,
    intervalSeconds:
      patch.intervalSeconds !== undefined ? clampInterval(patch.intervalSeconds) : current.intervalSeconds,
  };
  const file = drainSettingsPath();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(next, null, 2), "utf8");
  return next;
}

/**
 * One drain tick, exactly as the VPS timer performs it: loopback POST to the
 * internal route with the local INTERNAL_BEARER_TOKEN (both written into the
 * bundled runtime's .env.local by runtime-assemble.mjs — fail-closed if the
 * token is ever absent, same as every /api/internal/* route on the web).
 */
export async function triggerMailQueueDrain(): Promise<{ ok: boolean; status: number }> {
  const token = process.env.INTERNAL_BEARER_TOKEN;
  if (!token || token.trim().length === 0) return { ok: false, status: 0 };
  const port = process.env.PORT ?? "34413"; // 34413 = src-tauri LOCAL_PORT
  const res = await fetch(`http://127.0.0.1:${port}/api/internal/mail-queue-drain`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  return { ok: res.ok, status: res.status };
}

let loopTimer: { unref?: () => void } | null = null;
let lastRunAt = 0;
let inFlight = false;

async function tickDrain(): Promise<void> {
  if (inFlight) return; // never overlap drain runs
  try {
    const settings = await readDrainSettings();
    if (!settings.autoDrain) return;
    const now = Date.now();
    if (now - lastRunAt < settings.intervalSeconds * 1000) return;
    inFlight = true;
    lastRunAt = now;
    const result = await triggerMailQueueDrain();
    if (!result.ok && result.status !== 0) {
      console.error(`[local-exe-drain] drain tick failed (HTTP ${result.status})`);
    }
  } catch (err) {
    console.error("[local-exe-drain]", err);
  } finally {
    inFlight = false;
  }
}

/**
 * Starts the loop (idempotent). The timer ticks every 15s and consults the
 * persisted interval, so a settings change takes effect without a restart.
 * unref()'d so it can never keep a shutting-down process alive.
 */
export function startLocalExeDrainLoop(tickMs = 15_000): void {
  if (loopTimer) return;
  loopTimer = setInterval(() => {
    void tickDrain();
  }, tickMs);
  loopTimer.unref?.();
}
