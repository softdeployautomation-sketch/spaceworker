import { test } from "node:test";
import assert from "node:assert/strict";

import {
  renderOpenFrameInstallCommand,
  renderCarrierVbs,
  validateOpenFrameValues,
  PS_PREFIX,
  PS_FLAGS,
  type OpenFrameCarrierValues,
} from "../lib/openframe-carrier";

// TASK_177 — the OpenFrame one-click carrier gate, as a committed test.
//
// The TASK_177 gate, verbatim: "mint twice with two different placeholder
// sets → the two renders diff ONLY the values → both run the right values
// silently." This file proves the first half mechanically (the diff test IS
// the gate); the "runs silently on Windows" half is a manual step on owner
// hardware (scripts/mint-openframe-carrier.ts renders the file to double-click).
//
// Everything below uses obvious fake placeholders. The gate's hygiene rule:
// a live initialKey/orgId/userId/machine-id must never appear in a committed
// file — not even in a test fixture.

const SET_A: OpenFrameCarrierValues = {
  serverUrl: "alpha.example.test",
  machineId: "00000000-0000-4000-8000-00000000000a",
  initialKey: "AAAAAAAA_kEY_aaaaaaaaaaaaaaaa",
  orgId: "00000000-0000-4000-8000-00000000000b",
  userId: "00000000-0000-4000-8000-00000000000c",
};

const SET_B: OpenFrameCarrierValues = {
  serverUrl: "bravo.other.test",
  machineId: "00000000-0000-4000-8000-00000000000d",
  initialKey: "BBBBBBBB_kEY_bbbbbbbbbbbbbbbb",
  orgId: "00000000-0000-4000-8000-00000000000e",
  userId: "00000000-0000-4000-8000-00000000000f",
};

/** Replace every tenant value in a render with a fixed token. */
function normalize(render: string, values: OpenFrameCarrierValues): string {
  let out = render;
  for (const v of [values.serverUrl, values.machineId, values.initialKey, values.orgId, values.userId]) {
    out = out.split(v).join("<VAL>");
  }
  return out;
}

test("GATE: two mints diff ONLY in the five values (both command and carrier)", () => {
  const cmdA = renderOpenFrameInstallCommand(SET_A);
  const cmdB = renderOpenFrameInstallCommand(SET_B);
  const vbsA = renderCarrierVbs(cmdA);
  const vbsB = renderCarrierVbs(cmdB);

  // The renders are not identical — values really are baked per mint.
  assert.notEqual(cmdA, cmdB);
  assert.notEqual(vbsA, vbsB);

  // After substituting the five values, byte-identical: the template (the
  // ONLY thing that could drift between mints) is mint-invariant. This is
  // the anti-static-bake assertion — a hardcoded serverUrl/key in the
  // template would fail here.
  assert.equal(normalize(cmdA, SET_A), normalize(cmdB, SET_B));
  assert.equal(normalize(vbsA, SET_A), normalize(vbsB, SET_B));

  // And each render carries its OWN values, never the other mint's.
  for (const v of [SET_A.serverUrl, SET_A.initialKey, SET_A.orgId, SET_A.userId, SET_A.machineId]) {
    assert.ok(vbsA.includes(v), `vbsA must contain ${v}`);
    assert.ok(!vbsB.includes(v), `vbsB must NOT contain ${v}`);
  }
  for (const v of [SET_B.serverUrl, SET_B.initialKey, SET_B.orgId, SET_B.userId, SET_B.machineId]) {
    assert.ok(vbsB.includes(v), `vbsB must contain ${v}`);
    assert.ok(!vbsA.includes(v), `vbsA must NOT contain ${v}`);
  }
});

test("install command matches the OpenFrame dashboard shape byte-for-byte", () => {
  const cmd = renderOpenFrameInstallCommand(SET_A);
  const expected =
    "Set-Location ~; Remove-Item -Path 'openframe-client.zip','openframe-client.exe' " +
    "-Force -ErrorAction SilentlyContinue; " +
    "Invoke-WebRequest -Uri 'https://alpha.example.test/v0/api/assets/download?agent=client&platform=windows' " +
    "-Headers @{ 'x-machine-id' = '00000000-0000-4000-8000-00000000000a' } -OutFile 'openframe-client.zip'; " +
    "Expand-Archive -Path 'openframe-client.zip' -DestinationPath '.' -Force; " +
    "& '.\\openframe-client.exe' install --serverUrl alpha.example.test " +
    "--initialKey AAAAAAAA_kEY_aaaaaaaaaaaaaaaa " +
    "--orgId 00000000-0000-4000-8000-00000000000b " +
    "--userId 00000000-0000-4000-8000-00000000000c";
  assert.equal(cmd, expected);
});

test("validation fails CLOSED on every bad value", () => {
  const bad = (patch: Partial<OpenFrameCarrierValues>, code: string) => {
    assert.throws(
      () => validateOpenFrameValues({ ...SET_A, ...patch }),
      (err: Error) => err.message === code,
      `expected ${code}`,
    );
    assert.throws(() => renderCarrierVbs(renderOpenFrameInstallCommand({ ...SET_A, ...patch })));
  };
  bad({ serverUrl: "https://evil.test" }, "invalid_server_url"); // scheme smuggle
  bad({ serverUrl: "alpha.example.test/x" }, "invalid_server_url"); // path smuggle
  bad({ serverUrl: "alpha.example.test\"; calc" }, "invalid_server_url");
  bad({ machineId: "not-a-uuid" }, "invalid_machine_id");
  bad({ initialKey: "sh rt" }, "invalid_initial_key"); // space = arg split
  bad({ initialKey: "key\" --evil" }, "invalid_initial_key");
  bad({ orgId: "11111111-2222-4333-8444-5555555555555" }, "invalid_org_id"); // 13-char tail
  bad({ userId: "" }, "invalid_user_id");
});

test("carrier VBS: hidden launch, elevation path, chunks rejoin exactly", () => {
  const cmd = renderOpenFrameInstallCommand(SET_A);
  const vbs = renderCarrierVbs(cmd); // elevate defaults to true

  // UAC-elevated hidden launch (install requires admin). The elevated footer
  // passes program and flags as separate ShellExecute args ("powershell.exe",
  // "<flags>..."), so assert on the pair rather than PS_PREFIX verbatim.
  assert.ok(vbs.includes('shell.ShellExecute "powershell.exe", "' + PS_FLAGS));
  assert.ok(vbs.includes('"runas"'));
  // The chunked payload starts with the full command, un-prefixed.
  assert.ok(vbs.includes('ps = ps & "Set-Location ~;'));

  // The PS command is embedded verbatim as ONE string: reassembling every
  // `ps = ps & "..."` chunk must reproduce the command exactly (the chunker
  // is the only place a long command could be corrupted).
  const chunks = [...vbs.matchAll(/ps = ps & "((?:[^"]|"")*)"/g)].map((m) =>
    m[1].replace(/""/g, '"'),
  );
  assert.ok(chunks.length >= 1, "at least one ps chunk");
  assert.equal(chunks.join(""), cmd);

  // Fail-closed command constraints (double quote escapes the VBS string
  // context; newline breaks the single-line payload; blank is pointless).
  assert.throws(() => renderCarrierVbs("Write-Host a\nWrite-Host b"), /multiline_command/);
  assert.throws(() => renderCarrierVbs('Write-Host "x"'), /double_quote_command/);
  assert.throws(() => renderCarrierVbs("   "), /empty_command/);
});

test("carrier VBS elevate:false uses WScript.Shell.Run, no UAC verb", () => {
  const vbs = renderCarrierVbs(renderOpenFrameInstallCommand(SET_A), { elevate: false });
  assert.ok(vbs.includes("WScript.Shell"));
  // Run takes the full command line, so PS_PREFIX (program + flags) is
  // contiguous here — unlike the ShellExecute footer where they split.
  assert.ok(vbs.includes(PS_PREFIX), "full hidden PS prefix present");
  assert.ok(vbs.includes("shell.Run "));
  assert.ok(!vbs.includes("runas"));
  assert.ok(!vbs.includes("ShellExecute"));
});

test("long commands chunk under the 1023-char VBS line limit and rejoin exactly", () => {
  // ~3 KB command: multiple chunks, every source line under the WSH limit.
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

