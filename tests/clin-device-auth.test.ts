// TASK_246 — server-side Cline device-code polling.
// Run: npx tsx --test tests/clin-device-auth.test.ts
//
// WHAT THIS PREVENTS (the actual 2026-10 regression):
//   1. "fetch failed" leaking to the UI as the Confirm error.
//   2. The UI polling /me (a DB read) and never connecting, because nothing
//      server-side ever exchanged the device code.
//   3. A pending poll being reported as success (old code returned 202 and the
//      card treated `res.ok` as connected).
//   4. Stale device rows lingering forever after expiry/denial.
//   5. Two tabs racing the same one-time code.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

(process.env as Record<string, string>).NODE_ENV = "test";

type Loader = { _load: (request: string, parent: NodeModule | undefined, isMain: boolean) => unknown };
const loader = Module as unknown as Loader;
const original = loader._load;

interface DeviceRow {
  id: string;
  userId: string;
  deviceCode: string;
  userCode: string;
  expiresAt: Date;
}

interface SettingsRow {
  userId: string;
  clineOAuthTokenEnc?: string | null;
  clineRefreshTokenEnc?: string | null;
  [key: string]: unknown;
}

interface ClineCredentials {
  access: string;
  refresh: string;
  expires: number;
  email?: string;
  accountId?: string;
  metadata?: Record<string, unknown>;
}

type CompleteOptions = Record<string, unknown>;

const deviceRows = new Map<string, DeviceRow>();
const settingsRows = new Map<string, SettingsRow>();

let completeImpl: (opts: CompleteOptions) => Promise<ClineCredentials>;
let lastCompleteOptions: CompleteOptions | null = null;

const fakeDb = {
  clineDeviceAuth: {
    findUnique: async ({ where }: { where: { deviceCode: string } }) =>
      deviceRows.get(where.deviceCode) ?? null,
    findFirst: async ({ where }: { where: { userId: string; expiresAt: { gt: Date } } }) => {
      const rows = Array.from(deviceRows.values()).filter(
        (r) => r.userId === where.userId && r.expiresAt.getTime() > where.expiresAt.gt.getTime(),
      );
      rows.sort((a, b) => b.expiresAt.getTime() - a.expiresAt.getTime());
      return rows[0] ?? null;
    },
    delete: async ({ where }: { where: { deviceCode: string } }) => {
      const row = deviceRows.get(where.deviceCode);
      if (!row) throw new Error("P2025 record not found");
      deviceRows.delete(where.deviceCode);
      return row;
    },
    deleteMany: async ({ where }: { where: { userId: string } }) => {
      let count = 0;
      for (const [code, row] of deviceRows) {
        if (row.userId === where.userId) {
          deviceRows.delete(code);
          count++;
        }
      }
      return { count };
    },
  },
  cyberLabAgentSettings: {
    findUnique: async ({ where }: { where: { userId: string } }) => settingsRows.get(where.userId) ?? null,
    upsert: async ({
      where,
      update,
      create,
    }: {
      where: { userId: string };
      update: Partial<SettingsRow>;
      create: SettingsRow;
    }) => {
      const existing = settingsRows.get(where.userId);
      if (existing) {
        const next = { ...existing, ...update };
        settingsRows.set(where.userId, next);
        return next;
      }
      const next = { ...create };
      settingsRows.set(where.userId, next);
      return next;
    },
    updateMany: async ({ where, data }: { where: { userId: string }; data: Partial<SettingsRow> }) => {
      const existing = settingsRows.get(where.userId);
      if (!existing) return { count: 0 };
      settingsRows.set(where.userId, { ...existing, ...data });
      return { count: 1 };
    },
  },
};

const fakeSdk = {
  completeClineDeviceAuth: async (opts: CompleteOptions) => {
    lastCompleteOptions = opts;
    return completeImpl(opts);
  },
  getValidClineCredentials: async () => null,
};

loader._load = function patched(request, parent, isMain) {
  if (request === "server-only") return {};
  if (request === "@/lib/db") return { db: fakeDb };
  if (request === "@cline/sdk") return fakeSdk;
  return original.apply(this, [request, parent, isMain]);
};

process.env.SESSION_SECRET = "task-246-device-auth-secret";
delete process.env.CLINE_API_BASE_URL;

/* eslint-disable @typescript-eslint/no-require-imports */
const deviceAuth = require("../lib/clin/device-auth") as typeof import("../lib/clin/device-auth");
const crypto = require("../lib/clin/token-crypto") as typeof import("../lib/clin/token-crypto");
/* eslint-enable @typescript-eslint/no-require-imports */

