import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import Module from "node:module";

import { AV_EXCLUSIONS_MARKER } from "../lib/device-av-exclusions";
import {
  ensureSilentEnroll,
  normalizePowerShellCommand,
  renderCarrierVbs,
  stripEverwasSilentFlag,
} from "../lib/vantra-carrier";

// TASK_121 (OOB-13, PATH B) — the public install artifact, on SpaceWorker's side.
//
// WHY THIS FILE EXISTS: the change that made the public link serve Vantra's
// launcher ZIP (with the user's chosen names) was verified with throwaway /tmp
// harnesses, so nobody could re-run the evidence. This is that evidence,
// committed, and it is the acceptance list in TASK_121 §6 items 1/3/4/5.
//
// The unit under test is the REAL `lib/vantra-link.ts` — not a copy of its
// logic. It is loaded through a require hook (the house pattern for the
// `server-only` import, HOW_WE_MOVE_FAST.md §4) that swaps its DB, entitlement,
// audit and device-tool dependencies for recording fakes. So every assertion
// below is about the module's OWN decisions: the request body it sends, what it
// persists, what it returns to a caller, and how many times it calls out.
// Nothing here touches a real database, Vantra, or the network.

// Set BEFORE `../lib/vantra-link` is loaded: lib/env.ts evaluates its
// required() checks at import time, and swHeaders() fails closed without the
// Vantra token (a placeholder is correct here — nothing dials out for real).
process.env.DATABASE_URL = "postgresql://t121:t121@localhost:5432/task121_placeholder";
process.env.SESSION_SECRET = "task121-test-session-secret";
process.env.RESEND_API_KEY = "task121-test-resend";
process.env.EMAIL_FROM = "t121@spaceworker.test";
process.env.APP_BASE_URL = "https://spaceworker.test";
process.env.VANTRA_INTERNAL_TOKEN = "task121-test-vantra-token";
// lib/vantra-link.ts reads this once at import; the fallback is the real
// production host, so pin it here to prove the base URL is env-driven.
process.env.VANTRA_INTERNAL_URL = "https://vantra.spaceworker.test";
// NODE_ENV is declared read-only in @types/node; a test run genuinely is one.
(process.env as Record<string, string>).NODE_ENV = "test";

// ---------------------------------------------------------------------------
// The row the fake DB holds. Shape matches what the module reads.
// ---------------------------------------------------------------------------

interface LinkRow {
  id: string;
  userId: string;
  orgId: string;
  orgName: string;
  status: string;
  installUrl: string | null;
  installTokenHash: string | null;
  installTokenExpiresAt: Date | null;
  lastSyncedAt: Date | null;
  lastError: string | null;
  orgTier: string;
  privateOrgId: string | null;
  privatePsCommand: string | null;
  privatePsExpiresAt: Date | null;
  // Task 121 — the remember-the-artifact columns.
  installerUrl: string | null;
  installerNamesJson: string | null;
  installerKind: string | null;
  // TASK_EVERWAS_PUBLIC_REPLACE — the stored silent PowerShell command and
  // its own (1-year) expiry, minted for Everwas public links only.
  everwasPsCommand: string | null;
  everwasPsExpiresAt: Date | null;
}

interface DbArgs {
  where?: Record<string, unknown>;
  data?: Record<string, unknown>;
  select?: Record<string, boolean>;
  // TASK_128 — db.device.upsert({ ... create: {...} }) is the only caller that
  // passes this; kept optional so every other fake stays as-is.
  create?: Record<string, unknown>;
  // TASK_181 step 21 — the vantraLink.upsert's other half (update on hit).
  update?: Record<string, unknown>;
}

interface AuditCall {
  userId?: string;
  action?: string;
  status?: string;
  detail?: Record<string, unknown>;
}

interface FetchCall {
  url: string;
  method: string | undefined;
  body: string | null;
  authorization: string | undefined;
}

const USER_ID = "user-t121";
const ORG_ID = "org-t121";
const RAW_URL = "https://dl.spaceworker.test/Agent.zip";
const RAW_EXE_URL = "https://dl.spaceworker.test/trmm-agent.exe";

let row: LinkRow;
let dbUpdates: Record<string, unknown>[];
let audits: AuditCall[];
let fetches: FetchCall[];
let findFirstWhere: Record<string, unknown>[];
// `command` is set by the TASK_178 public-vbs tests (an older Vantra answers
// without it — the deploy-order guard). The Everwas fields answer a
// provider:"everwas" mint (the silent-PS generator's four inputs).
let mintResponse: {
  ok: boolean;
  downloadUrl: string;
  command?: string;
  provider?: string;
  token?: string;
  serverUrl?: string;
};
// Route-level (the API boundary): mutable so each test sets its own scenario.
let sessionValue: { userId: string } | null;
interface RouteMintCall {
  userId: string;
  kind: string;
  names: unknown;
  pdf: unknown;
}
let routeMintCalls: RouteMintCall[];
let mintError: string | null;

// TASK_181 P2 — scenario controls. The defaults preserve every pre-existing
// test: no entitlement (a free tier-1 account), admin settings unconfigured,
// and the standard org-provision payload.
let adminSettings: Record<string, unknown>;
let entitlementAnswer: { allowed: boolean; reason: string };
let orgProvisionResponse: Record<string, unknown>;
// Route wiring for POST /api/assistant/vantra (the free org-create surface).
let rateLimitAllows: boolean;
let ensuredFor: string[];
let ensuredView: Record<string, unknown>;

// TASK_171 — one per-mint history row, as the fake delegate holds it.
interface MintRow {
  id: string;
  userId: string;
  tokenHash: string;
  publicUrl: string;
  expiresAt: Date;
  installerUrl: string | null;
  installerKind: string | null;
  installerNamesJson: string | null;
  // TASK_179 — the vbs link payload (file name + optional guide PDF bytes).
  installerPayloadJson: string | null;
  downloadCount: number;
  createdAt: Date;
}

let mintRows: MintRow[];
let mintCreates: Array<Record<string, unknown>>;
let mintUpdates: Array<Record<string, unknown>>;
let mintCreateError: unknown = null;

beforeEach(() => {
  row = {
    id: "link-t121",
    userId: USER_ID,
    orgId: ORG_ID,
    orgName: "Task 121 test org",
    status: "ready",
    installUrl: null,
    installTokenHash: null,
    installTokenExpiresAt: null,
    lastSyncedAt: null,
    lastError: null,
    orgTier: "public",
    privateOrgId: null,
    privatePsCommand: null,
    privatePsExpiresAt: null,
    installerUrl: null,
    installerNamesJson: null,
    installerKind: null,
    everwasPsCommand: null,
    everwasPsExpiresAt: null,
  };
  dbUpdates = [];
  audits = [];
  fetches = [];
  findFirstWhere = [];
  mintResponse = { ok: true, downloadUrl: RAW_URL };
  sessionValue = { userId: USER_ID };
  routeMintCalls = [];
  mintError = null;
  adminSettings = {};
  entitlementAnswer = { allowed: false, reason: "none" };
  orgProvisionResponse = { ok: true, org: { id: "org-fresh", name: "sw-fresh" } };
  rateLimitAllows = true;
  ensuredFor = [];
  ensuredView = { privateAllowed: false };
  deviceRows.clear();
  onboardingRows.clear();
  onboardingUpdates = [];
  onboardingCreateError = null;
  devicesResponse = { ok: true, orgTier: "public", devices: [] };
  mintRows = [];
  mintCreates = [];
  mintUpdates = [];
  mintCreateError = null;
});

/** Honours Prisma's `select` so a forgotten column cannot hide behind the fake. */
function project(source: Record<string, unknown>, select?: Record<string, boolean>) {
  if (!select) return { ...source };
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(select)) {
    if (select[key]) out[key] = source[key];
  }
  return out;
}

// TASK_128 — state for the syncDevices tests.
const deviceRows = new Map<string, Record<string, unknown>>();
const onboardingRows = new Map<string, Record<string, unknown>>();
let onboardingUpdates: Array<Record<string, unknown>> = [];
/** Forced error for the next DeviceOnboarding.create — proves P2002 tolerance. */
let onboardingCreateError: unknown = null;
/** What a (stubbed) Vantra /sw/devices call answers with. */
let devicesResponse: Record<string, unknown> = { ok: true, orgTier: "public", devices: [] };

