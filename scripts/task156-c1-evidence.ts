/**
 * TASK_156 C1 — scratch-DB evidence harness. NOT part of the shipped app; run with
 * tsx against a scratch DB to produce RAW Cyber Lab rows for the task writeup:
 * the seeded LabToolCatalog, the §12.1 stale-hiding contract, the research state
 * and the C0 consent row / §12.9 premium gate.
 *
 *   dropdb --if-exists sw_156c1 && createdb sw_156c1
 *   DATABASE_URL='postgresql://mikeolab@127.0.0.1:5432/sw_156c1' npx prisma db push --skip-generate
 *   NODE_OPTIONS='--conditions=react-server' \
 *     DATABASE_URL='...sw_156c1' \
 *     npx tsx --require ./scripts/stub-server-only.cjs scripts/task156-c1-evidence.ts
 *
 * House pattern (cf. scripts/task152-m5-evidence.ts). The stub swaps `server-only`
 * for {} so lib/lab/* loads outside a React Server Component.
 */
import { db } from "../lib/db";
import { recordConsent, consentHash } from "../lib/lab/consent";
import { ensureCatalogSeed, CATALOG_SEED } from "../lib/lab/catalog-seed";
import { listCatalog, listVisibleCatalog, isCatalogStale, ATTACK_RELEASE } from "../lib/lab/tools";
import { researchState } from "../lib/lab/research";
import { cyberLabGate } from "../lib/lab/gate";

const h = (s: string) => console.log(`\n==== ${s} ====`);

async function main(): Promise<void> {
  await db.$executeRawUnsafe(
    'TRUNCATE "LabToolCatalog","LabConsent","UserEntitlement","User","AdminSetting" CASCADE',
  );

  // A premium (tier 5) user: the §12.9 gate should pass via `premium`.
  await db.user.create({
    data: { id: "c1_premium", email: "premium@c1.test", passwordHash: "x", tier: 5 },
  });
  // A free user: the §12.9 gate must refuse.
  await db.user.create({
    data: { id: "c1_free", email: "free@c1.test", passwordHash: "x", tier: 1 },
  });

  h("1. ensureCatalogSeed (first run)");
  console.log("seed rows defined:", CATALOG_SEED.length);
  console.log("created:", await ensureCatalogSeed());
  h("1b. ensureCatalogSeed (second run — idempotent, must be 0)");
  console.log("created:", await ensureCatalogSeed());

  h("2. listCatalog (admin view: every row + stale flag)");
  const rows = await listCatalog();
  console.log(`rows=${rows.length} stale=${rows.filter((r) => r.stale).length}`);
  for (const r of rows) {
    console.log(
      `  ${r.slug.padEnd(12)} ${r.klass.padEnd(9)} ${r.kind.padEnd(9)} stale=${r.stale} ` +
        `techniques=[${(r.techniqueIds as string[]).join(",")}] lic=${r.licence ?? "-"}`,
    );
  }

  h("3. §12.1 stale-hiding: age ONE row into the past, re-read visible set");
  await db.labToolCatalog.update({ where: { slug: "nmap" }, data: { staleAfter: new Date("2026-09-01") } });
  const visible = await listVisibleCatalog();
  console.log("visible slugs:", visible.map((r) => r.slug).join(","));
  console.log("nmap hidden from visible set:", !visible.some((r) => r.slug === "nmap"));
  console.log("nmap still flagged stale in admin view:", isCatalogStale({ staleAfter: new Date("2026-09-01") }));
  await db.labToolCatalog.update({
    where: { slug: "nmap" },
    data: { staleAfter: new Date(Date.now() + 180 * 24 * 3600 * 1000) },
  });

  h("4. researchState (read-only, no pulls)");
  const state = await researchState();
  console.log("ATT&CK pin:", ATTACK_RELEASE.version, "pinnedAt", ATTACK_RELEASE.pinnedAt);
  console.log("feeds:", state.feeds.map((f) => f.id).join(","));
  console.log("refreshDays:", state.refreshDays, "nextRefreshDueAt:", state.nextRefreshDueAt);
  console.log("toolStaleAfterDays:", state.toolStaleAfterDays);
  console.log("catalog summary:", JSON.stringify(state.catalog));

  h("5. C0 consent + §12.9 premium gate (default: lab dark)");
  const before = await cyberLabGate("c1_premium");
  console.log("premium user, switch OFF:", JSON.stringify({ ...before, consent: null }));
  const { row, created } = await recordConsent({ userId: "c1_premium", ip: "203.0.113.9" });
  console.log("consent row:", JSON.stringify(row), "created:", created);
  console.log("hash matches consentHash():", row.hash === consentHash("c1_premium", row.termsVersion));

  h("6. flip the platform master switch ON (admin dial) -> gate opens");
  await db.adminSetting.upsert({
    where: { id: "singleton" },
    update: { cyberlabEnabled: true },
    create: { id: "singleton", cyberlabEnabled: true },
  });
  const prem = await cyberLabGate("c1_premium");
  console.log("premium user:", JSON.stringify({ ...prem, consent: undefined }));
  const free = await cyberLabGate("c1_free");
  console.log("free user   :", JSON.stringify({ ...free, consent: undefined }));
  console.log("premium open:", prem.open, "| free open:", free.open);

  h("7. bumping the AUP version forces re-acceptance (§12.9)");
  await db.adminSetting.update({ where: { id: "singleton" }, data: { cyberlabConsentTermsVersion: "2026-11-01" } });
  const reversion = await cyberLabGate("c1_premium");
  console.log("after version bump -> consented:", reversion.consented, "open:", reversion.open);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });