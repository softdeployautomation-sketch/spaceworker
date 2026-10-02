import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// TASK_155 P1 — the hosting FILES engine (PLAN §7/§9/§11/§14).
//
// WHY THIS FILE EXISTS: the P1 acceptance list ("hash unchanged by rename", "a
// quota breach returns a clear message not a 500", "oversize for the selected
// engine is caught BEFORE the upload", "rename never touches the bytes", "an
// unknown/expired/private token 404s cleanly") is otherwise only provable by
// uploading to the real VPS. Every case below drives the REAL modules —
// `lib/hosting/rules.ts` (pure) and `lib/hosting/files.ts` (stateful) — not a
// copy of their logic. files.ts's own deps (../prisma, ../admin-settings,
// ../premium) are swapped for recording fakes through the house require hook
// (HOW_WE_MOVE_FAST §4), so no Postgres is needed and no state leaks.
//
// The `local` provider is exercised for REAL against a throwaway temp dir
// (HOSTING_STORAGE_DIR), which is what makes "the bytes on disk are byte-identical
// after a rename" a genuine end-to-end assertion rather than a mock echo.
//
// What this file canNOT prove (said plainly, per the task contract): that the
// migration applies cleanly to the live DB, that Cloudflare/external providers
// work (not implemented in P1), and that the public /hf route is reachable over
// real HTTP on the VPS. Those are owner-run live checks.

(process.env as Record<string, string>).NODE_ENV = "test";
process.env.APP_BASE_URL = "https://spaceworker.test";
const STORAGE_DIR = path.join(os.tmpdir(), `sw-t155-host-${process.pid}-${randomUUID()}`);
process.env.HOSTING_STORAGE_DIR = STORAGE_DIR;

after(async () => {
  await fs.rm(STORAGE_DIR, { recursive: true, force: true });
});

/* eslint-disable @typescript-eslint/no-require-imports */
const rules = require("../lib/hosting/rules") as typeof import("../lib/hosting/rules");
/* eslint-enable @typescript-eslint/no-require-imports */

// A type-only import is erased before the require-hook loader runs, so the
// `rules` value above stays a plain require while the type comes from TS.
import type { HostingCapSource } from "../lib/hosting/rules";

const {
  resolveHostingCaps,
  checkUpload,
  scanUpload,
  extensionOf,
  sanitizeDispositionFilename,
  isValidSlug,
  sha256Hex,
  monthPeriod,
  newHostingToken,
  isHostingProviderId,
  CLOUDFLARE_HARD_ASSET_MB,
  MB,
  GB,
} = rules;

// ---------------------------------------------------------------------------
// Pure rules — no DB, no fs.
// ---------------------------------------------------------------------------

function baseCapsSrc(overrides: Partial<HostingCapSource> = {}): HostingCapSource {
  return {
    hostingEnabled: true,
    hostingProvider: "local",
    hostingFreeStorageQuotaMb: 1024,
    hostingFreeMaxFileSizeMb: 512,
    hostingFreeMaxFiles: 500,
    hostingFreeMaxBandwidthGbPerMonth: 50,
    hostingPremiumStorageQuotaMb: 10240,
    hostingPagesMaxAssetMb: 20,
    hostingPlatformTokenTtlHours: 24,
    hostingFreeMaxLinks: 50,
    hostingPremiumMaxLinks: 500,
    // TASK_155 P3 — the premium/site dials (defaults mirror the AdminSetting schema).
    hostingPremiumMaxProjects: 25,
    hostingPremiumMaxFilesPerProject: 2000,
    hostingPremiumMaxBandwidthGbPerMonth: 200,
    hostingPremiumDeploymentsPerDay: 50,
    hostingPreviewTtlHours: 72,
    hostingMaxZipMb: 2048,
    hostingMaxZipEntries: 20000,
    hostingMaxHeavyJobsPerUser: 1,
    hostingPublishedRevisionsKept: 3,
    ...overrides,
  };
}

