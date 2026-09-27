// Typed environment accessor. Throws at boot if a required var is missing, so a
// misconfigured deployment fails loudly instead of failing at runtime mid-request.

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function number(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be a number, got "${raw}"`);
  }
  return parsed;
}

// 2026-09-27 (live incident) — SESSION_SECRET sat as the literal string
// "local_dev_session_secret_not_for_prod_..." in the real production .env for
// days (root cause never established; RESEND_API_KEY was found reverted to
// its own dev placeholder the same way, in BOTH SpaceWorker's and Vantra's
// .env, at the same time — most likely a .env restored from an old backup
// during some other operation). Neither failure was loud: Resend silently
// logged "failed" to NotificationLog instead of paging anyone, and a
// dev-labeled SESSION_SECRET would have just kept signing tokens fine, never
// erroring at all, while being a live forgeable-session vulnerability.
//
// This makes the same class of mistake IMPOSSIBLE to ship silently again:
// refuse to boot outright if any secret-shaped value still carries a known
// dev/placeholder marker while genuinely running in production.
//
// Gated on `!process.env.CI` specifically (not just NODE_ENV): the CI build
// (.github/workflows/deploy.yml) legitimately sets NODE_ENV=production AND
// its own "ci-placeholder-secret"-style values for every build — GitHub
// Actions runners set CI=true automatically for every job, which is the one
// signal that's true in CI and false on the real VPS, so this can gate on
// "real production runtime" without touching the CI placeholders at all.
const PLACEHOLDER_PATTERNS = [
  /placeholder/i,
  /changeme/i,
  /not_for_prod/i,
  /local_dev/i,
  /\bdummy\b/i,
  /fixme/i,
  /your_key/i,
];

function guardAgainstPlaceholder(name: string, value: string): string {
  if (process.env.NODE_ENV !== "production" || process.env.CI) return value;
  for (const pattern of PLACEHOLDER_PATTERNS) {
    if (pattern.test(value)) {
      throw new Error(
        `${name} looks like a dev/placeholder value in PRODUCTION (starts "${value.slice(0, 12)}..."). ` +
          `Refusing to boot rather than silently ship a broken/insecure secret again ` +
          `(2026-09-27 incident: this exact pattern took RESEND_API_KEY and SESSION_SECRET down at once). ` +
          `Set a real value in .env.`,
      );
    }
  }
  return value;
}

/** Like required(), but also refuses a placeholder-shaped value in real production. */
function requiredSecret(name: string): string {
  return guardAgainstPlaceholder(name, required(name));
}

/**
 * An OPTIONAL secret — blank is a legitimate, intentional "not configured"
 * state (every caller already fails soft on that), so only a genuinely SET
 * value is checked against the placeholder patterns.
 */
function optionalSecret(name: string): string {
  const value = process.env[name] ?? "";
  if (value.trim() === "") return value;
  return guardAgainstPlaceholder(name, value);
}

const appBaseUrl = required("APP_BASE_URL");

// TASK_122 (B11) D2 — the PUBLIC install-link host must be movable
// independently of the other ten `appBaseUrl` call sites (PIN callback,
// campaign links, licence links, the setup-bundle base, ...). Defaults to
// `appBaseUrl`, trailing slash stripped once here (so lib/vantra-link.ts's
// call site never needs its own `.replace(/\/$/, "")`), which means this is
// a ZERO-BEHAVIOUR-CHANGE addition until PUBLIC_LINK_BASE_URL is explicitly
// set — required by §7's owner gate: spaceworker.instaweb.top has no DNS yet
// (measured 2026-09-26: http=000), so the default must keep resolving to the
// live, working host, never a new one nobody asked to switch to.
const publicLinkBaseUrl = (process.env.PUBLIC_LINK_BASE_URL || appBaseUrl).replace(/\/$/, "");

// These are read directly via process.env at their own call sites elsewhere
// (browser-server, worker auth, the clone engine, the screenshot capture
// service, ...) rather than restructured through this module — that would be
// a much bigger refactor for no behavioural gain. But the exact same silent-
// failure risk applies to every one of them, so they get the same boot-time
// placeholder check anyway: this loop's only job is running guardAgainstPlaceholder
// on each (a no-op when unset or genuinely fine), purely for its throw.
for (const name of [
  "BROWSER_SERVER_TOKEN",
  "CLONE_ENGINE_SECRET",
  "EXE_LICENSE_SECRET",
  "INTERNAL_BEARER_TOKEN",
  "MAILBOX_ENCRYPTION_KEY",
  "SCREENSHOT_CAPTURE_TOKEN",
  "VANTRA_INTERNAL_TOKEN",
  "WORKER_AUTH_TOKEN",
  "SEED_MAILBOX_PASSWORD",
]) {
  optionalSecret(name);
}

export const env = {
  databaseUrl: required("DATABASE_URL"),
  sessionSecret: requiredSecret("SESSION_SECRET"),
  resendApiKey: requiredSecret("RESEND_API_KEY"),
  emailFrom: required("EMAIL_FROM"),
  appBaseUrl,
  publicLinkBaseUrl,

  // Admin panel shared passcode (SpaceWorker's ops). OPTIONAL, never required() —
  // but the admin login FAILS CLOSED when unset ("unset" = "locked", never
  // "open"). Checked at the call site in lib/admin-auth.
  adminToken: optionalSecret("ADMIN_TOKEN"),

  // Task 28, item 5 — the account whose EmailCampaign rows are surfaced as
  // "ready-made campaign templates". OPTIONAL: when unset there are no
  // ready-made templates and only the user's own campaigns can be automation
  // templates (today's behaviour).
  systemTemplatesUserEmail: process.env.SYSTEM_TEMPLATES_USER_EMAIL ?? "",

  // Task 31 — the API key for SpaceWorker's Channelry external-AI relay client
  // (client_id "spaceworker", $50/day pooled cap). OPTIONAL: when blank the
  // admin "Test connection" button and the AI agent fail CLOSED (marked "not
  // configured") — never send a fake/empty key to Channelry.
  channelryAiApiKey: optionalSecret("CHANNELRY_AI_API_KEY"),

  // Task 39 — Telegram notifications. All OPTIONAL/fail-soft, same discipline as
  // channelryAiApiKey: Telegram simply doesn't fire when unconfigured and
  // everything else keeps working.
  //  - telegramBotToken: the bot's API token from @BotFather. blank => no
  //    sends, no /start linking.
  //  - telegramBotUsername: the bot's @username, used to build the Connect deep
  //    link (https://t.me/<username>?start=<token>).
  //  - telegramWebhookSecret: the secret passed to setWebhook's
  //    secret_token (via the X-Telegram-Bot-Api-Secret-Token header). The
  //    webhook route FAILS CLOSED (401) when unset, matching adminToken's
  //    "unset = locked" rule.
  telegramBotToken: optionalSecret("TELEGRAM_BOT_TOKEN"),
  telegramBotUsername: process.env.TELEGRAM_BOT_USERNAME ?? "",
  telegramWebhookSecret: optionalSecret("TELEGRAM_WEBHOOK_SECRET"),

  // 2026-09-20 — owner: wants a Telegram ping for every EXE license bind/
  // transfer and every new signup. Distinct from telegramBotToken's per-USER
  // notifications (each customer links their own chat via /start): this is
  // the OWNER's own chat id, a single fixed destination for operational
  // alerts. Same bot/token — just a second, fixed recipient. Blank => the
  // alert helper no-ops (fail-soft, same discipline as every other optional
  // notification channel here).
  adminTelegramChatId: process.env.ADMIN_TELEGRAM_CHAT_ID ?? "",

  port: number("PORT", 3400),
};

export type Env = typeof env;