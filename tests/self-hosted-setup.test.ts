import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { mkdtempSync, realpathSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";

// TASK_130 — the self-hosted first-run setup wizard's contract, proven three
// ways (same house discipline as tests/device-status-sweep.test.ts, which loads
// the REAL route through a Module._load hook — HOW_WE_MOVE_FAST.md §4):
//
//   A. lib/self-hosted-setup-state.ts — the local state file (path resolution,
//      merge, completion marker) and the `.env.local` upsert that is what
//      actually takes effect on restart.
//   B. lib/self-hosted-setup-gate.ts — the proxy gate: an unconfigured
//      self-hosted install redirects, a configured one doesn't, a non-self-
//      hosted build NEVER does, and the wizard's own pages/APIs are exempt.
//   C. the five /api/setup/* routes — loaded as REAL modules, with only
//      `server-only`, `next/server` and `@/lib/admin-auth` swapped out (admin-
//      auth would drag in Prisma). Everything else is real: the real license
//      generator + real offline validator, the real env module, the real state
//      file, the real aiProviderChat. Nothing here touches a database, the
//      network, or the repo's own .env.local.
//
// Env notes: lib/env.ts requires DATABASE_URL / SESSION_SECRET / RESEND_API_KEY /
// EMAIL_FROM at import, so the test supplies them (below) — that's how the real
// module can be used instead of a stub. The placeholder guard is production-only
// and CI-aware, so it never fires here.

const TMP = mkdtempSync(`${process.env.TMPDIR ?? "/tmp"}/task130-setup-`);
process.env.SPACEWORKER_LOCAL_DATA_DIR = TMP;
process.env.SELF_HOSTED = "true";
process.env.DATABASE_URL = "postgresql://tester:pw@db.example.test:5432/spaceworker";
process.env.SESSION_SECRET = "task130-test-session-secret-value";
process.env.RESEND_API_KEY = "re_task130_test_key";
process.env.EMAIL_FROM = "setup@spaceworker.test";
process.env.APP_BASE_URL = "https://spaceworker.test";
process.env.EXE_LICENSE_SECRET = "task130-license-signing-secret";
delete process.env.CI;

// upsertLocalEnv() writes to `process.cwd()/.env.local` — point cwd at the same
// throwaway dir so a passing test can never edit the repo's real env file.
process.chdir(TMP);

type Loader = {
  _load: (request: string, parent: NodeModule | undefined, isMain: boolean) => unknown;
};

let adminSessionOk = false;

const NextResponseShim = {
  json: (body: unknown, init?: { status?: number }) => ({
    status: init?.status ?? 200,
    body,
    json: async () => body,
  }),
};

const SETUP_ROUTES = [
  "app/api/setup/license/validate/route.ts",
  "app/api/setup/rmm-engine/test/route.ts",
  "app/api/setup/ai-provider/test/route.ts",
  "app/api/setup/telegram/test/route.ts",
  "app/api/setup/complete/route.ts",
];

function installRequireHook(): void {
  const loader = Module as unknown as Loader;
  const original = loader._load;
  loader._load = function patched(request, parent, isMain) {
    // lib/*.ts all `import "server-only"` — a marker package whose non-RSC entry
    // throws by design. The house hook neutralises it (see the sweep test).
    if (request === "server-only") return {};
    const from = (parent?.filename ?? "").replace(/\\/g, "/");
    if (SETUP_ROUTES.some((route) => from.endsWith(`/${route}`))) {
      if (request === "next/server") return { NextResponse: NextResponseShim };
      if (request === "@/lib/admin-auth") {
        return { getAdminSession: async () => adminSessionOk };
      }
    }
    return original.call(this, request, parent, isMain);
  };
}

installRequireHook();

/* eslint-disable @typescript-eslint/no-require-imports */
const state = require("../lib/self-hosted-setup-state") as typeof import("../lib/self-hosted-setup-state");
const gate = require("../lib/self-hosted-setup-gate") as typeof import("../lib/self-hosted-setup-gate");
const licenseLib = require("../lib/exe-license") as typeof import("../lib/exe-license");
const aiProvider = require("../lib/ai-provider") as typeof import("../lib/ai-provider");
const licenseRoute = require("../app/api/setup/license/validate/route") as {
  POST: (req: Request) => Promise<RouteResponse>;
};
const rmmRoute = require("../app/api/setup/rmm-engine/test/route") as {
  POST: (req: Request) => Promise<RouteResponse>;
};
const aiRoute = require("../app/api/setup/ai-provider/test/route") as {
  POST: (req: Request) => Promise<RouteResponse>;
};
const telegramRoute = require("../app/api/setup/telegram/test/route") as {
  POST: (req: Request) => Promise<RouteResponse>;
};
const completeRoute = require("../app/api/setup/complete/route") as {
  POST: (req: Request) => Promise<RouteResponse>;
};
/* eslint-enable @typescript-eslint/no-require-imports */

interface RouteResponse {
  status: number;
  body: Record<string, unknown>;
}

// ---- fetch stub (the three connection-test routes + aiProviderChat) ---------
type FetchCall = { url: string; init?: RequestInit };
let fetchCalls: FetchCall[] = [];
let fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  fetchCalls.push({ url, init });
  return fetchImpl(url, init);
}) as typeof globalThis.fetch;

