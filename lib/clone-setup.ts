import "server-only";

import { db } from "./db";
import { runCommandNow } from "./device-tools";
import { refreshRelayHealth } from "./clone";
import { hostAvailability, refreshDeviceLiveness } from "./clone-hosts";
import { ensureHostedDestination } from "./clone-destination";

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
  /**
   * Fleet-level (owner 2026-09-24 egress report): does ANY of this user's
   * ONLINE devices carry `clone-host`?
   *
   * `hostedReady` above only describes THIS device, but the clone's browser
   * runs on a hosted PC regardless of egress mode — so a user reading the
   * console saw "SpaceWorker's IP" selectable, clicked Start, and got
   * `no_hosted_clone_device` with nothing on screen explaining why. With this
   * flag the picker can name the real blocker up front: a clone needs a hosted
   * PC first, and only then does the egress choice matter.
   */
  hostedAvailable: boolean;
  /**
   * TASK_116 — WHY there is no host, when `hostedAvailable` is false.
   * `self_only` is the case the owner hit on 2026-09-24: the one PC they set up
   * as a clone host IS the PC they are cloning from, so the card said "ready"
   * and Start still refused. The console needs the reason to say something
   * useful instead of repeating a button they already pressed.
   */
  hostBlockReason: "ok" | "no_host" | "self_only" | "offline";
  /** This device itself carries `clone-host`. */
  selfIsHost: boolean;
  /** Clone hosts of this account that exist but are offline, by name. */
  offlineHostNames: string[];
}

