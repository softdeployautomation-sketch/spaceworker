// TASK_177 — OpenFrame one-click carrier: the binder (Phase 2 of the spike).
//
// WHY THIS FILE EXISTS: OpenFrame hands out its agent install as a raw
// PowerShell one-liner (dashboard → "OpenFrame Installation Script"). There is
// no installer EXE to double-click, and our own pipeline only mints Vantra
// launcher ZIPs. The owner wants this kind of command bound into ONE
// double-clickable file, with the per-device values supplied AT MINT TIME —
// never baked at build time (the TASK_177 gate: mint twice, the two renders
// may differ ONLY in the values).
//
// Two layers, deliberately separated:
//   1. renderOpenFrameInstallCommand(values) — the EXACT dashboard script
//      shape, fail-closed validated so a typo can never enroll a device into
//      the wrong tenant (serverUrl/orgId/userId/initialKey are all
//      tenant-scoped; machineId scopes the download header).
//   2. renderCarrierVbs(powershellCommand) — GENERIC: any double-quote-free,
//      single-line PowerShell command → one .vbs that runs it hidden (and, by
//      default, UAC-elevated — service installs require admin). This is the
//      "binder" the owner asked for; the OpenFrame command is its first
//      client. A future command of the same shape binds the same way.
//
// The .vbs is plain TEXT: mint = string render. No toolchain, no build step,
// no zip — that is the whole feasibility argument for the single-file carrier
// (TASK_177_OPENFRAME_ONECLICK_FEASIBILITY_REPORT.md §4 F4a).
//
// VBS sunset reality (checked 2026-10-07): VBScript is deprecated (Feature on
// Demand) on Win11 24H2+/Server 2025 but still ENABLED BY DEFAULT; the
// published Microsoft roadmap disables it by default only in a future 2027
// release. VBS is the right carrier TODAY; the durable carrier is an EXE
// (phase 2 — needs a Windows build; the repo already has windows-latest CI
// runners in .github/workflows/build-exe.yml).
//
// Line-budget note: VBScript source lines cap at 1023 chars (WSH limit), so
// the ps = assignment is chunked with `& _` continuations well below that.

/** The five per-mint, per-tenant values of an OpenFrame install. */
export interface OpenFrameCarrierValues {
  /** Bare host (+optional port), NO scheme: `<dashboard-host>`. */
  serverUrl: string;
  /** UUID sent as the `x-machine-id` download header. */
  machineId: string;
  /** Per-device enrollment key (OpenFrame `--initialKey`). */
  initialKey: string;
  /** Tenant UUID (OpenFrame `--orgId`). */
  orgId: string;
  /** Enrolling user UUID (OpenFrame `--userId`). */
  userId: string;
}