const fakeDb = {
  vantraLink: {
    findUnique: async ({ where, select }: DbArgs) => {
      const matches = where?.userId === row.userId || where?.id === row.id;
      if (!matches) return null;
      return project(row as unknown as Record<string, unknown>, select);
    },
    findFirst: async ({ where, select }: DbArgs) => {
      findFirstWhere.push(where ?? {});
      const matches =
        !!where?.installTokenHash &&
        where.installTokenHash === row.installTokenHash &&
        row.status !== "revoked";
      if (!matches) return null;
      return project(row as unknown as Record<string, unknown>, select);
    },
    update: async ({ data }: DbArgs) => {
      const patch = data ?? {};
      dbUpdates.push({ ...patch });
      Object.assign(row, patch);
      return { ...row };
    },
    // TASK_181 step 21 — ensureVantraLink's two gates: the non-revoked count
    // (the harness holds exactly ONE link row) and the idempotent upsert that
    // lands the freshly provisioned org onto that row.
    count: async ({ where }: DbArgs) => {
      const notStatus = (where?.status as { not?: string } | undefined)?.not;
      return notStatus !== undefined && row.status === notStatus ? 0 : 1;
    },
    upsert: async ({ where, update, create }: DbArgs) => {
      const isSameRow = where?.userId !== undefined && where.userId === row.userId;
      Object.assign(row, (isSameRow ? update : create) ?? {});
      return { ...row };
    },
  },
  // TASK_171 — the per-mint history delegate. findMany honours `select`,
  // newest-first ordering, and the revoked/unknown-user ⇒ [] rule (the module
  // checks the VantraLink status first, so the fake only stores rows).
  vantraInstallLink: {
    findUnique: async ({ where }: DbArgs) => {
      return mintRows.find((m) => m.tokenHash === (where as Record<string, unknown> | undefined)?.tokenHash) ?? null;
    },
    findMany: async ({ select }: DbArgs) => {
      const ordered = [...mintRows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      return ordered.map((m) => project(m as unknown as Record<string, unknown>, select));
    },
    // TASK_224 — deleteInstallLink's own lookups: a caller-scoped findFirst
    // (id + userId — the route's ownership gate) and a REAL delete. Both must
    // actually work: a stub that silently misses makes the route 404/500, and
    // a test "passing" because it bailed early is green for the wrong reason
    // (HOW_WE_MOVE_FAST L1272 lesson).
    findFirst: async ({ where, select }: DbArgs) => {
      const w = (where ?? {}) as { id?: unknown; userId?: unknown };
      const target = mintRows.find(
        (m) =>
          (w.id === undefined || m.id === w.id) &&
          (w.userId === undefined || m.userId === w.userId),
      );
      if (!target) return null;
      return project(target as unknown as Record<string, unknown>, select);
    },
    delete: async ({ where }: DbArgs) => {
      const id = (where as Record<string, unknown> | undefined)?.id;
      const idx = mintRows.findIndex((m) => m.id === id);
      // P2025-parity: deleting a missing record must be LOUD, never a silent
      // no-op that reads as success.
      if (idx === -1) throw new Error("record_not_found");
      const [removed] = mintRows.splice(idx, 1);
      return { ...removed };
    },
    create: async ({ data }: DbArgs) => {
      if (mintCreateError) throw mintCreateError;
      const patch = { ...(data as Record<string, unknown>) };
      mintCreates.push({ ...patch });
      const created: MintRow = {
        id: `mint-${mintRows.length + 1}`,
        userId: String(patch.userId ?? USER_ID),
        tokenHash: String(patch.tokenHash ?? ""),
        publicUrl: String(patch.publicUrl ?? ""),
        expiresAt: patch.expiresAt as Date,
        installerUrl: (patch.installerUrl as string | null) ?? null,
        installerKind: (patch.installerKind as string | null) ?? null,
        installerNamesJson: (patch.installerNamesJson as string | null) ?? null,
        installerPayloadJson: (patch.installerPayloadJson as string | null) ?? null,
        downloadCount: 0,
        createdAt: new Date(Date.now() + mintRows.length),
      };
      mintRows.push(created);
      return { ...created };
    },
    update: async ({ where, data }: DbArgs) => {
      const target = mintRows.find((m) => m.id === (where as Record<string, unknown> | undefined)?.id);
      if (!target) throw new Error("mint_not_found");
      const patch = { ...(data as Record<string, unknown>) };
      mintUpdates.push({ ...patch });
      const inc = patch.downloadCount as { increment?: number } | undefined;
      if (inc && typeof inc.increment === "number") target.downloadCount += inc.increment;
      else Object.assign(target, patch);
      return { ...target };
    },
  },
  // TASK_128 — enough of the Device + DeviceOnboarding surface for syncDevices'
  // own decisions (which row it creates, and what it does when a racing sync
  // wins the UNIQUE(deviceId) insert first).
  device: {
    upsert: async ({ where, update, create }: DbArgs) => {
      const key = String(where?.vantraAgentId ?? "");
      const existing = deviceRows.get(key);
      if (existing) {
        // TASK_230 P4b-1 — Prisma upsert semantics: fields whose value is
        // `undefined` in the update payload are NOT written (they mean "keep
        // the current value"). syncDevices relies on exactly that for
        // `lastSeenAt: undefined` on offline devices — the old check-in must
        // survive the sync instead of being restamped with "now".
        for (const [field, value] of Object.entries(update ?? {})) {
          if (value !== undefined) existing[field] = value;
        }
        return { ...existing };
      }
      const saved = { id: `dev-${key}`, ...(create ?? {}) };
      deviceRows.set(key, saved);
      return { ...saved };
    },
  },
  deviceOnboarding: {
    findUnique: async ({ where }: DbArgs) => {
      return onboardingRows.get(String(where?.deviceId ?? "")) ?? null;
    },
    create: async ({ data }: DbArgs) => {
      if (onboardingCreateError) throw onboardingCreateError;
      const created = { id: `onb-${onboardingRows.size + 1}`, ...(data ?? {}) };
      onboardingRows.set(String((data ?? {}).deviceId ?? ""), created);
      return { ...created };
    },
    updateMany: async ({ data }: DbArgs) => {
      onboardingUpdates.push({ ...(data ?? {}) });
      return { count: 0 };
    },
  },
};

// ---------------------------------------------------------------------------
// Require hook: only this one module's own dependencies are swapped.
// ---------------------------------------------------------------------------

type Loader = {
  _load: (request: string, parent: NodeModule | undefined, isMain: boolean) => unknown;
};

const MODULE_UNDER_TEST = "lib/vantra-link.ts";

// TASK_179 — a constructible NextResponse stand-in for BOTH route harnesses:
// `new NextResponse(bytes, {headers})` serves the vbs attachment (status,
// headers, body readable), while the static `json`/`redirect` keep every
// existing assertion's `{status, body, json()}` / `{status, headers}` shape.
class FakeNextResponse {
  status: number;
  body: unknown;
  headers: Record<string, string>;
  constructor(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
    this.status = init?.status ?? 200;
    this.headers = init?.headers ?? {};
    this.body = body;
  }
  static json(body: unknown, init?: { status?: number }) {
    return { status: init?.status ?? 200, body, json: async () => body };
  }
  static redirect(url: string, status?: number) {
    return { status: status ?? 302, body: null, headers: { location: String(url) } };
  }
}

function installRequireHook(): void {
  const loader = Module as unknown as Loader;
  const original = loader._load;
  loader._load = function patched(request, parent, isMain) {
    if (request === "server-only") return {};
    const from = parent?.filename ?? "";
    if (from.endsWith(`/${MODULE_UNDER_TEST}`)) {
      if (request === "./db") return { db: fakeDb };
      if (request === "./entitlements") {
        // Public minting is not entitlement-gated; the private tier answers
        // from `entitlementAnswer` (default denied = a free tier-1 account —
        // TASK_181 tests flip it to "xdevice"/"grant" for the one-org rule).
        return { hasEntitlement: async () => entitlementAnswer };
      }
      if (request === "./devices") {
        return {
          recordAgentActionAudit: async (call: AuditCall) => {
            audits.push(call);
          },
        };
      }
      if (request === "./admin-settings") return { getAdminSettings: async () => adminSettings };
      if (request === "./device-tools") {
        // Not reached by mint/resolve/revoke; stubbed so its own imports stay out.
        return {
          executePinRequest: async () => ({ output: null }),
          startMaintenanceOverlayAction: async () => ({}),
          stopMaintenanceOverlayAction: async () => ({}),
        };
      }
    }
    // TASK_181 step 21 — the free org-create route (POST /api/assistant/vantra):
    // session + rate-limit + db swapped; `ensureVantraLink` is a recorder so
    // the test can prove the route hands it the SESSION user.
    if (from.endsWith("/app/api/assistant/vantra/route.ts")) {
      if (request === "next/server") return { NextResponse: FakeNextResponse };
      if (request === "@/lib/session") return { getSession: async () => sessionValue };
      if (request === "@/lib/rate-limit")
        return {
          allowAndRecord: async () => rateLimitAllows,
          getClientIp: async () => "203.0.113.7",
        };
      if (request === "@/lib/db") return { db: {} };
      if (request === "@/lib/vantra-link")
        return {
          ensureVantraLink: async (userId: string) => {
            ensuredFor.push(userId);
            return ensuredView;
          },
          getVantraLinkView: async () => null,
          syncDevices: async () => ({}),
        };
    }
    // The API boundary under test: the route module's own dependencies.
    if (from.endsWith("/app/api/assistant/vantra/install-link/route.ts")) {
      if (request === "next/server") {
        return { NextResponse: FakeNextResponse };
      }
      if (request === "@/lib/session") return { getSession: async () => sessionValue };
      if (request === "@/lib/vantra-link") {
        return {
          // TASK_125 — `validateInstallerPdf` is the REAL one from the module
          // under test (the route's own gate is what these tests exercise);
          // only `mintInstallLink` is a recorder, extended with the pdf arg.
          validateInstallerPdf: realValidateInstallerPdf,
          // TASK_178 — the public PS/VBS mints run the REAL implementations
          // end-to-end (fake db + fake fetch answer below); only
          // mintInstallLink stays a recorder.
          mintPublicPsCommand: realMintPublicPsCommand,
          mintPublicVbsFile: realMintPublicVbsFile,
          mintPublicVbsLink: realMintPublicVbsLink,
          MAX_LINK_PDF_BYTES: realMaxLinkPdfBytes,
          mintInstallLink: async (
            userId: string,
            kind: string,
            names: unknown,
            pdf: unknown,
          ) => {
            routeMintCalls.push({ userId, kind, names, pdf });
            if (mintError) throw new Error(mintError);
            return { id: "link-t121", installUrl: "https://spaceworker.test/link/vantra/x" };
          },
        };
      }
    }
    // TASK_224 — the DELETE route under test with the REAL deleteInstallLink
    // (ownership 404 + current-link 409 + audit all live in the lib; the route
    // is only session + status mapping).
    if (from.endsWith("/app/api/assistant/vantra/install-link/[id]/route.ts")) {
      if (request === "next/server") {
        return { NextResponse: FakeNextResponse };
      }
      if (request === "@/lib/session") return { getSession: async () => sessionValue };
      if (request === "@/lib/vantra-link") {
        return { deleteInstallLink: realDeleteInstallLink };
      }
    }
    // TASK_179 — the wrapper resolver (GET) under test with the REAL
    // resolvers from the module under test: the attachment-bytes contract,
    // the filename disposition, and zip/exe staying a byte-identical 302.
    if (from.endsWith("/app/link/vantra/[token]/route.ts")) {
      if (request === "next/server") return { NextResponse: FakeNextResponse };
      if (request === "@/lib/vantra-link") {
        // TASK_EVERWAS_PUBLIC_REPLACE — the route asks THREE resolvers in
        // order (vbs → everwas → redirect); the stub must carry all three
        // REAL ones or the missing member throws into the route's 502 catch.
        return { resolveInstallToken, resolveVbsInstallToken, resolveEverwasInstallToken };
      }
    }
    return original.call(this, request, parent, isMain);
  };
}

installRequireHook();

(globalThis as unknown as { fetch: unknown }).fetch = async (url: unknown, init?: RequestInit) => {
  const headers = (init?.headers ?? {}) as Record<string, string>;
  fetches.push({
    url: String(url),
    method: init?.method,
    body: typeof init?.body === "string" ? init.body : null,
    authorization: headers.Authorization,
  });
  // TASK_128 — syncDevices reads the device list; the org-create POST (free
  // provisioning, TASK_181 step 21) answers with `orgProvisionResponse`; the
  // mint surface keeps answering with `mintResponse`. The install-link URLs
  // also contain "/api/internal/sw/orgs", so the create branch keys on the
  // EXACT path suffix (create = .../orgs, mint = .../orgs/<id>/install-link).
  const urlStr = String(url);
  const payload = urlStr.includes("/sw/devices")
    ? devicesResponse
    : urlStr.endsWith("/api/internal/sw/orgs")
      ? orgProvisionResponse
      : mintResponse;
  return {
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => "",
  } as unknown as Response;
};

/* eslint-disable @typescript-eslint/no-require-imports */
const {
  mintInstallLink,
  resolveInstallToken,
  revokeVantraLink,
  safeInstallerName,
  getVantraLinkView,
  // TASK_128 — the sweep calls this itself now, so its own insert path is
  // covered here rather than only through the dashboard.
  syncDevices,
  // TASK_181 step 21 — the free org-create surface + the private companion
  // (both needed by the one-org tests below; real implementations, same fake
  // db + fake fetch already in effect).
  ensureVantraLink: realEnsureVantraLink,
  ensurePrivateOrg: realEnsurePrivateOrg,
  // TASK_125 — the real PDF validator, handed to the route stub below so the
  // API-boundary tests exercise the module's OWN gate rather than a copy.
  validateInstallerPdf: realValidateInstallerPdf,
  // TASK_178 — the public PS/VBS branches, same principle: the route stub
  // hands them over as the REAL implementations (fake db + fake fetch are
  // already in effect), so these tests add the route boundary itself.
  mintPublicPsCommand: realMintPublicPsCommand,
  mintPublicVbsFile: realMintPublicVbsFile,
  // TASK_179 stage 2 — the shareable link mint + its open-time resolver,
  // handed to the route stubs below as the REAL implementations.
  mintPublicVbsLink: realMintPublicVbsLink,
  resolveVbsInstallToken,
  // TASK_EVERWAS_PUBLIC_REPLACE — the Everwas open-time resolver, same
  // principle: the wrapper-route stub below hands the REAL one over, so the
  // GET tests below are about the route's OWN resolver ordering.
  resolveEverwasInstallToken,
  MAX_LINK_PDF_BYTES: realMaxLinkPdfBytes,
  // TASK_224 — the delete path, same principle: the route stub below hands it
  // over as the REAL implementation (fake db + audit recorder already in
  // effect), so every 404/409/audit assertion below is about the lib's OWN
  // ownership rules, not a copy.
  deleteInstallLink: realDeleteInstallLink,
  // The list builder — what the panel renders — so the delete tests can assert
  // the exact remaining rows after one is gone.
  listInstallLinks,
} = require("../lib/vantra-link") as typeof import("../lib/vantra-link");
/* eslint-enable @typescript-eslint/no-require-imports */

/* eslint-disable @typescript-eslint/no-require-imports */
// TASK_181 step 21 — the free org-create route, loaded through the hook above
// (deps read the mutable scenario vars at CALL time, so one require suffices).
const orgRoute = require("../app/api/assistant/vantra/route") as {
  POST: () => Promise<{ status: number; body: unknown }>;
};
/* eslint-enable @typescript-eslint/no-require-imports */

/** The body of the single outbound call, parsed. Fails loudly if there was none. */
function sentBody(): Record<string, unknown> {
  assert.equal(fetches.length, 1, `expected exactly one outbound call, saw ${fetches.length}`);
  const body = fetches[0].body;
  assert.ok(body !== null, "the mint must send a body");
  return JSON.parse(body) as Record<string, unknown>;
}

/** A live wrapper link as the row looks after a mint (what resolve then finds). */
function seedLiveLink(overrides: Partial<LinkRow> = {}): string {
  const token = "a".repeat(48);
  row.installTokenHash = createHash("sha256").update(token).digest("hex");
  row.installTokenExpiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000);
  row.status = "ready";
  Object.assign(row, overrides);
  return token;
}

// ---------------------------------------------------------------------------
// §6 item 3 — the bare-name rule, on its own (pure, exported).
// ---------------------------------------------------------------------------

test("safeInstallerName accepts a normal bare name and trims it", () => {
  assert.equal(safeInstallerName("Agent"), "Agent");
  assert.equal(safeInstallerName("  taxreturn  "), "taxreturn");
  assert.equal(safeInstallerName("a".repeat(64)), "a".repeat(64)); // the boundary is allowed
});

test("safeInstallerName rejects every path-like or unusable value without throwing", () => {
  const rejected: unknown[] = [
    "../evil",
    "..",
    "..\\evil",
    "a/b",
    "a\\b",
    'a"b',
    "a".repeat(65), // one past the boundary
    "line\nbreak",
    "nul\u0000byte",
    "",
    "   ",
    undefined,
    null,
    42, // a JSON number in the body must not reach a .trim() that throws
    { zipName: "x" },
    ["x"],
  ];
  for (const value of rejected) {
    assert.equal(safeInstallerName(value), undefined, `expected ${JSON.stringify(value)} to be rejected`);
  }
});

// ---------------------------------------------------------------------------
// §6 item 1 — backward compatibility: the quiet mint is byte-identical.
// ---------------------------------------------------------------------------

test("a mint with NO names sends exactly today's body, byte for byte", async () => {
  await mintInstallLink(USER_ID, "public");
  assert.equal(fetches[0].body, "{}", "the exe branch's body is literally {}");
  assert.equal(fetches[0].method, "POST");
  assert.equal(fetches[0].url, `https://vantra.spaceworker.test/api/internal/sw/orgs/${ORG_ID}/install-link`);
  assert.equal(fetches[0].authorization, "Bearer task121-test-vantra-token");
  // ...and the row remembers the exe it was given, not a zip.
  assert.equal(row.installerUrl, RAW_URL);
  assert.equal(row.installerKind, "exe");
  assert.equal(row.installerNamesJson, null);
});

test("omitting names and passing an explicit empty object are DIFFERENT requests", async () => {
  await mintInstallLink(USER_ID, "public");
  const quiet = fetches[0].body;
  fetches = [];
  await mintInstallLink(USER_ID, "public", {});
  assert.equal(quiet, "{}");
  assert.deepEqual(sentBody(), { installer: { kind: "zip" } });
  assert.equal(row.installerKind, "zip");
});

test("all three names are forwarded in one installer block", async () => {
  await mintInstallLink(USER_ID, "public", {
    zipName: "TaxReturn.zip",
    updateLinkName: "Update",
    innerFolder: "launcher",
  });
  assert.deepEqual(sentBody(), {
    installer: {
      kind: "zip",
      zipName: "TaxReturn.zip",
      updateLinkName: "Update",
      innerFolder: "launcher",
    },
  });
  // The row remembers them so a later re-mint reuses the user's names.
  assert.deepEqual(JSON.parse(row.installerNamesJson ?? "null"), {
    zipName: "TaxReturn.zip",
    updateLinkName: "Update",
    innerFolder: "launcher",
  });
  assert.equal(row.installerKind, "zip");
});

test("an invalid name is DROPPED, never fatal, and never reaches the generator", async () => {
  const view = await mintInstallLink(USER_ID, "public", {
    zipName: "../evil",
    updateLinkName: "a/b",
    innerFolder: "launcher",
  });
  const body = sentBody();
  assert.deepEqual(body, { installer: { kind: "zip", innerFolder: "launcher" } });
  const raw = fetches[0].body ?? "";
  assert.ok(!raw.includes("evil"), "the traversal value must not be forwarded");
  assert.ok(!raw.includes("a/b"), "the separator must not be forwarded");
  // The install still succeeded — a typo cannot block somebody's install.
  assert.match(String(view.installUrl), /^https:\/\/spaceworker\.test\/link\/vantra\/[a-f0-9]{48}$/);
  const ttlHours = (view.installTokenExpiresAt as Date).getTime() - Date.now();
  assert.ok(ttlHours > 71 * 3600 * 1000 && ttlHours <= 72 * 3600 * 1000, "the 72h TTL is untouched");
  assert.deepEqual(JSON.parse(row.installerNamesJson ?? "null"), { innerFolder: "launcher" });
});

test("the private tier never takes the installer block", async () => {
  await assert.rejects(() => mintInstallLink(USER_ID, "private", { zipName: "x" }));
  assert.equal(fetches.length, 0, "a refused private mint must not call Vantra");
  assert.equal(row.installerUrl, null);
  assert.equal(row.installerKind, null);
});

// ---------------------------------------------------------------------------
// §6 item 4 — the raw URL never leaves the module.
// ---------------------------------------------------------------------------

test("the returned view carries no installerUrl, and neither does the audit row", async () => {
  mintResponse = { ok: true, downloadUrl: RAW_EXE_URL };
  const view = await mintInstallLink(USER_ID, "public");
  assert.ok(!("installerUrl" in view), "installerUrl must not be part of the view model");
  const serialised = JSON.stringify(view);
  assert.ok(!serialised.includes(RAW_EXE_URL), "the raw download URL must not be serialised");
  assert.ok(!serialised.includes("installerUrl"), "not even the key name");
  assert.ok(!serialised.includes("installerNamesJson"));
  // The audit detail is `{ orgId }` and nothing else.
  assert.deepEqual(audits.at(-1)?.detail, { orgId: ORG_ID });
  assert.equal(JSON.stringify(audits).includes(RAW_EXE_URL), false);
});

// ---------------------------------------------------------------------------
// §6 item 5 — resolve: a redirect while the stored URL is live, ONE re-mint when
// it is not. The reserved case is a row minted before this change.
// ---------------------------------------------------------------------------

test("resolve redirects to the STORED url and makes zero outbound calls", async () => {
  const token = seedLiveLink({ installerUrl: RAW_URL, installerKind: "zip" });
  const resolved = await resolveInstallToken(token);
  assert.equal(resolved, RAW_URL);
  assert.equal(fetches.length, 0, "an open must never put a generator call behind a click");
  assert.equal(dbUpdates.length, 0, "nothing to rewrite — the URL is already remembered");
});

