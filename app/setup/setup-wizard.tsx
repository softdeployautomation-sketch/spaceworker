"use client";

import { useState } from "react";

// TASK_130 §2 — the single-page, six-step first-run wizard. Deliberate friction:
// nothing is persisted to the server until the FINAL "Confirm and finish setup"
// (step 6). Steps 3–5 "Test" actions hit the setup APIs, which validate against
// the submitted values and persist nothing; every collected value lives here in
// React state until the final POST to /api/setup/complete.

interface SetupWizardProps {
  databaseLabel: string;
  emailConfigured: boolean;
  initialLicenseValidated: boolean;
}

const STEP_LABELS = [
  "License",
  "Database",
  "Device management",
  "AI provider",
  "Notifications",
  "Review",
] as const;

interface ApiOk {
  ok?: boolean;
  error?: string;
  code?: string;
  content?: string;
  valid?: boolean;
  licensee?: string;
  plan?: string;
  expiresAt?: string;
  username?: string;
  // TASK_145 T10 (senior §3 D6.2/D6.4) — the server's own classification of the
  // decoded `expires_at` sentinel. Never recomputed client-side.
  lifetime?: boolean;
}

async function postJson(url: string, body: unknown): Promise<{ status: number; data: ApiOk }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let data: ApiOk = {};
  try {
    data = (await res.json()) as ApiOk;
  } catch {
    data = {};
  }
  return { status: res.status, data };
}

/** Masks a secret for display, e.g. `sk-••••••••1234`. Never shows the middle. */
function maskSecret(value: string): string {
  if (value.length <= 6) return "••••••";
  return `${value.slice(0, 3)}••••••••${value.slice(-4)}`;
}

/**
 * TASK_145 T10 (senior §3 D6.3) — human-readable label for the expiry the API
 * returned. Mirrors the codebase's Python-isoformat convention
 * (`lib/exe-license-validator.ts:124-131`): the value is UTC-naive, so append
 * 'Z' before parsing. This only *labels* the date — it never classifies the
 * licence (that is the API's `lifetime` flag, decided server-side) — and it
 * returns "" for unreadable input so the caller degrades instead of rendering
 * "Invalid Date".
 */
