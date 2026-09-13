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

export const env = {
  databaseUrl: required("DATABASE_URL"),
  sessionSecret: required("SESSION_SECRET"),
  resendApiKey: required("RESEND_API_KEY"),
  emailFrom: required("EMAIL_FROM"),
  appBaseUrl: required("APP_BASE_URL"),

  // Admin panel shared passcode (SpaceWorker's ops). OPTIONAL, never required() —
  // but the admin login FAILS CLOSED when unset ("unset" = "locked", never
  // "open"). Checked at the call site in lib/admin-auth.
  adminToken: process.env.ADMIN_TOKEN ?? "",

  // Task 28, item 5 — the account whose EmailCampaign rows are surfaced as
  // "ready-made campaign templates". OPTIONAL: when unset there are no
  // ready-made templates and only the user's own campaigns can be automation
  // templates (today's behaviour).
  systemTemplatesUserEmail: process.env.SYSTEM_TEMPLATES_USER_EMAIL ?? "",

  // Task 31 — the API key for SpaceWorker's Channelry external-AI relay client
  // (client_id "spaceworker", $50/day pooled cap). OPTIONAL: when blank the
  // admin "Test connection" button and the AI agent fail CLOSED (marked "not
  // configured") — never send a fake/empty key to Channelry.
  channelryAiApiKey: process.env.CHANNELRY_AI_API_KEY ?? "",

  port: number("PORT", 3400),
};

export type Env = typeof env;