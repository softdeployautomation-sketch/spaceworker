/**
 * TASK_181 P0b — W5 live-confirm evidence harness. NOT part of the shipped app.
 * Run ON the VPS against the real deployed HTTP route (playbook §4 house
 * pattern, cf. scripts/task152-*-evidence.ts):
 *
 *   cd /opt/spaceworker && set -a; . ./.env; set +a
 *   sudo -u trmm npx tsx --require ./scripts/stub-server-only.cjs \
 *     scripts/e2e-wallet-spend-p0b.ts
 *
 * (env values are loaded server-side only — never printed.)
 *
 * WHAT IT PROVES, against the LIVE build — not a fake, not localhost dev:
 *   1. POST /api/wallet/spend with a funded disposable user debits EXACTLY the
 *      admin-configured price, grants a ~30-day tier-5 term, writes exactly one
 *      `debit_purchase` ledger row, and answers JSON (W5's core promise);
 *   2. a keyed retry answers chargedCents 0 — a double-click never charges twice;
 *   3. a second unkeyed tap is 409 already_active — a second month is never eaten;
 *   4. truth in Postgres matches the HTTP response (tier, balance, term, ledger).
 *
 * Always cleans up its rows (ledger before user — FK order). Prints a single
 * RESULT: PASS / RESULT: FAIL line gated on every assertion.
 */
import fs from "node:fs";

import { db } from "../lib/db";
import { createSessionToken, SESSION_COOKIE } from "../lib/auth";
import { getAdminSettings } from "../lib/admin-settings";

const BASE = "http://localhost:3500";
const DAY_MS = 24 * 60 * 60 * 1000;

// writeSync, not console.log: the run is captured through a pipe, where stdout
// is async — a process.exit() after console.log can silently drop the very
// RESULT line the evidence hangs on.
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

let userId: string | null = null;

async function cleanup(): Promise<void> {
  if (!userId) return;
  try {
    // Ledger first: WalletLedgerEntry.userId is an FK to User.
    await db.walletLedgerEntry.deleteMany({ where: { userId } });
    await db.user.delete({ where: { id: userId } });
    log("cleanup: ledger rows + disposable user deleted");
  } catch (err) {
    logErr(`cleanup FAILED — remove manually: ${String(err)}`);
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  const settings = await getAdminSettings();
  const priceCents = Math.ceil(settings.webSubscriptionPriceUsd * 100);
  const opening = priceCents + 500;
  const stamp = Date.now();
  const email = `_e2e-w5-spend-${stamp}@spaceworker.test`;
  const idemKey = `e2e_w5_${stamp}`;

  log(`price=${priceCents}c opening=${opening}c email=${email}`);

  const user = await db.user.create({
    data: { email, passwordHash: "e2e-not-a-real-hash", emailVerified: true, tier: 1, balanceCents: opening },
  });
  userId = user.id;
  log(`seeded user id=${user.id} tier=1 balance=${opening}c`);

  const token = await createSessionToken({ sub: user.id, email, emailVerified: true });
  const cookie = `${SESSION_COOKIE}=${token}`;
  const post = (body: unknown) =>
    fetch(`${BASE}/api/wallet/spend`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify(body),
    });

  // ---- 1. THE SPEND -------------------------------------------------------
  const before = Date.now();
  const r1 = await post({ product: "web_subscription", idempotencyKey: idemKey });
  const b1 = (await r1.json()) as Record<string, unknown>;
  check(r1.status === 200, `spend answers 200 (got ${r1.status})`, b1);
  check(b1.ok === true, "response body ok:true", b1);
  check(b1.chargedCents === priceCents, `chargedCents === ${priceCents}`, b1.chargedCents);
  check(b1.balanceCents === opening - priceCents, `balanceCents === ${opening - priceCents}`, b1.balanceCents);
  const term1Days = b1.premiumExpiresAt
    ? (Date.parse(String(b1.premiumExpiresAt)) - before) / DAY_MS
    : -1;
  check(term1Days > 29 && term1Days < 31, `term is ~30 days (got ${term1Days.toFixed(3)})`);

  // ---- 2. keyed replay: never a second charge ----------------------------
  const r2 = await post({ product: "web_subscription", idempotencyKey: idemKey });
  const b2 = (await r2.json()) as Record<string, unknown>;
  check(r2.status === 200, `keyed replay answers 200 (got ${r2.status})`, b2);
  check(b2.chargedCents === 0, "keyed replay chargedCents === 0", b2.chargedCents);

  // ---- 3. second unkeyed tap: refused, never a second month ---------------
  const r3 = await post({ product: "web_subscription" });
  const b3 = (await r3.json()) as Record<string, unknown>;
  check(r3.status === 409, `second tap answers 409 (got ${r3.status})`, b3);
  check(b3.code === "already_active", `code === already_active (got ${String(b3.code)})`, b3);

  // ---- 4. truth in Postgres matches the HTTP response ---------------------
  const u = await db.user.findUnique({ where: { id: user.id } });
  check(u?.tier === 5, `DB tier === 5 (got ${String(u?.tier)})`);
  check(u?.balanceCents === opening - priceCents, `DB balance === ${opening - priceCents} (got ${String(u?.balanceCents)})`);
  const dbTermDays = u?.premiumExpiresAt ? (u.premiumExpiresAt.getTime() - before) / DAY_MS : -1;
  check(dbTermDays > 29 && dbTermDays < 31, `DB term is ~30 days (got ${dbTermDays.toFixed(3)})`);

  const entries = await db.walletLedgerEntry.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "asc" },
  });
  check(entries.length === 1, `exactly ONE ledger row (got ${entries.length})`);
  const e = entries[0];
  check(e?.kind === "debit_purchase", `kind === debit_purchase (got ${String(e?.kind)})`);
  check(e?.amountCents === -priceCents, `amount === -${priceCents} (got ${String(e?.amountCents)})`);
  check(e?.balanceAfterCents === opening - priceCents, `balanceAfter === ${opening - priceCents} (got ${String(e?.balanceAfterCents)})`);
  check((e?.note ?? "").includes("web_subscription"), `note names web_subscription (got ${String(e?.note)})`);
  check(e?.idempotencyKey === idemKey, "ledger carries the idempotency key");
}

main()
  .catch((err: unknown) => {
    failures.push(`unhandled: ${err instanceof Error ? (err.stack ?? String(err)) : String(err)}`);
  })
  .finally(async () => {
    await cleanup();
    try {
      await db.$disconnect();
    } catch {
      /* disconnect is best-effort */
    }
    for (const f of failures) logErr(`FAIL - ${f}`);
    const pass = failures.length === 0;
    log(`RESULT: ${pass ? "PASS" : "FAIL"}`);
    process.exit(pass ? 0 : 1);
  });

