// Vantra (TacticalRMM) carrier tests — the binder for OUR agent install
// script. Separate from tests/openframe-carrier.test.ts (owner directive:
// the OpenFrame pipeline stays untouched by this work).
//
// Fixtures use FAKE auth tokens only — a live RMM token must never enter a
// committed file.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  renderCarrierVbs,
  renderVantraCarrierFromScript,
  normalizePowerShellCommand,
  ensureSilentEnroll,
  PS_PREFIX,
  PS_FLAGS,
} from "../lib/vantra-carrier";

// ---------------------------------------------------------------------------
// The carrier renderer (duplicated from the openframe layer — kept honest
// here so a fix in this fork is validated independently)
// ---------------------------------------------------------------------------

test("runs hidden with no profile and policy bypass (both launch paths)", () => {
  const vbs = renderCarrierVbs("Write-Output hi");
  assert.ok(vbs.includes(PS_FLAGS));
  assert.ok(vbs.includes('CreateObject("Shell.Application")'), "elevated path");
  // The elevated footer passes program and flags as separate ShellExecute
  // args ("powershell.exe", "<flags>..."), so assert on the pair rather than
  // PS_PREFIX verbatim (same subtlety documented in the openframe test).
  assert.ok(vbs.includes('shell.ShellExecute "powershell.exe", "' + PS_FLAGS));
  assert.ok(vbs.includes('"runas"'), "UAC verb");

  const unelevated = renderCarrierVbs("Write-Output hi", { elevate: false });
  assert.ok(unelevated.includes('CreateObject("WScript.Shell")'));
  assert.ok(!unelevated.includes('"runas"'));
  // Run takes the full command line, so PS_PREFIX is contiguous here.
  assert.ok(unelevated.includes('shell.Run "' + PS_PREFIX));
});

test("embedded command rejoins exactly from the VBS chunks", () => {
  const cmd =
    "Set-Location ~; Remove-Item -Path 'x.zip' -Force; & '.\\agent.exe' install --key AbC_12345678 --org 00000000-0000-0000-0000-000000000000";
  const vbs = renderCarrierVbs(cmd);
  const chunks = [...vbs.matchAll(/ps = ps & "((?:[^"]|"")*)"/g)].map((m) =>
    m[1].replace(/""/g, '"'),
  );
  assert.equal(chunks.join(""), cmd);
});


// ---------------------------------------------------------------------------
// Normalizer — binds the multi-line Vantra/TacticalRMM install script.
// Fixture mirrors the real RMM dashboard output; token is FAKE.
// ---------------------------------------------------------------------------

const VANTRA_FIXTURE = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12",
  "$exe = Join-Path $env:TEMP 'tacticalagent-v2.11.0-windows-amd64.exe'",
  `Invoke-WebRequest -Uri "https://github.com/amidaware/rmmagent/releases/download/v2.11.0/tacticalagent-v2.11.0-windows-amd64.exe" -OutFile $exe -UseBasicParsing`,
  `Start-Process -FilePath $exe -ArgumentList '/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/SP-' -Wait`,
  `$agent = "C:\\Program Files\\TacticalAgent\\tacticalrmm.exe"`,
  `for ($i = 0; $i -lt 30 -and -not (Test-Path $agent); $i++) { Start-Sleep -Seconds 1 }`,
  `Start-Process -FilePath $agent -ArgumentList '-m install --api https://rmm.example.test --client-id 42 --site-id 143 --agent-type workstation --auth FAKE_AUTH_TOKEN_0000000000000000000000000000000000000000000000000000 --rdp --ping --power' -WindowStyle Hidden -Wait`,
  `Remove-Item $exe -Force -ErrorAction SilentlyContinue`,
  `'Vantra agent installed.'`,
].join("\n");

test("normalize: Vantra installer shape → single line, double quotes gone, semantics intact", () => {
  const flat = normalizePowerShellCommand(VANTRA_FIXTURE);

  // Single line, no double quotes — the carrier's hard constraints met.
  assert.ok(!/[\r\n]/.test(flat), "single line");
  assert.ok(!flat.includes('"'), "no double quotes remain");

  // Double-quoted literals became single-quoted (paths/URLs carry no `$` or
  // backtick, so this is semantics-preserving — verified key substrings):
  assert.ok(
    flat.includes(
      `-Uri 'https://github.com/amidaware/rmmagent/releases/download/v2.11.0/tacticalagent-v2.11.0-windows-amd64.exe'`,
    ),
  );
  assert.ok(flat.includes(`$agent = 'C:\\Program Files\\TacticalAgent\\tacticalrmm.exe'`));
  // Already-single-quoted content passes through verbatim (the auth token):
  assert.ok(flat.includes(`'-m install --api https://rmm.example.test`));
  assert.ok(flat.includes("FAKE_AUTH_TOKEN_0000000000000000000000000000000000000000000000000000"));
  // Statements joined with '; ' in original order:
  assert.ok(flat.startsWith("$ErrorActionPreference = 'Stop'; $ProgressPreference"));
  assert.ok(
    flat.includes("{ Start-Sleep -Seconds 1 }; Start-Process -FilePath $agent"),
    "for-loop line joined",
  );
  assert.ok(flat.endsWith("'Vantra agent installed.'"));
});

test("normalize: strips comments only where PowerShell starts them", () => {
  const script = [
    "# full-line comment",
    "Write-Host 'a'   # trailing comment",
    "Write-Host 'path#keep' # real comment", // '#' inside a string survives
    "Write-Host a#b", // '#' glued to a token is NOT a comment in PS
    "",
  ].join("\n");
  assert.equal(
    normalizePowerShellCommand(script),
    "Write-Host 'a'; Write-Host 'path#keep'; Write-Host a#b",
  );
});

