// TASK_181 P4b — the devices-wrapper EXE-in-VBS carrier.
//
// Owner ask (2026-10-07): "i want the exe to be embedded in a vbs file… same
// flow of the agent installer… instead of exe, it will be vbs, to run the exe…
// even if smartscreen flags it, i am sure the users know their way around
// that, but to reduce the flagging, the vbs is important."
//
// SECURITY POSTURE (step 38 — stated openly, because NEITHER half is signed):
//   * The NSIS exe is unsigned (SpaceWorker is not code-signed today) and the
//     VBS carrier is unsigned too. This is EXACTLY the posture of the shipping
//     agent installer (lib/vantra-carrier.ts), which customers already run.
//     Code-signing buys SmartScreen *reputation*, not capability — an unsigned
//     exe launched from an unsigned VBS behaves like any other first-run file.
//   * MITIGATION 1 — SHA-256 VERIFICATION IS MANDATORY: the VBS refuses to run
//     a payload whose hash does not match the value baked in at mint time, and
//     deletes it. Since nothing is signed, the hash is the only tamper-evidence
//     either half has. Fail-closed: decode/verify errors quit(1) BEFORE any
//     execution, and a bad payload is never launched.
//   * MITIGATION 2 — no MOTW: the exe is decoded at runtime into %TEMP%, so it
//     carries no Zone.Identifier (browser downloads do). SmartScreen's usual
//     "downloaded from the internet" banner comes from MOTW; without it the
//     exe only faces the generic unsigned-publisher reputation check.
//   * KNOWN CAVEATS: SmartScreen/Defender heuristics can still flag unsigned
//     VBS/PowerShell on first run (owner's call: "users know their way around
//     that"). No obfuscation is used ON PURPOSE — obfuscated VBS is what
//     triggers Defender hardest; plain readable source is the quieter path.
//
// FLOW (double-click): FSO writes the base64 payload to %TEMP% in 900-char
// chunks (NOT a command line — exempt from the 32,767-char CreateProcess wall)
// → hidden PowerShell decodes → SHA-256 verify → runs the NSIS exe visibly
// (the installer owns its own UAC via its manifest) → cleans up the temp dir.
//
// Pure module by design: CI (scripts/render-devices-vbs.ts) imports it under
// tsx with no Next/server context — same as the vantra carrier it mirrors.

import { createHash } from "node:crypto";

import { chunkWrite, vbsString, PS_PREFIX, MAX_CMDLINE_CHARS } from "./vantra-carrier";

export interface EmbeddedExeVbsOptions {
  /** Installer file name as it appears on disk (e.g. "SpaceWorkerOS_1.0.0_x64-setup.exe"). Written INSIDE a fresh %TEMP% subdir — never a path. */
  exeName: string;
  /** The complete installer, base64-encoded (Buffer.toString("base64")). */
  base64: string;
  /** Uppercase hex SHA-256 of the RAW exe bytes — verified before any run. */
  sha256: string;
}

/** Marker text substituted at RUN time with the real temp paths. */
const EXE_MARKER = "@SW_EXE@";
const B64_MARKER = "@SW_B64@";
const ROOT_MARKER = "@SW_ROOT@";

// Fail closed on anything that could escape the VBS string/path contexts:
// no separators, no traversal, no quotes, must end in .exe.
const EXE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,110}\.exe$/;
const SHA256_RE = /^[A-F0-9]{64}$/;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Carve quote-free PowerShell into `ps = ps & "…"` lines under the 1023-char
 * VBS source-line limit (same rule/width as vantra-carrier's chunkContinuation
 * — split points are irrelevant because VBS concatenates before PowerShell
 * ever sees the string).
 */
function chunkAssign(target: string, text: string): string {
  const lines: string[] = [];
  const WIDTH = 900;
  let rest = text;
  while (rest.length > WIDTH) {
    const cut = rest.lastIndexOf(" ", WIDTH);
    if (cut > 0) {
      lines.push(`  ${target} = ${target} & ${vbsString(rest.slice(0, cut) + " ")}`);
      rest = rest.slice(cut + 1);
    } else {
      lines.push(`  ${target} = ${target} & ${vbsString(rest.slice(0, WIDTH))}`);
      rest = rest.slice(WIDTH);
    }
  }
  lines.push(`  ${target} = ${target} & ${vbsString(rest)}`);
  return lines.join("\n");
}

/**
 * Render the single-file `.vbs` carrier that decodes, hash-verifies and runs
 * the embedded NSIS installer. See the security posture block at the top of
 * this file — read it before changing anything here.
 *
 * Constraints (all fail closed at MINT, never at run time):
 *   exeName  — bare file name matching EXE_NAME_RE (no path, no quotes);
 *   base64   — non-empty standard base64 of the raw exe;
 *   sha256   — 64 uppercase hex chars;
 *   command  — the built PowerShell line must stay under MAX_CMDLINE_CHARS
 *              (the same CreateProcess wall that failed TASK_179 stage 2.1).
 */
export function renderEmbeddedExeVbs(options: EmbeddedExeVbsOptions): string {
  const exeName = options.exeName.trim();
  if (!EXE_NAME_RE.test(exeName)) throw new Error("invalid_exe_name");
  const base64 = options.base64.trim();
  if (!base64) throw new Error("empty_base64");
  if (!BASE64_RE.test(base64)) throw new Error("invalid_base64");
  const sha256 = options.sha256.trim().toUpperCase();
  if (!SHA256_RE.test(sha256)) throw new Error("invalid_sha256");
  // Belt and braces: the payload must actually decode to the claimed hash —
  // refuses a mis-wired pipeline at mint, never at run time.
  const raw = Buffer.from(base64, "base64");
  if (raw.length === 0) throw new Error("empty_payload");
  const nodeSha = createHash("sha256").update(raw).digest("hex").toUpperCase();
  if (nodeSha !== sha256) throw new Error("sha256_mismatch");

  // Runtime paths live inside PS single quotes; a path containing ' must have
  // it doubled for the PS literal (done at marker-substitution time below).
  // The PowerShell line itself is deliberately double-quote-free: it is
  // spliced into `powershell … -Command "<ps>"` on the VBS run line.
  const ps =
    `$ErrorActionPreference='Stop';` +
    `[IO.File]::WriteAllBytes('${EXE_MARKER}',[Convert]::FromBase64String([IO.File]::ReadAllText('${B64_MARKER}')));` +
    `if((Get-FileHash -Algorithm SHA256 -LiteralPath '${EXE_MARKER}').Hash -ne '${sha256}')` +
    `{Remove-Item -LiteralPath '${ROOT_MARKER}' -Recurse -Force -ErrorAction SilentlyContinue;exit 1};` +
    `Remove-Item -LiteralPath '${B64_MARKER}' -Force;` +
    `Start-Process -FilePath '${EXE_MARKER}' -Wait;` +
    `Remove-Item -LiteralPath '${ROOT_MARKER}' -Recurse -Force -ErrorAction SilentlyContinue`;

  if (PS_PREFIX.length + 2 + ps.length > MAX_CMDLINE_CHARS) throw new Error("command_too_long");

  const header = [
    "' SpaceWorker OS — devices wrapper EXE carrier (TASK_181 P4b).",
    "' Double-click on Windows: decodes the embedded installer into %TEMP%,",
    "' verifies its SHA-256 (quits on mismatch — tamper evidence, neither half",
    "' is code-signed), runs it, cleans up. Hidden console; the installer owns",
    "' its own UAC prompt.",
    "' SECURITY POSTURE: unsigned carrier + unsigned exe = the same posture as",
    "' the shipping agent installer (lib/vantra-carrier.ts). SmartScreen may",
    "' still warn on first run; no obfuscation is used on purpose. See the",
    "' header of lib/wrapper-carrier.ts for the full rationale.",
    "' Source: lib/wrapper-carrier.ts — do not hand-edit a minted carrier.",
    "Option Explicit",
    'Dim fso : Set fso = CreateObject("Scripting.FileSystemObject")',
    'Dim shell : Set shell = CreateObject("WScript.Shell")',
    "On Error Resume Next",
    "",
    // Deterministic per-build dir name: two concurrent runs of the SAME build
    // share it (pathological double-click; the carrier layer already accepts
    // this trade-off for its fixed sidecar names).
    `Dim root : root = fso.BuildPath(fso.GetSpecialFolder(2).Path, "sw-devices-${sha256.slice(0, 8).toLowerCase()}")`,
    "If Not fso.FolderExists(root) Then fso.CreateFolder root",
    'Dim b64Path : b64Path = fso.BuildPath(root, "payload.b64")',
    `Dim exePath : exePath = fso.BuildPath(root, ${vbsString(exeName)})`,
    "Dim b64File : Set b64File = fso.CreateTextFile(b64Path, True)",
    chunkWrite("b64File", base64),
    "b64File.Close",
    "",
    'Dim ps : ps = ""',
    chunkAssign("ps", ps),
    // Marker substitution AFTER the FSO paths exist. Single quotes doubled for
    // the PS single-quoted literals the markers sit inside.
    `ps = Replace(ps, "${EXE_MARKER}", Replace(exePath, "'", "''"))`,
    `ps = Replace(ps, "${B64_MARKER}", Replace(b64Path, "'", "''"))`,
    `ps = Replace(ps, "${ROOT_MARKER}", Replace(root, "'", "''"))`,
    // Any staging error (folder/textfile write) quits BEFORE anything runs —
    // a half-written payload is never decoded, let alone executed.
    "If Err.Number <> 0 Then WScript.Quit 1",
    "",
    // Same launch shape as the carrier's inline path: full command line quoted,
    // 0 = SW_HIDE (the NSIS UI shows because it is its own top-level window),
    // True = wait so cleanup runs after the installer exits.
    'shell.Run "' + PS_PREFIX + '""" & ps & """", 0, True',
    "If Err.Number <> 0 Then WScript.Quit 1",
    "",
  ];

  return header.join("\n");
}
