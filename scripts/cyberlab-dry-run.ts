// TASK_156 C2a — the owner-run DRY-RUN CLI (PLAN_TASK_156 §7 C2 item 4).
//
// Runs the REAL chain against the REAL database: gate → consent → scenario
// allow-list → governor slot → pre-flight → range lifecycle → synthetic smoke
// telemetry → signed, append-only LabEpisode → verified teardown — then writes
// the evidence bundle to .cyberlab-runs/<rangeId>/ so the owner can inspect
// every artefact, the manifest paths, and the signature.
//
// WHAT THIS IS NOT: live execution. Every artefact is SYNTHETIC and says so in
// its own content; no packet leaves the platform; no real host is contacted.
// Live ranges are C2b (owner infra) and reuse this same chain.
//
// Usage (needs DATABASE_URL; run `npx prisma db push` once for the lab tables):
//   npm run lab:dry-run -- --user <userId> [--attest] [--accept-aup]
//     [--target 10.77.0.11 --target 10.77.0.12] [--scenario smoke-network-baseline]
//
//   --accept-aup   record consent for the CURRENT AdminSetting.cyberlabConsentTermsVersion
//   --attest       attest the given targets (or the two demo RFC1918 lab hosts) first
//   --target       exactly two host targets (the smoke scenario addresses two lab hosts)

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { getAdminSettings } from "../lib/admin-settings";
import { recordConsent } from "../lib/lab/consent";
import { startLabRun, LabRunRefusedError } from "../lib/lab/engine";
import { verifyEpisodeSignature } from "../lib/lab/episode";
import { cyberLabGate } from "../lib/lab/gate";
import { ensureSmokeScenario, SMOKE_SCENARIO_SLUG } from "../lib/lab/scenarios";
import { attestTarget, TargetRefusedError } from "../lib/lab/targets";

const OUT_ROOT = ".cyberlab-runs";
/** Two RFC1918 documentation hosts — private addresses, no real asset. */
const DEMO_TARGETS = ["10.77.0.11", "10.77.0.12"];

function fail(message: string): never {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

function printUsage(): void {
  console.log(`Cyber Lab dry-run — synthetic telemetry, signed evidence, no live hosts.

  npm run lab:dry-run -- --user <userId> [options]

  --user <id>          the user the run is for (must hold the cyberlab entitlement)
  --accept-aup         record consent for the current admin terms version
  --attest             attest the targets before running (owner declaration)
  --target <host>      exactly two host targets (default: ${DEMO_TARGETS.join(" ")})
  --scenario <slug>    scenario slug (default: ${SMOKE_SCENARIO_SLUG})
  --help               this text`);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      user: { type: "string" },
      scenario: { type: "string", default: SMOKE_SCENARIO_SLUG },
      target: { type: "string", multiple: true },
      "accept-aup": { type: "boolean", default: false },
      attest: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });

  if (values.help) {
    printUsage();
    return;
  }
  if (!values.user) {
    printUsage();
    fail("--user <userId> is required");
  }
  const userId = values.user;
  const targetValues = values.target && values.target.length > 0 ? values.target : DEMO_TARGETS;
  if (targetValues.length !== 2) fail("--target must be given exactly twice (the smoke scenario addresses two lab hosts)");

  console.log("SpaceWorker Cyber Lab — DRY-RUN");
  console.log("Synthetic telemetry only: no packet leaves the platform, no real host is contacted.\n");

  // The admin dials, read live — the same rows the UI and the gate read.
  const settings = await getAdminSettings();
  console.log(`master switch  cyberlabEnabled = ${settings.cyberlabEnabled}`);
  console.log(
    `caps           ${settings.cyberlabFreeMaxConcurrentRanges} range/user · ` +
      `${settings.cyberlabFreeMaxRangeMinutes} min TTL · ${settings.cyberlabMaxRunsPerDay} runs/day · ` +
      `${settings.cyberlabMaxEpisodesPerMonth} episodes/month`,
  );

  if (values["accept-aup"]) {
    const consent = await recordConsent({ userId, termsVersion: settings.cyberlabConsentTermsVersion });
    console.log(`AUP consent    ${consent.created ? "recorded now" : "already on file"} (${consent.row.termsVersion})`);
  }

  const gate = await cyberLabGate(userId);
  console.log(
    `gate           enabled=${gate.enabled} entitled=${gate.entitled} (${gate.entitlementReason}) ` +
      `consented=${gate.consented} → open=${gate.open}`,
  );
  if (!gate.open) {
    fail(
      "gate closed — set cyberlabEnabled=true in admin settings, ensure the user holds the premium " +
        "cyberlab entitlement, and run with --accept-aup for the CURRENT terms version",
    );
  }

  await ensureSmokeScenario();
  if (values.attest) {
    for (const value of targetValues) {
      await attestTarget({ userId, kind: "host", value });
      console.log(`attested       host ${value}`);
    }
  }

  const res = await startLabRun({
    userId,
    scenarioSlug: values.scenario,
    targets: targetValues.map((value) => ({ kind: "host", value })),
  });

  // Persist the bundle exactly as signed: every artefact + a manifest index +
  // the run summary (timeline, techniques, signature ids).
  const dir = join(OUT_ROOT, res.rangeId);
  await mkdir(dir, { recursive: true });
  for (const artefact of res.artefacts) {
    await writeFile(join(dir, artefact.path), artefact.content, "utf8");
  }
  await writeFile(
    join(dir, "manifest.json"),
    JSON.stringify(
      {
        episodeId: res.episodeId,
        rangeId: res.rangeId,
        signedHash: res.signedHash,
        paths: res.artefacts.map((a) => a.path),
      },
      null,
      2,
    ),
    "utf8",
  );
  await writeFile(
    join(dir, "run.json"),
    JSON.stringify(
      {
        mode: res.mode,
        scenarioSlug: res.scenarioSlug,
        targets: res.targets,
        techniques: res.techniques,
        telemetrySignatures: res.telemetrySignatures,
        timeline: res.timeline,
        verified: res.verified,
      },
      null,
      2,
    ),
    "utf8",
  );

  const signatureValid = await verifyEpisodeSignature(res.episodeId);
  console.log(`\nrange          ${res.rangeId} (torn_down, verified teardown)`);
  console.log(`episode        ${res.episodeId}`);
  console.log(`signedHash     ${res.signedHash}`);
  console.log(`signatureValid ${signatureValid}`);
  console.log(`bundle         ${dir}/ (${res.artefacts.length} artefacts + manifest.json + run.json)`);
  if (!signatureValid) fail("episode signature did NOT verify from the stored row");
  console.log("\n✓ dry-run complete — the evidence chain held end to end.");
}

main().catch((err: unknown) => {
  if (err instanceof LabRunRefusedError) fail(`run refused: ${err.message}`);
  if (err instanceof TargetRefusedError) fail(`targets refused (LabAbuseReport written): ${err.message}`);
  const message = err instanceof Error ? err.message : String(err);
  if (/does not exist|Unknown argument|Invalid `prisma/i.test(message)) {
    fail(`database error — are the lab tables pushed? (npx prisma db push) ${message}`);
  }
  fail(message);
});