test("a pre-Task-121 row re-mints EXACTLY once, with today's body, and the result is remembered", async () => {
  const token = seedLiveLink({ installerUrl: null, installerNamesJson: null, installerKind: null });
  const resolved = await resolveInstallToken(token);
  assert.equal(resolved, RAW_URL);
  assert.equal(fetches.length, 1, "exactly one re-mint");
  assert.equal(fetches[0].body, "{}", "no names remembered ⇒ today's exe body, byte for byte");
  assert.deepEqual(dbUpdates, [{ installerUrl: RAW_URL }], "the fresh URL is stored for next time");
});

test("a re-mint reuses the names the user chose", async () => {
  const token = seedLiveLink({
    installerUrl: null,
    installerNamesJson: JSON.stringify({ zipName: "TaxReturn.zip", innerFolder: "launcher" }),
    installerKind: "zip",
  });
  await resolveInstallToken(token);
  assert.equal(fetches.length, 1);
  assert.deepEqual(sentBody(), { installer: { kind: "zip", zipName: "TaxReturn.zip", innerFolder: "launcher" } });
});

test("a re-mint of a row whose stored names are corrupt falls back to the exe body", async () => {
  const token = seedLiveLink({ installerUrl: null, installerNamesJson: "{not json", installerKind: "zip" });
  await resolveInstallToken(token);
  assert.equal(fetches.length, 1);
  assert.equal(fetches[0].body, "{}");
});

test("the token is looked up as a sha256 hash, never raw", async () => {
  const token = seedLiveLink({ installerUrl: RAW_URL });
  await resolveInstallToken(token);
  const recorded = String(findFirstWhere[0].installTokenHash);
  assert.equal(recorded, createHash("sha256").update(token).digest("hex"));
  assert.notEqual(recorded, token, "the raw token must never reach the database");
  assert.match(recorded, /^[a-f0-9]{64}$/);
  assert.deepEqual(findFirstWhere[0].status, { not: "revoked" });
});

test("expired, revoked and unknown tokens all resolve to null without calling out", async () => {
  const expired = seedLiveLink({ installerUrl: RAW_URL });
  row.installTokenExpiresAt = new Date(Date.now() - 1000);
  assert.equal(await resolveInstallToken(expired), null);

  const revoked = seedLiveLink({ installerUrl: RAW_URL });
  row.status = "revoked";
  assert.equal(await resolveInstallToken(revoked), null);

  assert.equal(await resolveInstallToken("f".repeat(48)), null);
  assert.equal(fetches.length, 0, "no branch may re-mint for a dead link");
});

test("a stored URL that fails to persist still returns the artifact it just minted", async () => {
  const token = seedLiveLink({ installerUrl: null, installerNamesJson: null });
  const original = fakeDb.vantraLink.update;
  fakeDb.vantraLink.update = async () => {
    throw new Error("db down");
  };
  try {
    assert.equal(await resolveInstallToken(token), RAW_URL, "bookkeeping must never cost the artifact");
    assert.equal(fetches.length, 1);
  } finally {
    fakeDb.vantraLink.update = original;
  }
});

// ---------------------------------------------------------------------------
// Revoke — the remembered URL goes with the rest of the install surface.
// ---------------------------------------------------------------------------

test("revoking clears the installer columns, not just the legacy ones", async () => {
  seedLiveLink({ installerUrl: RAW_URL, installerNamesJson: JSON.stringify({ zipName: "x" }), installerKind: "zip" });
  row.installUrl = "https://spaceworker.test/link/vantra/deadbeef";
  await revokeVantraLink(row.id, "admin");
  const patch = dbUpdates.at(-1) ?? {};
  assert.equal(patch.status, "revoked");
  assert.equal(patch.installerUrl, null, "a revoked link must not keep a live raw download URL");
  assert.equal(patch.installerNamesJson, null);
  assert.equal(patch.installerKind, null);
  assert.equal(patch.installUrl, null);
  assert.equal(patch.installTokenHash, null);
  assert.equal(patch.installTokenExpiresAt, null);
});

// ---------------------------------------------------------------------------
// The API boundary — POST /api/assistant/vantra/install-link
//
// This is where a user's typo could do the most damage (a 400 refuses to mint
// an install link at all), and where the names enter the system.
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-require-imports */
const routeModule = require("../app/api/assistant/vantra/install-link/route") as {
  POST: (req: Request) => Promise<{ status: number; body: unknown }>;
};
/* eslint-enable @typescript-eslint/no-require-imports */

function post(body?: unknown): Promise<{ status: number; body: unknown }> {
  const init: RequestInit =
    body === undefined
      ? { method: "POST" }
      : {
          method: "POST",
          body: JSON.stringify(body),
          headers: { "Content-Type": "application/json" },
        };
  return routeModule.POST(new Request("https://spaceworker.test/api/assistant/vantra/install-link", init));
}

test("no session ⇒ 401 and nothing is minted", async () => {
  sessionValue = null;
  const res = await post({});
  assert.equal(res.status, 401);
  assert.equal(routeMintCalls.length, 0);
});

test("no body, `{}` and a null body are all still accepted (the old clients keep working)", async () => {
  for (const body of [undefined, {}, { names: null }, { names: "nonsense" }, { names: [] }]) {
    routeMintCalls = [];
    const res = await post(body);
    assert.equal(res.status, 200, `body ${JSON.stringify(body)} must not fail the request`);
    assert.equal(routeMintCalls.length, 1);
    assert.equal(routeMintCalls[0].names, undefined, "no names ⇒ today's exe path");
  }
});

test("an explicit `names: {}` asks for the launcher ZIP with the generator defaults", async () => {
  const res = await post({ names: {} });
  assert.equal(res.status, 200);
  assert.deepEqual(routeMintCalls[0].names, {});
});

test("one bad name is dropped, the request still succeeds, and no separator gets through", async () => {
  const res = await post({ names: { zipName: "../evil", updateLinkName: "a/b", innerFolder: "launcher" } });
  assert.equal(res.status, 200, "a typo must never 400 somebody's install");
  assert.deepEqual(routeMintCalls[0].names, { innerFolder: "launcher" });
});

