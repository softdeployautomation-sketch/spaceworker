/**
 * TASK_181 P4 (step 34) — live xdevice gate evidence harness. NOT shipped app
 * code. Run ON the VPS against the real deployed HTTP route (playbook §4 house
 * pattern, cf. scripts/e2e-wallet-spend-p0b.ts):
 *
 *   cd /opt/spaceworker && set -a; . ./.env; set +a
 *   sudo -u trmm npx tsx --require ./scripts/stub-server-only.cjs \
 *     scripts/e2e-xdevice-gate-p4.ts
 *
 * WHAT IT PROVES against the LIVE build — POST /api/devices/<fake>/run-command:
 *   1. no session            → 401
 *   2. free user (tier 1)    → 403 {code:"xdevice_required"}  (owner's core
 *      promise: free accounts SEE devices but cannot act on them)
 *   3. live tier-3 user      → gate PASSES (NOT xdevice_required; reaches the
 *      device layer and answers device-not-linked 404 for the fake id)
 *   4. expired tier-3 user   → 403 xdevice_required (term ended → tools lock)
 *
 * Gate order in the route is session → deviceToolsDenied → device work, so a
 * fake deviceId is safe: the free/expired cases never reach the device layer,
 * and the pass case proves the gate opened by getting PAST it.
 *
 * Always cleans up its disposable users. Prints one RESULT: PASS / FAIL line.
 */
import fs from "node:fs";

import { db } from "../lib/db";
import { createSessionToken, SESSION_COOKIE } from "../lib/auth";

const BASE = "http://localhost:3500";
const FAKE_DEVICE = "e2e-no-such-device";
const DAY_MS = 24 * 60 * 60 * 1000;

// writeSync, not console.log: stdout through a pipe is async — a process.exit
// after console.log can silently drop the RESULT line the evidence hangs on.
const log = (line: string) => fs.writeSync(1, `${line}\n`);
const logErr = (line: string) => fs.writeSync(2, `${line}\n`);

const failures: string[] = [];
function check(cond: boolean, label: string, detail?: unknown): void {
  if (cond) {
    log(`ok   - ${label}`);
  } else {
    failures.push(label);
    log(`FAIL - ${label}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
  }
}

const seeded: string[] = [];

async function cleanup(): Promise<void> {
  if (seeded.length === 0) return;
  try {
    await db.user.deleteMany({ where: { id: { in: seeded } } });
    log(`cleanup: ${seeded.length} disposable user(s) deleted`);
  } catch (err) {
    logErr(`cleanup FAILED — remove manually: ${String(err)}`);
    process.exitCode = 1;
  }
}

async function seedUser(email: string, tier: number, expiresAt: Date | null): Promise<string> {
  const user = await db.user.create({
    data: {
      email,
      passwordHash: "e2e-not-a-real-hash",
      emailVerified: true,
      tier,
      ...(expiresAt ? { premiumExpiresAt: expiresAt } : {}),
    },
  });
  seeded.push(user.id);
  return user.id;
}

async function cookieFor(userId: string, email: string): Promise<string> {
  const token = await createSessionToken({ sub: userId, email, emailVerified: true });
  return `${SESSION_COOKIE}=${token}`;
}

function runCommand(cookie: string | null): Promise<Response> {
  return fetch(`${BASE}/api/devices/${FAKE_DEVICE}/run-command`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify({ cmd: "echo e2e-gate-probe", shell: "cmd" }),
  });
}

async function main(): Promise<void> {
  const stamp = Date.now();
  const emails = {
    free: `_e2e-xdevice-free-${stamp}@spaceworker.test`,
    live: `_e2e-xdevice-live-${stamp}@spaceworker.test`,
    expired: `_e2e-xdevice-expired-${stamp}@spaceworker.test`,
  };
  log(`email=${emails.free}`);

  const [freeId, liveId, expiredId] = await Promise.all([
    seedUser(emails.free, 1, null),
    seedUser(emails.live, 3, new Date(Date.now() + 7 * DAY_MS)),
    seedUser(emails.expired, 3, new Date(Date.now() - DAY_MS)),
  ]);
  log(`seeded free=${freeId} live3=${liveId} expired3=${expiredId}`);

  // ---- 1. no session → 401 -------------------------------------------------
  const r0 = await runCommand(null);
  check(r0.status === 401, `no session → 401 (got ${r0.status})`);

  // ---- 2. free user → 403 xdevice_required ---------------------------------
  const freeCookie = await cookieFor(freeId, emails.free);
  const r1 = await runCommand(freeCookie);
  const b1 = (await r1.json().catch(() => ({}))) as Record<string, unknown>;
  check(r1.status === 403, `free → 403 (got ${r1.status})`, b1);
  check(b1.error === "xdevice_required", `free → error xdevice_required`, b1);

  // ---- 3. live tier-3 → gate PASSES (past the gate → 404 device_not_linked) -
  const liveCookie = await cookieFor(liveId, emails.live);
  const r2 = await runCommand(liveCookie);
  const b2 = (await r2.json().catch(() => ({}))) as Record<string, unknown>;
  check(r2.status !== 403, `live tier-3 NOT 403 (got ${r2.status})`, b2);
  check(b2.error !== "xdevice_required", `live tier-3 error is not xdevice_required`, b2);
  check(r2.status === 404, `live tier-3 reaches device layer → 404 fake id (got ${r2.status})`, b2);

  // ---- 4. expired tier-3 → 403 xdevice_required ----------------------------
  const expiredCookie = await cookieFor(expiredId, emails.expired);
  const r3 = await runCommand(expiredCookie);
  const b3 = (await r3.json().catch(() => ({}))) as Record<string, unknown>;
  check(r3.status === 403, `expired tier-3 → 403 (got ${r3.status})`, b3);
  check(b3.error === "xdevice_required", `expired tier-3 → error xdevice_required`, b3);
}

main()
  .catch((err) => {
    logErr(`harness crashed: ${String(err)}`);
    failures.push("harness crashed");
  })
  .finally(async () => {
    await cleanup();
    if (failures.length === 0) {
      log("RESULT: PASS");
      process.exit(0);
    }
    log(`RESULT: FAIL (${failures.length}) — ${failures.join(" | ")}`);
    process.exit(1);
  });