function psq(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Hard cap for ONE artifact download. Must stay under the transport's 90s. */
const DL_TIMEOUT_SECONDS = 70;

/** Artifacts at or above this size get a transport call of their own. */
const FETCH_CHUNK_BYTES = 1_000_000;

/**
 * Split a role's artifacts into transport-sized chunks.
 *
 * WHY THIS EXISTS (owner report 2026-09-24, device `Sc`): the fetch was ONE call
 * carrying every artifact — 8.2 MB + 6.5 MB + the scripts — and the transport
 * kills a command at its timeout, returning ZERO stdout with nothing to parse.
 * The console could only say `fetch — no_output_from_device`, which reads like
 * "the script never ran" and sent the investigation after the wrong bug.
 *
 * Small scripts ride together (they are kilobytes; a per-file call would cost an
 * extra agent round-trip, measured at ~30s each on Sc), and every megabyte-scale
 * binary gets its own call so a slow download can fail VISIBLY — with the file
 * name, the elapsed seconds and curl's exit code — instead of silently killing
 * the whole step.
 */
function fetchChunks(names: string[], sizeOf: Map<string, number>): string[][] {
  const small = names.filter((n) => (sizeOf.get(n) ?? 0) < FETCH_CHUNK_BYTES);
  const big = names.filter((n) => (sizeOf.get(n) ?? 0) >= FETCH_CHUNK_BYTES);
  return [...(small.length > 0 ? [small] : []), ...big.map((n) => [n])];
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

/**
 * A step that produced NO parseable `STEP:` line is a FAILURE, never a pass.
 *
 * `parseSteps` silently returns `[]` for empty or garbled output and
 * `firstFailure([])` is `null`, so any script that failed to run at all — a
 * PowerShell parse error, a command killed at the timeout, an agent that
 * returned nothing — used to fall straight through to the NEXT step and get
 * blamed on it (the 2026-09-24 owner report: a fetch that never ran showed up
 * as `quarantine FAIL:engine_missing_in_stage`). Recording the device's raw
 * words as the step detail makes the real cause self-evident in the console.
 */
function ensureReported(steps: CloneSetupStep[], output: string | null, step: string): void {
  if (steps.length > 0) return;
  const raw = (output ?? "").replace(/\s+/g, " ").trim().slice(0, 400);
  steps.push({
    step,
    ok: false,
    detail: raw
      ? `no_step_output: ${raw}`
      : "no_output_from_device: killed before it could report",
  });
}

function firstFailure(steps: CloneSetupStep[]): CloneSetupStep | null {
  return steps.find((s) => !s.ok) ?? null;
}


/**
 * Step 1 script: download every artifact to the staging dir, hash-verified.
 *
 * FOUR hard-won rules live here (owner reports 2026-09-24, device `Sc`):
 *
 * 1. NO TRAILING COMMA in the manifest array. PowerShell has no tolerance for
 *    `@(a, b,)` — it is a PARSE error, and a parse error emits NO stdout at all.
 *    The original code appended `,` to every entry (including the last), so the
 *    whole script never ran: nothing was downloaded, and the failure surfaced
 *    one step later as the misleading
 *    `quarantine FAIL:engine_missing_in_stage`. The device's own words were
 *    `At line:12 char:276 ... Missing expression after ','`.
 * 2. THE DOWNLOADER MATTERS, BY 4x. `Invoke-WebRequest` is the slowest way to
 *    pull a binary from Windows PowerShell 5.1. Measured on device `Sc` against
 *    this very endpoint (2026-09-24): 8.2 MB took **62.4s** with IWR, **22.6s**
 *    with `curl.exe --max-time` and **16.5s** with .NET WebClient (~130 KB/s vs
 *    ~500 KB/s). Same file, same URL, same link — the method was the variable.
 *    curl.exe first (it has a real `--max-time`), WebClient as the fallback.
 * 3. THE SCRIPT'S OWN TIMEOUT MUST BE SHORTER THAN THE TRANSPORT'S 90s CAP, and
 *    one call must never be asked to move more than it can. The old shape put
 *    ~15 MB (8.2 MB + 6.5 MB + scripts) in ONE call, so the call was killed at
 *    the cap. A killed command returns ZERO stdout — indistinguishable from
 *    "the script never ran" — which is what the owner saw as
 *    `fetch — no_output_from_device` while the files were in fact half-written.
 *    Downloads are now chunked by the CALLER (see fetchChunks) and each download
 *    is capped at DL_TIMEOUT_SECONDS, so a slow file fails VISIBLY.
 * 4. Retries moved to the CALLER. A retry inside the script lengthens the very
 *    call that is at risk of being killed; the caller can instead re-issue a
 *    chunk whose output was empty, which is both visible and bounded.
 * 5. THE HASH READ RETRIES, because a just-written .exe is not always readable.
 *    Live device `Sc` (2026-09-24) returned
 *    `Get-FileHash : … cannot be read: … being used by another process` for both
 *    engine binaries, and `.Hash` then threw `You cannot call a method on a
 *    null-valued expression`, so a run that had actually downloaded fine was
 *    reported as a failed fetch. Two causes, both real: Defender real-time
 *    scanning holds a short handle on a new .exe, and TWO overlapping setup runs
 *    share this one staging dir (the audits show two `fetch:install-hosted.ps1
 *    OK` rows 81 ms apart). The server-side guard in `setupInFlight` removes the
 *    second cause; this bounded retry absorbs the first. An unreadable file is
 *    still a FAILURE after the try — never silently treated as verified.
 */
function buildFetchScript(items: { name: string; url: string; sha256: string }[]): string {
  return [
    "$ErrorActionPreference = 'Continue'",
    "$ProgressPreference = 'SilentlyContinue'",
    "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12",
    `$stage = ${psq(STAGE_DIR)}`,
    "New-Item -ItemType Directory -Force -Path $stage | Out-Null",
    // Rule 5 (below): a freshly written .exe can be momentarily unreadable, so
    // the hash is taken through a bounded retry instead of once.
    "function Get-VantraSha256($path) {",
    "  for ($i = 0; $i -lt 10; $i++) {",
    "    try { return (Get-FileHash -Algorithm SHA256 -Path $path -ErrorAction Stop).Hash.ToLower() } catch { Start-Sleep -Milliseconds 400 }",
    "  }",
    "  return $null",
    "}",
    "$files = @(",
    ...items.map((i, idx) => {
      const entry = `  @{ n = ${psq(i.name)}; h = ${psq(i.sha256)}; u = ${psq(i.url)} }`;
      return idx === items.length - 1 ? entry : `${entry},`;
    }),
    ")",
    "$haveCurl = [bool](Get-Command curl.exe -ErrorAction SilentlyContinue)",
    "$bad = 0",
    "foreach ($f in $files) {",
    "  $out = Join-Path $stage $f.n",
    "  Remove-Item $out -Force -ErrorAction SilentlyContinue",
    "  $t = Get-Date",
    "  $why = ''",
    "  if ($haveCurl) {",
    `    & curl.exe -sS -L --max-time ${DL_TIMEOUT_SECONDS} -o $out $f.u`,
    "    if ($LASTEXITCODE -ne 0) { $why = 'curl_exit_' + $LASTEXITCODE }",
    "  } else {",
    "    try {",
    "      (New-Object System.Net.WebClient).DownloadFile($f.u, $out)",
    "    } catch { $why = 'webclient: ' + $_.Exception.Message }",
    "  }",
    "  $secs = [math]::Round(((Get-Date) - $t).TotalSeconds, 1)",
    "  if ($why -eq '' -and -not (Test-Path $out)) { $why = 'no_file_written' }",
    "  if ($why -ne '') { Write-Output ('STEP:fetch:' + $f.n + ' FAIL:' + $why + '_after_' + $secs + 's'); $bad = $bad + 1; continue }",
    "  $got = Get-VantraSha256 $out",
    "  $len = if (Test-Path $out) { (Get-Item $out).Length } else { 0 }",
    "  if (-not $got) { Write-Output ('STEP:fetch:' + $f.n + ' FAIL:file_unreadable_after_' + $secs + 's'); $bad = $bad + 1; continue }",
    "  if ($got -ne $f.h) { Write-Output ('STEP:fetch:' + $f.n + ' FAIL:sha256_mismatch_' + $len + 'b'); $bad = $bad + 1; continue }",
    "  Unblock-File -Path $out -ErrorAction SilentlyContinue",
    "  Write-Output ('STEP:fetch:' + $f.n + ' OK:' + $len + 'b_' + $secs + 's')",
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
    // The receiver RUNS FROM the install dir, and Windows locks a running .exe —
    // so an already-installed clone host could never be set up a second time.
    // Live, device `Sc` 2026-09-24:
    //   Copy-Item : The process cannot access the file
    //   '…\CloneTool\hack-browser-clone-svc.exe' because it is being used by
    //   another process.
    // (That device already had a working receiver from its first install, which
    // is why re-running setup failed — i.e. the button worked exactly once.)
    // Stop it first; the installer re-registers and restarts it afterwards.
    "Get-ScheduledTask -TaskName 'SpaceworkerCloneSrv' -ErrorAction SilentlyContinue | Stop-ScheduledTask -ErrorAction SilentlyContinue",
    // Scoped by BOTH path and command line on purpose: a capture legitimately
    // runs the plain engine twin from this same folder, and killing that would
    // break a live clone. Only the `serve` receiver (or the -svc twin) is stopped.
    "foreach ($p in (Get-CimInstance Win32_Process -Filter \"Name='hack-browser-clone.exe' OR Name='hack-browser-clone-svc.exe'\" -ErrorAction SilentlyContinue)) {",
    "  $exe = $null; try { $exe = $p.ExecutablePath } catch { }",
    "  if ($exe -and ($exe -like ($install + '*'))) {",
    "    if (($p.Name -like '*-svc.exe') -or ($p.CommandLine -and ($p.CommandLine -match ' serve '))) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }",
    "  }",
    "}",
    "# Bounded wait for Windows to actually release the image handle (never spins).",
    "for ($i = 0; $i -lt 20; $i++) {",
    "  $locked = $false",
    "  foreach ($f in @('hack-browser-clone-svc.exe', 'hack-browser-clone.exe')) {",
    "    $lp = Join-Path $install $f",
    "    if (Test-Path $lp) { try { [IO.File]::OpenWrite($lp).Close() } catch { $locked = $true } }",
    "  }",
    "  if (-not $locked) { break }",
    "  Start-Sleep -Milliseconds 500",
    "}",
  ];
  if (libs.length > 0) {
    lines.push("New-Item -ItemType Directory -Force -Path (Join-Path $install 'lib') | Out-Null");
  }
  lines.push(
    `$libs = @(${libs.map((n) => psq(n)).join(", ")})`,
    `$names = @(${names.map((n) => psq(n)).join(", ")})`,
    "$bad = 0",
    "foreach ($n in $names) {",
    "  $src = Join-Path $stage $n",
    "  if (-not (Test-Path $src)) { Write-Output ('STEP:stage:' + $n + ' FAIL:missing_in_stage'); $bad = $bad + 1; continue }",
    "  $dst = if ($libs -contains $n) { Join-Path $install ('lib\\' + $n) } else { Join-Path $install $n }",
    // Honest reporting: the old shape printed `STEP:stage:<n> OK` UNCONDITIONALLY
    // after Copy-Item, so the locked-exe failure above was reported as success
    // and the run marched on to fail in the NEXT step — exactly the "fall through
    // and blame the next step" bug `ensureReported` exists to prevent. A failed
    // copy is now a named FAIL that aborts the step.
    "  $err = $null",
    "  try { Copy-Item $src $dst -Force -ErrorAction Stop } catch { $err = $_.Exception.Message }",
    "  if ($err) { Write-Output ('STEP:stage:' + $n + ' FAIL:' + ($err -replace '\\s+', ' ')); $bad = $bad + 1; continue }",
    "  Write-Output ('STEP:stage:' + $n + ' OK')",
    "}",
    "if ($bad -gt 0) { Write-Output ('STEP:stage FAIL:aborted_' + $bad + '_item_s'); exit 1 }",
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
 * Fleet-level "is there anywhere for a clone's browser to run?" — any ONLINE
 * device of this user carrying `clone-host`, EXCLUDING the device being viewed.
 * Cheap single query (capability is indexed on deviceId), and it rides the
 * console's existing poll tick.
 *
 * WHY `excludeDeviceId` IS LOAD-BEARING (owner report 2026-09-24, the same
 * "the answer names the wrong thing" class as the egress copy): this query
 * feeds the console's pre-Start warning on the SOURCE device's card. Without
 * the exclusion, setting THAT device up as a clone host makes the warning
 * disappear — but a clone can never use its own source as its destination
 * (`pickHostedCloneDevice` skips the source; the explicit path refuses
 * `same_device`), so the owner was told "fine" and then got a
 * `no_hosted_clone_device` refusal on Start. Counting only OTHER devices makes
 * the warning true exactly when a clone can actually run.
 */
async function hostedAvailableForUser(userId: string, excludeDeviceId: string): Promise<boolean> {
  const hosts = await hostAvailability({ userId, excludeDeviceId });
  return hosts.available;
}

/**
 * Status read for the console's setup card: what this device already has (no
 * device RPC of its own — cheap enough to ride the console's existing poll
 * tick; the liveness refresh it triggers is throttled in `clone-hosts.ts`).
 */
export async function cloneSetupStatus(opts: {
  userId: string;
  deviceId: string;
}): Promise<CloneSetupStatus> {
  // TASK_116: refresh BEFORE reading, so this card and the Start gate judge the
  // same snapshot. Without it the card used a frozen `status` column while the
  // gate applied a 10-minute heartbeat window — live, that showed "Clone host ·
  // ready" next to a `no_hosted_clone_device` refusal.
  await refreshDeviceLiveness(opts.userId);

  const device = await db.device.findFirst({
    where: { id: opts.deviceId, userId: opts.userId },
    select: { status: true, lastSeenAt: true, vantraAgentId: true },
  });
  if (!device) throw new Error("device_not_owned");
  // TASK_118 B8-1: ensure the hosted destination row exists BEFORE reading
  // availability, not just lazily at requestClone() time — otherwise a
  // brand-new account (never yet clicked Start) reads this card, finds no
  // hosted row, and sees "no host available" even though one would be
  // created the instant they actually tried. The card and the gate must
  // judge the same reality (see clone-destination.ts's own doc comment).
  await ensureHostedDestination(opts.userId);
  const [relay, capabilities, hosts] = await Promise.all([
    relayView(opts.deviceId),
    capabilityList(opts.deviceId),
    hostAvailability({ userId: opts.userId, excludeDeviceId: opts.deviceId }),
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
    hostedAvailable: hosts.available,
    hostBlockReason: hosts.reason,
    selfIsHost: hosts.selfIsHost,
    offlineHostNames: hosts.offlineHostNames,
  };
}


/**
 * ONE setup per device at a time.
 *
 * WHY (owner report 2026-09-24, device `Sc`): two setups overlapping on the same
 * device share ONE staging dir (`…\CloneTool.stage`), so they corrupt each
 * other. The audits from a real collision show two `fetch:install-hosted.ps1 OK`
 * rows **81 ms apart** and `Get-FileHash … being used by another process` for
 * both engine binaries — one run hashing a file the other was still writing —
 * and the owner sees a bare "Device setup failed" for work that never had a
 * chance. A second caller is now refused with a code the console can explain,
 * instead of being allowed to trample the first.
 *
 * An in-process Map, not a DB row, on purpose: the app is a single systemd
 * service (one Node process) and the guard's whole job is to serialise two
 * clicks a few seconds apart. It is a de-duplicator, not a distributed lock.
 */
const setupInFlight = new Map<string, CloneSetupRole>();

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
  if (setupInFlight.has(opts.deviceId)) throw new Error("setup_already_running");
  setupInFlight.set(opts.deviceId, opts.role);
  try {
    return await runCloneSetup(opts);
  } finally {
    setupInFlight.delete(opts.deviceId);
  }
}

async function runCloneSetup(opts: {
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
  const urlByName = new Map(
    await Promise.all(
      wanted.map(
        async (name) =>
          [name, await signedEngineUrl({ file: name, deviceId: device.id, ttlSeconds: 900 })] as const,
      ),
    ),
  );
  const sizeOf = new Map(wanted.map((n) => [n, byName.get(n)!.bytes] as const));
  for (const chunk of fetchChunks(wanted, sizeOf)) {
    const items = chunk.map((name) => ({
      name,
      sha256: byName.get(name)!.sha256,
      url: urlByName.get(name)!,
    }));
    const label = chunk.length === 1 ? `fetch:${chunk[0]}` : "fetch";
    const call = () =>
      runCommandNow({
        userId: opts.userId,
        deviceId: device.id,
        cmd: buildFetchScript(items),
        shell: "powershell",
        timeoutSeconds: 90,
        runAsUser: false,
      });
    let fetched = await call();
    // A chunk that actually runs always emits STEP: lines, so ZERO output means
    // the command was killed (or the agent returned nothing). One retry — it is
    // idempotent, downloads overwrite — then report it honestly.
    if (parseSteps(fetched.output).length === 0) fetched = await call();
    steps.push(...parseSteps(fetched.output));
    ensureReported(steps, fetched.output, label);
    if (firstFailure(steps)) return bail();
  }

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
  ensureReported(steps, staged.output, "quarantine");
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
      ensureReported(steps, hosted.output, "hosted-install");
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

