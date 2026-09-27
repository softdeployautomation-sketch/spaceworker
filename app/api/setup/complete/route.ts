import { NextResponse } from "next/server";

import { getAdminSession } from "@/lib/admin-auth";
import { env } from "@/lib/env";
import { exeLicenseSecret } from "@/lib/exe-license";
import { validateLicenseKey } from "@/lib/exe-license-validator";
import { isSelfHosted } from "@/lib/exe-build-target";
import { getCachedMachineId } from "@/lib/license-state";
import { invalidateSetupGateCache } from "@/lib/self-hosted-setup-gate";
import {
  readSetupState,
  updateSetupState,
  upsertLocalEnv,
} from "@/lib/self-hosted-setup-state";

// POST /api/setup/complete — body carrying everything collected in steps 1–5.
//
// TASK_130 §3 + §2 step 6. The single point where the wizard actually persists
// anything: writes `completedAt` to the setup-state file and best-effort
// appends every collected value to `.env.local`, then tells the UI a restart is
// required. (Steps 3–5's own "Test" actions deliberately persist nothing —
// see each route's comment.) Wiring an AUTOMATIC restart here is Phase 6
// (Tauri/Rust orchestration), explicitly out of scope.
//
// Required-ness: only the license is truly required; every other step may be
// skipped, but ONLY by an explicit `skipX: true` flag — a malformed body or a
// missing value with no skip flag is a 400, per "validates nothing is missing
// except explicitly-skipped optional steps".
interface CompleteBody {
  licenseKey?: unknown;
  rmmEngine?: { url?: unknown; token?: unknown } | null;
  skipRmmEngine?: unknown;
  aiProvider?: { apiKey?: unknown; baseUrl?: unknown; model?: unknown } | null;
  skipAiProvider?: unknown;
  telegram?: { botToken?: unknown; botUsername?: unknown } | null;
  skipTelegram?: unknown;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export async function POST(req: Request) {
  if (!isSelfHosted()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const state = await readSetupState();
  if (state.completedAt && !(await getAdminSession())) {
    return NextResponse.json({ error: "Setup already completed" }, { status: 403 });
  }

  let body: CompleteBody;
  try {
    body = (await req.json()) as CompleteBody;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  // ---- Step 1: license (mandatory) -----------------------------------------
  // Usually already validated and stored by /api/setup/license/validate. If the
  // body carries a key the state doesn't have, validate it now rather than
  // trusting an unvalidated client value.
  let licenseKey = state.license?.key ?? "";
  const bodyLicenseKey = str(body.licenseKey);
  if (bodyLicenseKey && bodyLicenseKey !== licenseKey) {
    let secret: string;
    try {
      secret = exeLicenseSecret();
    } catch {
      return NextResponse.json(
        { error: "Licensing is not configured on the server (EXE_LICENSE_SECRET unset)." },
        { status: 500 },
      );
    }
    const currentMachineId = (await getCachedMachineId()).toLowerCase();
    const validation = await validateLicenseKey(bodyLicenseKey, secret, { currentMachineId });
    if (!validation.valid) {
      return NextResponse.json(
        { error: `License activation is required before finishing setup: ${validation.error}` },
        { status: 400 },
      );
    }
    licenseKey = bodyLicenseKey;
  }
  if (!licenseKey) {
    return NextResponse.json(
      { error: "License activation is required before finishing setup." },
      { status: 400 },
    );
  }

  // ---- Step 3: RMM Engine (skippable) --------------------------------------
  const rmmUrl = str(body.rmmEngine?.url);
  const rmmToken = str(body.rmmEngine?.token);
  const rmmProvided = rmmUrl.length > 0 || rmmToken.length > 0;
  const skipRmm = body.skipRmmEngine === true;
  if (rmmProvided && (!rmmUrl || !rmmToken)) {
    return NextResponse.json(
      { error: "RMM Engine needs both a URL and a token, or an explicit skip." },
      { status: 400 },
    );
  }
  if (!rmmProvided && !skipRmm) {
    return NextResponse.json(
      { error: "Provide the RMM Engine connection or tick 'set this up later'." },
      { status: 400 },
    );
  }

  // ---- Step 4: AI provider (skippable) -------------------------------------
  const aiKey = str(body.aiProvider?.apiKey);
  const aiBaseUrl = str(body.aiProvider?.baseUrl);
  const aiModel = str(body.aiProvider?.model);
  const skipAi = body.skipAiProvider === true;
  if (!aiKey && !skipAi) {
    return NextResponse.json(
      { error: "Provide an AI provider key, or confirm AI features will be disabled." },
      { status: 400 },
    );
  }

  // ---- Step 5: Email / Telegram (skippable) --------------------------------
  const telegramToken = str(body.telegram?.botToken);
  const telegramUsername = str(body.telegram?.botUsername);
  const skipTelegram = body.skipTelegram === true;
  if (!telegramToken && !skipTelegram) {
    // Email needs no value here (RESEND_API_KEY is already a boot-required var —
    // see the telegram/test route's comment); only Telegram is optional-entry.
    return NextResponse.json(
      { error: "Provide a Telegram bot token, or tick 'skip notifications setup'." },
      { status: 400 },
    );
  }

  // ---- Persist: setup-state file -------------------------------------------
  const now = new Date().toISOString();
  // Email is "configured" whenever RESEND_API_KEY is set. lib/env.ts's
  // requiredSecret() has already refused to boot on a placeholder value in real
  // production, so a non-empty value here is a genuinely usable key.
  const emailConfigured = env.resendApiKey.trim().length > 0;

  await updateSetupState({
    license: { key: licenseKey, validatedAt: state.license?.validatedAt ?? now },
    ...(rmmProvided ? { rmmEngine: { url: rmmUrl, token: rmmToken, testedAt: now } } : {}),
    ...(aiKey
      ? {
          aiProvider: {
            configured: true,
            ...(aiBaseUrl ? { baseUrl: aiBaseUrl } : {}),
            ...(aiModel ? { model: aiModel } : {}),
            testedAt: now,
          },
        }
      : {}),
    email: { configured: emailConfigured },
    telegram: { configured: telegramToken.length > 0 },
    completedAt: now,
  });

  // ---- Persist: .env.local (what actually takes effect on restart) ---------
  // `SELF_HOSTED_LICENSE_KEY` is written (not read) here: no code path consumes
  // it yet, and it deliberately doesn't bypass validation — the license key
  // recorded in the state file is already the validated one. It's written so
  // that everything the wizard collected lives in one discoverable place for a
  // restart, and so Phase 6's installer / the plan's flexible-term license admin
  // UI have the key available without re-deriving it from the EXE activation
  // flow. Adding a reader for it is that later work's call, not this task's.
  const envVars: Record<string, string> = { SELF_HOSTED_LICENSE_KEY: licenseKey };
  if (rmmProvided) {
    envVars.VANTRA_INTERNAL_URL = rmmUrl;
    envVars.VANTRA_INTERNAL_TOKEN = rmmToken;
  }
  if (aiKey) {
    envVars.AI_PROVIDER_API_KEY = aiKey;
    if (aiBaseUrl) envVars.AI_PROVIDER_BASE_URL = aiBaseUrl;
    if (aiModel) envVars.AI_PROVIDER_MODEL = aiModel;
  }
  if (telegramToken) {
    envVars.TELEGRAM_BOT_TOKEN = telegramToken;
    if (telegramUsername) envVars.TELEGRAM_BOT_USERNAME = telegramUsername;
  }
  const envResult = await upsertLocalEnv(envVars);

  // Best-effort, in-process only (proxy's isolated bundle notices on its own
  // short TTL — see lib/self-hosted-setup-gate.ts).
  invalidateSetupGateCache();

  return NextResponse.json({
    ok: true,
    restartRequired: true,
    envLocalWritten: envResult.written,
    envLocalPath: envResult.written ? envResult.path : undefined,
    envLocalError: envResult.written ? undefined : envResult.error,
    restartNotice:
      "Setup saved. Restart the SpaceWorker process (and the RMM Engine, if you configured one) for the new settings to take effect.",
  });
}