test("resolveHostingCaps: premium swaps the storage quota AND the link count (PLAN §17.2), engine from admin", () => {
  const src = baseCapsSrc({ hostingProvider: "cloudflare" });
  const free = resolveHostingCaps(src, { premium: false });
  const premium = resolveHostingCaps(src, { premium: true });
  assert.equal(free.storageQuotaMb, 1024);
  assert.equal(premium.storageQuotaMb, 10240);
  // TASK_155 P4 — links get premium the same way files do.
  assert.equal(free.maxLinks, 50);
  assert.equal(premium.maxLinks, 500);
  assert.equal(free.provider, "cloudflare");
  // Abuse dials must NOT differ between tiers.
  assert.equal(free.maxFileSizeMb, premium.maxFileSizeMb);
  assert.equal(free.maxFiles, premium.maxFiles);
  assert.equal(free.maxBandwidthGbPerMonth, premium.maxBandwidthGbPerMonth);
});

test("resolveHostingCaps: an unknown stored engine falls back to local (typo can't break uploads)", () => {
  assert.equal(resolveHostingCaps(baseCapsSrc({ hostingProvider: "nope" }), { premium: false }).provider, "local");
});

test("resolveHostingCaps: pagesMaxAssetMb can never exceed Cloudflare's hard 25 MiB ceiling", () => {
  const capped = resolveHostingCaps(baseCapsSrc({ hostingPagesMaxAssetMb: 999 }), { premium: false });
  assert.ok(capped.pagesMaxAssetMb <= CLOUDFLARE_HARD_ASSET_MB, "pages ceiling must stay at/below the witnessed 25 MiB 500");
  assert.equal(capped.pagesMaxAssetMb, CLOUDFLARE_HARD_ASSET_MB);
  // A lower admin value is respected as-is.
  assert.equal(resolveHostingCaps(baseCapsSrc({ hostingPagesMaxAssetMb: 20 }), { premium: false }).pagesMaxAssetMb, 20);
});

test("resolveHostingCaps: every §14 cap is admin-driven — no cap is a hard-coded literal", () => {
  // Each dial below is a named AdminSetting field; changing the stored value MUST
  // change the resolved cap (that is the §14 contract: editable in admin, changes
  // server behaviour without a redeploy). Assert the source value flows through.
  const src = baseCapsSrc({
    hostingFreeStorageQuotaMb: 7,
    hostingFreeMaxFileSizeMb: 8,
    hostingFreeMaxFiles: 9,
    hostingFreeMaxBandwidthGbPerMonth: 10,
    hostingPremiumStorageQuotaMb: 11,
    hostingPagesMaxAssetMb: 12,
    hostingPlatformTokenTtlHours: 13,
  });
  const free = resolveHostingCaps(src, { premium: false });
  const premium = resolveHostingCaps(src, { premium: true });
  assert.equal(free.storageQuotaMb, 7);
  assert.equal(premium.storageQuotaMb, 11);
  assert.equal(free.maxFileSizeMb, 8);
  assert.equal(free.maxFiles, 9);
  assert.equal(free.maxBandwidthGbPerMonth, 10);
  assert.equal(free.pagesMaxAssetMb, 12);
  assert.equal(free.platformTokenTtlHours, 13);
  // ...and the defaults the panel ships are the ones the plan named (§14).
  const d = resolveHostingCaps(baseCapsSrc(), { premium: false });
  assert.equal(d.storageQuotaMb, 1024);
  assert.equal(d.maxFileSizeMb, 512);
  assert.equal(d.maxFiles, 500);
  assert.equal(d.maxBandwidthGbPerMonth, 50);
  assert.equal(d.pagesMaxAssetMb, 20);
  assert.equal(d.platformTokenTtlHours, 24);
});

test("checkUpload: disabled engine refuses with a typed verdict, never a throw", () => {
  const caps = resolveHostingCaps(baseCapsSrc({ hostingEnabled: false }), { premium: false });
  const verdict = checkUpload(caps, { usedBytes: 0, fileCount: 0, usedBandwidthBytes: 0 }, { bytes: 10 });
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.equal(verdict.code, "disabled");
});