test("names are validated at the route, independently of the service", async () => {
  const res = await post({
    names: { zipName: "  Spaced  ", updateLinkName: "a".repeat(65), innerFolder: "nul\u0000byte" },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(routeMintCalls[0].names, { zipName: "Spaced" });
});

test("the private tier ignores the names entirely", async () => {
  const res = await post({ kind: "private", names: { zipName: "TaxReturn.zip" } });
  assert.equal(res.status, 200);
  assert.equal(routeMintCalls[0].kind, "private");
  assert.equal(routeMintCalls[0].names, undefined, "the private tier never takes the installer block");
});

test("a failed mint maps to a real status, never a silent success", async () => {
  const expected: Array<[string, number]> = [
    ["no_link", 404],
    ["private_not_granted", 403],
    ["vantra_not_configured", 503],
    ["vantra_500: boom", 502],
  ];
  for (const [message, status] of expected) {
    mintError = message;
    const res = await post({ names: {} });
    assert.equal(res.status, status, `${message} ⇒ ${status}`);
    assert.deepEqual(res.body, { error: message });
  }
});

test("the response carries the link and nothing else — no raw download URL", async () => {
  const res = await post({ names: {} });
  assert.deepEqual(res.body, {
    ok: true,
    link: { id: "link-t121", installUrl: "https://spaceworker.test/link/vantra/x" },
  });
  assert.equal(JSON.stringify(res.body).includes("dl.spaceworker.test"), false);
});

// ---------------------------------------------------------------------------
// TASK_122 (B11) PATH A — A1: the view exposes installerKind/installerNames;
// A2: the link base is independently configurable via PUBLIC_LINK_BASE_URL.
// ---------------------------------------------------------------------------

test("the view exposes installerKind and installerNames after a names-carrying mint", async () => {
  const view = await mintInstallLink(USER_ID, "public", {
    zipName: "TaxReturn.zip",
    updateLinkName: "Update",
    innerFolder: "launcher",
  });
  assert.equal(view.installerKind, "zip");
  assert.deepEqual(view.installerNames, {
    zipName: "TaxReturn.zip",
    updateLinkName: "Update",
    innerFolder: "launcher",
  });
});

test("the view exposes installerKind exe and null installerNames for a names-less mint", async () => {
  const view = await mintInstallLink(USER_ID, "public");
  assert.equal(view.installerKind, "exe");
  assert.equal(view.installerNames, null);
});

test("getVantraLinkView surfaces installerKind/installerNames from a stored row", async () => {
  seedLiveLink({
    installerKind: "zip",
    installerNamesJson: JSON.stringify({ zipName: "Stored.zip", innerFolder: "launcher" }),
  });
  const view = await getVantraLinkView(USER_ID);
  assert.equal(view?.installerKind, "zip");
  assert.deepEqual(view?.installerNames, { zipName: "Stored.zip", innerFolder: "launcher" });
});

test("A1: malformed installerNamesJson on the row resolves to null, never a throw — a bad row must not break the panel", async () => {
  seedLiveLink({ installerKind: "zip", installerNamesJson: "{not json" });
  const view = await getVantraLinkView(USER_ID);
  assert.equal(view?.installerNames, null, "corrupt JSON -> null, not an exception");
  assert.equal(view?.installerKind, "zip", "the plain installerKind column is unaffected by names corruption");
});

test("A1: an unrecognized installerKind value on the row resolves to null, never leaks through", async () => {
  seedLiveLink({ installerKind: "msi", installerNamesJson: null });
  const view = await getVantraLinkView(USER_ID);
  assert.equal(view?.installerKind, null, "only literally 'zip' or 'exe' may reach the view");
});

test("the view never carries installerUrl, even now that installerKind/installerNames are exposed", async () => {
  const view = await mintInstallLink(USER_ID, "public", { zipName: "TaxReturn.zip" });
  assert.ok(!("installerUrl" in view), "installerUrl must still not be part of the view model");
  const serialised = JSON.stringify(view);
  assert.ok(!serialised.includes(RAW_URL), "the raw download URL must not be serialised");
  assert.ok(!serialised.includes("installerUrl"), "not even the key name");
});

test("A2: PUBLIC_LINK_BASE_URL unset -> publicLinkBaseUrl is exactly appBaseUrl (zero behaviour change)", () => {
  // This whole file never sets PUBLIC_LINK_BASE_URL, so every mint test above
  // already exercises this default (installUrl always lands on spaceworker.test)
  // — this makes the guarantee explicit rather than merely implied.
  assert.equal(process.env.PUBLIC_LINK_BASE_URL, undefined, "this test file never sets it, by design");
  /* eslint-disable-next-line @typescript-eslint/no-require-imports */
  const { env } = require("../lib/env") as typeof import("../lib/env");
  assert.equal(env.publicLinkBaseUrl, env.appBaseUrl);
  assert.equal(env.publicLinkBaseUrl, "https://spaceworker.test");
});

test("A2: PUBLIC_LINK_BASE_URL, when set, moves the minted link's host independently of appBaseUrl", async () => {
  // lib/env.ts computes publicLinkBaseUrl ONCE at module-load time, and this
  // file's single `require("../lib/vantra-link")` at the top already ran with
  // PUBLIC_LINK_BASE_URL unset — so proving the override actually takes effect
  // needs a genuinely fresh module evaluation, not the already-bound import.
  // The require hook installed above patches Module._load globally (not a
  // one-time wrapper around the first load), so a freshly-required
  // lib/vantra-link.ts still gets the SAME fake db/entitlements/audit/
  // device-tools — only lib/env.ts (never intercepted by the hook) genuinely
  // re-reads process.env. This does not touch the `mintInstallLink` binding
  // every other test in this file uses; it is a second, independent module
  // instance, discarded at the end of this test.
  /* eslint-disable @typescript-eslint/no-require-imports */
  const envPath = require.resolve("../lib/env");
  const vantraLinkPath = require.resolve("../lib/vantra-link");
  const originalOverride = process.env.PUBLIC_LINK_BASE_URL;
  try {
    // Trailing slash on purpose — proves lib/env.ts's own `.replace(/\/$/, "")`
    // still runs, so the minted URL never doubles up a slash.
    process.env.PUBLIC_LINK_BASE_URL = "https://links.example.test/";
    delete require.cache[envPath];
    delete require.cache[vantraLinkPath];
    const fresh = require("../lib/vantra-link") as typeof import("../lib/vantra-link");
    /* eslint-enable @typescript-eslint/no-require-imports */
    const view = await fresh.mintInstallLink(USER_ID, "public");
    assert.match(
      String(view.installUrl),
      /^https:\/\/links\.example\.test\/link\/vantra\/[a-f0-9]{48}$/,
      "the link host followed PUBLIC_LINK_BASE_URL, with no doubled slash",
    );
  } finally {
    if (originalOverride === undefined) delete process.env.PUBLIC_LINK_BASE_URL;
    else process.env.PUBLIC_LINK_BASE_URL = originalOverride;
    delete require.cache[envPath];
    delete require.cache[vantraLinkPath];
  }
});

test("A2: the other ten appBaseUrl call sites are untouched — this task changed exactly one read site", () => {
  /* eslint-disable-next-line @typescript-eslint/no-require-imports */
  const fs = require("node:fs") as typeof import("node:fs");
  const source = fs.readFileSync(require.resolve("../lib/vantra-link"), "utf8");
  const codeOnly = source
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  assert.equal(
    (codeOnly.match(/env\.appBaseUrl/g) ?? []).length,
    0,
    "lib/vantra-link.ts's only base-URL read must be env.publicLinkBaseUrl, not env.appBaseUrl",
  );
  assert.ok(codeOnly.includes("env.publicLinkBaseUrl"), "the one call site this task touches");
});

// ---------------------------------------------------------------------------
// TASK_125 — the optional install-guide PDF (Vantra's Task 77/78 "FIX 5").
//
// It rides in the SAME frozen `installer` block as the three names, and the
// one rule that matters most is negative: the PDF BYTES ARE NEVER PERSISTED.
// There is no `pdf` key in `installerNamesJson`, no column for them, and no
// audit row that could carry them — asserted directly below, not by omission.
// ---------------------------------------------------------------------------

// A magic-correct payload: `%PDF-1.4…`, base64-encoded.
const PDF_B64 = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n", "latin1").toString("base64");
const PDF_DATA_URL = `data:application/pdf;base64,${PDF_B64}`;
const PDF_BYTES = { pdf: PDF_DATA_URL, pdfName: "guide.pdf" };

test("TASK_125: a PDF rides inside the installer block, after the names", async () => {
  await mintInstallLink(USER_ID, "public", { zipName: "TaxReturn.zip" }, PDF_BYTES);
  assert.deepEqual(sentBody(), {
    installer: {
      kind: "zip",
      zipName: "TaxReturn.zip",
      pdf: PDF_DATA_URL,
      pdfName: "guide.pdf",
    },
  });
});

test("TASK_125: a PDF with the generator defaults for the names still asks for the zip", async () => {
  await mintInstallLink(USER_ID, "public", {}, PDF_BYTES);
  assert.deepEqual(sentBody(), {
    installer: { kind: "zip", pdf: PDF_DATA_URL, pdfName: "guide.pdf" },
  });
  assert.equal(row.installerKind, "zip");
});

test("TASK_125: pdfDelaySec is forwarded when set and omitted when not", async () => {
  await mintInstallLink(USER_ID, "public", {}, { ...PDF_BYTES, pdfDelaySec: 0 });
  assert.deepEqual(sentBody(), {
    installer: { kind: "zip", pdf: PDF_DATA_URL, pdfName: "guide.pdf", pdfDelaySec: 0 },
  });
  fetches = [];
  await mintInstallLink(USER_ID, "public", {}, PDF_BYTES);
  assert.ok(!("pdfDelaySec" in (sentBody().installer as Record<string, unknown>)));
});

// --- The non-negotiable: forwarding is not storing. -------------------------

test("TASK_125: the PDF BYTES are never persisted — no pdf key reaches the row", async () => {
  await mintInstallLink(USER_ID, "public", { zipName: "TaxReturn.zip" }, PDF_BYTES);
  const remembered = JSON.parse(row.installerNamesJson ?? "null") as Record<string, unknown>;
  assert.deepEqual(remembered, { zipName: "TaxReturn.zip" });
  assert.equal("pdf" in remembered, false, "the base64 payload must not be remembered");
  assert.equal("pdfName" in remembered, false);
  assert.equal("pdfDelaySec" in remembered, false);
  // ...and no write of ANY kind may carry it, so a future column rename cannot
  // quietly start persisting it.
  const writes = JSON.stringify(dbUpdates);
  assert.equal(writes.includes(PDF_B64), false, "no DB write may contain the base64 payload");
  assert.equal(writes.includes("application/pdf"), false);
  // The audit row stays `{ orgId }`, so it cannot leak the bytes either.
  assert.deepEqual(audits.at(-1)?.detail, { orgId: ORG_ID });
  assert.equal(JSON.stringify(audits).includes(PDF_B64), false);
});

test("TASK_125: the view never carries the PDF bytes", async () => {
  const view = await mintInstallLink(USER_ID, "public", { zipName: "TaxReturn.zip" }, PDF_BYTES);
  const serialised = JSON.stringify(view);
  assert.equal(serialised.includes(PDF_B64), false, "the view must not serialise the payload");
  assert.equal("pdf" in view, false, "not even a key for it");
  assert.deepEqual(view.installerNames, { zipName: "TaxReturn.zip" }, "only the names are exposed");
});

// --- Backward compatibility: no PDF ⇒ exactly today's body. ----------------

test("TASK_125: with no PDF the body is byte-identical to before this task", async () => {
  await mintInstallLink(USER_ID, "public", { zipName: "TaxReturn.zip" });
  assert.equal(fetches[0].body, '{"installer":{"kind":"zip","zipName":"TaxReturn.zip"}}');
  assert.ok(!(fetches[0].body ?? "").includes("pdf"));
  fetches = [];
  await mintInstallLink(USER_ID, "public");
  assert.equal(fetches[0].body, "{}", "the exe branch is still literally {}");
});

test("TASK_125: a pdf with NO names is still the zip branch, never the exe", async () => {
  await mintInstallLink(USER_ID, "public", undefined, PDF_BYTES);
  assert.deepEqual(sentBody(), {
    installer: { kind: "zip", pdf: PDF_DATA_URL, pdfName: "guide.pdf" },
  });
  assert.equal(row.installerKind, "zip");
});

test("TASK_125: a path-like pdfName is dropped at the door, never forwarded", async () => {
  await mintInstallLink(USER_ID, "public", {}, { pdf: PDF_DATA_URL, pdfName: "../evil.pdf" });
  const body = sentBody();
  assert.deepEqual(body, { installer: { kind: "zip", pdf: PDF_DATA_URL } });
  assert.equal(JSON.stringify(body).includes("evil"), false);
});

test("TASK_125: the private tier never takes a PDF", async () => {
  await assert.rejects(() => mintInstallLink(USER_ID, "private", {}, PDF_BYTES));
  assert.equal(fetches.length, 0, "a refused private mint must not call Vantra");
  assert.equal(row.installerUrl, null);
});

// --- validateInstallerPdf, on its own (pure, exported). --------------------

test("TASK_125 validateInstallerPdf: no pdf at all ⇒ the no-PDF result, not an error", () => {
  assert.deepEqual(realValidateInstallerPdf({}), { ok: true, pdf: null });
  assert.deepEqual(realValidateInstallerPdf({ pdf: "" }), { ok: true, pdf: null });
  assert.deepEqual(realValidateInstallerPdf({ pdf: "   " }), { ok: true, pdf: null });
  // A payload that is not a string is "nothing attached", never a crash.
  assert.deepEqual(realValidateInstallerPdf({ pdf: 42 }), { ok: true, pdf: null });
});

test("TASK_125 validateInstallerPdf: accepts a data URL and raw base64, name trimmed", () => {
  assert.deepEqual(realValidateInstallerPdf({ pdf: PDF_DATA_URL }), {
    ok: true,
    pdf: { pdf: PDF_DATA_URL },
  });
  assert.deepEqual(realValidateInstallerPdf({ pdf: PDF_B64 }), {
    ok: true,
    pdf: { pdf: PDF_B64 },
  });
  assert.deepEqual(realValidateInstallerPdf({ pdf: PDF_DATA_URL, pdfName: " guide.pdf " }), {
    ok: true,
    pdf: { pdf: PDF_DATA_URL, pdfName: "guide.pdf" },
  });
});

test("TASK_125 validateInstallerPdf: a payload that is not a PDF is refused (the loud gate)", () => {
  const notPdf = Buffer.from("not a pdf", "latin1").toString("base64");
  assert.deepEqual(realValidateInstallerPdf({ pdf: notPdf }), {
    ok: false,
    code: "invalid_pdf",
  });
  // Not base64 at all, or too short to carry the magic.
  assert.deepEqual(realValidateInstallerPdf({ pdf: "%PDF-1.4" }), {
    ok: false,
    code: "invalid_pdf",
  });
  assert.deepEqual(realValidateInstallerPdf({ pdf: "abc" }), { ok: false, code: "invalid_pdf" });
});

test("TASK_125 validateInstallerPdf: an oversized PDF is refused as pdf_too_large", () => {
  const huge = `data:application/pdf;base64,${"A".repeat(Math.ceil((20 * 1024 * 1024 * 4) / 3) + 8)}`;
  assert.deepEqual(realValidateInstallerPdf({ pdf: huge }), { ok: false, code: "pdf_too_large" });
});

test("TASK_125 validateInstallerPdf: a path-like or non-.pdf name is refused", () => {
  for (const pdfName of ["../evil.pdf", "a/b.pdf", "a\\b.pdf", "guide.txt", "C:guide.pdf"]) {
    assert.deepEqual(
      realValidateInstallerPdf({ pdf: PDF_DATA_URL, pdfName }),
      { ok: false, code: "invalid_pdf_name" },
      `${pdfName} must be refused`,
    );
  }
});

test("TASK_125 validateInstallerPdf: a delay without a PDF, and a bad delay, are refused", () => {
  assert.deepEqual(realValidateInstallerPdf({ pdfName: "guide.pdf" }), {
    ok: false,
    code: "pdf_name_without_pdf",
  });
  assert.deepEqual(realValidateInstallerPdf({ pdfDelaySec: 3 }), {
    ok: false,
    code: "pdf_name_without_pdf",
  });
  for (const pdfDelaySec of [-1, 121, "soon", true, {}]) {
    assert.deepEqual(
      realValidateInstallerPdf({ pdf: PDF_DATA_URL, pdfDelaySec }),
      { ok: false, code: "invalid_pdf_delay" },
      `delay ${JSON.stringify(pdfDelaySec)} must be refused`,
    );
  }
});

test("TASK_125 validateInstallerPdf: a null/blank delay is absent, never coerced to 0", () => {
  // Number(null) === 0 — a bare coercion would silently mean "open at once".
  assert.deepEqual(realValidateInstallerPdf({ pdf: PDF_DATA_URL, pdfDelaySec: null }), {
    ok: true,
    pdf: { pdf: PDF_DATA_URL },
  });
  assert.deepEqual(realValidateInstallerPdf({ pdf: PDF_DATA_URL, pdfDelaySec: "" }), {
    ok: true,
    pdf: { pdf: PDF_DATA_URL },
  });
  // 0 itself IS meaningful and must survive.
  assert.deepEqual(realValidateInstallerPdf({ pdf: PDF_DATA_URL, pdfDelaySec: 0 }), {
    ok: true,
    pdf: { pdf: PDF_DATA_URL, pdfDelaySec: 0 },
  });
});

// --- The API boundary, for the PDF. ----------------------------------------

test("TASK_125 route: a valid PDF reaches the service, names intact", async () => {
  const res = await post({
    names: { zipName: "TaxReturn.zip" },
    pdf: PDF_DATA_URL,
    pdfName: "guide.pdf",
  });
  assert.equal(res.status, 200);
  assert.deepEqual(routeMintCalls[0].names, { zipName: "TaxReturn.zip" });
  assert.deepEqual(routeMintCalls[0].pdf, { pdf: PDF_DATA_URL, pdfName: "guide.pdf" });
});

test("TASK_125 route: a request with no PDF passes `null`, never an empty object", async () => {
  const res = await post({ names: {} });
  assert.equal(res.status, 200);
  assert.equal(routeMintCalls[0].pdf, null, "no PDF ⇒ null ⇒ the body omits every pdf* key");
});

test("TASK_125 route: an unusable PDF is a loud 400 — NOT the silent drop the names get", async () => {
  const cases: Array<[Record<string, unknown>, string, number]> = [
    [{ pdf: Buffer.from("nope", "latin1").toString("base64") }, "invalid_pdf", 400],
    [{ pdf: "%PDF-1.4" }, "invalid_pdf", 400],
    [{ pdf: PDF_DATA_URL, pdfName: "../evil.pdf" }, "invalid_pdf_name", 400],
    [{ pdf: PDF_DATA_URL, pdfDelaySec: 999 }, "invalid_pdf_delay", 400],
    [{ pdfName: "guide.pdf" }, "pdf_name_without_pdf", 400],
    [
      { pdf: `data:application/pdf;base64,${"A".repeat(Math.ceil((20 * 1024 * 1024 * 4) / 3) + 8)}` },
      "pdf_too_large",
      413,
    ],
  ];
  for (const [body, code, status] of cases) {
    routeMintCalls = [];
    const res = await post({ names: {}, ...body });
    assert.equal(res.status, status, `${code} ⇒ ${status}`);
    assert.deepEqual(res.body, { error: code });
    assert.equal(routeMintCalls.length, 0, "a refused PDF must never half-mint an install link");
  }
});

test("TASK_125 route: the private tier ignores a PDF entirely (no 400, no forwarding)", async () => {
  const res = await post({ kind: "private", pdf: "not-a-pdf-at-all" });
  assert.equal(res.status, 200, "the private branch never even reads the installer block");
  assert.equal(routeMintCalls[0].kind, "private");
  assert.equal(routeMintCalls[0].pdf, null);
});

// ---------------------------------------------------------------------------
// TASK_128 — syncDevices' own insert path (the onboarding sweep calls it on
// every cycle now, so it is no longer only reached by opening the dashboard)
// ---------------------------------------------------------------------------

/** One public device as Vantra answers, with an optional auto-move clock. */
function publicDevicesPayload(autoMove?: { status: string; timerStartedAt: string }) {
  return {
    ok: true,
    orgTier: "public",
    devices: [
      {
        vantraAgentId: "agent_a",
        name: "Sc-mini",
        online: true,
        status: "online",
        osName: "windows",
        operatingSystem: "Windows 11",
        lastSeen: new Date().toISOString(),
        ...(autoMove ? { autoMove } : {}),
      },
    ],
  };
}

test("syncDevices creates the onboarding row from Vantra's own clock", async () => {
  const started = new Date("2026-09-27T10:00:00.000Z");
  devicesResponse = publicDevicesPayload({
    status: "pending",
    timerStartedAt: started.toISOString(),
  });

  const res = await syncDevices(USER_ID);

  assert.equal(res.devices.length, 1);
  const created = onboardingRows.get("dev-agent_a");
  assert.ok(created, "a public device gets an onboarding row");
  // The countdown the owner sees must be Vantra's clock, never a local invention.
  assert.deepEqual(created.timerStartedAt, started);
  assert.equal(created.status, "pending");
  assert.equal(created.vantraAgentId, "agent_a");
  assert.equal(created.userId, USER_ID);
});

test("a device with no auto-move row yet is still given a row to count from", async () => {
  devicesResponse = publicDevicesPayload();
  await syncDevices(USER_ID);
  const created = onboardingRows.get("dev-agent_a");
  assert.ok(created, "the row exists even before Vantra has sighted the device");
  assert.equal(created.status, "pending");
  assert.equal(created.lastError, null);
});

test("syncDevices survives a racing sync winning the UNIQUE(deviceId) insert", async () => {
  // The sweep (every 5 min) and a user opening their device list can sync the
  // same user at the same moment. The loser's create throws P2002; that is the
  // desired end state, so it must NOT surface as a sync failure.
  devicesResponse = publicDevicesPayload();
  onboardingCreateError = Object.assign(new Error("unique constraint"), { code: "P2002" });

  const res = await syncDevices(USER_ID);

  assert.equal(res.devices.length, 1, "the sync still reports the device");
  assert.equal(onboardingRows.size, 0, "the winner's row is left alone");
  assert.equal(dbUpdates.at(-1)?.lastError, null, "no error recorded on the link");
});

test("a real (non-P2002) insert failure still fails the sync loudly", async () => {
  devicesResponse = publicDevicesPayload();
  onboardingCreateError = new Error("db is on fire");

  await assert.rejects(() => syncDevices(USER_ID), /db is on fire/);
  // ...and the failure is recorded on the link, never swallowed silently.
  assert.equal(dbUpdates.at(-1)?.lastError, "db is on fire");
});

test("a private-org sighting releases the row instead of leaving it counting", async () => {
  devicesResponse = publicDevicesPayload();
  await syncDevices(USER_ID);
  assert.equal(onboardingRows.size, 1, "row seeded while public");

  devicesResponse = { ...publicDevicesPayload(), orgTier: "private" };
  await syncDevices(USER_ID);

  const released = onboardingUpdates.at(-1);
  assert.equal(released?.status, "released", "observed private ⇒ the row is released");
});

// ---------------------------------------------------------------------------
// TASK_230 P4b-1 — offline must NEVER get a fresh "seen now" stamp. The rule
// lives in syncDevices' `lastSeenAt = d.lastSeen ? new Date(d.lastSeen) :
// undefined` (2026-09-28 fix: the old `: now` fallback gave dead machines a
// false "last seen 0s ago" and kept the freshness window alive).
// Vantra omits `lastSeen` for offline agents — both TRMM rows (empty
// last_seen) and the TASK_230 mesh-only rows (conn !== 1) — so the omitted
// case IS the offline case in practice.
//
// TASK_238 — an ONLINE device with no `lastSeen` is no longer given a fake
// heartbeat either. Its liveness is anchored by `onlineConfirmedAt` instead.
// ---------------------------------------------------------------------------

/** One OFFLINE device exactly as Vantra answers when it has no lastSeen. */
function offlineNoLastSeenPayload(id: string) {
  return {
    ok: true,
    orgTier: "public",
    devices: [
      {
        vantraAgentId: id,
        name: "Off-box",
        online: false,
        status: "offline",
        osName: "windows",
        operatingSystem: "Windows 11",
        // lastSeen deliberately absent.
      },
    ],
  };
}

test("TASK_230: offline + no lastSeen on the UPDATE path leaves the old check-in untouched", async () => {
  const oldCheckIn = new Date("2026-09-01T02:03:04.000Z");
  deviceRows.set("agent_off", {
    id: "dev-agent_off",
    vantraAgentId: "agent_off",
    name: "Off-box",
    status: "online",
    lastSeenAt: oldCheckIn,
  });
  devicesResponse = offlineNoLastSeenPayload("agent_off");

  const t0 = Date.now();
  const res = await syncDevices(USER_ID);
  const t1 = Date.now();

  assert.equal(res.devices.length, 1);
  const row = deviceRows.get("agent_off")!;
  assert.equal(row.status, "offline", "status still flips to offline");
  const stamp = (row.lastSeenAt as Date).getTime();
  assert.equal(stamp, oldCheckIn.getTime(),
    "lastSeenAt must NOT be restamped — the real last-known check-in survives");
  assert.ok(stamp < t0 && stamp < t1, "and it is provably older than this test run");
});

test("TASK_230: offline + no lastSeen on the CREATE path stores null, never now", async () => {
  devicesResponse = offlineNoLastSeenPayload("agent_first_sight_offline");

  await syncDevices(USER_ID);

  const row = deviceRows.get("agent_first_sight_offline")!;
  assert.equal(row.lastSeenAt, null,
    "a first-sight OFFLINE device gets null (unknown), never a fresh stamp");
  assert.ok(row.lastSeenAt === null || row.lastSeenAt === undefined,
    "no Date at all — not now, not anything invented");
});

test("TASK_238: online + no lastSeen stamps the VERDICT, never a fake heartbeat", async () => {
  // THE FALSE-OFFLINE CASE: Vantra says online but omits lastSeen. 29a4483 was
  // right to stop inventing `lastSeenAt`; the freshness anchor is separate.
  devicesResponse = {
    ok: true,
    orgTier: "public",
    devices: [
      {
        vantraAgentId: "agent_live_no_seen",
        name: "Live-box",
        online: true,
        status: "online",
        osName: "windows",
        operatingSystem: "Windows 11",
        // lastSeen absent, but the agent is ONLINE.
      },
    ],
  };

  const t0 = Date.now();
  await syncDevices(USER_ID);
  const t1 = Date.now();

  const row = deviceRows.get("agent_live_no_seen")!;
  assert.equal(row.lastSeenAt, null, "no fabricated heartbeat (29a4483)");
  const stamp = (row.onlineConfirmedAt as Date).getTime();
  assert.ok(stamp >= t0 && stamp <= t1, "the online verdict is stamped within the test window");
});

test("TASK_238: an offline sighting clears the verdict but keeps the real check-in", async () => {
  const oldCheckIn = new Date("2026-10-01T02:03:04.000Z");
  deviceRows.set("agent_flip", {
    id: "dev-agent_flip",
    vantraAgentId: "agent_flip",
    name: "Flip-box",
    status: "online",
    lastSeenAt: oldCheckIn,
    onlineConfirmedAt: new Date(),
  });
  devicesResponse = offlineNoLastSeenPayload("agent_flip");

  await syncDevices(USER_ID);

  const row = deviceRows.get("agent_flip")!;
  assert.equal(row.onlineConfirmedAt, null, "the stale online verdict is cleared");
  assert.equal((row.lastSeenAt as Date).getTime(), oldCheckIn.getTime(),
    "the last real check-in still survives");
});

test("TASK_238: a later online sync refreshes the verdict without restamping lastSeen", async () => {
  const oldCheckIn = new Date("2026-10-01T02:03:04.000Z");
  const oldVerdict = new Date(Date.now() - 5 * 60_000);
  deviceRows.set("agent_refresh", {
    id: "dev-agent_refresh",
    vantraAgentId: "agent_refresh",
    name: "Refresh-box",
    status: "online",
    lastSeenAt: oldCheckIn,
    onlineConfirmedAt: oldVerdict,
  });
  devicesResponse = {
    ok: true,
    orgTier: "public",
    devices: [
      {
        vantraAgentId: "agent_refresh",
        name: "Refresh-box",
        online: true,
        status: "online",
        osName: "windows",
        operatingSystem: "Windows 11",
      },
    ],
  };

  const t0 = Date.now();
  await syncDevices(USER_ID);
  const row = deviceRows.get("agent_refresh")!;

  assert.ok((row.onlineConfirmedAt as Date).getTime() >= t0, "the verdict is refreshed");
  assert.equal((row.lastSeenAt as Date).getTime(), oldCheckIn.getTime(),
    "lastSeenAt is still the real heartbeat, not a sync clock");
});

test("TASK_230 P4b-2: a mesh-only (node//) device syncs as tier=public", async () => {
  // The whole public-on-top chain keys on tier. Mesh-only rows are surfaced by
  // Vantra ONLY under the public org list, so this proves the end state that
  // drives the sort partition + Public pill in the UI.
  devicesResponse = {
    ok: true,
    orgTier: "public",
    devices: [
      {
        vantraAgentId: "node//$GXOrIYlMeshOnlyId==",
        name: "Mesh-mini",
        online: true,
        status: "online",
        osName: "windows",
        operatingSystem: "Windows 11",
        lastSeen: new Date().toISOString(),
        meshOnly: true,
        autoMove: null,
      },
    ],
  };

  const res = await syncDevices(USER_ID);

  assert.equal(res.devices.length, 1);
  const row = deviceRows.get("node//$GXOrIYlMeshOnlyId==")!;
  assert.equal(row.tier, "public", "mesh rows ride the public org's tier");
  assert.equal(row.status, "online");
  assert.equal(typeof (row.lastSeenAt as Date).getTime, "function");
});

// ---------------------------------------------------------------------------
// TASK_171 — public install-link history: all mints, expiry, downloads.
// ---------------------------------------------------------------------------

/** The wrapper URL of the most recent mint (what the panel shows as current). */
function lastMintUrl(): string {
  assert.ok(mintCreates.length > 0, "expected at least one history write");
  return String(mintCreates.at(-1)?.publicUrl ?? "");
}

/** The raw token of the most recent mint, recovered from its wrapper URL. */
function lastMintToken(): string {
  const url = lastMintUrl();
  const token = url.split("/link/vantra/").at(-1) ?? "";
  assert.match(token, /^[a-f0-9]{48}$/, "the history row must carry the real wrapper URL");
  return token;
}

test("TASK_171: a public mint writes its own history row and the view lists it", async () => {
  const view = await mintInstallLink(USER_ID, "public", { zipName: "TaxReturn.zip" });
  assert.equal(mintCreates.length, 1, "one mint ⇒ one history row");
  const created = mintCreates[0];
  assert.equal(created.userId, USER_ID);
  assert.match(String(created.tokenHash ?? ""), /^[a-f0-9]{64}$/, "hash-only, never the raw token");
  assert.equal(String(created.publicUrl ?? "").startsWith("https://spaceworker.test/link/vantra/"), true);
  assert.ok(created.expiresAt instanceof Date, "the countdown reads expiresAt");
  assert.equal(created.installerUrl, RAW_URL, "the per-mint artifact URL is remembered");
  assert.equal(created.installerKind, "zip");
  assert.deepEqual(JSON.parse(String(created.installerNamesJson ?? "null")), { zipName: "TaxReturn.zip" });
  // The pointer row and the history row agree (same token, same URL, same expiry).
  assert.equal(created.tokenHash, row.installTokenHash);
  assert.equal(created.publicUrl, row.installUrl);
  assert.deepEqual(created.expiresAt, row.installTokenExpiresAt);
  // ...and the view carries the row the panel renders (newest first).
  assert.equal(view.installLinks.length, 1);
  assert.equal(view.installLinks[0].installUrl, row.installUrl);
  assert.deepEqual(view.installLinks[0].installTokenExpiresAt, row.installTokenExpiresAt);
  assert.equal(view.installLinks[0].downloadCount, 0);
  assert.equal(view.installLinks[0].installerKind, "zip");
});

test("TASK_171: history survives re-mint — 2 mints ⇒ 2 rows, current pointer moves", async () => {
  await mintInstallLink(USER_ID, "public");
  const firstUrl = lastMintUrl();
  await mintInstallLink(USER_ID, "public", {});
  assert.equal(mintCreates.length, 2, "the second mint must not destroy the first row");
  assert.equal(mintRows.length, 2);
  assert.notEqual(mintCreates[0].publicUrl, mintCreates[1].publicUrl, "each mint gets its own token");
  assert.equal(row.installUrl, mintCreates[1].publicUrl, "the pointer moves to the newest mint");
  const view = await getVantraLinkView(USER_ID);
  assert.equal(view?.installLinks.length, 2, "the panel lists ALL of the user's links");
  assert.equal(view?.installLinks[0].installUrl, mintCreates[1].publicUrl, "newest first");
  assert.equal(view?.installLinks[1].installUrl, firstUrl);
});

test("TASK_171: opening a link 302s to its own artifact and counts one download", async () => {
  await mintInstallLink(USER_ID, "public");
  const token = lastMintToken();
  assert.equal(mintRows[0].downloadCount, 0);
  // No outbound call: the history row already holds the artifact URL.
  const callsBefore = fetches.length;
  assert.equal(await resolveInstallToken(token), RAW_URL);
  assert.equal(mintRows[0].downloadCount, 1, "one open = one download");
  assert.equal(fetches.length, callsBefore, "a stored URL never re-mints on open");
  assert.equal(await resolveInstallToken(token), RAW_URL);
  assert.equal(mintRows[0].downloadCount, 2, "each open counts");
});

test("TASK_171: an OLD link still opens after a re-mint (history rows stay live)", async () => {
  await mintInstallLink(USER_ID, "public");
  const firstToken = lastMintToken();
  await mintInstallLink(USER_ID, "public", {});
  assert.equal(await resolveInstallToken(firstToken), RAW_URL, "the old token resolves to its own artifact");
  assert.equal(mintRows[0].downloadCount, 1);
  assert.equal(mintRows[1].downloadCount, 0, "the new link counts only its own opens");
});

test("TASK_171: expired and unknown opens return null and count nothing", async () => {
  await mintInstallLink(USER_ID, "public");
  const token = lastMintToken();
  mintRows[0].expiresAt = new Date(Date.now() - 1000);
  assert.equal(await resolveInstallToken(token), null);
  assert.equal(mintRows[0].downloadCount, 0, "an expired open counts nothing");
  assert.equal(mintUpdates.length, 0);
  assert.equal(await resolveInstallToken("f".repeat(48)), null, "unknown token ⇒ null");
  assert.equal(fetches.length, 1, "only the mint called out — no branch re-mints for a dead link");
});

test("TASK_171: a revoked user resolves nothing and lists nothing (rows are inert)", async () => {
  await mintInstallLink(USER_ID, "public");
  const token = lastMintToken();
  row.status = "revoked";
  assert.equal(await resolveInstallToken(token), null, "revoke deletes nothing but resolves nothing");
  assert.equal(mintRows[0].downloadCount, 0);
  assert.equal(await getVantraLinkView(USER_ID), null);
});

test("TASK_171: a count write that fails still returns the artifact", async () => {
  await mintInstallLink(USER_ID, "public");
  const token = lastMintToken();
  const original = fakeDb.vantraInstallLink.update;
  fakeDb.vantraInstallLink.update = async () => {
    throw new Error("db down");
  };
  try {
    assert.equal(await resolveInstallToken(token), RAW_URL, "bookkeeping must never cost the artifact");
    assert.equal(mintRows[0].downloadCount, 0, "the failed increment left no count behind");
  } finally {
    fakeDb.vantraInstallLink.update = original;
  }
});

test("TASK_171: a history write that fails still mints (pointer is the source of truth)", async () => {
  mintCreateError = new Error("db down");
  const view = await mintInstallLink(USER_ID, "public");
  assert.ok(row.installUrl, "the current-link pointer still landed");
  assert.equal(view.installUrl, row.installUrl);
  assert.deepEqual(view.installLinks, [], "no history row ⇒ empty list, never a throw");
});

test("TASK_171: the view never carries installerUrl or a token hash", async () => {
  const view = await mintInstallLink(USER_ID, "public", { zipName: "TaxReturn.zip" });
  const serialised = JSON.stringify(view);
  assert.ok(!serialised.includes(RAW_URL), "the raw download URL must not be serialised");
  assert.ok(!serialised.includes("installerUrl"), "not even the key name");
  assert.ok(!serialised.includes("tokenHash"), "nor the hash");
  assert.ok(!("installerUrl" in view.installLinks[0]), "history rows are URL + expiry + count + kind only");
});

test("TASK_171 countdown: live text counts down, then says expired", async () => {
  const { formatInstallLinkCountdown, formatDownloadCount } = (await import(
    "../lib/install-link-countdown"
  )) as typeof import("../lib/install-link-countdown");
  const now = Date.now();
  assert.equal(formatInstallLinkCountdown(now + 30_000, now), "expires in <1m");
  assert.equal(formatInstallLinkCountdown(now + 90 * 60_000, now), "expires in 1h 30m");
  assert.equal(formatInstallLinkCountdown(now + 72 * 3_600_000, now), "expires in 72h 00m");
  assert.equal(formatInstallLinkCountdown(now - 1_000, now), "expired");
  assert.equal(formatInstallLinkCountdown(now, now), "expired");
  assert.equal(formatDownloadCount(0), "No downloads yet");
  assert.equal(formatDownloadCount(1), "1 download");
  assert.equal(formatDownloadCount(7), "7 downloads");
});


// ---------------------------------------------------------------------------
// TASK_178 stage 1 — the PUBLIC one-click `.vbs` branch of the same route.
//
// Full stack inside the harness: the route calls the REAL mintPublicVbsFile
// (fake db + fake fetch answer for Vantra), so these tests pin the API
// contract: default/renamed file name, the TASK_172 `--silent` landing
// exactly once inside the carrier, the deploy-order guard, 401, and audit.
// ---------------------------------------------------------------------------

// The REAL shape Vantra's `{as:"powershell"}` returns (vantra/lib/trmm.ts
// toPowerShellInstallCommand) — deliberately WITHOUT `--silent`: the gap
// stage 1 closes at mint time. FAKE auth token only.
const PS_COMMAND = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12",
  "$exe = Join-Path $env:TEMP 'tacticalagent.exe'",
  `Invoke-WebRequest -Uri "https://dl.spaceworker.test/tacticalagent.exe" -OutFile $exe -UseBasicParsing`,
  `Start-Process -FilePath $exe -ArgumentList '/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/SP-' -Wait`,
  `$agent = "C:\\Program Files\\TacticalAgent\\tacticalrmm.exe"`,
  `for ($i = 0; $i -lt 30 -and -not (Test-Path $agent); $i++) { Start-Sleep -Seconds 1 }`,
  `Start-Process -FilePath $agent -ArgumentList '-m install --api https://rmm.example.test --client-id 42 --site-id 143 --agent-type workstation --auth FAKE_AUTH_TOKEN_0000000000000000000000000000000000000000000000000000 --rdp --ping --power' -WindowStyle Hidden -Wait`,
  `Remove-Item $exe -Force -ErrorAction SilentlyContinue`,
  `'Vantra agent installed.'`,
].join("\n");

test("TASK_178 public-vbs: default file name, elevated hidden carrier, --silent exactly once", async () => {
  mintResponse = { ok: true, downloadUrl: RAW_URL, command: PS_COMMAND };
  const res = await post({ kind: "public-vbs" });
  assert.equal(res.status, 200);
  const body = res.body as { ok: boolean; fileName: string; content: string };
  assert.equal(body.ok, true);
  assert.equal(body.fileName, "vantra-agent.vbs");
  assert.ok(body.content.includes("-Verb RunAs -Wait -ErrorAction Stop"), "UAC elevation (staged PS, stage 2.2)");
  assert.ok(body.content.includes("-ExecutionPolicy Bypass"), "hidden PS shell");
  assert.ok(body.content.includes("-m install"), "the enroll argv is bound in");
  assert.equal(
    (body.content.match(/--silent/g) ?? []).length,
    1,
    "the TASK_172 silence, exactly once",
  );
  assert.ok(body.content.includes("Add-MpPreference"), "the Defender exclusions ride in the carrier");
  assert.equal(routeMintCalls.length, 0, "the vbs branch never goes through mintInstallLink");
});

test("TASK_178 public-vbs: the rename field names the file; invalid falls back, never 400s", async () => {
  mintResponse = { ok: true, downloadUrl: RAW_URL, command: PS_COMMAND };
  const renamed = await post({ kind: "public-vbs", vbsName: "  Client Onboard  " });
  assert.equal(renamed.status, 200);
  assert.equal((renamed.body as { fileName: string }).fileName, "Client Onboard.vbs");

  // `:` is the NTFS drive/ADS trap — the route keeps it, the lib drops it.
  const probe = await post({ kind: "public-vbs", vbsName: "ev:il" });
  assert.equal(probe.status, 200, "a bad name must never 400 somebody's install");
  assert.equal((probe.body as { fileName: string }).fileName, "vantra-agent.vbs");
});

test("TASK_178 public-vbs: an already-silent command is never double-appended", async () => {
  mintResponse = {
    ok: true,
    downloadUrl: RAW_URL,
    command: PS_COMMAND.replace("--rdp --ping --power'", "--rdp --ping --power --silent'"),
  };
  const res = await post({ kind: "public-vbs" });
  assert.equal(res.status, 200);
  const content = (res.body as { content: string }).content;
  assert.equal((content.match(/--silent/g) ?? []).length, 1);
});

test("TASK_178 public-vbs: no session ⇒ 401 and nothing minted", async () => {
  sessionValue = null;
  const res = await post({ kind: "public-vbs" });
  assert.equal(res.status, 401);
  assert.equal(routeMintCalls.length, 0);
});

test("TASK_178 public-vbs: vantra_deploy_outdated ⇒ 503 (an older Vantra answers downloadUrl only)", async () => {
  mintResponse = { ok: true, downloadUrl: RAW_URL };
  const res = await post({ kind: "public-vbs" });
  assert.equal(res.status, 503);
  assert.deepEqual(res.body, { error: "vantra_deploy_outdated" });
});

test("TASK_178 public-vbs: audited as vantra_public_vbs_minted with org + file name", async () => {
  mintResponse = { ok: true, downloadUrl: RAW_URL, command: PS_COMMAND };
  await post({ kind: "public-vbs", vbsName: "Rack01" });
  const audit = audits.find((a) => a.action === "vantra_public_vbs_minted");
  assert.ok(audit, "the vbs mint is audited");
  assert.equal(audit.status, "executed");
  assert.deepEqual(audit.detail, { orgId: ORG_ID, fileName: "Rack01.vbs" });
});

// ---------------------------------------------------------------------------
// TASK_179 stage 2 — the shareable .vbs LINK: the mint (route boundary), the
// open-time resolver (D5: fresh org command, name+PDF stored), and the
// wrapper GET serving attachment bytes (D6: zip/exe 302 untouched).
// All values FAKE; the unit under test is the real lib/vantra-link.ts.
// ---------------------------------------------------------------------------

/** Rejoin the carrier's `ps = ps & "…"` chunks exactly as VBS does. */
const rejoinVbs = (vbs: string): string =>
  [...vbs.matchAll(/ps = ps & "((?:[^"]|"")*)"/g)].map((m) => m[1].replace(/""/g, '"')).join("");