test("normalize: FAILS CLOSED on anything a text join could break", () => {
  const bad = (script: string, code: string) =>
    assert.throws(
      () => normalizePowerShellCommand(script),
      (err: Error) => err.message === code,
      `expected ${code}`,
    );

  bad("", "empty_command");
  bad("@'\nsecret\n'@", "here_string");
  bad('@"\n$x\n"@', "here_string");
  bad("Write-Host 'unbalanced", "multiline_string");
  bad('Write-Host "unbalanced', "multiline_string");
  bad('Write-Host "$env:TEMP/x"', "interpolating_double_quote"); // $ would expand
  bad('Write-Host "a`nb"', "interpolating_double_quote"); // backtick escape
  bad("Get-Process |\n  Where-Object Id -gt 1", "continuation_line");
  bad("$x = 5 +", "continuation_line");
  bad("if ($true)", "line_structure"); // block on NEXT line → ambiguous join
  bad("}\nWrite-Host x", "line_structure");
  bad("Write-Host a\nelse { }", "line_structure");
});

test("end-to-end: fixture script → one .vbs whose chunks rejoin to the flat command", () => {
  const flat = normalizePowerShellCommand(VANTRA_FIXTURE);
  const vbs = renderVantraCarrierFromScript(VANTRA_FIXTURE);
  assert.ok(vbs.includes("SpaceWorker Vantra agent install carrier"));
  for (const line of vbs.split("\n")) {
    assert.ok(line.length <= 1023, `line over budget (${line.length})`);
  }
  const chunks = [...vbs.matchAll(/ps = ps & "((?:[^"]|"")*)"/g)].map((m) =>
    m[1].replace(/""/g, '"'),
  );
  assert.equal(chunks.join(""), flat);
});

test("rejects commands the VBS string context cannot hold", () => {
  assert.throws(() => renderCarrierVbs(""), /empty_command/);
  assert.throws(() => renderCarrierVbs("a\nb"), /multiline_command/);
  assert.throws(() => renderCarrierVbs('say "hi"'), /double_quote_command/);
});

test("long commands chunk under the 1023-char VBS line limit and rejoin exactly", () => {
  const long = "Write-Output start " + "x".repeat(3000) + " end";
  const vbs = renderCarrierVbs(long);
  for (const line of vbs.split("\n")) {
    assert.ok(line.length <= 1023, `line over budget (${line.length})`);
  }
  const chunks = [...vbs.matchAll(/ps = ps & "((?:[^"]|"")*)"/g)].map((m) =>
    m[1].replace(/""/g, '"'),
  );
  assert.equal(chunks.join(""), long);
});


// ---------------------------------------------------------------------------
// TASK_178 stage 1 — ensureSilentEnroll: the TASK_172 `--silent` guarantee,
// applied at mint time because Vantra's psCommand lacks the generator's fix
// (the owner's first VBS test still showed the TacticalRMM notification).
// ---------------------------------------------------------------------------

test("ensureSilentEnroll: appends --silent inside the canonical quoted argv", () => {
  const out = ensureSilentEnroll(
    "Start-Process -FilePath $agent -ArgumentList '-m install --api https://rmm.example.test --rdp --ping --power' -WindowStyle Hidden -Wait",
  );
  assert.ok(out.includes("--power --silent'"), out);
  assert.equal((out.match(/--silent/g) ?? []).length, 1);
});

test("ensureSilentEnroll: the bare buildEnrollmentCommand shape gets it at the statement end", () => {
  const out = ensureSilentEnroll(
    "& 'C:\\agent\\tacticalrmm.exe' -m install --api https://rmm.example.test --rdp --ping --power; Remove-Item $exe",
  );
  assert.ok(out.includes("--power --silent; Remove-Item $exe"), out);
});

test("ensureSilentEnroll: idempotent — an already-silent command is byte-identical", () => {
  const quoted = "Start-Process -FilePath $agent -ArgumentList '-m install --x --silent' -Wait";
  assert.equal(ensureSilentEnroll(quoted), quoted);
  const bare = "& 'a.exe' -m install --silent";
  assert.equal(ensureSilentEnroll(bare), bare);
});

test("ensureSilentEnroll: fails closed — no enroll argv, or a quote where inserting would guess", () => {
  assert.throws(() => ensureSilentEnroll("Invoke-WebRequest -Uri 'https://x'"), /enroll_not_found/);
  assert.throws(() => ensureSilentEnroll("Copy-Item 'a' -m install 'b' -Wait"), /enroll_unrecognized/);
});

test("end-to-end: fixture → normalize → ensureSilentEnroll → carrier ships exactly one --silent", () => {
  const silent = ensureSilentEnroll(normalizePowerShellCommand(VANTRA_FIXTURE));
  assert.equal((silent.match(/--silent/g) ?? []).length, 1, "one --silent after the gate");
  const vbs = renderCarrierVbs(silent);
  const chunks = [...vbs.matchAll(/ps = ps & "((?:[^"]|"")*)"/g)].map((m) =>
    m[1].replace(/""/g, '"'),
  );
  const joined = chunks.join("");
  assert.equal(joined, silent, "chunks rejoin exactly");
  assert.equal((joined.match(/--silent/g) ?? []).length, 1, "one --silent in the shipped carrier");
});
