/**
 * TASK_181 P5 live-confirm harness — owner's asks 1+2. NOT part of the shipped
 * app. Run ON the VPS against the real deployed HTTP routes (playbook §4 house
 * pattern, cf. scripts/e2e-wallet-spend-p0b.ts):
 *
 *   cd /opt/spaceworker && set -a; . ./.env; set +a
 *   sudo -u trmm npx tsx --require ./scripts/stub-server-only.cjs \
 *     scripts/e2e-xdevice-grant-live-p5.ts
 *
 * WHAT IT PROVES, against the LIVE build:
 *   1. THE GRANT BUG IS GONE (P0a): POST /api/admin/wallet/grant with the
 *      shared-passcode admin session + a real userId answers 200 JSON (never
 *      HTML 500), credits the balance, and writes exactly one `admin_grant`
 *      ledger row with adminId NULL (the FK-mismatch fix);
 *   2. ADMIN TIER-3 GRANT: POST /api/admin/users/[id]/grant-premium {tier:3}
 *      lands the user on tier 3 with a ~30-day term; a second call STACKS
 *      (expiry moves later, never resets) — the extend surface;
 *   3. XDEVICE PAYMENT→GRANT (owner: "make sure granting works after user pays
 *      for the premiumxdevice from wrapper"): POST /api/wallet/spend
 *      {product:"xdevice"} debits the admin-configured xdevice price, grants
 *      tier 3 + ~30-day term in the SAME transaction as the debit, writes one
 *      `debit_purchase` row; a keyed retry charges 0; a second tap is 409
 *      already_active; Postgres truth matches every response.
 *
 * Always cleans up its rows (ledger before user — FK order). Prints one
 * RESULT: PASS / RESULT: FAIL line gated on every assertion.
 */
import fs from "node:fs";

import { db } from "../lib/db";
import { createSessionToken, SESSION_COOKIE } from "../lib/auth";
import { ADMIN_SESSION_COOKIE, createAdminSessionToken } from "../lib/admin-auth";
import { getAdminSettings } from "../lib/admin-settings";

const BASE = "http://localhost:3500";
const DAY_MS = 24 * 60 * 60 * 1000;

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

let buyerId: string | null = null;
let granteeId: string | null = null;

