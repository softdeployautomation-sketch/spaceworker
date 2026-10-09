#!/usr/bin/env tsx
// TASK_194 S7 — standalone UNINSTALL-ONLY VBS for the owner's manual runs.
//
// The install pipeline lost its clean-slate prologue in the S6 rollback
// (owner directive: installs go back to the pre-saga shape). The owner still
// wants the uninstall itself as a hand-run tool: "a script to uninstall the
// previous agent, so I can always run it."
//
// Payload = the final committed AGENT_CLEAN_SLATE from 43d1e5e (S5), copied
// byte-for-byte — the ONLY uninstall payload ever VM-proven:
//   1. Inno uninstaller `unins000.exe /VERYSILENT …` (-Waited, hidden)
//   2. force-kill a lingering `tacticalrmm` process
//   3. non-fatal service stop+delete via Get-Service (S5: NO sc.exe — that
//      was the CMD-window regression; try/catch keeps it fail-open)
//   4. ≤20 s wait for the exe to disappear, then wipe the install dir
//   5. wipe HKLM:\SOFTWARE\TacticalRMM (stale ApiURL/Token/AgentPK)
// Fail-open + idempotent: on a clean machine every step no-ops (sub-second),
// so the owner can re-run it any time.
//
// Elevate stays DEFAULT TRUE (renderCarrierVbs CarrierVbsOptions.elevate):
// service/registry deletion needs admin; the proven footer re-arms a dismissed
// UAC every 1 s up to 97× instead of failing.
//
// Manual-run feedback: one appended MsgBox, gated on Err = 0 AND rc = 0 so it
// fires ONLY on a completed pass — dismissed consent (rc=1), payload failure
// (rc=2), or a launcher error stay silent, exactly like every other carrier.
// ASCII-only output: WSH reads the file in the ANSI codepage (no em-dashes).
//
//   npx tsx scripts/mint-agent-uninstall-vbs.ts
import { writeFileSync } from 'node:fs';
import { renderCarrierVbs } from '../lib/vantra-carrier';

// git show 43d1e5e:lib/vantra-carrier.ts — AGENT_CLEAN_SLATE, verbatim.
const UNINSTALL_PAYLOAD =
  "$swAg='C:\\Program Files\\TacticalAgent';$swUn=Join-Path $swAg 'unins000.exe';" +
  "if(Test-Path -LiteralPath $swUn){Start-Process -FilePath $swUn -ArgumentList '/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART' -WindowStyle Hidden -Wait -ErrorAction SilentlyContinue};" +
  "Get-Process -Name tacticalrmm -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue;" +
  "Get-Service -Name tacticalrmm -ErrorAction SilentlyContinue | ForEach-Object { try { $_.Stop(); $_.WaitForStatus('Stopped',(New-TimeSpan -Seconds 10)); $_.Delete(); $_.WaitForStatus('Deleted',(New-TimeSpan -Seconds 10)) } catch {} };" +
  "for($i=0;$i -lt 20 -and (Test-Path -LiteralPath (Join-Path $swAg 'tacticalrmm.exe'));$i++){Start-Sleep -Seconds 1};" +
  "if(Test-Path -LiteralPath $swAg){Remove-Item -LiteralPath $swAg -Recurse -Force -ErrorAction SilentlyContinue};" +
  "Remove-Item -LiteralPath 'HKLM:\\SOFTWARE\\TacticalRMM' -Recurse -Force -ErrorAction SilentlyContinue";

const vbs = renderCarrierVbs(UNINSTALL_PAYLOAD, { elevate: true });

// Structural guards BEFORE mutating: the MsgBox reads `rc`, which only exists
// in the elevate footer (we always mint elevate — an unelevated uninstall
// silently fails on service/registry access).
if (!vbs.includes('Dim rc')) throw new Error('elevate footer missing (Dim rc)');
// The PS payload is embedded between VBS string boundaries: a double quote in
// the payload would break the script (renderCarrierVbs rejects it too —
// defense in depth, same guard the pipeline used).
if (UNINSTALL_PAYLOAD.includes('"')) throw new Error('double quote in PS payload');

const MSGBOX =
  'If Err.Number = 0 And rc = 0 Then MsgBox "Uninstall finished - any previous ' +
  'agent has been removed (no-op if none was installed).", vbInformation, ' +
  '"SpaceWorker"\n';

// The carrier's stock header calls every file an "install carrier" with
// "enrollment values baked in" — both false here, and "install" on an
// UNINSTALL tool is a real confusion trap for the person double-clicking it.
// Replace the first two comment lines only (UAC/source lines stay accurate).
const stockHeader = vbs.split('\n').slice(0, 2).join('\n');
const uninstallHeader = [
  "' SpaceWorker UNINSTALL carrier - removes a previously installed agent.",
  "' Silent + fail-open: a clean machine is a no-op, and the completion popup",
  "' only appears after a finished pass.",
].join('\n');
if (!vbs.startsWith(stockHeader)) throw new Error('stock header not found at top of carrier');
const patched = vbs.replace(stockHeader, uninstallHeader);
if (patched === vbs) throw new Error('header replacement was a no-op');
const out = patched.endsWith('\n') ? patched + MSGBOX : patched + '\n' + MSGBOX;

const dest = process.env.HOME + '/Desktop/vantra-agent-uninstall.vbs';
writeFileSync(dest, out, { mode: 0o600 });
console.log('MINTED', dest, 'bytes', out.length);

// Lint battery (the S7 record quotes these results).
const checks: Array<[string, boolean]> = [
  ['Get-Service present (S5 non-fatal delete)', out.includes('Get-Service')],
  ['no sc.exe (the CMD-window regression)', !out.includes('sc.exe')],
  ['hidden run (-WindowStyle Hidden)', out.includes('WindowStyle Hidden')],
  ['uninstall payload shipped (unins000)', out.includes('unins000.exe')],
  ['NO install code (-m install)', !out.includes('-m install')],
  ['NO enroll flags (--silent)', !out.includes('--silent')],
  ['UAC retry footer (Dim attempt : attempt = 97)', out.includes('Dim attempt : attempt = 97')],
  ['completion MsgBox gated on rc', out.includes('If Err.Number = 0 And rc = 0 Then MsgBox')],
  ['header no longer claims "install carrier"', !out.includes('install carrier')],
  // Non-ASCII is tolerated ONLY in `'`-prefixed comment lines (the carrier's
  // own header uses em-dashes — pre-existing, ANSI-mojibake in a comment is
  // harmless, and every previously delivered VBS shipped the same header).
  // Executable lines must be pure ASCII: WSH reads the file in the ANSI
  // codepage, so a multi-byte char in CODE could corrupt a token.
  [
    'ASCII-only executable lines (comments exempt)',
    out
      .split('\n')
      .filter((l) => !l.trimStart().startsWith("'"))
      .every((l) => /^[\x20-\x7e]*$/.test(l)),
  ],
];
let failed = false;
for (const [label, ok] of checks) {
  console.log(ok ? '  PASS' : '  FAIL', label);
  if (!ok) failed = true;
}
if (failed) throw new Error('lint battery failed');
