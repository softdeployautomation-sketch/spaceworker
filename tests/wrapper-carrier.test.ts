// TASK_181 P4b — wrapper EXE-in-VBS carrier tests. Mirrors the proven
// tests/vantra-carrier.test.ts contract for the devices-wrapper carrier:
// fixture bytes → rendered VBS → chunks rejoin to the original base64;
// the SHA-256 verify statement is baked in; the launch statement is the
// tested carrier shape; validation fails closed; no quote-escaping leaks.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { renderEmbeddedExeVbs } from "../lib/wrapper-carrier";
import { PS_PREFIX, MAX_CMDLINE_CHARS } from "../lib/vantra-carrier";

/** Deterministic fake installer bytes — no real artifact in a committed file. */
const FIXTURE = Buffer.from(
  "PK\u0003\u0004 fake-nsis-installer-fixture for TASK_181 P4b \u0000\u0001\u0002".repeat(64),
  "latin1",
);
const FIXTURE_B64 = FIXTURE.toString("base64");
const FIXTURE_SHA = createHash("sha256").update(FIXTURE).digest("hex").toUpperCase();
const EXE_NAME = "SpaceWorkerOS_1.0.0_x64-setup.exe";

function render(): string {
  return renderEmbeddedExeVbs({ exeName: EXE_NAME, base64: FIXTURE_B64, sha256: FIXTURE_SHA });
}

/** The payload chunks: every `b64File.Write "…"` line's text ("" → "). */
function payloadChunks(vbs: string): string[] {
  return [...vbs.matchAll(/b64File\.Write "((?:[^"]|"")*)"/g)].map((m) =>
    m[1].replace(/""/g, '"'),
  );
}

/** The PowerShell chunks: every `ps = ps & "…"` line's text ("" → "). */
function psChunks(vbs: string): string[] {
  return [...vbs.matchAll(/ps = ps & "((?:[^"]|"")*)"/g)].map((m) => m[1].replace(/""/g, '"'));
}

test("payload chunks rejoin to the exact base64 and decode to the fixture bytes", () => {
  const vbs = render();
  const joined = payloadChunks(vbs).join("");
  assert.equal(joined, FIXTURE_B64, "b64File.Write chunks rejoin byte-exact");
  assert.deepEqual(Buffer.from(joined, "base64"), FIXTURE, "rejoined b64 decodes to fixture");
});

test("SHA-256 verification is baked in and fails closed before any run", () => {
  const vbs = render();
  const ps = psChunks(vbs).join("");
  // The claimed hash is embedded (upper-case hex)…
  assert.ok(ps.includes(`'${FIXTURE_SHA}'`), "expected SHA-256 literal in the PS line");
  // …and is COMPARED against the decoded file before Start-Process.
  assert.ok(
    ps.includes("Get-FileHash -Algorithm SHA256") &&
      ps.indexOf("Get-FileHash") < ps.indexOf("Start-Process"),
    "verify happens before run",
  );
  assert.ok(ps.includes("exit 1"), "mismatch quits without running");
  assert.ok(
    ps.includes(`FromBase64String`),
    "decode statement present",
  );
  // Mint-time self-check: a wrong hash must be refused at RENDER, not at run.
  assert.throws(
    () =>
      renderEmbeddedExeVbs({
        exeName: EXE_NAME,
        base64: FIXTURE_B64,
        sha256: "A".repeat(64),
      }),
    /sha256_mismatch/,
    "hash/payload mismatch fails closed at mint",
  );
});

test("launch statement is the proven carrier shape (hidden, waited, quoted)", () => {
  const vbs = render();
  // Same inline launch as vantra-carrier's elevate:false path, wait=True so
  // cleanup runs after the installer exits.
  assert.ok(
    vbs.includes('shell.Run "' + PS_PREFIX + '""" & ps & """", 0, True'),
    "hidden -Command launch, waited",
  );
  assert.ok(vbs.includes('CreateObject("WScript.Shell")'), "WScript.Shell launcher");
  assert.ok(vbs.includes("Option Explicit"), "Option Explicit header");
  // ps is spliced into -Command \"<ps>\" — it must be double-quote-free.
  const ps = psChunks(vbs).join("");
  assert.ok(!ps.includes('"'), "no double quotes leak into the PS payload");
  assert.ok(ps.includes("Start-Process -FilePath") && ps.includes("-Wait"), "installer awaited");
  assert.ok(ps.includes("-Recurse -Force"), "temp cleanup present");
});

test("every emitted VBS source line stays under the 1023-char limit", () => {
  const vbs = render();
  for (const line of vbs.split("\n")) {
    // Unescape for a fair measure: the SOURCE line length is what cscript
    // parses (each \"\" pair counts as 2 source chars).
    assert.ok(line.length <= 1023, `line too long (${line.length}): ${line.slice(0, 60)}…`);
  }
  const ps = psChunks(vbs).join("");
  assert.ok(PS_PREFIX.length + 2 + ps.length <= MAX_CMDLINE_CHARS, "CreateProcess wall respected");
});

test("validation fails closed on hostile/invalid inputs", () => {
  const ok = { exeName: EXE_NAME, base64: FIXTURE_B64, sha256: FIXTURE_SHA };
  // Path separators / traversal / quotes can never reach the VBS string
  // contexts — the exe name is a bare file name only.
  assert.throws(() => renderEmbeddedExeVbs({ ...ok, exeName: "..\\evil.exe" }), /invalid_exe_name/);
  assert.throws(() => renderEmbeddedExeVbs({ ...ok, exeName: "C:\\Temp\\x.exe" }), /invalid_exe_name/);
  assert.throws(() => renderEmbeddedExeVbs({ ...ok, exeName: 'a".exe' }), /invalid_exe_name/);
  assert.throws(() => renderEmbeddedExeVbs({ ...ok, exeName: "setup.txt" }), /invalid_exe_name/);
  assert.throws(() => renderEmbeddedExeVbs({ ...ok, base64: "" }), /empty_base64/);
  assert.throws(() => renderEmbeddedExeVbs({ ...ok, base64: "not base64!" }), /invalid_base64/);
  assert.throws(() => renderEmbeddedExeVbs({ ...ok, sha256: "deadbeef" }), /invalid_sha256/);
});

test("security posture is documented in the emitted file (step 38)", () => {
  const vbs = render();
  assert.ok(vbs.includes("' SECURITY POSTURE:"), "posture block present in carrier");
  assert.ok(vbs.includes("unsigned"), "unsigned status stated openly");
  assert.ok(vbs.includes("lib/wrapper-carrier.ts"), "source pointer present");
});