async function cleanup(): Promise<void> {
  try {
    // Ledger first: WalletLedgerEntry.userId is an FK to User.
    for (const uid of [buyerId, granteeId]) {
      if (!uid) continue;
      await db.walletLedgerEntry.deleteMany({ where: { userId: uid } });
      await db.user.delete({ where: { id: uid } });
    }
    log("cleanup: ledger rows + disposable users deleted");
  } catch (err) {
    logErr(`cleanup FAILED — remove manually: ${String(err)}`);
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  const settings = await getAdminSettings();
  const priceCents = Math.ceil(settings.xdevicePriceUsd * 100);
  const opening = priceCents + 500;
  const stamp = Date.now();
  const buyerEmail = `_e2e-xdev-buyer-${stamp}@spaceworker.test`;
  const granteeEmail = `_e2e-xdev-grantee-${stamp}@spaceworker.test`;

  log(`xdevice price=${priceCents}c opening=${opening}c`);

  const buyer = await db.user.create({
    data: { email: buyerEmail, passwordHash: "e2e-not-a-real-hash", emailVerified: true, tier: 1, balanceCents: opening },
  });
  buyerId = buyer.id;
  const grantee = await db.user.create({
    data: { email: granteeEmail, passwordHash: "e2e-not-a-real-hash", emailVerified: true, tier: 1, balanceCents: 0 },
  });
  granteeId = grantee.id;
  log(`seeded buyer=${buyer.id} grantee=${grantee.id}`);

  const userCookie = `${SESSION_COOKIE}=${await createSessionToken({ sub: buyer.id, email: buyerEmail, emailVerified: true })}`;
  const adminCookie = `${ADMIN_SESSION_COOKIE}=${await createAdminSessionToken()}`;


  // ---- 1. GRANT BUG IS GONE (P0a) -----------------------------------------
  const g1 = await fetch(`${BASE}/api/admin/wallet/grant`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: adminCookie },
    body: JSON.stringify({ userId: grantee.id, amountCents: 1500, note: "TASK_181 P5 live harness — grant repro" }),
  });
  const g1Text = await g1.text();
  let g1Body: Record<string, unknown> = {};
  try {
    g1Body = JSON.parse(g1Text) as Record<string, unknown>;
  } catch {
    // fall through — HTML/non-JSON is exactly the bug being hunted
  }
  check(g1.status === 200, `admin wallet grant → 200 (got ${g1.status})`, g1Text.slice(0, 300));
  check(typeof g1Body.error !== "string", "grant body has no error string", g1Body);
  check(!g1Text.trimStart().startsWith("<"), "grant answer is JSON, never HTML", g1Text.slice(0, 120));
  const granteeAfterGrant = await db.user.findUnique({ where: { id: grantee.id }, select: { balanceCents: true } });
  check(granteeAfterGrant?.balanceCents === 1500, `balance credited 1500c (got ${String(granteeAfterGrant?.balanceCents)})`);
  const adminGrantRow = await db.walletLedgerEntry.findFirst({
    where: { userId: grantee.id, kind: "admin_grant" },
    orderBy: { createdAt: "desc" },
  });
  check(adminGrantRow !== null, "ledger row kind=admin_grant exists");
  check(adminGrantRow?.adminId === null, `admin_grant.adminId is NULL (P0a fix; got ${String(adminGrantRow?.adminId)})`);

  // ---- 2. ADMIN TIER-3 GRANT + STACK ---------------------------------------
  const t1 = await fetch(`${BASE}/api/admin/users/${grantee.id}/grant-premium`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: adminCookie },
    body: JSON.stringify({ tier: 3 }),
  });
  const t1Body = (await t1.json().catch(() => ({}))) as Record<string, unknown>;
  check(t1.status === 200, `admin grant-premium tier:3 → 200 (got ${t1.status})`, t1Body);
  check(t1Body.tier === 3, `response tier === 3 (got ${String(t1Body.tier)})`, t1Body);
  const expiry1 = typeof t1Body.premiumExpiresAt === "string" ? Date.parse(t1Body.premiumExpiresAt) : NaN;
  check(Number.isFinite(expiry1), "term expiry returned to admin", t1Body.premiumExpiresAt);
  const term1Days = (expiry1 - Date.now()) / DAY_MS;
  check(term1Days > 29 && term1Days < 31, `first term ~30 days (got ${term1Days.toFixed(3)})`);

  const t2 = await fetch(`${BASE}/api/admin/users/${grantee.id}/grant-premium`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: adminCookie },
    body: JSON.stringify({ tier: 3 }),
  });
  const t2Body = (await t2.json().catch(() => ({}))) as Record<string, unknown>;
  const expiry2 = typeof t2Body.premiumExpiresAt === "string" ? Date.parse(t2Body.premiumExpiresAt) : NaN;
  check(t2.status === 200 && expiry2 > expiry1, `second grant STACKS (expiry ${expiry2} > ${expiry1})`, t2Body);

  // ---- 3. XDEVICE PAYMENT → TIER-3 GRANT ----------------------------------
  const idemKey = `e2e_xdev_${stamp}`;
  const spendPost = (body: unknown) =>
    fetch(`${BASE}/api/wallet/spend`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify(body),
    });

  const before = Date.now();
  const s1 = await spendPost({ product: "xdevice", idempotencyKey: idemKey });
  const s1Body = (await s1.json().catch(() => ({}))) as Record<string, unknown>;
  check(s1.status === 200, `xdevice spend → 200 (got ${s1.status})`, s1Body);
  check(s1Body.ok === true && s1Body.product === "xdevice", "body ok:true product:xdevice", s1Body);
  check(s1Body.chargedCents === priceCents, `chargedCents === ${priceCents}`, s1Body.chargedCents);
  check(s1Body.balanceCents === opening - priceCents, `balanceCents === ${opening - priceCents}`, s1Body.balanceCents);
  const s1Days = s1Body.premiumExpiresAt ? (Date.parse(String(s1Body.premiumExpiresAt)) - before) / DAY_MS : -1;
  check(s1Days > 29 && s1Days < 31, `payment term ~30 days (got ${s1Days.toFixed(3)})`);
  const buyerRow = await db.user.findUnique({ where: { id: buyer.id }, select: { tier: true, premiumExpiresAt: true, balanceCents: true } });
  check(buyerRow?.tier === 3, `Postgres tier === 3 (got ${String(buyerRow?.tier)})`);
  check(buyerRow !== null && buyerRow.premiumExpiresAt !== null, "Postgres premiumExpiresAt set");
  const debitRows = await db.walletLedgerEntry.count({ where: { userId: buyer.id, kind: "debit_purchase" } });
  check(debitRows === 1, `exactly one debit_purchase row (got ${debitRows})`);

  const s2 = await spendPost({ product: "xdevice", idempotencyKey: idemKey });
  const s2Body = (await s2.json().catch(() => ({}))) as Record<string, unknown>;
  check(s2.status === 200 && s2Body.chargedCents === 0, `keyed retry charges 0 (got ${String(s2Body.chargedCents)}c)`, s2Body);

  const s3 = await spendPost({ product: "xdevice" });
  const s3Body = (await s3.json().catch(() => ({}))) as Record<string, unknown>;
  check(s3.status === 409 && s3Body.code === "already_active", `second tap 409 already_active (got ${s3.status} ${String(s3Body.code)})`, s3Body);
  const debitRowsFinal = await db.walletLedgerEntry.count({ where: { userId: buyer.id, kind: "debit_purchase" } });
  check(debitRowsFinal === 1, `still exactly one debit after retries (got ${debitRowsFinal})`);
}

main()
  .catch((err) => {
    logErr(`harness threw: ${String(err)}`);
    failures.push("harness exception");
  })
  .finally(() => {
    void cleanup().then(() => {
      if (failures.length === 0) {
        log("RESULT: PASS");
      } else {
        log(`RESULT: FAIL (${failures.length}) — ${failures.join(" | ")}`);
        process.exitCode = 1;
      }
      process.exit();
    });
  });