test("checkUpload: a file over the selected engine's ceiling is refused BEFORE any upload", () => {
  const caps = resolveHostingCaps(baseCapsSrc(), { premium: false });
  const verdict = checkUpload(
    caps,
    { usedBytes: 0, fileCount: 0, usedBandwidthBytes: 0 },
    { bytes: 26 * MB },
    CLOUDFLARE_HARD_ASSET_MB // the Cloudflare Pages per-asset ceiling
  );
  assert.equal(verdict.ok, false);
  if (!verdict.ok) {
    assert.equal(verdict.code, "too_large_for_provider");
    assert.match(verdict.message, /25 MB/);
  }
});

test("checkUpload: size, count, storage and bandwidth caps each return their own clear message", () => {
  const sizeCaps = resolveHostingCaps(baseCapsSrc({ hostingFreeMaxFileSizeMb: 1 }), { premium: false });
  const sizeVerdict = checkUpload(sizeCaps, { usedBytes: 0, fileCount: 0, usedBandwidthBytes: 0 }, { bytes: 2 * MB });
  assert.ok(!sizeVerdict.ok && sizeVerdict.code === "quota_file_size");

  const countCaps = resolveHostingCaps(baseCapsSrc({ hostingFreeMaxFiles: 2 }), { premium: false });
  const countVerdict = checkUpload(countCaps, { usedBytes: 0, fileCount: 2, usedBandwidthBytes: 0 }, { bytes: 100 });
  assert.ok(!countVerdict.ok && countVerdict.code === "quota_files");

  const storageCaps = resolveHostingCaps(baseCapsSrc({ hostingFreeStorageQuotaMb: 1024 }), { premium: false });
  const storageVerdict = checkUpload(
    storageCaps,
    { usedBytes: 1023 * MB, fileCount: 0, usedBandwidthBytes: 0 },
    { bytes: 2 * MB }
  );
  assert.ok(!storageVerdict.ok && storageVerdict.code === "quota_storage");

  const bwCaps = resolveHostingCaps(baseCapsSrc({ hostingFreeMaxBandwidthGbPerMonth: 1 }), { premium: false });
  const bwVerdict = checkUpload(bwCaps, { usedBytes: 0, fileCount: 0, usedBandwidthBytes: GB }, { bytes: 100 });
  assert.ok(!bwVerdict.ok && bwVerdict.code === "quota_bandwidth");
});

test("scanUpload: scripts and browser-active content are blocked; executables are a GATED class", () => {
  for (const name of ["shell.php", "app.js", "index.html", "logo.svg", "run.sh", "x.jar"]) {
    const v = scanUpload(name);
    assert.ok(!v.ok, `${name} should be blocked`);
  }
  const exe = scanUpload("SpaceWorker Setup.exe");
  assert.ok(exe.ok && exe.gated === true && exe.extension === "exe");
  const zip = scanUpload("leads.zip");
  assert.ok(zip.ok && zip.gated === false);
  // No extension at all is allowed (and not gated).
  assert.ok(scanUpload("README").ok === true);
});

test("extensionOf / sanitizeDispositionFilename: header-safe names, no path or control chars", () => {
  assert.equal(extensionOf("a/b/c.TAR.GZ"), "gz");
  assert.equal(extensionOf("noext"), "");
  const dirty = '../../evil"\r\nname.exe';
  const clean = sanitizeDispositionFilename(dirty);
  assert.ok(!clean.includes("/") && !clean.includes("\\") && !clean.includes('"'));
  assert.ok(!/[\u0000-\u001f\u007f]/.test(clean));
  // A name that sanitizes down to nothing usable becomes a safe default.
  assert.equal(sanitizeDispositionFilename(".."), "download");
});

test("isValidSlug / sha256Hex / monthPeriod / token: contract of the public link layer", () => {
  assert.ok(isValidSlug("my-app"));
  assert.ok(!isValidSlug("My App"));
  assert.ok(!isValidSlug("-bad"));
  assert.equal(sha256Hex(Buffer.from("abc")), createHash("sha256").update("abc").digest("hex"));
  assert.equal(monthPeriod(new Date(Date.UTC(2026, 9, 1))), "2026-10");
  const t = newHostingToken();
  assert.match(t, /^[A-Za-z0-9_-]{24}$/);
  assert.notEqual(t, newHostingToken());
  assert.ok(isHostingProviderId("cloudflare") && !isHostingProviderId("s3"));
});


// ---------------------------------------------------------------------------
// Stateful engine — files.ts driven through the house require hook. Its own
// deps (../prisma, ../admin-settings, ../premium) are swapped for fakes; the
// `local` provider underneath is REAL (bytes land in HOSTING_STORAGE_DIR).
// ---------------------------------------------------------------------------

const USER = "user-t155";

interface AssetRow {
  id: string;
  userId: string;
  kind: string;
  name: string;
  token: string;
  slug: string | null;
  provider: string;
  storagePath: string | null;
  externalId: string | null;
  sha256: string;
  bytes: number;
  mime: string;
  dispositionFilename: string;
  visibility: string;
  status: string;
  expiresAt: Date | null;
  url: string | null;
  downloadCount: number;
  bytesServed: bigint;
  uploadIp: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  [k: string]: unknown;
}

let assets: AssetRow[];
let usage: Map<string, bigint>;
let seq: number;
let adminRow: Record<string, unknown>;
let userRow: { tier: number; premiumExpiresAt: Date | null };

function matches(row: Record<string, unknown>, where: Record<string, unknown> | undefined): boolean {
  if (!where) return true;
  for (const [key, expected] of Object.entries(where)) {
    if (expected === undefined) continue;
    if (expected && typeof expected === "object" && !Array.isArray(expected)) continue;
    if (row[key] !== expected) return false;
  }
  return true;
}

function uniqueError(): Error & { code: string } {
  const e = new Error("unique constraint") as Error & { code: string };
  e.code = "P2002";
  return e;
}

const fakePrisma = {
  user: { findUnique: async () => ({ ...userRow }) },
  hostedAsset: {
    aggregate: async ({ where }: { where?: Record<string, unknown> }) => {
      const rows = assets.filter((r) => matches(r, where));
      return {
        _sum: {
          bytes: rows.reduce((n, r) => n + r.bytes, 0),
          bytesServed: rows.reduce((n, r) => n + r.bytesServed, BigInt(0)),
        },
      };
    },
    count: async ({ where }: { where?: Record<string, unknown> }) => assets.filter((r) => matches(r, where)).length,
    findMany: async ({ where }: { where?: Record<string, unknown> }) => assets.filter((r) => matches(r, where)),
    findFirst: async ({ where }: { where?: Record<string, unknown> }) => assets.find((r) => matches(r, where)) ?? null,
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = assets.find((r) => r.id === where.id);
      if (!row) throw new Error("row not found");
      for (const [key, value] of Object.entries(data)) {
        // Prisma-style atomic increment (used by recordServe's downloadCount /
        // bytesServed) — the fake applies it rather than storing the operator.
        if (value && typeof value === "object" && "increment" in (value as Record<string, unknown>)) {
          const inc = (value as { increment: number | bigint }).increment;
          const current = row[key];
          row[key] = typeof current === "bigint" ? current + BigInt(inc as number) : (current as number) + (inc as number);
          continue;
        }
        row[key] = value;
      }
      row.updatedAt = new Date();
      return row;
    },
    create: async ({ data }: { data: Record<string, unknown> }) => {
      if (assets.some((r) => r.token === data.token)) throw uniqueError();
      seq += 1;
      const row = {
        id: `asset-${seq}`,
        slug: null,
        visibility: "public",
        status: "active",
        expiresAt: null,
        downloadCount: 0,
        bytesServed: BigInt(0),
        deletedAt: null,
        externalId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...(data as object),
      } as AssetRow;
      assets.push(row);
      return row;
    },
  },
  hostingUsageMonthly: {
    findUnique: async ({ where }: { where: { userId_period: { userId: string; period: string } } }) => {
      const bytes = usage.get(`${where.userId_period.userId}:${where.userId_period.period}`);
      return bytes === undefined ? null : { bytesServed: bytes };
    },
    upsert: async ({
      where,
      create,
      update,
    }: {
      where: { userId_period: { userId: string; period: string } };
      create: { bytesServed?: number | bigint };
      update: { bytesServed?: { increment: number | bigint } };
    }) => {
      const key = `${where.userId_period.userId}:${where.userId_period.period}`;
      const existing = usage.get(key);
      if (existing !== undefined) {
        const next = existing + BigInt((update?.bytesServed?.increment ?? 0) as number);
        usage.set(key, next);
        return { bytesServed: next };
      }
      const start = BigInt((create.bytesServed as number) ?? 0);
      usage.set(key, start);
      return { bytesServed: start };
    },
  },
  $transaction: async (ops: unknown[]) => Promise.all(ops as Promise<unknown>[]),
};


