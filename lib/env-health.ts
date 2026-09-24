import "server-only";

// Boot-time environment health check (owner incident 2026-09-24).
//
// WHAT HAPPENED: a deploy wiped the VPS runtime state (/opt/spaceworker has no
// .git — it is an rsync target, so a `--delete` sync removes every file not in
// the source tree). The app's .env lost its whole service-wiring block and
// `lib/env.ts` never noticed, because it only `required()`s the five values it
// cannot boot without. The app started perfectly happily and then failed
// feature-by-feature, silently, at request time:
//   * extraction jobs sat "queued" forever      → WORKER_BASE_URL / _AUTH_TOKEN
//   * private browser refused to start          → BROWSER_SERVER_TOKEN
//   * US/Canada routes vanished from the picker → EXIT_NODE_US / EXIT_NODE_CA
// The owner only found out by testing each feature by hand, hours later.
//
// This module makes that impossible: on boot the app logs ONE clearly-tagged
// line per degraded feature, so `journalctl -u spaceworker` answers "what is
// misconfigured?" immediately after any deploy or restart. It never throws —
// a missing optional key must NOT take the app down; it must only be loud.
//
// Deliberately NOT in lib/env.ts: that module is imported everywhere and must
// stay a pure accessor (its `required()` throws at import time).

interface FeatureEnv {
  /** Owner-visible capability that stops working without the keys. */
  feature: string;
  /** Env keys this feature needs (all of them). */
  keys: string[];
  /** False for keys that are genuinely optional (dev/EXE/template conveniences). */
  severe?: boolean;
}

const FEATURES: FeatureEnv[] = [
  { feature: "Extraction queue (searches never leave \"queued\")", keys: ["WORKER_BASE_URL", "WORKER_AUTH_TOKEN"], severe: true },
  { feature: "Private browser sessions", keys: ["BROWSER_SERVER_TOKEN"], severe: true },
  { feature: "Free exit nodes / location picker (US, CA)", keys: ["EXIT_NODE_US"], severe: true },
  { feature: "Telegram notifications + /start linking", keys: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_BOT_USERNAME"] },
  { feature: "Owner Telegram alerts", keys: ["ADMIN_TELEGRAM_CHAT_ID"] },
  { feature: "Ready-made campaign templates", keys: ["SYSTEM_TEMPLATES_USER_EMAIL"] },
  { feature: "Vantra device tools (clone/remote)", keys: ["VANTRA_INTERNAL_TOKEN"], severe: true },
];

export interface EnvHealthIssue {
  feature: string;
  missing: string[];
  severe: boolean;
}

/** Pure check so it can be unit-tested / reused by an admin surface. */
export function checkEnvHealth(env: Record<string, string | undefined> = process.env): EnvHealthIssue[] {
  const issues: EnvHealthIssue[] = [];
  for (const f of FEATURES) {
    const missing = f.keys.filter((k) => !env[k] || env[k]!.trim().length === 0);
    if (missing.length > 0) issues.push({ feature: f.feature, missing, severe: f.severe === true });
  }
  return issues;
}

/**
 * Logs one line per broken feature (names only — never values, so this is safe
 * in a journal that gets pasted into a chat). `severe` issues are tagged
 * CRITICAL, the rest WARN.
 */
export function logEnvHealth(): void {
  const issues = checkEnvHealth();
  if (issues.length === 0) {
    console.log("[env-health] OK — every feature's env keys are present.");
    return;
  }
  for (const issue of issues) {
    const tag = issue.severe ? "CRITICAL" : "WARN";
    console.log(
      `[env-health] ${tag}: ${issue.feature} is NOT configured — missing ${issue.missing.join(", ")}.`,
    );
  }
}