function addRow(overrides: Partial<DeviceRow> = {}): DeviceRow {
  const row: DeviceRow = {
    id: `row-${deviceRows.size + 1}`,
    userId: "u1",
    deviceCode: "device-abc",
    userCode: "USER-123",
    expiresAt: new Date(Date.now() + 300_000),
    ...overrides,
  };
  deviceRows.set(row.deviceCode, row);
  return row;
}

const creds = {
  access: "live-access-token",
  refresh: "live-refresh-token",
  expires: Date.now() + 3_600_000,
  email: "person@example.com",
  accountId: "acct_123",
  metadata: { provider: "workos" },
};

function sdkError(message: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), extra);
}

beforeEach(() => {
  deviceRows.clear();
  settingsRows.clear();
  lastCompleteOptions = null;
  completeImpl = async () => {
    throw sdkError("WorkOS device authorization timed out", { errorCode: "authorization_pending" });
  };
  crypto.resetClineTokenKeyCacheForTesting();
  process.env.SESSION_SECRET = "task-246-device-auth-secret";
  delete process.env.CLINE_API_BASE_URL;
});

// ---------------------------------------------------------------------------
// Error classification (never by raw "fetch failed")
// ---------------------------------------------------------------------------

test("TASK_246 poll.1 — classification by errorCode, not message text", () => {
  assert.equal(deviceAuth.classifyClineDeviceAuthError(sdkError("whatever", { errorCode: "expired_token" })), "expired");
  assert.equal(deviceAuth.classifyClineDeviceAuthError(sdkError("whatever", { errorCode: "access_denied" })), "denied");
  assert.equal(
    deviceAuth.classifyClineDeviceAuthError(sdkError("whatever", { errorCode: "authorization_pending" })),
    "pending",
  );
});

test("TASK_246 poll.2 — WorkOS timeout is pending; a dead host is unreachable (not 'fetch failed')", () => {
  assert.equal(deviceAuth.classifyClineDeviceAuthError(new Error("WorkOS device authorization timed out")), "pending");
  assert.equal(deviceAuth.classifyClineDeviceAuthError(new TypeError("fetch failed")), "unreachable");
  assert.equal(deviceAuth.classifyClineDeviceAuthError(new Error("getaddrinfo ENOTFOUND api.cline.com")), "unreachable");
});

// ---------------------------------------------------------------------------
// Polling semantics
// ---------------------------------------------------------------------------

test("TASK_246 poll.3 — default base URL is api.cline.bot, override honoured", async () => {
  addRow();
  completeImpl = async () => creds;
  await deviceAuth.pollClineDeviceAuth({ userId: "u1", deviceCode: "device-abc" });
  assert.ok(lastCompleteOptions);
  assert.equal(lastCompleteOptions.apiBaseUrl, "https://api.cline.bot");

  addRow({ deviceCode: "device-env" });
  process.env.CLINE_API_BASE_URL = "https://staging.example.test/";
  await deviceAuth.pollClineDeviceAuth({ userId: "u1", deviceCode: "device-env" });
  assert.ok(lastCompleteOptions);
  assert.equal(lastCompleteOptions.apiBaseUrl, "https://staging.example.test");
  delete process.env.CLINE_API_BASE_URL;
});

test("TASK_246 poll.4 — not approved yet = pending, device row retained", async () => {
  addRow();
  const result = await deviceAuth.pollClineDeviceAuth({ userId: "u1", deviceCode: "device-abc" });
  assert.equal(result.status, "pending");
  assert.ok(deviceRows.has("device-abc"), "row must survive a pending poll");
  assert.equal(settingsRows.size, 0, "no credentials written while pending");
});

test("TASK_246 poll.5 — success persists encrypted creds and deletes the code", async () => {
  addRow();
  completeImpl = async () => creds;

  const result = await deviceAuth.pollClineDeviceAuth({ userId: "u1", deviceCode: "device-abc" });
  assert.equal(result.status, "connected");
  if (result.status !== "connected") return;
  assert.equal(result.email, "person@example.com");
  assert.equal(result.accountId, "acct_123");

  assert.equal(deviceRows.has("device-abc"), false, "one-time code must be consumed");

  const row = settingsRows.get("u1");
  assert.ok(row, "settings row written");
  const sealedAccess = row.clineOAuthTokenEnc;
  const sealedRefresh = row.clineRefreshTokenEnc;
  assert.ok(sealedAccess, "access token stored");
  assert.ok(sealedRefresh, "refresh token stored");
  assert.ok(sealedAccess.startsWith("v1:"), "stored under the AES-GCM envelope");
  assert.notEqual(sealedAccess, creds.access, "raw token must never be stored");
  assert.notEqual(sealedRefresh, creds.refresh, "raw refresh token must never be stored");

  const stored = crypto.decryptCredentials(sealedAccess);
  assert.equal(stored.access, creds.access);
  assert.equal(stored.refresh, creds.refresh);
  assert.equal(stored.email, "person@example.com");
  assert.equal(crypto.decryptValue(sealedRefresh), creds.refresh);
});