const MODULE_UNDER_TEST = "lib/hosting/files.ts";

function installRequireHook(): void {
  const loader = Module as unknown as { _load: (r: string, p: NodeModule | undefined, m: boolean) => unknown };
  const original = loader._load;
  loader._load = function patched(request, parent, isMain) {
    if (request === "server-only") return {};
    const from = parent?.filename ?? "";
    if (from.endsWith(`/${MODULE_UNDER_TEST}`)) {
      if (request === "../prisma") return { prisma: fakePrisma };
      if (request === "../admin-settings") return { getAdminSettings: async () => ({ ...adminRow }) };
      if (request === "../premium") {
        return {
          isPremiumWithReversion: (u: { tier: number; premiumExpiresAt: Date | null }) =>
            u.tier >= 5 && (u.premiumExpiresAt === null || u.premiumExpiresAt.getTime() > Date.now()),
        };
      }
    }
    return original.call(this, request, parent, isMain);
  };
}

installRequireHook();

/* eslint-disable @typescript-eslint/no-require-imports */
const files = require("../lib/hosting/files") as typeof import("../lib/hosting/files");
/* eslint-enable @typescript-eslint/no-require-imports */

const { createHostedFile, renameHostedFile, deleteHostedFile, resolveServe, listHostedFiles, readUsage } = files;

function streamOf(buf: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(buf));
      controller.close();
    },
  });
}

const BODY = Buffer.from("TASK-155 hosting bytes — rename must not change me");
const SHA = createHash("sha256").update(BODY).digest("hex");

beforeEach(async () => {
  assets = [];
  usage = new Map();
  seq = 0;
  userRow = { tier: 1, premiumExpiresAt: null };
  adminRow = {
    hostingEnabled: true,
    hostingProvider: "local",
    hostingFreeStorageQuotaMb: 1024,
    hostingFreeMaxFileSizeMb: 512,
    hostingFreeMaxFiles: 500,
    hostingFreeMaxBandwidthGbPerMonth: 50,
    hostingPremiumStorageQuotaMb: 10240,
    hostingPagesMaxAssetMb: 20,
    hostingPlatformTokenTtlHours: 24,
    hostingModulePriceUsd: 9,
  };
  await fs.rm(STORAGE_DIR, { recursive: true, force: true });
});

async function upload(name: string, buf = BODY, acknowledgeGated = true) {
  return createHostedFile({
    userId: USER,
    ip: "203.0.113.7",
    filename: name,
    mime: "application/zip",
    declaredBytes: buf.length,
    body: streamOf(buf),
    acknowledgeGated,
  });
}


// ---------------------------------------------------------------------------
// createHostedFile
// ---------------------------------------------------------------------------

test("createHostedFile: a real upload stores bytes, records sha256 + size, and hands back a URL", async () => {
  const res = await upload("leads.zip");
  assert.ok(res.ok, JSON.stringify(res));
  if (!res.ok) return;
  assert.equal(res.value.sha256, SHA);
  assert.equal(res.value.bytes, BODY.length);
  assert.equal(res.value.dispositionFilename, "leads.zip");
  assert.equal(res.value.provider, "local");
  assert.match(res.value.url ?? "", /\/hf\/[A-Za-z0-9_-]{24}$/);
  // The bytes really landed on disk, under the token as the key.
  const onDisk = await fs.readFile(path.join(STORAGE_DIR, USER, res.value.token));
  assert.equal(createHash("sha256").update(onDisk).digest("hex"), SHA);
});

test("createHostedFile: hosting disabled platform-wide refuses BEFORE writing anything", async () => {
  adminRow.hostingEnabled = false;
  const res = await upload("leads.zip");
  assert.ok(!res.ok && res.code === "disabled" && res.status === 403);
  assert.equal(assets.length, 0);
  await assert.rejects(() => fs.stat(path.join(STORAGE_DIR, USER)));
});