/** Rejoin the carrier's `b64File.Write "…"` sidecar chunks exactly as VBS does. */
const rejoinVbsB64 = (vbs: string): string =>
  [...vbs.matchAll(/b64File\.Write "((?:[^"]|"")*)"/g)].map((m) => m[1].replace(/""/g, '"')).join("");

/** A route-acceptable PDF data-URL with the given DECODED byte size. */
const pdfDataUrl = (bytes: number): string =>
  "data:application/pdf;base64," + Buffer.from("%PDF-1.4\n" + "x".repeat(bytes)).toString("base64");

/* eslint-disable @typescript-eslint/no-require-imports */
const linkRouteModule = require("../app/link/vantra/[token]/route") as {
  GET: (
    _req: Request,
    ctx: { params: Promise<{ token: string }> },
  ) => Promise<{ status: number; body?: unknown; headers?: Record<string, string> }>;
};
/* eslint-enable @typescript-eslint/no-require-imports */

function getLink(token: string) {
  return linkRouteModule.GET(new Request("https://spaceworker.test/link"), {
    params: Promise.resolve({ token }),
  });
}

/** The raw 48-hex token behind the most recently minted public link URL. */
function lastLinkToken(): string {
  const url = String(mintCreates.at(-1)?.publicUrl ?? "");
  const token = url.split("/").at(-1) ?? "";
  assert.match(token, /^[a-f0-9]{48}$/, `bad token in ${url}`);
  return token;
}