test("TASK_246 poll.6 — DB expiry removes the row WITHOUT calling Cline", async () => {
  addRow({ expiresAt: new Date(Date.now() - 1000) });
  let called = false;
  completeImpl = async () => {
    called = true;
    return creds;
  };

  const result = await deviceAuth.pollClineDeviceAuth({ userId: "u1", deviceCode: "device-abc" });
  assert.equal(result.status, "expired");
  assert.equal(called, false);
  assert.equal(deviceRows.has("device-abc"), false);
  assert.equal(settingsRows.size, 0);
});

test("TASK_246 poll.7 — WorkOS expired_token / access_denied delete the row", async () => {
  addRow({ deviceCode: "expired-code" });
  completeImpl = async () => {
    throw sdkError("expired_token", { errorCode: "expired_token" });
  };
  assert.equal((await deviceAuth.pollClineDeviceAuth({ userId: "u1", deviceCode: "expired-code" })).status, "expired");
  assert.equal(deviceRows.has("expired-code"), false);

  addRow({ deviceCode: "denied-code" });
  completeImpl = async () => {
    throw sdkError("access_denied", { errorCode: "access_denied" });
  };
  assert.equal((await deviceAuth.pollClineDeviceAuth({ userId: "u1", deviceCode: "denied-code" })).status, "denied");
  assert.equal(deviceRows.has("denied-code"), false);
});

test("TASK_246 poll.8 — transport failure keeps the code and never echoes 'fetch failed'", async () => {
  addRow();
  completeImpl = async () => {
    throw new TypeError("fetch failed");
  };

  const result = await deviceAuth.pollClineDeviceAuth({ userId: "u1", deviceCode: "device-abc" });
  assert.equal(result.status, "unreachable");
  if (result.status !== "unreachable") return;
  assert.doesNotMatch(result.message, /fetch failed/i);
  assert.match(result.message, /could not reach cline/i);
  assert.ok(deviceRows.has("device-abc"), "transient failure must be retryable");
});

test("TASK_246 poll.9 — another user's code is not disclosed and not consumed", async () => {
  addRow({ userId: "someone-else" });
  const result = await deviceAuth.pollClineDeviceAuth({ userId: "u1", deviceCode: "device-abc" });
  assert.equal(result.status, "expired");
  if (result.status !== "expired") return;
  assert.match(result.message, /no pending cline login/i);
  assert.ok(deviceRows.has("device-abc"), "must not delete another user's row");
});

test("TASK_246 poll.10 — without a deviceCode, the newest live code for the user is used", async () => {
  addRow({ deviceCode: "older", expiresAt: new Date(Date.now() + 60_000) });
  addRow({ deviceCode: "newer", expiresAt: new Date(Date.now() + 240_000) });
  completeImpl = async () => creds;

  const result = await deviceAuth.pollClineDeviceAuth({ userId: "u1" });
  assert.equal(result.status, "connected");
  assert.ok(lastCompleteOptions);
  assert.equal(lastCompleteOptions.deviceCode, "newer");
  assert.equal(deviceRows.has("newer"), false);
  assert.ok(deviceRows.has("older"), "only the polled code is consumed");
});

test("TASK_246 poll.11 — overlapping polls cannot race the one-time code", async () => {
  addRow();
  let release!: (value: ClineCredentials) => void;
  completeImpl = () =>
    new Promise<ClineCredentials>((resolve) => {
      release = resolve;
    });

  const first = deviceAuth.pollClineDeviceAuth({ userId: "u1", deviceCode: "device-abc" });
  await new Promise((r) => setTimeout(r, 0));
  const second = await deviceAuth.pollClineDeviceAuth({ userId: "u1", deviceCode: "device-abc" });
  assert.equal(second.status, "pending");
  if (second.status !== "pending") return;
  assert.equal(second.retryAfterSeconds, 2);

  release(creds);
  assert.equal((await first).status, "connected");
});