test("createHostedFile: a quota breach is a typed 400 with a human message — not a 500", async () => {
  adminRow.hostingFreeMaxFileSizeMb = 1; // 1 MB cap, upload 2 MB
  const big = Buffer.alloc(2 * MB, 1);
  const res = await upload("big.zip", big);
  assert.ok(!res.ok);
  if (!res.ok) {
    assert.equal(res.status, 400);
    assert.equal(res.code, "quota_file_size");
    assert.match(res.message, /1 MB/);
  }
});

test("createHostedFile: a blocked extension is refused with the reason, no bytes written", async () => {
  const res = await upload("webshell.php");
  assert.ok(!res.ok && res.code === "blocked_extension" && res.status === 400);
  assert.equal(assets.length, 0);
});

test("createHostedFile: an executable is refused until it is explicitly acknowledged (gated class)", async () => {
  const refused = await upload("Setup.exe", BODY, false);
  assert.ok(!refused.ok && refused.code === "gated_ack_required");
  const accepted = await upload("Setup.exe", BODY, true);
  assert.ok(accepted.ok, JSON.stringify(accepted));
  if (accepted.ok) assert.equal(accepted.value.dispositionFilename, "Setup.exe");
});

test("createHostedFile: real stored size is re-checked — a lying declared size cannot slip through", async () => {
  adminRow.hostingFreeMaxFileSizeMb = 1;
  const big = Buffer.alloc(2 * MB, 7);
  // Declare 1 byte (under the cap) but stream the real 2 MB.
  const res = await createHostedFile({
    userId: USER,
    ip: null,
    filename: "sneaky.zip",
    mime: "application/zip",
    declaredBytes: 1,
    body: streamOf(big),
    acknowledgeGated: true,
  });
  assert.ok(!res.ok, "the real-size re-check must reject this");
  if (!res.ok) assert.equal(res.status, 413);
  assert.equal(assets.length, 0);
});

// ---------------------------------------------------------------------------
// rename / delete
// ---------------------------------------------------------------------------

test("renameHostedFile: the served filename changes and the BYTES/hash do not (the P1 anchor)", async () => {
  const created = await upload("original-name.zip");
  assert.ok(created.ok);
  if (!created.ok) return;
  const { id, token, sha256, bytes } = created.value;

  const renamed = await renameHostedFile({ userId: USER, id, displayName: "invoice-2026-10.zip" });
  assert.ok(renamed.ok, JSON.stringify(renamed));
  if (!renamed.ok) return;
  assert.equal(renamed.value.dispositionFilename, "invoice-2026-10.zip");
  assert.equal(renamed.value.sha256, sha256, "hash must be untouched by a rename");
  assert.equal(renamed.value.bytes, bytes, "byte count must be untouched by a rename");
  assert.equal(renamed.value.token, token, "the public lookup key must not change on rename");

  // The bytes on disk are byte-identical, still under the SAME token key.
  const onDisk = await fs.readFile(path.join(STORAGE_DIR, USER, token));
  assert.equal(createHash("sha256").update(onDisk).digest("hex"), sha256);
});

test("renameHostedFile: a friendly slug is validated; a bad one is a 400, not a crash", async () => {
  const created = await upload("f.zip");
  assert.ok(created.ok);
  if (!created.ok) return;

  const bad = await renameHostedFile({ userId: USER, id: created.value.id, slug: "My App!" });
  assert.ok(!bad.ok && bad.status === 400 && bad.code === "invalid_slug");

  const good = await renameHostedFile({ userId: USER, id: created.value.id, slug: "my-app" });
  assert.ok(good.ok && good.value.slug === "my-app");
});

test("renameHostedFile / deleteHostedFile: another user's asset is a clean 404 (no cross-tenant access)", async () => {
  const created = await upload("mine.zip");
  assert.ok(created.ok);
  if (!created.ok) return;
  const notMine = await renameHostedFile({ userId: "someone-else", id: created.value.id, displayName: "x.zip" });
  assert.ok(!notMine.ok && notMine.status === 404);
  const del = await deleteHostedFile("someone-else", created.value.id);
  assert.ok(!del.ok && del.status === 404);
});