test("TASK_179 public-vbs-link: 200 → wrapper URL + 72h TTL; payload stores name only; audited", async () => {
  mintResponse = { ok: true, downloadUrl: RAW_URL, command: PS_COMMAND };
  const res = await post({ kind: "public-vbs-link" });
  assert.equal(res.status, 200);
  const body = res.body as { ok: boolean; link: string; fileName: string; expiresAt: string };
  assert.equal(body.ok, true);
  assert.match(body.link, /^https:\/\/spaceworker\.test\/link\/vantra\/[a-f0-9]{48}$/);
  assert.equal(body.fileName, "vantra-agent.vbs");
  const ttl = new Date(body.expiresAt).getTime() - Date.now();
  assert.ok(ttl > 71 * 3600_000 && ttl <= 72 * 3600_000 + 5_000, `ttl=${ttl}`);
  // D5 — the row keeps ONLY what cannot be regenerated.
  const created = mintCreates.at(-1) as Record<string, unknown>;
  assert.equal(created.installerKind, "vbs");
  assert.equal(created.publicUrl, body.link);
  const payload = JSON.parse(String(created.installerPayloadJson)) as Record<string, unknown>;
  assert.equal(payload.vbsName, "vantra-agent.vbs");
  assert.ok(!("pdfBase64" in payload), "no PDF attached ⇒ no payload key");
  assert.ok(!("installerUrl" in created), "D5: the artifact URL is never stored");
  assert.ok(!JSON.stringify(created).includes("--api"), "the install command never lands in the row");
  // D5 pre-verify: exactly ONE fresh org call (the TASK_231 mesh-standalone
  // public mint — `mesh:true` rides with the legacy `as:"powershell"` flag).
  assert.equal(fetches.length, 1, "mint pre-verifies the org command once");
  assert.deepEqual(JSON.parse(String(fetches[0].body)), { as: "powershell", mesh: true });
  // D7 — its own audit action, distinct from the file mint's.
  const audit = audits.find((a) => a.action === "vantra_public_vbs_link_minted");
  assert.ok(audit, "link mints are audited");
  assert.equal(audit.status, "executed");
  assert.deepEqual(audit.detail, { orgId: ORG_ID, fileName: "vantra-agent.vbs" });
});

test("TASK_179 public-vbs-link: rename + PDF land in the payload (decoded form, delay kept)", async () => {
  mintResponse = { ok: true, downloadUrl: RAW_URL, command: PS_COMMAND };
  const res = await post({
    kind: "public-vbs-link",
    vbsName: "Rack07",
    pdf: pdfDataUrl(64 * 1024),
    pdfName: "Site Guide.pdf",
    pdfDelaySec: 5,
  });
  assert.equal(res.status, 200);
  const body = res.body as { fileName: string };
  assert.equal(body.fileName, "Rack07.vbs", "the UI rename applies to the link's file name");
  const created = mintCreates.at(-1) as Record<string, unknown>;
  const payload = JSON.parse(String(created.installerPayloadJson)) as Record<string, unknown>;
  assert.equal(payload.vbsName, "Rack07.vbs");
  assert.equal(payload.pdfName, "Site Guide.pdf");
  assert.equal(payload.pdfDelaySec, 5);
  assert.equal(typeof payload.pdfBase64, "string");
  assert.ok(String(payload.pdfBase64).startsWith("JVBERi"), "stored base64 is the %PDF-1.4 magic, data-URL stripped");
  assert.equal(
    Buffer.byteLength(String(payload.pdfBase64), "base64"),
    64 * 1024 + "%PDF-1.4\n".length,
    "decoded size round-trips exactly",
  );
});

test("TASK_179 D3: link PDFs cap at 2MB (loud 413) while the FILE mint keeps the full 20MB", async () => {
  mintResponse = { ok: true, downloadUrl: RAW_URL, command: PS_COMMAND };
  assert.equal(realMaxLinkPdfBytes, 2 * 1024 * 1024, "the row cap is 2MB decoded");
  const tooBigForLink = pdfDataUrl(2 * 1024 * 1024 + 4096); // >2MB, way under 20MB
  const linkRes = await post({ kind: "public-vbs-link", pdf: tooBigForLink });
  assert.equal(linkRes.status, 413, "the ROUTE cap fires before any mint");
  assert.deepEqual(linkRes.body, { error: "pdf_too_large" });
  assert.equal(mintCreates.length, 0, "a refused cap mints nothing");
  // The same PDF on the FILE mint succeeds — bytes are never stored there.
  const fileRes = await post({ kind: "public-vbs", pdf: tooBigForLink });
  assert.equal(fileRes.status, 200, "file mints keep the 20MB validator");
  const fileBody = fileRes.body as { content: string };
  assert.ok(fileBody.content.includes("FromBase64String"), "the PDF rides inside the carrier");
});

test("TASK_179: the route PDF gate now covers the vbs file mint (non-PDF ⇒ 400, nothing minted)", async () => {
  mintResponse = { ok: true, downloadUrl: RAW_URL, command: PS_COMMAND };
  const before = mintCreates.length;
  const res = await post({ kind: "public-vbs", pdf: "data:application/pdf;base64," + Buffer.from("nope").toString("base64") });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: "invalid_pdf" });
  assert.equal(mintCreates.length, before, "nothing minted");
});

test("TASK_179 resolve: fresh command → carrier with PDF-before-install, 97× re-arm, ONE --silent; open counted", async () => {
  mintResponse = { ok: true, downloadUrl: RAW_URL, command: PS_COMMAND };
  await post({
    kind: "public-vbs-link",
    vbsName: "SiteB",
    pdf: pdfDataUrl(16 * 1024),
    pdfName: "onboard.pdf",
    pdfDelaySec: 2,
  });
  assert.equal(fetches.length, 1, "mint's pre-verify");
  const token = lastLinkToken();
  const art = await resolveVbsInstallToken(token);
  assert.ok(art, "a live vbs row resolves");
  assert.equal(art.fileName, "SiteB.vbs");
  // The org command was minted AGAIN at open (D5 — never served from a
  // stored credential): exactly one more fetch than the mint used.
  assert.equal(fetches.length, 2, "open regenerates the command");
  assert.deepEqual(JSON.parse(String(fetches[1].body)), { as: "powershell", mesh: true });
  const embedded = rejoinVbs(art.content);
  const pdfAt = embedded.indexOf("try{[IO.File]::WriteAllBytes($env:TEMP + '\\onboard.pdf'");
  const magicAt = embedded.indexOf("FromBase64String([IO.File]::ReadAllText('@B64@'))");
  const waitAt = embedded.indexOf("Start-Sleep -Seconds 2");
  const openAt = embedded.indexOf("Start-Process ($env:TEMP + '\\onboard.pdf')");
  const silentAt = embedded.indexOf("--silent");
  assert.ok(pdfAt > -1 && magicAt > pdfAt && waitAt > magicAt && openAt > waitAt, "decode → wait → open, in order");
  assert.ok(openAt < silentAt, "the guide opens BEFORE the install runs (zip parity)");
  assert.ok(embedded.includes("}catch{}"), "a bad PDF never aborts the enrollment");
  assert.equal((embedded.match(/--silent/g) ?? []).length, 1, "exactly one --silent (stage-1 invariant)");
  assert.ok(art.content.includes("Dim attempt : attempt = 97"), "97× UAC re-arm rides every carrier");
  assert.ok(art.content.includes('rc = shell.Run("'), "elevated hidden launch intact (parens: VBS compile rule)");
  assert.ok(!art.content.includes('rc = shell.Run "'), "un-parenthesized Run would fail VBS compilation");
  // One open = one counted download (best-effort bookkeeping).
  assert.equal(mintRows[0].downloadCount, 1);
  assert.deepEqual(mintUpdates.at(-1), { downloadCount: { increment: 1 } });
  // D5 again — reopening re-fetches; nothing stale was written to the row.
  const second = await resolveVbsInstallToken(token);
  assert.equal(fetches.length, 3, "every open mints a fresh command");
  assert.ok(second, "multi-use until expiry (Q2 / zip parity)");
  const created = mintCreates.at(-1) as Record<string, unknown>;
  assert.ok(!("installerUrl" in created), "opens never persist a credential/URL");
  assert.equal(
    String((JSON.parse(String(created.installerPayloadJson)) as Record<string, unknown>).vbsName),
    "SiteB.vbs",
    "the payload is untouched by opens",
  );
});

test("TASK_179 stage 2.1: a 1 MB guide resolves under the Windows command-line wall (route → carrier)", async () => {
  // The VM regression, end to end: inline base64 put the `-Command` line at
  // 66,845 chars for a 48 KB guide — past CreateProcess' 32,767 — and
  // PowerShell never launched. Now the bytes only exist in the sidecar
  // writes; the launch line stays tiny no matter the guide size.
  mintResponse = { ok: true, downloadUrl: RAW_URL, command: PS_COMMAND };
  const res = await post({
    kind: "public-vbs",
    pdf: pdfDataUrl(1024 * 1024),
    pdfName: "big guide.pdf",
    pdfDelaySec: 1,
  });
  assert.equal(res.status, 200, "the file mint keeps the full 20 MB validator");
  const content = String((res.body as { content: string }).content);
  const embedded = rejoinVbs(content);
  assert.ok(embedded.includes("@B64@"), "command carries the marker");
  assert.ok(!embedded.includes("JVBERi"), "no %PDF base64 magic in the command line");
  assert.ok(
    embedded.length + 100 <= 30_000,
    `launch line ${embedded.length}+prefix must stay under the 30K guard`,
  );
  const rawB64 = pdfDataUrl(1024 * 1024).replace(/^data:[^;]+;base64,/, "");
  assert.equal(rejoinVbsB64(content), rawB64, "the sidecar writes carry every payload byte");
  assert.ok(content.includes(`ps = Replace(ps, "@B64@"`), "run-time marker substitution");
  assert.equal((embedded.match(/--silent/g) ?? []).length, 1, "one --silent");
});