// Leave the process exactly as we found it — a later test file sharing this
// process must never inherit the stub.
after(() => {
  globalThis.fetch = realFetch;
});

function postJson(route: { POST: (req: Request) => Promise<RouteResponse> }, body: unknown) {
  return route.POST(
    new Request("https://spaceworker.test/api/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

const STATE_FILE = path.join(TMP, "self-hosted-setup-state.json");
const ENV_LOCAL = path.join(TMP, ".env.local");

async function resetLocalFiles(): Promise<void> {
  await rm(STATE_FILE, { force: true });
  await rm(ENV_LOCAL, { force: true });
  await rm(path.join(TMP, "exe-license-state.json"), { force: true });
}

beforeEach(async () => {
  await resetLocalFiles();
  gate.invalidateSetupGateCache();
  adminSessionOk = false;
  process.env.SELF_HOSTED = "true";
  fetchCalls = [];
  fetchImpl = async () => new Response("{}", { status: 200 });
});

// ===========================================================================
// A. lib/self-hosted-setup-state.ts — the local state file + .env.local writer
// ===========================================================================

test("A1: setupStatePath() honours SPACEWORKER_LOCAL_DATA_DIR, like license-state", () => {
  assert.equal(state.setupStatePath(), STATE_FILE);

  const saved = process.env.SPACEWORKER_LOCAL_DATA_DIR;
  process.env.SPACEWORKER_LOCAL_DATA_DIR = "/tmp/task130-other-location";
  try {
    assert.equal(
      state.setupStatePath(),
      path.join("/tmp/task130-other-location", "self-hosted-setup-state.json"),
    );
  } finally {
    process.env.SPACEWORKER_LOCAL_DATA_DIR = saved;
  }
});

test("A2: a fresh install reads { version: 1 } and is NOT complete", async () => {
  assert.deepEqual(await state.readSetupState(), { version: 1 });
  assert.equal(await state.isSetupComplete(), false);
});

test("A3: updateSetupState merges fields and isSetupComplete flips on completedAt", async () => {
  await state.updateSetupState({ license: { key: "k-1", validatedAt: "2026-09-27T00:00:00.000Z" } });
  await state.updateSetupState({ telegram: { configured: true } });
  // The first patch's field must survive the second (no blind overwrite).
  const merged = await state.readSetupState();
  assert.equal(merged.license?.key, "k-1");
  assert.equal(merged.telegram?.configured, true);
  assert.equal(merged.version, 1);
  assert.equal(await state.isSetupComplete(), false, "no completedAt yet");

  await state.updateSetupState({ completedAt: "2026-09-27T12:00:00.000Z" });
  assert.equal(await state.isSetupComplete(), true);
});

test("A4: a corrupt state file is tolerated (defaults, never a throw)", async () => {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(STATE_FILE, "{ this is not json", "utf8");
  assert.deepEqual(await state.readSetupState(), { version: 1 });
  // A file with the wrong envelope version is treated as absent, too.
  await writeFile(STATE_FILE, JSON.stringify({ version: 2, completedAt: "x" }), "utf8");
  assert.deepEqual(await state.readSetupState(), { version: 1 });
});

test("A5: upsertLocalEnv creates .env.local, then updates in place and appends", async () => {
  const first = await state.upsertLocalEnv({
    AI_PROVIDER_API_KEY: "sk-first",
    SELF_HOSTED_LICENSE_KEY: "payload.sig",
  });
  assert.equal(first.written, true);
  // macOS resolves /var -> /private/var, so compare real paths, not raw strings.
  assert.equal(realpathSync(first.path), realpathSync(ENV_LOCAL));

  const second = await state.upsertLocalEnv({
    AI_PROVIDER_API_KEY: "sk-second",
    TELEGRAM_BOT_TOKEN: "123:abc",
  });
  assert.equal(second.written, true);

  const contents = await readFile(ENV_LOCAL, "utf8");
  assert.equal(
    contents,
    ["AI_PROVIDER_API_KEY=sk-second", "SELF_HOSTED_LICENSE_KEY=payload.sig", "TELEGRAM_BOT_TOKEN=123:abc", ""].join(
      "\n",
    ),
  );
  // The replaced key appears exactly once — never duplicated.
  assert.equal(contents.split("AI_PROVIDER_API_KEY=").length - 1, 1);
});

test("A6: upsertLocalEnv preserves unrelated lines and quotes values dotenv would split", async () => {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(ENV_LOCAL, "# mine\nKEEP_ME=1\nAI_PROVIDER_MODEL=old\n\n", "utf8");

  await state.upsertLocalEnv({
    AI_PROVIDER_MODEL: "llama 3.1 8b # local",
    VANTRA_INTERNAL_URL: "http://rmm.internal:8080",
  });

  const lines = (await readFile(ENV_LOCAL, "utf8")).split("\n");
  assert.equal(lines[0], "# mine");
  assert.equal(lines[1], "KEEP_ME=1");
  assert.equal(lines[2], 'AI_PROVIDER_MODEL="llama 3.1 8b # local"');
  assert.equal(lines[3], "VANTRA_INTERNAL_URL=http://rmm.internal:8080");
  assert.equal(lines[4], "", "file ends with exactly one newline");
});

test("A7: upsertLocalEnv refuses malformed keys and never throws on an unwritable path", async () => {
  await state.upsertLocalEnv({ "not a key": "x", GOOD_KEY: "y" });
  assert.equal(await readFile(ENV_LOCAL, "utf8"), "GOOD_KEY=y\n");

  // A read-only/unwritable cwd must yield { written: false }, not a rejection —
  // 'setup finished' must never 500 because the install dir is read-only.
  const saved = process.cwd();
  process.chdir("/");
  try {
    // cwd "/" is genuinely unwritable for a normal user; if it somehow isn't,
    // the call still must not throw — either outcome is acceptable, silence isn't.
    const result = await state.upsertLocalEnv({ SOME_KEY: "v" });
    assert.equal(typeof result.written, "boolean");
  } finally {
    process.chdir(saved);
  }
});

// ===========================================================================
// B. lib/self-hosted-setup-gate.ts — the proxy redirect gate
// ===========================================================================

test("B1: the wizard's own pages/APIs and Next's static assets are exempt", () => {
  for (const allowed of [
    "/setup",
    "/setup/anything",
    "/api/setup",
    "/api/setup/license/validate",
    "/api/setup/complete",
    "/_next/static/chunks/main.js",
    "/favicon.ico",
  ]) {
    assert.equal(gate.isSetupAllowedPath(allowed), true, `${allowed} must be allowed`);
  }
  for (const blocked of ["/", "/admin", "/admin/login", "/api/admin/settings", "/dashboard/x"]) {
    assert.equal(gate.isSetupAllowedPath(blocked), false, `${blocked} must NOT be allowed`);
  }
});

test("B2: a NON-self-hosted build is never redirected, even with no setup state", async () => {
  process.env.SELF_HOSTED = "";
  assert.equal(await gate.shouldRedirectToSetup("/"), false);
  assert.equal(await gate.shouldRedirectToSetup("/admin"), false);
  // SELF_HOSTED must be the literal "true", exactly like isSelfHosted().
  process.env.SELF_HOSTED = "1";
  gate.invalidateSetupGateCache();
  assert.equal(await gate.shouldRedirectToSetup("/"), false);
});

test("B3: self-hosted + no completedAt redirects every non-wizard path", async () => {
  assert.equal(await gate.shouldRedirectToSetup("/"), true);
  assert.equal(await gate.shouldRedirectToSetup("/admin"), true);
  gate.invalidateSetupGateCache();
  assert.equal(await gate.shouldRedirectToSetup("/setup"), false, "the wizard itself must load");
  gate.invalidateSetupGateCache();
  assert.equal(await gate.shouldRedirectToSetup("/api/setup/complete"), false);
});

test("B4: completing setup (a completedAt in the state file) stops the redirect", async () => {
  assert.equal(await gate.shouldRedirectToSetup("/"), true);
  await state.updateSetupState({ completedAt: new Date().toISOString() });
  gate.invalidateSetupGateCache();
  assert.equal(await gate.shouldRedirectToSetup("/"), false);
  assert.equal(await gate.shouldRedirectToSetup("/admin"), false);
});


// ===========================================================================
// C. The five /api/setup/* routes, loaded as real modules
// ===========================================================================

test("C1: every setup route 404s outright on a NON-self-hosted build", async () => {
  process.env.SELF_HOSTED = "";
  const routes = [licenseRoute, rmmRoute, aiRoute, telegramRoute, completeRoute];
  for (const route of routes) {
    const res = await postJson(route, { licenseKey: "x" });
    assert.equal(res.status, 404, "our own hosted SaaS must not expose /api/setup at all");
  }
});

test("C2: every setup route 403s once setup is complete without an admin session", async () => {
  await state.updateSetupState({ completedAt: new Date().toISOString() });
  adminSessionOk = false;
  const routes = [licenseRoute, rmmRoute, aiRoute, telegramRoute, completeRoute];
  for (const route of routes) {
    const res = await postJson(route, { licenseKey: "x" });
    assert.equal(res.status, 403);
  }
  // An admin may still re-walk the wizard (e.g. to add device management later).
  adminSessionOk = true;
  const res = await postJson(telegramRoute, { botToken: "" });
  assert.equal(res.status, 400, "an admin passes the gate and reaches normal validation");
});

test("C3: license/validate accepts a REAL generated key and records it in setup state", async () => {
  const issued = licenseLib.generateLicenseKey({
    licensee: "buyer@example.test",
    plan: "self_hosted",
    product: "automation_exe",
  });

  const res = await postJson(licenseRoute, { licenseKey: issued.licenseKey });
  assert.equal(res.status, 200);
  assert.equal(res.body.valid, true);
  assert.equal(res.body.licensee, "buyer@example.test");
  assert.equal(res.body.plan, "self_hosted");

  const stored = await state.readSetupState();
  assert.equal(stored.license?.key, issued.licenseKey);
  assert.equal(typeof stored.license?.validatedAt, "string");
  assert.equal(await state.isSetupComplete(), false, "step 1 alone must not mark setup complete");
});

test("C4: license/validate reports the validator's own error for a bad key, storing nothing", async () => {
  const res = await postJson(licenseRoute, { licenseKey: "not-a-real-key" });
  assert.equal(res.status, 200);
  assert.equal(res.body.valid, false);
  assert.equal(typeof res.body.error, "string");
  assert.ok((res.body.error as string).length > 0, "the validator's reason must reach the user");
  assert.equal((await state.readSetupState()).license, undefined);
});

test("C5: license/validate 400s on an empty key and 500s without EXE_LICENSE_SECRET", async () => {
  const empty = await postJson(licenseRoute, { licenseKey: "   " });
  assert.equal(empty.status, 400);

  const saved = process.env.EXE_LICENSE_SECRET;
  delete process.env.EXE_LICENSE_SECRET;
  try {
    const res = await postJson(licenseRoute, { licenseKey: "payload.sig" });
    assert.equal(res.status, 500);
    assert.match(String(res.body.error), /EXE_LICENSE_SECRET/);
  } finally {
    process.env.EXE_LICENSE_SECRET = saved;
  }
});

test("C6: rmm-engine/test 400s on missing fields and non-http URLs", async () => {
  assert.equal((await postJson(rmmRoute, { url: "", token: "t" })).status, 400);
  assert.equal((await postJson(rmmRoute, { url: "http://x.test", token: "" })).status, 400);
  const badScheme = await postJson(rmmRoute, { url: "ftp://rmm.test", token: "t" });
  assert.equal(badScheme.status, 400);
  assert.equal(fetchCalls.length, 0, "nothing may be dialled before validation passes");
});

test("C7: rmm-engine/test probes the RMM Engine's orgs endpoint with the SUBMITTED token", async () => {
  let seen: FetchCall | undefined;
  fetchImpl = async (url, init) => {
    seen = { url, init };
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  const res = await postJson(rmmRoute, { url: "https://rmm.customer.test/", token: "tok-123" });
  assert.equal(res.body.ok, true);
  // Trailing slash normalised, and the probe targets the same /api/internal/sw/*
  // surface every existing vantraFetch call uses.
  assert.equal(seen?.url, "https://rmm.customer.test/api/internal/sw/orgs");
  const headers = (seen?.init?.headers ?? {}) as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer tok-123");
});

test("C8: rmm-engine/test maps 401/403, 404 and unreachable to actionable messages", async () => {
  fetchImpl = async () => new Response("{}", { status: 401 });
  const rejected = await postJson(rmmRoute, { url: "https://rmm.customer.test", token: "bad" });
  assert.equal(rejected.body.ok, false);
  assert.match(String(rejected.body.error), /token/i);

  fetchImpl = async () => new Response("{}", { status: 404 });
  const wrong = await postJson(rmmRoute, { url: "https://rmm.customer.test", token: "t" });
  assert.equal(wrong.body.ok, false);
  assert.match(String(wrong.body.error), /404/);

  fetchImpl = async () => {
    throw new Error("ECONNREFUSED");
  };
  const down = await postJson(rmmRoute, { url: "https://rmm.customer.test", token: "t" });
  assert.equal(down.body.ok, false);
  assert.match(String(down.body.error), /Could not reach/i);
});


test("C9: ai-provider/test drives the REAL aiProviderChat with the wizard's unsaved key", async () => {
  // No AI_PROVIDER_API_KEY is set in this environment, so the module reports
  // itself unconfigured — meaning C9's success can ONLY come from the override
  // this test is about. (The wizard's key must work before .env.local exists;
  // lib/env.ts is evaluated once at boot and can never see it.)
  assert.equal(aiProvider.aiProviderConfigured(), false);

  let seen: FetchCall | undefined;
  fetchImpl = async (url, init) => {
    seen = { url, init };
    return new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const res = await postJson(aiRoute, {
    apiKey: "sk-wizard-unsaved",
    baseUrl: "https://groq.example.test/openai/v1/",
    model: "llama-3.1-8b",
  });

  assert.equal(res.body.ok, true);
  assert.equal(res.body.content, "OK");
  // The key the user typed (not AI_PROVIDER_API_KEY, which is unset here) is
  // what actually reached the wire — this is TASK_130's whole point.
  assert.equal(seen?.url, "https://groq.example.test/openai/v1/chat/completions");
  const headers = (seen?.init?.headers ?? {}) as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer sk-wizard-unsaved");
  assert.match(String(seen?.init?.body), /llama-3\.1-8b/);
});

test("C10: ai-provider/test 400s without a key and surfaces the provider's own error", async () => {
  assert.equal((await postJson(aiRoute, { apiKey: "  " })).status, 400);

  fetchImpl = async () =>
    new Response(JSON.stringify({ error: { message: "Invalid API key" } }), { status: 401 });
  const res = await postJson(aiRoute, { apiKey: "sk-bad" });
  assert.equal(res.body.ok, false);
  assert.match(String(res.body.error), /Invalid API key|rejected|Unauthorized/i);
});

test("C11: telegram/test accepts a real bot token via getMe and reports the username", async () => {
  let seen: FetchCall | undefined;
  fetchImpl = async (url, init) => {
    seen = { url, init };
    return new Response(JSON.stringify({ ok: true, result: { username: "SpaceWorkerBot" } }), {
      status: 200,
    });
  };

  const res = await postJson(telegramRoute, { botToken: "123:abc" });
  assert.equal(res.body.ok, true);
  assert.equal(res.body.username, "SpaceWorkerBot");
  assert.equal(seen?.url, "https://api.telegram.org/bot123:abc/getMe");
});

test("C12: telegram/test 400s without a token and reports Telegram's own rejection", async () => {
  assert.equal((await postJson(telegramRoute, { botToken: "" })).status, 400);

  fetchImpl = async () =>
    new Response(JSON.stringify({ ok: false, description: "Unauthorized" }), { status: 401 });
  const res = await postJson(telegramRoute, { botToken: "123:wrong" });
  assert.equal(res.body.ok, false);
  assert.match(String(res.body.error), /Unauthorized/);

  fetchImpl = async () => {
    throw new Error("ENOTFOUND");
  };
  const offline = await postJson(telegramRoute, { botToken: "123:abc" });
  assert.equal(offline.body.ok, false);
  assert.match(String(offline.body.error), /Could not reach/i);
});

const VALID_KEY = () =>
  licenseLib.generateLicenseKey({
    licensee: "buyer@example.test",
    plan: "self_hosted",
    product: "automation_exe",
  }).licenseKey;

test("C13: complete requires activation — no license key at all is a 400", async () => {
  const res = await postJson(completeRoute, {
    skipRmmEngine: true,
    skipAiProvider: true,
    skipTelegram: true,
  });
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /[Ll]icense/);
  assert.equal(await state.isSetupComplete(), false);
});

test("C14: complete rejects an invalid license key instead of trusting the client", async () => {
  const res = await postJson(completeRoute, {
    licenseKey: "forged.payload",
    skipRmmEngine: true,
    skipAiProvider: true,
    skipTelegram: true,
  });
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /[Ll]icense/);
  assert.equal(await state.isSetupComplete(), false);
});

test("C15: complete demands an explicit skip for every optional step", async () => {
  const key = VALID_KEY();

  // RMM half-filled (url but no token) is never a silent skip.
  const partialRmm = await postJson(completeRoute, {
    licenseKey: key,
    rmmEngine: { url: "https://rmm.test" },
    skipAiProvider: true,
    skipTelegram: true,
  });
  assert.equal(partialRmm.status, 400);
  assert.match(String(partialRmm.body.error), /RMM/);

  // RMM untouched AND unskipped is also a 400 — "missing" must be a choice.
  const unskippedRmm = await postJson(completeRoute, {
    licenseKey: key,
    skipAiProvider: true,
    skipTelegram: true,
  });
  assert.equal(unskippedRmm.status, 400);
  assert.match(String(unskippedRmm.body.error), /RMM/);

  const unskippedAi = await postJson(completeRoute, {
    licenseKey: key,
    skipRmmEngine: true,
    skipTelegram: true,
  });
  assert.equal(unskippedAi.status, 400);
  assert.match(String(unskippedAi.body.error), /AI/);

  const unskippedTelegram = await postJson(completeRoute, {
    licenseKey: key,
    skipRmmEngine: true,
    skipAiProvider: true,
  });
  assert.equal(unskippedTelegram.status, 400);
  assert.match(String(unskippedTelegram.body.error), /Telegram/);

  assert.equal(await state.isSetupComplete(), false, "a rejected save must not complete setup");
});

test("C16: complete with only a license + explicit skips finishes and writes .env.local", async () => {
  const key = VALID_KEY();
  const res = await postJson(completeRoute, {
    licenseKey: key,
    skipRmmEngine: true,
    skipAiProvider: true,
    skipTelegram: true,
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.restartRequired, true, "a restart is required for env changes to apply");
  assert.equal(res.body.envLocalWritten, true);
  assert.match(String(res.body.restartNotice), /[Rr]estart/);

  const stored = await state.readSetupState();
  assert.equal(typeof stored.completedAt, "string");
  assert.equal(stored.license?.key, key);
  assert.equal(stored.rmmEngine, undefined, "a skipped step must not be recorded as configured");
  assert.equal(stored.aiProvider, undefined);
  assert.equal(stored.telegram?.configured, false);
  assert.equal(stored.email?.configured, true, "RESEND_API_KEY is set in this environment");

  const envLocal = await readFile(ENV_LOCAL, "utf8");
  assert.match(envLocal, new RegExp(`^SELF_HOSTED_LICENSE_KEY=${key.replace(/[.+]/g, "\\$&")}$`, "m"));
  assert.equal(envLocal.includes("VANTRA_INTERNAL_TOKEN"), false);
  assert.equal(envLocal.includes("AI_PROVIDER_API_KEY"), false);
});

test("C17: complete persists RMM/AI/Telegram values to both the state file and .env.local", async () => {
  const key = VALID_KEY();
  const res = await postJson(completeRoute, {
    licenseKey: key,
    rmmEngine: { url: "https://rmm.customer.test", token: "rmm-token" },
    aiProvider: {
      apiKey: "sk-ai-key",
      baseUrl: "https://api.groq.test/openai/v1",
      model: "llama-3.1-8b",
    },
    telegram: { botToken: "123:abc", botUsername: "SpaceWorkerBot" },
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.envLocalWritten, true);

  const stored = await state.readSetupState();
  assert.equal(stored.rmmEngine?.url, "https://rmm.customer.test");
  assert.equal(stored.rmmEngine?.token, "rmm-token");
  assert.equal(stored.aiProvider?.configured, true);
  assert.equal(stored.aiProvider?.model, "llama-3.1-8b");
  assert.equal(stored.telegram?.configured, true);

  const envLocal = await readFile(ENV_LOCAL, "utf8");
  assert.match(envLocal, /^VANTRA_INTERNAL_URL=https:\/\/rmm\.customer\.test$/m);
  assert.match(envLocal, /^VANTRA_INTERNAL_TOKEN=rmm-token$/m);
  assert.match(envLocal, /^AI_PROVIDER_API_KEY=sk-ai-key$/m);
  assert.match(envLocal, /^AI_PROVIDER_BASE_URL=https:\/\/api\.groq\.test\/openai\/v1$/m);
  assert.match(envLocal, /^AI_PROVIDER_MODEL=llama-3\.1-8b$/m);
  assert.match(envLocal, /^TELEGRAM_BOT_TOKEN=123:abc$/m);
  assert.match(envLocal, /^TELEGRAM_BOT_USERNAME=SpaceWorkerBot$/m);

  // And the gate is released the moment setup is marked complete.
  gate.invalidateSetupGateCache();
  assert.equal(await gate.shouldRedirectToSetup("/"), false);
});

test("C18: a second complete call is a no-op 403 for a non-admin (setup is one-shot)", async () => {
  const key = VALID_KEY();
  const payload = { licenseKey: key, skipRmmEngine: true, skipAiProvider: true, skipTelegram: true };
  assert.equal((await postJson(completeRoute, payload)).status, 200);
  adminSessionOk = false;
  assert.equal((await postJson(completeRoute, payload)).status, 403);
});


