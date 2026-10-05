import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

// 2026-10-04 — "budget exceeded" was semantically WRONG, and this file is the
// regression bar for the fix.
//
// WHAT HAPPENED LIVE: the relay answered a real admin "Test connection" click
// with usage 120/500000 hundredths of a cent used — 0.02% of the pool — yet the
// UI reported the cap as exhausted, and the owner went looking for a money
// problem that did not exist.
//
// THE ROOT CAUSE: lib/channelry-ai.ts mapped EVERY 429 to the `over_cap` code
// and the "daily cap is exhausted" message. But the relay's own source
// (faceless-channel-os/admin-server/worker/src/worker-full.ts, the
// /external/ai-chat handler) emits 429 for exactly ONE reason — its own spend
// cap — and always alongside BOTH usage fields:
//
//   return json({ detail: 'daily AI cost cap reached for this client',
//     used_hundredths_cent, cap_hundredths_cent, active }, active ? 429 : 403);
//
// It deliberately collapses every upstream Groq failure into a 502, so a bare
// 429 carrying no usage body can only be Cloudflare-level back-pressure in
// front of the Worker — never money.
//
// WHAT THIS FILE PINS: the REAL channelryAiChat, with ONLY global fetch
// swapped. `over_cap` (and its budget wording) is reachable ONLY from the
// relay's explicit usage-bearing cap response; a body-less 429 is
// `rate_limited` and must never say "budget"/"cap". Getting this wrong is what
// sent the operator chasing a phantom spend cap, so it is worth a real test
// rather than a code-reading assertion.

process.env.DATABASE_URL = "postgresql://t161:t161@localhost:5432/t161_placeholder";
process.env.SESSION_SECRET = "t161-test-session-secret";
process.env.RESEND_API_KEY = "t161-test-resend";
process.env.EMAIL_FROM = "t161@spaceworker.test";
process.env.APP_BASE_URL = "https://spaceworker.test";
// Set BEFORE the module under test is required: lib/env.ts reads this once at
// import time. With it set, channelryAiConfigured() is true and the call
// actually reaches (our stubbed) fetch.
process.env.CHANNELRY_AI_API_KEY = "t161-test-relay-key";
(process.env as Record<string, string>).NODE_ENV = "test";

type Loader = {
  _load: (request: string, parent: NodeModule | undefined, isMain: boolean) => unknown;
};

function installRequireHook(): void {
  const loader = Module as unknown as Loader;
  const original = loader._load;
  loader._load = function patched(request, parent, isMain) {
    // `server-only` throws outside Next's build pipeline (HOW_WE_MOVE_FAST §4).
    if (request === "server-only") return {};
    return original.call(this, request, parent, isMain);
  };
}

installRequireHook();

/* eslint-disable @typescript-eslint/no-require-imports */
const { channelryAiChat } = require("../lib/channelry-ai") as typeof import("../lib/channelry-ai");
/* eslint-enable @typescript-eslint/no-require-imports */

// The thrown type, referenced in TYPE position only (it is never used as a value
// here), so it is taken from the module's own type rather than destructured.
type RelayError = InstanceType<
  (typeof import("../lib/channelry-ai"))["ChannelryAiError"]
>;

type StubResponse = { status: number; body: unknown };

let stub: StubResponse;
const realFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = (async () => {
    const payload =
      typeof stub.body === "string" ? stub.body : JSON.stringify(stub.body ?? {});
    return {
      ok: stub.status >= 200 && stub.status < 300,
      status: stub.status,
      json: async () => JSON.parse(payload),
    };
  }) as unknown as typeof fetch;
});

process.on("exit", () => {
  globalThis.fetch = realFetch;
});

async function expectFailure(): Promise<RelayError> {
  try {
    await channelryAiChat({ system: "s", user: "u", external_user_id: "t161" });
  } catch (err) {
    return err as RelayError;
  }
  throw new Error("expected channelryAiChat to reject, but it resolved");
}

// --- the money case: ONLY the relay's own usage-bearing cap response --------

test("a 429 carrying the relay's usage body IS a real spend cap, and says so with the real numbers", async () => {
  stub = {
    status: 429,
    body: {
      detail: "daily AI cost cap reached for this client",
      used_hundredths_cent: 500000,
      cap_hundredths_cent: 500000,
      active: true,
    },
  };

  const err = await expectFailure();
  assert.equal(err.code, "over_cap");
  assert.equal(err.status, 429);
  // The numbers must survive into the operator-facing message — a bare
  // "budget exceeded" with no figures is what made this un-investigable.
  assert.match(err.message, /500000\/500000/);
});

test("a 429 with a PARTIAL usage body is NOT treated as a cap (both fields are required)", async () => {
  // Only `used`, no `cap`: not the relay's documented cap shape. Claiming money
  // here would reintroduce the exact false alarm this file exists to prevent.
  stub = { status: 429, body: { detail: "slow down", used_hundredths_cent: 500000 } };

  const err = await expectFailure();
  assert.equal(err.code, "rate_limited");
});

// --- the NOT-money cases: bare 429s are back-pressure, never budget ---------

test("a body-less 429 is rate_limited, and NEVER claims a budget problem", async () => {
  // The exact live symptom: Cloudflare edge throttling, no usage body.
  stub = { status: 429, body: {} };

  const err = await expectFailure();
  assert.equal(err.code, "rate_limited");
  assert.equal(err.status, 429);
  // The thing to forbid is a CLAIM that money is gone, not the mere word: the
  // message mentions "budget" only to rule it OUT for the operator.
  assert.doesNotMatch(err.message, /cap is exhausted/i);
  assert.doesNotMatch(err.message, /daily cap/i);
  // ...and it must be honest about the alternative reading, so the operator
  // stops looking for a spend problem.
  assert.match(err.message, /not an exhausted budget/i);
});

test("an HTML-bodied 429 (Cloudflare error page) is rate_limited, not a cap", async () => {
  // A real Cloudflare 429 body is HTML; the old code swallowed the JSON parse
  // failure and reported the cap anyway.
  stub = { status: 429, body: "<html><body>Error 429 Too Many Requests</body></html>" };

  const err = await expectFailure();
  assert.equal(err.code, "rate_limited");
  // An HTML error page must not be laundered into a spend-cap claim either.
  assert.doesNotMatch(err.message, /cap is exhausted/i);
});

// --- regression: the other statuses keep their existing meaning -------------

test("the non-429 statuses are unmapped by this change", async () => {
  stub = { status: 401, body: { detail: "bad key" } };
  assert.equal((await expectFailure()).code, "unauthorized");

  stub = { status: 403, body: { detail: "client inactive" } };
  assert.equal((await expectFailure()).code, "inactive");

  // 502 = upstream Groq. The relay collapses Groq errors here on purpose, which
  // is why a bare 429 can be trusted as "not the provider".
  stub = { status: 502, body: { detail: "script service error" } };
  assert.equal((await expectFailure()).code, "temporarily_unavailable");
});

test("a healthy response still resolves with its content and usage", async () => {
  stub = {
    status: 200,
    body: { content: "Understood", usage: { mode: "plain", cost_hundredths_cent: 1 } },
  };

  const res = await channelryAiChat({ system: "s", user: "u", external_user_id: "t161" });
  assert.equal(res.content, "Understood");
  assert.equal(res.usage.cost_hundredths_cent, 1);
});