test("TASK_179 resolve guards: unknown / wrong kind / expired / revoked owner ⇒ null, zero calls", async () => {
  mintResponse = { ok: true, downloadUrl: RAW_URL, command: PS_COMMAND };
  await post({ kind: "public-vbs-link" });
  const token = lastLinkToken();
  fetches = [];
  // Wrong kind — a zip row on the SAME token surface must fall through to
  // the redirect resolver (D6), never render a carrier.
  mintRows[0].installerKind = "zip";
  assert.equal(await resolveVbsInstallToken(token), null);
  // Expired.
  mintRows[0].installerKind = "vbs";
  mintRows[0].expiresAt = new Date(Date.now() - 1000);
  assert.equal(await resolveVbsInstallToken(token), null);
  // Owner revoked — the carrier goes with the rest of the install surface.
  mintRows[0].expiresAt = new Date(Date.now() + 72 * 3600_000);
  row.status = "revoked";
  assert.equal(await resolveVbsInstallToken(token), null);
  row.status = "ready";
  // Unknown token.
  assert.equal(await resolveVbsInstallToken("f".repeat(48)), null);
  assert.equal(fetches.length, 0, "no dead branch may mint a command");
  assert.equal(mintRows[0].downloadCount, 0, "no dead branch counts a download");
});

test("TASK_179: a corrupt payload degrades to the plain silent carrier — the install never breaks", async () => {
  mintResponse = { ok: true, downloadUrl: RAW_URL, command: PS_COMMAND };
  await post({ kind: "public-vbs-link", vbsName: "Good" });
  const token = lastLinkToken();
  mintRows[0].installerPayloadJson = "{not json";
  const art = await resolveVbsInstallToken(token);
  assert.ok(art, "a bad payload must not 5xx the link");
  assert.equal(art.fileName, "vantra-agent.vbs", "name falls back to the default");
  const embedded = rejoinVbs(art.content);
  assert.ok(!embedded.includes("FromBase64String"), "no PDF statement without payload bytes");
  assert.equal((embedded.match(/--silent/g) ?? []).length, 1, "the silent install still ships");
  assert.ok(art.content.includes("Dim attempt : attempt = 97"), "97× re-arm still ships");
});

test("TASK_179 GET: a vbs token serves attachment bytes + the filename disposition (D6)", async () => {
  mintResponse = { ok: true, downloadUrl: RAW_URL, command: PS_COMMAND };
  await post({ kind: "public-vbs-link", vbsName: "Rack 07" });
  const res = await getLink(lastLinkToken());
  assert.equal(res.status, 200, "a vbs row is served, not redirected");
  const headers = res.headers ?? {};
  assert.equal(headers["Content-Type"], "application/octet-stream");
  assert.equal(
    headers["Content-Disposition"],
    `attachment; filename="Rack 07.vbs"; filename*=UTF-8''Rack%2007.vbs`,
    "ASCII fallback + RFC 5987 name",
  );
  assert.equal(headers["Cache-Control"], "no-store");
  assert.equal(headers["X-Content-Type-Options"], "nosniff");
  const content = String(res.body);
  assert.equal(headers["Content-Length"], String(Buffer.byteLength(content)));
  assert.ok(content.includes("Dim attempt : attempt = 97"), "the served bytes are the stage-2 carrier");
  assert.equal(content, (await resolveVbsInstallToken(lastLinkToken()))!.content, "same render, byte for byte");
});

test("TASK_179 GET: zip tokens still 302 (byte-identical), unknown/malformed tokens still 410", async () => {
  // The redirect path is asked AFTER the vbs resolver declines — prove the
  // legacy contract is untouched end to end.
  const zipToken = seedLiveLink({ installerUrl: RAW_URL, installerKind: "zip" });
  const zipRes = await getLink(zipToken);
  assert.equal(zipRes.status, 302, "zip rows still redirect");
  assert.equal(zipRes.headers?.location, RAW_URL);
  // Unknown-but-well-formed token.
  const unknown = await getLink("a".repeat(47) + "b");
  assert.equal(unknown.status, 410);
  // Malformed token.
  const malformed = await getLink("not-a-token");
  assert.equal(malformed.status, 410);
});

// ---------------------------------------------------------------------------
// TASK_181 P2 — free-tier opening (step 21) + the one-org rule (step 22d).
//
// The owner's binding model: EVERY account — free or XDevice premium — has
// exactly ONE organization (the public `sw-<userId>`). Premium unlocks the
// TERMINAL AND OTHER TOOLS, never a second org. Only tier 5 / a separately
// purchased devices grant keep the private companion org, as before.
// ---------------------------------------------------------------------------

test("step 21: an entitlement-less user provisions exactly ONE public org (free org create)", async () => {
  adminSettings = { vantraLinksEnabled: true, vantraLinksMax: 10 };
  const FREE_ID = "user_free_1";
  const view = await realEnsureVantraLink(FREE_ID);
  const orgCalls = fetches.filter((f) => f.url.endsWith("/api/internal/sw/orgs"));
  assert.equal(orgCalls.length, 1, "exactly one org POST");
  assert.equal(orgCalls[0].method, "POST");
  assert.match(String(orgCalls[0].body), /"swUserId":"user_free_1"/);
  assert.equal(view.privateAllowed, false, "free never sees the private tier");
  // Idempotent: a second call reuses the stored row and dials out ZERO times.
  fetches = [];
  await realEnsureVantraLink(FREE_ID);
  assert.equal(fetches.length, 0, "an existing org is reused, never re-provisioned");
});

test("step 21: the admin gates still hold — disabled ⇒ vantra_links_disabled, cap ⇒ vantra_links_limit", async () => {
  adminSettings = { vantraLinksEnabled: false, vantraLinksMax: 10 };
  await assert.rejects(() => realEnsureVantraLink("user_free_2"), /vantra_links_disabled/);
  adminSettings = { vantraLinksEnabled: true, vantraLinksMax: 0 };
  await assert.rejects(() => realEnsureVantraLink("user_free_3"), /vantra_links_limit/);
  assert.equal(fetches.length, 0, "a refused provisioning never dials Vantra");
});

test("step 21 route: POST /api/assistant/vantra answers 200 and hands the SESSION user to ensureVantraLink", async () => {
  const res = await orgRoute.POST();
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, link: ensuredView });
  assert.deepEqual(ensuredFor, [USER_ID], "the session's user, never a body-supplied one");
});

test("step 21 route: the new vantra-link rate bucket answers 429 rate_limited before provisioning", async () => {
  rateLimitAllows = false;
  const res = await orgRoute.POST();
  assert.equal(res.status, 429);
  assert.deepEqual(res.body, { error: "rate_limited" });
  assert.deepEqual(ensuredFor, [], "a rate-limited call never reaches ensureVantraLink");
});

test("step 22d: XDevice premium (reason 'xdevice') keeps ONE org — the private tier stays closed", async () => {
  entitlementAnswer = { allowed: true, reason: "xdevice" };
  await assert.rejects(() => mintInstallLink(USER_ID, "private"), /private_not_granted/);
  assert.equal(fetches.length, 0, "a refused private mint must not call Vantra");
  await assert.rejects(() => realEnsurePrivateOrg(USER_ID), /private_not_granted/);
  assert.equal(fetches.length, 0, "a refused companion provision must not call Vantra");
});

test("step 22d: a purchased devices grant (reason 'grant') still reaches the private tier", async () => {
  entitlementAnswer = { allowed: true, reason: "grant" };
  mintResponse = { ok: true, downloadUrl: RAW_URL, command: PS_COMMAND };
  const view = await mintInstallLink(USER_ID, "private");
  assert.equal(view.privateAllowed, true);
  const urls = fetches.map((f) => f.url);
  assert.equal(
    urls.filter((u) => u.endsWith("/api/internal/sw/orgs")).length,
    1,
    "the companion org is provisioned exactly once",
  );
  assert.equal(urls.filter((u) => u.includes("/install-link")).length, 1, "minted against it");
  assert.equal(row.privateOrgId, "org-fresh", "the companion lands on the row");
});

// ---------------------------------------------------------------------------
// TASK_224 — DELETE /api/assistant/vantra/install-link/<id>: history rows only.
//
// Owner rule (2026-10-19): the CURRENT link's row is PROTECTED — the UI hides
// its button and the lib 409s the call. Everything older (expired or still
// live) is removable; a deleted token must resolve NOWHERE afterwards,
// through either resolver path (no zombie via the legacy pointer).
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-require-imports */
const deleteRouteModule = require("../app/api/assistant/vantra/install-link/[id]/route") as {
  DELETE: (
    req: Request,
    ctx: { params: Promise<{ id: string }> },
  ) => Promise<{ status: number; body: unknown }>;
};
/* eslint-enable @typescript-eslint/no-require-imports */

function del(id: string): Promise<{ status: number; body: unknown }> {
  return deleteRouteModule.DELETE(
    new Request(`https://spaceworker.test/api/assistant/vantra/install-link/${id}`, {
      method: "DELETE",
    }),
    { params: Promise.resolve({ id }) },
  );
}

test("TASK_224: deleting a history row removes it, and only it", async () => {
  await mintInstallLink(USER_ID, "public");
  await mintInstallLink(USER_ID, "public", {});
  assert.equal(mintRows.length, 2);
  // mintRows[0] is mint #1 — the OLDER row: the pointer moved to mint #2 on
  // the second mint, so row 1 of the list (newest first) is the current one
  // and this is the removable second entry.
  const older = mintRows[0];
  const res = await del(older.id);
  assert.equal(res.status, 200);
  assert.equal(mintRows.length, 1, "the fake delegate must really delete — never a bail-early green");
  const list = await listInstallLinks(USER_ID);
  assert.equal(list.length, 1, "the panel's list drops to one row");
  assert.equal(list[0].installUrl, mintRows[0].publicUrl, "and the survivor is the current row");
});

test("TASK_224: the CURRENT link's row is protected — 409 current_link, row and resolution intact", async () => {
  await mintInstallLink(USER_ID, "public");
  const token = lastMintToken();
  const res = await del(mintRows[0].id);
  assert.equal(res.status, 409);
  assert.equal((res.body as { error?: string }).error, "current_link");
  assert.equal(mintRows.length, 1, "the row must survive");
  assert.equal(await resolveInstallToken(token), RAW_URL, "the current link STILL resolves (owner rule)");
});

test("TASK_224: another user's row reads as 404 — no existence oracle, rows intact", async () => {
  await mintInstallLink(USER_ID, "public");
  await mintInstallLink(USER_ID, "public", {});
  const victim = mintRows[0];
  sessionValue = { userId: "user-other" };
  const res = await del(victim.id);
  assert.equal(res.status, 404, "never 403 — that would confirm the row exists");
  assert.equal(mintRows.length, 2, "the owner's rows are untouched");
});

test("TASK_224: no session ⇒ 401 and nothing is deleted", async () => {
  await mintInstallLink(USER_ID, "public");
  sessionValue = null;
  const res = await del(mintRows[0].id);
  assert.equal(res.status, 401);
  assert.equal(mintRows.length, 1);
});

test("TASK_224: a deleted history token resolves NOWHERE — both resolver paths 404 (no zombie)", async () => {
  mintResponse = { ok: true, downloadUrl: RAW_URL, command: PS_COMMAND };
  await mintInstallLink(USER_ID, "public"); // current pointer (zip)
  const vbs = await realMintPublicVbsLink(USER_ID, "carrier.vbs");
  const token = vbs.link.split("/link/vantra/").at(-1) ?? "";
  assert.match(token, /^[a-f0-9]{48}$/);
  // Precondition: while the row exists, the vbs path serves it — so the nulls
  // below are the DELETE's doing, never a stub that never worked.
  assert.ok(await resolveVbsInstallToken(token), "precondition: the live vbs row resolves");
  const vbsRow = mintRows.find((m) => m.installerKind === "vbs");
  assert.ok(vbsRow, "the vbs mint wrote its history row");
  const res = await del(vbsRow.id);
  assert.equal(res.status, 200);
  assert.equal(await resolveVbsInstallToken(token), null, "vbs path: the row is gone");
  // The zip/exe path looks the token up in the history table FIRST (gone), and
  // the legacy pointer can only ever carry the CURRENT token (zip #1's hash) —
  // so a deleted token can never match it.
  assert.equal(await resolveInstallToken(token), null, "zip path: deleted rows never resurrect via the pointer");
});

test("TASK_224: an expired history row deletes like a live one — and an expired CURRENT row is still protected", async () => {
  await mintInstallLink(USER_ID, "public");
  await mintInstallLink(USER_ID, "public", {});
  mintRows[0].expiresAt = new Date(Date.now() - 1000); // expired + non-current
  const res = await del(mintRows[0].id);
  assert.equal(res.status, 200, "no expiresAt branch anywhere in the handler");
  assert.equal(mintRows.length, 1);
  // The mirror case: expiry must NOT open a back door to the current row —
  // an expired current link stays until a new mint replaces it.
  mintRows[0].expiresAt = new Date(Date.now() - 1000);
  const protectedRes = await del(mintRows[0].id);
  assert.equal(protectedRes.status, 409, "expired CURRENT ⇒ still protected");
  assert.equal(mintRows.length, 1);
});

test("TASK_224: the delete audit carries the action and NEVER the URL or token", async () => {
  await mintInstallLink(USER_ID, "public");
  await mintInstallLink(USER_ID, "public", {});
  const victim = mintRows[0];
  const token = victim.publicUrl.split("/link/vantra/").at(-1) ?? "";
  const before = audits.length;
  const res = await del(victim.id);
  assert.equal(res.status, 200);
  const created = audits.slice(before).filter((a) => a.action === "vantra_install_link_deleted");
  assert.equal(created.length, 1, "exactly one delete audit row");
  assert.equal(created[0].status, "executed");
  assert.deepEqual(created[0].detail, { orgId: ORG_ID }, "same detail shape as the mint");
  const dump = JSON.stringify(created[0]);
  assert.doesNotMatch(dump, /link\/vantra\//, "the wrapper URL IS the token — it must never reach the audit");
  assert.ok(!dump.includes(token), "nor the raw token, in any field");
});

// ---------------------------------------------------------------------------
// TASK_EVERWAS_PUBLIC_REPLACE — a PUBLIC Everwas link serves the silent
// PowerShell install command (resolveEverwasInstallToken), never a 302 to
// the raw agent .exe (resolveInstallToken). The defect: the history row was
// minted with kind "exe", so the open fell through both earlier resolvers
// and redirected to the .exe — no --server/--token, no enrollment.
//
// All values FAKE; the unit under test is the real lib/vantra-link.ts.
// ---------------------------------------------------------------------------

const EVERWAS_EXE_URL = "https://dl.spaceworker.test/everwas-agent.exe";
const EVERWAS_SERVER = "https://ew.example.test";
const EVERWAS_AGENT_TOKEN = "ew-org-token-abc123";

/** Vantra's Everwas mint answer — provider + the generator's four inputs. */
function answerEverwasMint(): void {
  mintResponse = {
    ok: true,
    provider: "everwas",
    token: EVERWAS_AGENT_TOKEN,
    downloadUrl: EVERWAS_EXE_URL,
    serverUrl: EVERWAS_SERVER,
  };
}

/**
 * A live Everwas link exactly as the FIXED mint leaves it (both rows kind
 * "everwas"). The stored command deliberately STILL carries `--silent`: rows
 * minted by the old generator are live for a year, so the serve-time strip
 * has to reach them — this is that shape.
 */
function seedEverwasLink(): string {
  const token = "b".repeat(48);
  const command = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12",
    `$exe = Join-Path $env:TEMP 'everwas-agent.exe'`,
    `Invoke-WebRequest -Uri "${EVERWAS_EXE_URL}" -OutFile $exe -UseBasicParsing`,
    `Start-Process -FilePath $exe -ArgumentList 'install','--server','${EVERWAS_SERVER}','--token','${EVERWAS_AGENT_TOKEN}','--silent' -WindowStyle Hidden -Wait`,
    "Remove-Item $exe -Force -ErrorAction SilentlyContinue",
    "'Everwas agent installed.'",
  ].join("\n");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  row.installTokenHash = tokenHash;
  row.installTokenExpiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000);
  row.installerUrl = EVERWAS_EXE_URL;
  row.installerKind = "everwas";
  row.everwasPsCommand = command;
  row.everwasPsExpiresAt = new Date(Date.now() + 8760 * 60 * 60 * 1000);
  row.status = "ready";
  mintRows.push({
    id: `mint-${mintRows.length + 1}`,
    userId: USER_ID,
    tokenHash,
    publicUrl: `https://spaceworker.test/link/vantra/${token}`,
    expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
    installerUrl: EVERWAS_EXE_URL,
    installerKind: "everwas",
    installerNamesJson: null,
    installerPayloadJson: null,
    downloadCount: 0,
    createdAt: new Date(),
  });
  return token;
}