test("deleteHostedFile: soft-deletes the row, drops it from the list, and unlinks the bytes", async () => {
  const created = await upload("gone.zip");
  assert.ok(created.ok);
  if (!created.ok) return;
  const storedPath = path.join(STORAGE_DIR, USER, created.value.token);
  assert.ok(await fs.stat(storedPath));

  const del = await deleteHostedFile(USER, created.value.id);
  assert.ok(del.ok);
  assert.equal(assets.length, 1);
  assert.equal(assets[0].status, "deleted");
  assert.ok(assets[0].deletedAt instanceof Date);
  assert.equal((await listHostedFiles(USER)).length, 0, "a deleted asset must not appear in the list");
  await assert.rejects(() => fs.stat(storedPath), "the bytes must be unlinked on delete");
});


// ---------------------------------------------------------------------------
// resolveServe / recordServe — the public GET /hf/<token> contract
// ---------------------------------------------------------------------------

test("resolveServe: an unknown token is a clean 404 (never a stack trace)", async () => {
  const res = await resolveServe("no-such-token");
  assert.ok(!res.ok && res.status === 404 && res.code === "not_found");
});

test("resolveServe: the master switch off hides every asset (404, not 403)", async () => {
  const created = await upload("secret.zip");
  assert.ok(created.ok);
  if (!created.ok) return;
  adminRow.hostingEnabled = false;
  const res = await resolveServe(created.value.token);
  assert.ok(!res.ok && res.status === 404);
});

test("resolveServe: a public, unexpired asset resolves to a servable descriptor", async () => {
  const created = await upload("ok.zip");
  assert.ok(created.ok);
  if (!created.ok) return;
  const res = await resolveServe(created.value.token);
  assert.ok(res.ok, JSON.stringify(res));
  if (!res.ok) return;
  assert.equal(res.value.sha256, SHA);
  assert.equal(res.value.dispositionFilename, "ok.zip");
  assert.equal(res.value.provider, "local");
});

test("resolveServe: a private asset and an expired asset both 404 with the right code", async () => {
  const priv = await upload("priv.zip");
  assert.ok(priv.ok);
  if (!priv.ok) return;
  await renameHostedFile({ userId: USER, id: priv.value.id, visibility: "private" });
  const privRes = await resolveServe(priv.value.token);
  assert.ok(!privRes.ok && privRes.status === 404 && privRes.code === "not_found");

  const exp = await upload("exp.zip");
  assert.ok(exp.ok);
  if (!exp.ok) return;
  await renameHostedFile({ userId: USER, id: exp.value.id, expiresAt: new Date(Date.now() - 1000) });
  const expRes = await resolveServe(exp.value.token);
  assert.ok(!expRes.ok && expRes.status === 404 && expRes.code === "expired");
});

test("resolveServe: once the monthly bandwidth cap is spent, serving is a 429 (not an outage)", async () => {
  adminRow.hostingFreeMaxBandwidthGbPerMonth = 1;
  const created = await upload("bw.zip");
  assert.ok(created.ok);
  if (!created.ok) return;
  usage.set(`${USER}:${monthPeriod()}`, BigInt(GB));
  const res = await resolveServe(created.value.token);
  assert.ok(!res.ok && res.status === 429 && res.code === "quota_bandwidth");
});

test("recordServe: counts the download on the asset and the monthly bandwidth (best-effort)", async () => {
  const created = await upload("counted.zip");
  assert.ok(created.ok);
  if (!created.ok) return;
  const resolved = await resolveServe(created.value.token);
  assert.ok(resolved.ok);
  if (!resolved.ok) return;

  await files.recordServe(resolved.value, BODY.length);
  assert.equal(assets[0].downloadCount, 1);
  assert.equal(assets[0].bytesServed, BigInt(BODY.length));
  assert.equal(usage.get(`${USER}:${monthPeriod()}`), BigInt(BODY.length));

  const read = await readUsage(USER);
  assert.equal(read.bandwidthBytes, BODY.length);
  assert.equal(read.storageBytes, BODY.length);
  assert.equal(read.fileCount, 1);
});

