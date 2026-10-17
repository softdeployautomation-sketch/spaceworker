import { test } from "node:test";
import assert from "node:assert/strict";

// TASK_217 D4 — scope-block enforcement (binding safety rule #1).
//
// WHY THIS FILE EXISTS: the lab's whole promise is READ-ONLY reconnaissance.
// probes.ts's header documents that THIS file owns the attack-tool blocklist and
// statically scans the script that actually ships to the device — a declaration
// in the source proves nothing about the assembled text. A future edit that adds
// an offensive probe fails this suite until consciously approved.
//
// probes.ts is pure (no server-only, no db) — no require-hook needed.

import {
  buildAuditScript,
  AUDIT_JSON_BEGIN,
  AUDIT_JSON_END,
} from "../lib/security-audit/probes";

// The attack-tool blocklist. Documented OUT OF SCOPE in the task doc: deauth /
// PMKID / handshake capture, flooding, password spraying, credential attacks,
// and active probing of neighbour hosts.
const SCOPE_BLOCKED = [
  "aircrack",
  "aireplay",
  "airmon",
  "deauth",
  "handshake",
  "pmkid",
  "hcxpcap",
  "responder",
  "crackmapexec",
  "netexec",
  "flood",
  "hydra",
  "medusa",
  "bettercap",
  "wifite",
  "hashcat",
  "ncrack",
  "enum4linux",
  "smbclient -N",
  "nmap",
  "masscan",
  "ping -t",
];

const script = buildAuditScript();

test("the assembled script is non-empty and carries both stdout markers", () => {
  assert.ok(script.length > 500, "script must assemble to real content");
  assert.ok(script.includes(AUDIT_JSON_BEGIN));
  assert.ok(script.includes(AUDIT_JSON_END));
});

test("HARD: the assembled script contains NONE of the scope-blocked patterns", () => {
  const lowered = script.toLowerCase();
  for (const pattern of SCOPE_BLOCKED) {
    const p = pattern.toLowerCase();
    assert.ok(
      !lowered.includes(p),
      `probe script must not contain scope-blocked pattern: ${pattern}`,
    );
  }
});

test("the script is read-only recon: only the documented commands appear", () => {
  // The exact command set the pack is allowed to run (all read-only; P4's single
  // benign broadcast is a .NET send, enumerated separately below).
  assert.ok(script.includes("netsh wlan show interfaces"), "P1");
  assert.ok(script.includes("netsh wlan show profile"), "P2 (key read)");
  assert.ok(script.includes("Get-NetRoute"), "P3");
  assert.ok(script.includes("arp -a"), "P3");
  assert.ok(script.includes("Get-ItemProperty"), "P5 registry reads");
  assert.ok(script.includes("Get-SmbServerConfiguration"), "P5");
  assert.ok(script.includes("netstat -an"), "P6");
});

test("P4 sends exactly ONE benign UDP packet (single UdpClient send, no loop)", () => {
  const sends = script.match(/\.Send\(/g) ?? [];
  assert.equal(sends.length, 1, "P4 must issue exactly one broadcast send");
  assert.ok(script.includes("UdpClient"), "P4 uses a UDP client for the single send");
});

test("the script prints the end marker exactly once and the begin marker once", () => {
  const begins = script.split(AUDIT_JSON_BEGIN).length - 1;
  const ends = script.split(AUDIT_JSON_END).length - 1;
  assert.equal(begins, 1);
  assert.equal(ends, 1);
});

test("the script never prints raw netsh key output (only the marker JSON is emitted)", () => {
  // Binding safety rule #2 at the script level: `key=clear` output is captured
  // into $swProf / $swKeyVal variables and must never be Write-Output'd.
  assert.ok(!/Write-Output[^\n]*\$swProf/.test(script), "$swProf (raw profile w/ key) must not be printed");
  assert.ok(!/Write-Output[^\n]*\$swKeyVal/.test(script), "$swKeyVal (raw key) must not be printed");
  assert.ok(!/Write-Output[^\n]*\$swIf\b/.test(script), "$swIf (raw netsh interfaces) must not be printed");
});