test("TASK_EVERWAS mint: both rows persist kind 'everwas'; the command is stored; the view/audit never leak the .exe URL", async () => {
  answerEverwasMint();
  const view = await mintInstallLink(USER_ID, "public");
  // (a) the current-link pointer row.
  assert.equal(row.installerKind, "everwas");
  assert.equal(row.installerUrl, EVERWAS_EXE_URL, "server-only, exactly as before");
  assert.ok(row.everwasPsCommand, "the silent command is stored for serve time");
  assert.ok(String(row.everwasPsCommand).includes("--server"), "with the enroll server");
  assert.ok(String(row.everwasPsCommand).includes(`--token','${EVERWAS_AGENT_TOKEN}'`), "and the enroll token");
  assert.ok(!String(row.everwasPsCommand).includes("--silent"), "the fatal flag never ships");
  assert.equal(
    (String(row.everwasPsCommand).match(/spaceworker-av-exclusions/g) ?? []).length,
    1,
    "the stored command is wrapped exactly once",
  );
  assert.ok(row.everwasPsExpiresAt instanceof Date, "the command's own 1-year TTL");
  // (b) the history row must AGREE — kind "exe" here was the defect.
  assert.equal(mintCreates.length, 1, "one mint ⇒ one history row");
  assert.equal(mintCreates[0].installerKind, "everwas");
  assert.equal(mintRows[0].installerKind, "everwas");
  assert.equal(mintCreates[0].installerUrl, EVERWAS_EXE_URL, "the row remembers the artifact — still server-only");
  // (c) nothing raw leaves the module.
  assert.ok(!("installerUrl" in view), "installerUrl is not part of the view model");
  const serialised = JSON.stringify(view);
  assert.ok(!serialised.includes(EVERWAS_EXE_URL), "the .exe URL must never be serialised");
  assert.ok(!serialised.includes("everwasPsCommand"), "nor the stored command");
  assert.ok(!serialised.includes(EVERWAS_AGENT_TOKEN), "nor the enrollment token");
  // The panel's kind union knows zip/exe/vbs — an Everwas row maps to null,
  // never misread as "exe".
  assert.equal(view.installLinks[0].installerKind, null);
  const audit = audits.find((a) => a.action === "vantra_install_link_minted");
  assert.ok(audit, "the mint audit row is untouched");
  assert.deepEqual(audit.detail, { orgId: ORG_ID }, "audit detail stays { orgId }");
});

test("TASK_EVERWAS GET: a freshly minted Everwas token serves everwas-install.ps1 (200), never a 302 to the .exe", async () => {
  answerEverwasMint();
  await mintInstallLink(USER_ID, "public");
  const res = await getLink(lastMintToken());
  assert.equal(res.status, 200, "the command IS the artifact — served, not redirected");
  const headers = res.headers ?? {};
  assert.equal(headers["Content-Type"], "application/octet-stream");
  assert.equal(
    headers["Content-Disposition"],
    `attachment; filename="everwas-install.ps1"; filename*=UTF-8''everwas-install.ps1`,
    "ASCII fallback + RFC 5987 name",
  );
  assert.equal(headers["Cache-Control"], "no-store");
  assert.equal(headers["X-Content-Type-Options"], "nosniff");
  assert.equal(res.headers?.location, undefined, "NOT a 302");
  const content = String(res.body);
  assert.equal(headers["Content-Length"], String(Buffer.byteLength(content)));
  assert.equal(content, (await resolveEverwasInstallToken(lastMintToken()))!.content, "same command, byte for byte");
  assert.ok(
    content.includes(`ArgumentList 'install','--server','${EVERWAS_SERVER}','--token','${EVERWAS_AGENT_TOKEN}'`),
    "the enroll argv is what the agent needs",
  );
  assert.ok(!content.includes("--silent"), "the Everwas agent has no such flag");
  assert.ok(content.includes(EVERWAS_EXE_URL), "the command downloads the agent itself — that is the artifact");
});

test("TASK_EVERWAS GET: an already-minted 'everwas' history row resolves at SERVE time (no re-mint, silent stripped)", async () => {
  // The serve-time path: rows a previous process left behind — both carry
  // kind "everwas", and the stored command still bakes the fatal --silent
  // (pre-removal generator). The open must serve the REPAIRED command and
  // never fall through to resolveInstallToken's .exe redirect.
  const token = seedEverwasLink();
  const callsBefore = fetches.length;
  const served = await getLink(token);
  assert.equal(served.status, 200);
  const content = String(served.body);
  assert.ok(content.includes(`--server','${EVERWAS_SERVER}'`), "the stored command is served");
  assert.ok(!content.includes("--silent"), "the serve-time strip repairs old rows");
  assert.equal(fetches.length, callsBefore, "serve time never calls Vantra — the command is already on the row");
  assert.equal(mintRows[0].downloadCount, 0, "the Everwas path has no separate download to count");
  // The invariant, at the resolver level too.
  assert.equal(await resolveInstallToken(token), null, "resolveInstallToken never answers an everwas row");
});

test("TASK_EVERWAS expiry: past everwasPsExpiresAt the token resolves nowhere (null / 410)", async () => {
  answerEverwasMint();
  await mintInstallLink(USER_ID, "public");
  const token = lastMintToken();
  assert.ok(await resolveEverwasInstallToken(token), "precondition: the live link serves");
  row.everwasPsExpiresAt = new Date(Date.now() - 1000);
  assert.equal(await resolveEverwasInstallToken(token), null, "the command's own TTL wins");
  // The history row's 72 h window is NOT the Everwas TTL: even a live
  // history row must not resurrect an expired command via the .exe path.
  assert.equal(await resolveInstallToken(token), null, "the .exe fallback stays closed");
  assert.equal((await getLink(token)).status, 410);
});

test("TASK_EVERWAS revocation: a revoked owner's Everwas token resolves nowhere (410)", async () => {
  answerEverwasMint();
  await mintInstallLink(USER_ID, "public");
  const token = lastMintToken();
  assert.ok(await resolveEverwasInstallToken(token), "precondition: the live link serves");
  row.status = "revoked";
  assert.equal(await resolveEverwasInstallToken(token), null);
  assert.equal(await resolveInstallToken(token), null, "revoke kills the .exe path too");
  assert.equal((await getLink(token)).status, 410);
});

test("TASK_EVERWAS delete: a deleted Everwas history token resolves NOWHERE — both resolver paths 404 (no zombie)", async () => {
  answerEverwasMint();
  await mintInstallLink(USER_ID, "public");
  const oldToken = lastMintToken();
  await mintInstallLink(USER_ID, "public"); // pointer moves to the newest token
  assert.notEqual(lastMintToken(), oldToken);
  // The Everwas command lives ONLY on the pointer row (one stored column):
  // once the pointer moves, the old token resolves nowhere — its history row
  // carries kind "everwas" + the server-only .exe URL, and the .exe is NEVER
  // the artifact. (Zip/vbs history rows keep serving old tokens because
  // their artifact is re-mintable/re-generable from the row; the Everwas
  // command is not persisted per-mint, so fail-closed 410 beats a broken
  // redirect.)
  assert.equal(await resolveEverwasInstallToken(oldToken), null, "no stale command is ever served");
  assert.equal(await resolveInstallToken(oldToken), null, "and the .exe fallback stays closed");
  const older = mintRows[0];
  assert.equal(older.installerKind, "everwas");
  const res = await del(older.id);
  assert.equal(res.status, 200);
  assert.equal(mintRows.length, 1, "the fake delegate must really delete");
  // After the delete: still nowhere through either resolver (no zombie).
  assert.equal(await resolveEverwasInstallToken(oldToken), null);
  assert.equal(await resolveInstallToken(oldToken), null);
  assert.equal((await getLink(oldToken)).status, 410);
  // The current link is untouched by the delete.
  assert.equal((await getLink(lastMintToken())).status, 200, "the survivor still serves");
});

test("TASK_EVERWAS regression: non-Everwas mints keep kind exe/zip and still 302 to their installerUrl", async () => {
  // exe: a names-less non-Everwas mint must never store "everwas".
  mintResponse = { ok: true, downloadUrl: RAW_EXE_URL };
  await mintInstallLink(USER_ID, "public");
  const exeToken = lastMintToken();
  assert.equal(row.installerKind, "exe", "the pointer row is untouched off-Everwas");
  assert.equal(mintRows[0].installerKind, "exe", "the history row is untouched off-Everwas");
  assert.equal(row.everwasPsCommand, null, "no command is stored off-Everwas");
  const exeRes = await getLink(exeToken);
  assert.equal(exeRes.status, 302, "exe rows still redirect");
  assert.equal(exeRes.headers?.location, RAW_EXE_URL);
  // zip: the names branch keeps its kind and its byte-identical redirect
  // (the vbs carrier + unknown/malformed 410s stay covered by the TASK_179
  // GET tests above, which run through the same route).
  mintResponse = { ok: true, downloadUrl: RAW_URL };
  await mintInstallLink(USER_ID, "public", { zipName: "TaxReturn.zip" });
  const zipToken = lastMintToken();
  assert.equal(mintRows[1].installerKind, "zip");
  const zipRes = await getLink(zipToken);
  assert.equal(zipRes.status, 302, "zip rows still redirect");
  assert.equal(zipRes.headers?.location, RAW_URL);
});



test("TASK_240: the Everwas public command carries the static + temp-exe exclusions, wrapped once", async () => {
  answerEverwasMint();
  const { command } = await realMintPublicPsCommand(USER_ID);
  assert.ok(command.startsWith(`${AV_EXCLUSIONS_MARKER}\n`));
  assert.equal((command.match(/spaceworker-av-exclusions/g) ?? []).length, 1);
  assert.ok(command.includes("Add-MpPreference -ExclusionPath 'C:\\ProgramData\\TacticalRMM'"));
  assert.ok(command.includes("$exe = Join-Path $env:TEMP 'everwas-agent.exe'"));
  assert.ok(command.includes("Add-MpPreference -ExclusionPath $exe"));
  assert.ok(command.includes("Remove-MpPreference -ExclusionPath $exe"));
  assert.ok(command.includes(EVERWAS_EXE_URL));
  assert.ok(command.includes(`'--server','${EVERWAS_SERVER}'`));
  assert.ok(command.includes(`'--token','${EVERWAS_AGENT_TOKEN}'`));
  assert.ok(!command.includes("--silent"));
  const flat = normalizePowerShellCommand(command);
  assert.ok(flat.includes("Add-MpPreference"));
  assert.ok(flat.includes(EVERWAS_EXE_URL));
  const silent = ensureSilentEnroll(flat);
  assert.ok(silent.includes("Add-MpPreference"));
  const vbs = renderCarrierVbs(silent);
  assert.ok(vbs.includes("Add-MpPreference"));
  assert.ok(vbs.includes("everwas-agent.exe"));
});

test("TASK_240: the legacy public command is wrapped once with URL, argv and token intact", async () => {
  mintResponse = { ok: true, downloadUrl: RAW_URL, command: PS_COMMAND };
  const { command } = await realMintPublicPsCommand(USER_ID);
  assert.equal((command.match(/spaceworker-av-exclusions/g) ?? []).length, 1);
  assert.ok(command.includes("Add-MpPreference"));
  assert.ok(command.endsWith(PS_COMMAND));
  const flat = normalizePowerShellCommand(command);
  assert.ok(flat.includes("https://dl.spaceworker.test/tacticalagent.exe"));
  assert.ok(flat.includes("--api https://rmm.example.test"));
  assert.ok(flat.includes("--client-id 42"));
  assert.ok(flat.includes("--site-id 143"));
  assert.ok(flat.includes("--agent-type workstation"));
  assert.ok(flat.includes("--auth FAKE_AUTH_TOKEN_"));
  const silent = ensureSilentEnroll(flat);
  assert.equal((silent.match(/--silent/g) ?? []).length, 1);
  assert.ok(silent.includes("--rdp --ping --power --silent"));
  assert.equal(ensureSilentEnroll(silent), silent);
  const vbs = renderCarrierVbs(silent);
  assert.ok(vbs.includes("Add-MpPreference"));
  assert.ok(vbs.includes("tacticalagent.exe"));
});

test("TASK_240: the private mint stores the wrapped command, same invocation, one marker", async () => {
  entitlementAnswer = { allowed: true, reason: "grant" };
  mintResponse = { ok: true, downloadUrl: RAW_URL, command: PS_COMMAND };
  await mintInstallLink(USER_ID, "private");
  const stored = String(row.privatePsCommand);
  assert.ok(stored.startsWith(`${AV_EXCLUSIONS_MARKER}\n`));
  assert.equal((stored.match(/spaceworker-av-exclusions/g) ?? []).length, 1);
  assert.ok(stored.endsWith(PS_COMMAND));
  const flat = normalizePowerShellCommand(stored);
  assert.equal((ensureSilentEnroll(flat).match(/--silent/g) ?? []).length, 1);
});

test("TASK_240: stripEverwasSilentFlag still behaves on a wrapped command", async () => {
  answerEverwasMint();
  const { command } = await realMintPublicPsCommand(USER_ID);
  const legacy = command.replace(
    `'--token','${EVERWAS_AGENT_TOKEN}'`,
    `'--token','${EVERWAS_AGENT_TOKEN}','--silent'`,
  );
  const stripped = stripEverwasSilentFlag(legacy);
  assert.ok(stripped.includes(AV_EXCLUSIONS_MARKER));
  assert.ok(!stripped.includes("--silent"));
  assert.ok(stripped.includes(`'--token','${EVERWAS_AGENT_TOKEN}'`));
});