export interface CarrierVbsOptions {
  /**
   * UAC-elevate before running PowerShell (DEFAULT TRUE: `install` refuses
   * without admin — `PermissionUtils::require_admin()` in openframe's cli.rs).
   * `false` = `WScript.Shell.Run` unelevated, for already-elevated contexts.
   */
  elevate?: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Hostname (+ optional :port). Deliberately rejects `://`, `/`, spaces and
// quotes: everything that could smuggle a second command or a URL rewrite.
const SERVER_URL_RE =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/i;
// OpenFrame keys look like `kXyZa-bCdEf_...` (format illustration only — a
// real key must never appear here): alnum, dash, underscore.
const INITIAL_KEY_RE = /^[A-Za-z0-9_-]{8,128}$/;

/**
 * Fail-closed tenant-value validation. Every check throws a stable code string
 * (house style: error messages ARE machine-readable codes) — a bad value must
 * never produce a render, because a wrong orgId/userId/initialKey enrolls the
 * customer's machine into the wrong tenant.
 */
export function validateOpenFrameValues(
  values: OpenFrameCarrierValues,
): OpenFrameCarrierValues {
  if (!values || typeof values !== "object") throw new Error("invalid_values");
  const serverUrl = String(values.serverUrl ?? "").trim();
  const machineId = String(values.machineId ?? "").trim();
  const initialKey = String(values.initialKey ?? "").trim();
  const orgId = String(values.orgId ?? "").trim();
  const userId = String(values.userId ?? "").trim();
  if (!SERVER_URL_RE.test(serverUrl)) throw new Error("invalid_server_url");
  if (!UUID_RE.test(machineId)) throw new Error("invalid_machine_id");
  if (!INITIAL_KEY_RE.test(initialKey)) throw new Error("invalid_initial_key");
  if (!UUID_RE.test(orgId)) throw new Error("invalid_org_id");
  if (!UUID_RE.test(userId)) throw new Error("invalid_user_id");
  return { serverUrl, machineId, initialKey, orgId, userId };
}

/**
 * The OpenFrame dashboard's install script, rendered from validated values.
 * Byte-for-byte the same shape the dashboard copies (verified against a live
 * SoftStack acct 2026-10-07; values below are placeholders, never live ones).
 */
export function renderOpenFrameInstallCommand(
  values: OpenFrameCarrierValues,
): string {
  const v = validateOpenFrameValues(values);
  return (
    "Set-Location ~; Remove-Item -Path 'openframe-client.zip','openframe-client.exe' " +
    "-Force -ErrorAction SilentlyContinue; " +
    "Invoke-WebRequest -Uri 'https://" +
    v.serverUrl +
    "/v0/api/assets/download?agent=client&platform=windows' " +
    "-Headers @{ 'x-machine-id' = '" +
    v.machineId +
    "' } -OutFile 'openframe-client.zip'; " +
    "Expand-Archive -Path 'openframe-client.zip' -DestinationPath '.' -Force; " +
    "& '.\\openframe-client.exe' install --serverUrl " +
    v.serverUrl +
    " --initialKey " +
    v.initialKey +
    " --orgId " +
    v.orgId +
    " --userId " +
    v.userId
  );
}

// ---------------------------------------------------------------------------
// The generic carrier: any single-line PowerShell command → one .vbs
// ---------------------------------------------------------------------------

// PS flags: no profile (deterministic), no interactive prompts (a hidden
// window must never stall waiting for stdin), bypass policy for our one-shot
// script, hidden window. The command itself is embedded with doubled-quote
// VBS escaping; validation below guarantees it contains no `"` in the first
// place (defense in depth: escaping AND rejection).
/** PS flag prefix shared by both launch paths (exported for tests). */
export const PS_FLAGS =
  "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -Command ";
export const PS_PREFIX = "powershell.exe " + PS_FLAGS;

/** VBScript string-literal escaping (double the quotes). */
function vbsString(value: string): string {
  return '"' + value.replace(/"/g, '""') + '"';
}

/** Carve a long PS command into `ps = ps & "..."` lines under the 1023-char
 *  VBScript source-line limit. Chunks rejoin EXACTLY (tested): split points
 *  are irrelevant to correctness because VBS concatenates before PowerShell
 *  ever sees the string — spaces are preferred only for human diffing. */
function chunkContinuation(command: string): string {
  const lines: string[] = [];
  let rest = command;
  const WIDTH = 900;
  while (rest.length > WIDTH) {
    const cut = rest.lastIndexOf(" ", WIDTH);
    if (cut > 0) {
      lines.push(`  ps = ps & ${vbsString(rest.slice(0, cut) + " ")}`);
      rest = rest.slice(cut + 1);
    } else {
      lines.push(`  ps = ps & ${vbsString(rest.slice(0, WIDTH))}`);
      rest = rest.slice(WIDTH);
    }
  }
  lines.push(`  ps = ps & ${vbsString(rest)}`);
  return lines.join("\n");
}

/**
 * Render a single-file `.vbs` carrier that runs the given PowerShell command
 * hidden on double-click.
 *
 * `elevate` (default true) routes through Shell.Application.ShellExecute with
 * the `runas` verb → one UAC consent, then the command runs hidden as admin —
 * `openframe-client install` refuses to run without admin. With `elevate:false`
 * it uses WScript.Shell.Run (window style 0 = hidden, no UAC) for contexts
 * that are already elevated or for non-admin installs.
 *
 * Command constraints (fail closed): non-empty, single line, and NO `"` —
 * the command is embedded verbatim between VBS string boundaries, and a
 * double quote is the only way out of that context. The OpenFrame dashboard
 * command satisfies this (it quotes everything with single quotes).
 */
export function renderCarrierVbs(
  powershellCommand: string,
  options: CarrierVbsOptions = {},
): string {
  const command = powershellCommand.trim();
  if (!command) throw new Error("empty_command");
  if (/[\r\n\t]/.test(command)) throw new Error("multiline_command");
  if (command.includes('"')) throw new Error("double_quote_command");
  const elevate = options.elevate !== false;

  const header = [
    "' SpaceWorker OpenFrame install carrier (TASK_177).",
    "' Generated at MINT time — per-device values are baked into THIS file.",
    "' Double-click to run. Requires one UAC consent (install needs admin).",
    "' Source: lib/openframe-carrier.ts — do not hand-edit a minted carrier.",
    "Option Explicit",
    "Dim ps : ps = \"\"",
    "On Error Resume Next",
    "",
  ].join("\n");

  const body = chunkContinuation(command);

  const footer = elevate
    ? [
        "",
        "If Err.Number <> 0 Then WScript.Quit 1",
        "Dim shell : Set shell = CreateObject(\"Shell.Application\")",
        // Escaping decode of the middle argument (VBS string rules: "" = one
        // literal quote, & = concatenation OUTSIDE quotes):
        //   value = `-NoProfile ... -Command "` & ps & `"`
        // runas = UAC elevation (install requires admin); 0 = SW_HIDE after
        // consent. The command itself never contains " (validated above), so
        // the single wrapping pair of quotes survives intact.
        'shell.ShellExecute "powershell.exe", "' + PS_FLAGS + '""" & ps & """", "", "runas", 0',
        "If Err.Number <> 0 Then WScript.Quit 1",
        "",
      ].join("\n")
    : [
        "",
        "If Err.Number <> 0 Then WScript.Quit 1",
        "Dim shell : Set shell = CreateObject(\"WScript.Shell\")",
        // Run takes the FULL command line (program included). 0 = SW_HIDE: no
        // console window flashes. Use only when already elevated — install
        // fails without admin, and unelevated there is no UAC prompt here.
        'shell.Run "' + PS_PREFIX + '""" & ps & """", 0, False',
        "If Err.Number <> 0 Then WScript.Quit 1",
        "",
      ].join("\n");

  return header + body + "\n" + footer;
}