function formatExpiry(value: string): string {
  if (!value) return "";
  const parsed = new Date(value + "Z");
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

function Field({
  label,
  hint,
  value,
  onChange,
  type = "text",
  placeholder,
  disabled,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <label className="mt-4 block">
      <span className="text-sm font-medium text-fg">{label}</span>
      {hint ? <span className="mt-0.5 block text-xs text-fg-muted">{hint}</span> : null}
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        className="mt-1 w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg outline-none focus:border-brand-600 disabled:opacity-60"
      />
    </label>
  );
}

function ErrorText({ children }: { children: string }) {
  if (!children) return null;
  return (
    <p className="mt-3 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
      {children}
    </p>
  );
}

function OkText({ children }: { children: string }) {
  if (!children) return null;
  return (
    <p className="mt-3 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300">
      {children}
    </p>
  );
}

export default function SetupWizard({
  databaseLabel,
  emailConfigured,
  initialLicenseValidated,
}: SetupWizardProps) {
  const [step, setStep] = useState(1);

  // --- Step 1: license -------------------------------------------------------
  const [licenseKey, setLicenseKey] = useState("");
  const [licenseValidated, setLicenseValidated] = useState(initialLicenseValidated);
  const [licenseLicensee, setLicenseLicensee] = useState("");
  const [licenseError, setLicenseError] = useState("");
  const [licenseBusy, setLicenseBusy] = useState(false);
  // TASK_145 T10 (senior §3 D6.4) — stored beside `licenseValidated`, straight
  // from the API's own `lifetime` boolean (never re-derived from a date).
  const [licenseLifetime, setLicenseLifetime] = useState(false);
  const [licenseExpiresAt, setLicenseExpiresAt] = useState("");

  // --- Step 3: RMM Engine ----------------------------------------------------
  const [rmmUrl, setRmmUrl] = useState("");
  const [rmmToken, setRmmToken] = useState("");
  const [rmmTested, setRmmTested] = useState(false);
  const [rmmSkipped, setRmmSkipped] = useState(false);
  const [rmmError, setRmmError] = useState("");
  const [rmmBusy, setRmmBusy] = useState(false);

  // --- Step 4: AI provider ---------------------------------------------------
  const [aiKey, setAiKey] = useState("");
  const [aiBaseUrl, setAiBaseUrl] = useState("");
  const [aiModel, setAiModel] = useState("");
  const [aiTested, setAiTested] = useState(false);
  const [aiSkipped, setAiSkipped] = useState(false);
  const [aiError, setAiError] = useState("");
  const [aiBusy, setAiBusy] = useState(false);

  // --- Step 5: Notifications -------------------------------------------------
  const [telegramToken, setTelegramToken] = useState("");
  const [telegramUsername, setTelegramUsername] = useState("");
  const [telegramTested, setTelegramTested] = useState(false);
  const [telegramSkipped, setTelegramSkipped] = useState(false);
  const [telegramError, setTelegramError] = useState("");
  const [telegramBusy, setTelegramBusy] = useState(false);

  // --- Step 6: finish --------------------------------------------------------
  const [completing, setCompleting] = useState(false);
  const [completeError, setCompleteError] = useState("");
  const [finished, setFinished] = useState<{
    envLocalWritten: boolean;
    envLocalError?: string;
    restartNotice: string;
  } | null>(null);

  async function activateLicense() {
    setLicenseBusy(true);
    setLicenseError("");
    try {
      const { data } = await postJson("/api/setup/license/validate", { licenseKey });
      if (data.valid) {
        setLicenseValidated(true);
        setLicenseLicensee(data.licensee ?? "");
        setLicenseLifetime(Boolean(data.lifetime));
        setLicenseExpiresAt(data.expiresAt ?? "");
      } else {
        setLicenseValidated(false);
        setLicenseLifetime(false);
        setLicenseExpiresAt("");
        setLicenseError(data.error ?? "That license key was not accepted.");
      }
    } catch {
      setLicenseError("Could not reach the server. Try again.");
    } finally {
      setLicenseBusy(false);
    }
  }

  async function testRmm() {
    setRmmBusy(true);
    setRmmError("");
    try {
      const { data } = await postJson("/api/setup/rmm-engine/test", { url: rmmUrl, token: rmmToken });
      if (data.ok) setRmmTested(true);
      else {
        setRmmTested(false);
        setRmmError(data.error ?? "Connection test failed.");
      }
    } catch {
      setRmmError("Could not reach the server. Try again.");
    } finally {
      setRmmBusy(false);
    }
  }

  async function testAi() {
    setAiBusy(true);
    setAiError("");
    try {
      const { data } = await postJson("/api/setup/ai-provider/test", {
        apiKey: aiKey,
        baseUrl: aiBaseUrl,
        model: aiModel,
      });
      if (data.ok) setAiTested(true);
      else {
        setAiTested(false);
        setAiError(data.error ?? "AI provider test failed.");
      }
    } catch {
      setAiError("Could not reach the server. Try again.");
    } finally {
      setAiBusy(false);
    }
  }

  async function testTelegram() {
    setTelegramBusy(true);
    setTelegramError("");
    try {
      const { data } = await postJson("/api/setup/telegram/test", { botToken: telegramToken });
      if (data.ok) {
        setTelegramTested(true);
        if (data.username && !telegramUsername) setTelegramUsername(data.username);
      } else {
        setTelegramTested(false);
        setTelegramError(data.error ?? "Telegram test failed.");
      }
    } catch {
      setTelegramError("Could not reach the server. Try again.");
    } finally {
      setTelegramBusy(false);
    }
  }

  async function finishSetup() {
    setCompleting(true);
    setCompleteError("");
    try {
      const { status, data } = await postJson("/api/setup/complete", {
        licenseKey,
        ...(rmmSkipped ? { skipRmmEngine: true } : { rmmEngine: { url: rmmUrl, token: rmmToken } }),
        ...(aiSkipped ? { skipAiProvider: true } : { aiProvider: { apiKey: aiKey, baseUrl: aiBaseUrl, model: aiModel } }),
        ...(telegramSkipped
          ? { skipTelegram: true }
          : { telegram: { botToken: telegramToken, botUsername: telegramUsername } }),
      });
      if (status >= 400 || !data.ok) {
        setCompleteError(data.error ?? `Setup could not be completed (HTTP ${status}).`);
        return;
      }
      setFinished({
        envLocalWritten: Boolean((data as unknown as { envLocalWritten?: boolean }).envLocalWritten),
        envLocalError: (data as unknown as { envLocalError?: string }).envLocalError,
        restartNotice:
          (data as unknown as { restartNotice?: string }).restartNotice ??
          "Restart SpaceWorker for the new settings to take effect.",
      });
    } catch {
      setCompleteError("Could not reach the server. Try again.");
    } finally {
      setCompleting(false);
    }
  }

  // TASK_145 T10 (senior §3 D6.3) — label only; "" when the date is unreadable.
  const licenseExpiryLabel = formatExpiry(licenseExpiresAt);

  const canContinue =
    step === 1
      ? licenseValidated
      : step === 3
        ? rmmTested || rmmSkipped
        : step === 4
          ? aiTested || aiSkipped
          : step === 5
            ? telegramTested || telegramSkipped
            : true;


  if (finished) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg px-4">
        <div className="w-full max-w-lg rounded-xl border border-border bg-bg-elevated p-8 shadow-sm">
          <h1 className="text-xl font-bold text-fg">Setup complete</h1>
          <p className="mt-2 text-sm text-fg-muted">{finished.restartNotice}</p>
          {finished.envLocalWritten ? (
            <OkText>Saved your settings to .env.local — they take effect on the next start.</OkText>
          ) : (
            <ErrorText>
              {`Settings were saved, but appending to .env.local failed${
                finished.envLocalError ? ` (${finished.envLocalError})` : ""
              }. Set the values in your environment by hand before restarting.`}
            </ErrorText>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-bg px-4 py-10">
      <div className="mx-auto w-full max-w-2xl">
        <h1 className="text-2xl font-bold tracking-tight text-fg">Set up SpaceWorker</h1>
        <p className="mt-1 text-sm text-fg-muted">
          A few one-time steps before this instance is usable. Nothing is saved until the final
          confirmation.
        </p>

        <ol className="mt-6 flex flex-wrap items-center gap-2 text-xs">
          {STEP_LABELS.map((label, i) => {
            const n = i + 1;
            const active = n === step;
            const done = n < step;
            return (
              <li key={label} className="flex items-center gap-2">
                <span
                  className={`flex h-6 w-6 items-center justify-center rounded-full font-semibold ${
                    active
                      ? "bg-brand-600 text-white"
                      : done
                        ? "bg-emerald-500 text-white"
                        : "bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
                  }`}
                >
                  {done ? "✓" : n}
                </span>
                <span className={active ? "font-medium text-fg" : "text-fg-muted"}>{label}</span>
                {n < STEP_LABELS.length ? <span className="text-fg-muted">·</span> : null}
              </li>
            );
          })}
        </ol>

        <div className="mt-6 rounded-xl border border-border bg-bg-elevated p-6 shadow-sm">

          {step === 1 && (
            <section>
              <h2 className="text-lg font-semibold text-fg">1. Activate your license</h2>
              <p className="mt-1 text-sm text-fg-muted">
                Paste the license key for this SpaceWorker install. This step can&apos;t be skipped.
              </p>
              <Field
                label="License key"
                value={licenseKey}
                onChange={setLicenseKey}
                placeholder="payload.signature"
                disabled={licenseBusy}
              />
              <button
                type="button"
                onClick={activateLicense}
                disabled={licenseBusy || licenseKey.trim().length === 0}
                className="mt-4 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
              >
                {licenseBusy ? "Activating…" : "Activate"}
              </button>
              {licenseValidated ? (
                <OkText>
                  {licenseLicensee
                    ? licenseLifetime
                      ? `License accepted for ${licenseLicensee} — lifetime license, no renewal needed.`
                      : licenseExpiryLabel
                        ? `License accepted for ${licenseLicensee}. Valid until ${licenseExpiryLabel}.`
                        : `License accepted for ${licenseLicensee}.`
                    : "License accepted."}
                </OkText>
              ) : null}
              <ErrorText>{licenseError}</ErrorText>
            </section>
          )}

          {step === 2 && (
            <section>
              <h2 className="text-lg font-semibold text-fg">2. Database</h2>
              <p className="mt-1 text-sm text-fg-muted">
                This instance is already connected to its database (it was required to start).
                Confirm it&apos;s the right one:
              </p>
              <p className="mt-4 rounded-lg border border-border bg-bg px-3 py-2 font-mono text-sm text-fg">
                {databaseLabel}
              </p>
              <p className="mt-3 text-xs text-fg-muted">
                To change it later, edit DATABASE_URL in your environment and restart.
              </p>
            </section>
          )}

          {step === 3 && (
            <section>
              <h2 className="text-lg font-semibold text-fg">3. Device management (RMM Engine)</h2>
              <p className="mt-1 text-sm text-fg-muted">
                Optional. Connect your SpaceWorker RMM Engine to manage devices. You can also add
                this later from the admin Infrastructure tab.
              </p>
              <Field
                label="RMM Engine URL"
                value={rmmUrl}
                onChange={setRmmUrl}
                placeholder="https://rmm.example.com"
                disabled={rmmSkipped}
              />
              <Field
                label="RMM Engine token"
                type="password"
                value={rmmToken}
                onChange={setRmmToken}
                disabled={rmmSkipped}
              />
              <button
                type="button"
                onClick={testRmm}
                disabled={rmmBusy || rmmSkipped || !rmmUrl || !rmmToken}
                className="mt-4 rounded-lg border border-border px-4 py-2 text-sm font-medium text-fg hover:bg-bg disabled:opacity-50"
              >
                {rmmBusy ? "Testing…" : "Test connection"}
              </button>
              {rmmTested ? <OkText>Connected to the RMM Engine.</OkText> : null}
              <ErrorText>{rmmError}</ErrorText>
              <label className="mt-4 flex items-center gap-2 text-sm text-fg">
                <input
                  type="checkbox"
                  checked={rmmSkipped}
                  onChange={(e) => {
                    setRmmSkipped(e.target.checked);
                    setRmmError("");
                  }}
                />
                Set this up later from Admin → Infrastructure
              </label>
            </section>
          )}

          {step === 4 && (
            <section>
              <h2 className="text-lg font-semibold text-fg">4. AI provider</h2>
              <p className="mt-1 text-sm text-fg-muted">
                Optional but recommended. SpaceWorker talks to any OpenAI-compatible endpoint with
                your own key. Without it, AI features stay disabled.
              </p>
              <Field
                label="API key"
                type="password"
                value={aiKey}
                onChange={setAiKey}
                placeholder="sk-…"
                disabled={aiSkipped}
              />
              <Field
                label="Base URL"
                hint="Leave blank for the default OpenAI endpoint."
                value={aiBaseUrl}
                onChange={setAiBaseUrl}
                placeholder="https://api.openai.com/v1"
                disabled={aiSkipped}
              />
              <Field
                label="Model"
                value={aiModel}
                onChange={setAiModel}
                placeholder="gpt-4o-mini"
                disabled={aiSkipped}
              />
              <button
                type="button"
                onClick={testAi}
                disabled={aiBusy || aiSkipped || aiKey.trim().length === 0}
                className="mt-4 rounded-lg border border-border px-4 py-2 text-sm font-medium text-fg hover:bg-bg disabled:opacity-50"
              >
                {aiBusy ? "Testing…" : "Test connection"}
              </button>
              {aiTested ? <OkText>The AI provider responded successfully.</OkText> : null}
              <ErrorText>{aiError}</ErrorText>
              <label className="mt-4 flex items-center gap-2 text-sm text-fg">
                <input
                  type="checkbox"
                  checked={aiSkipped}
                  onChange={(e) => {
                    setAiSkipped(e.target.checked);
                    setAiError("");
                  }}
                />
                Skip for now — AI features stay disabled
              </label>
            </section>
          )}

          {step === 5 && (
            <section>
              <h2 className="text-lg font-semibold text-fg">5. Notifications</h2>
              <p className="mt-1 text-sm text-fg-muted">
                How SpaceWorker reaches you. Each channel is optional and can be added later.
              </p>

              <div className="mt-4 rounded-lg border border-border bg-bg px-3 py-3">
                <p className="text-sm font-medium text-fg">Email (Resend)</p>
                {emailConfigured ? (
                  <OkText>Email is configured (RESEND_API_KEY is set).</OkText>
                ) : (
                  <p className="mt-2 text-xs text-fg-muted">
                    Not configured. Set RESEND_API_KEY in your environment and restart to enable
                    email.
                  </p>
                )}
              </div>

              <Field
                label="Telegram bot token"
                type="password"
                value={telegramToken}
                onChange={setTelegramToken}
                placeholder="123456:ABC-DEF…"
                disabled={telegramSkipped}
              />
              <Field
                label="Bot username"
                hint="Filled in automatically by a successful test."
                value={telegramUsername}
                onChange={setTelegramUsername}
                placeholder="MySpaceWorkerBot"
                disabled={telegramSkipped}
              />
              <button
                type="button"
                onClick={testTelegram}
                disabled={telegramBusy || telegramSkipped || telegramToken.trim().length === 0}
                className="mt-4 rounded-lg border border-border px-4 py-2 text-sm font-medium text-fg hover:bg-bg disabled:opacity-50"
              >
                {telegramBusy ? "Testing…" : "Test bot token"}
              </button>
              {telegramTested ? (
                <OkText>
                  {telegramUsername
                    ? `Telegram bot @${telegramUsername} is reachable.`
                    : "Telegram bot token accepted."}
                </OkText>
              ) : null}
              <ErrorText>{telegramError}</ErrorText>
              <label className="mt-4 flex items-center gap-2 text-sm text-fg">
                <input
                  type="checkbox"
                  checked={telegramSkipped}
                  onChange={(e) => {
                    setTelegramSkipped(e.target.checked);
                    setTelegramError("");
                  }}
                />
                Skip notifications setup
              </label>
            </section>
          )}

          {step === 6 && (
            <section>
              <h2 className="text-lg font-semibold text-fg">6. Review and finish</h2>
              <p className="mt-1 text-sm text-fg-muted">
                Confirm what will be saved. Your settings are written to .env.local and take effect
                after a restart.
              </p>
              <dl className="mt-4 divide-y divide-border rounded-lg border border-border bg-bg">
                <ReviewRow
                  label="License"
                  value={
                    licenseValidated ? (licenseLifetime ? "Lifetime" : "Activated") : "Not activated"
                  }
                />
                <ReviewRow label="Database" value={databaseLabel} />
                <ReviewRow
                  label="RMM Engine"
                  value={rmmSkipped ? "Skipped" : rmmUrl ? rmmUrl : "Not provided"}
                />
                <ReviewRow
                  label="AI provider"
                  value={
                    aiSkipped ? "Skipped" : aiKey ? `${aiModel || "default model"}` : "Not provided"
                  }
                />
                <ReviewRow
                  label="Email"
                  value={emailConfigured ? "Configured (Resend)" : "Not configured"}
                />
                <ReviewRow
                  label="Telegram"
                  value={
                    telegramSkipped
                      ? "Skipped"
                      : telegramToken
                        ? maskSecret(telegramToken)
                        : "Not provided"
                  }
                />
              </dl>
              <ErrorText>{completeError}</ErrorText>
            </section>
          )}
        </div>

        <div className="mt-6 flex items-center justify-between">
          <button
            type="button"
            onClick={() => setStep((s) => Math.max(1, s - 1))}
            disabled={step === 1 || completing}
            className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-fg hover:bg-bg disabled:opacity-40"
          >
            Back
          </button>
          {step < 6 ? (
            <button
              type="button"
              onClick={() => setStep((s) => Math.min(6, s + 1))}
              disabled={!canContinue}
              className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
            >
              Continue
            </button>
          ) : (
            <button
              type="button"
              onClick={finishSetup}
              disabled={completing || !licenseValidated}
              className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
            >
              {completing ? "Saving…" : "Confirm and finish setup"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4 px-3 py-2">
      <dt className="text-sm text-fg-muted">{label}</dt>
      <dd className="max-w-[60%] truncate text-right text-sm font-medium text-fg">{value}</dd>
    </div>
  );
}
