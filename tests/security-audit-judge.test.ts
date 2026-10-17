import { test } from "node:test";
import assert from "node:assert/strict";

// TASK_217 D4 — the judging service's fixture suite.
//
// WHY THIS FILE EXISTS: the judge is the layer that TELLS the owner a leak
// exists (or doesn't). A silent regression that flips a LEAK to a PASS would
// hand a false clean bill of health on someone's own network — the worst
// possible failure for an audit tool. These fixtures pin every probe's verdict
// mapping, the LEAK-first ordering, the batch summary, and — as a HARD test —
// that key material can never survive into evidence (binding safety rule #2).
//
// Both modules under test are deliberately pure (no server-only, no db), so
// this file needs no require-hook and touches nothing external.

import {
  judgeAudit,
  judgeProbe,
  parseAuditOutput,
  scrubSecrets,
  type RawProbeResult,
} from "../lib/security-audit/judge";
import { AUDIT_JSON_BEGIN, AUDIT_JSON_END } from "../lib/security-audit/probes";

// ---------------------------------------------------------------------------
// P1 — WiFi link audit
// ---------------------------------------------------------------------------

test("P1 open network is a high LEAK", () => {
  const [card] = judgeProbe({ probe: "P1", ssid: "CoffeeShop", bssid: "aa-bb-cc-dd-ee-ff", auth: "Open", cipher: "none" });
  assert.equal(card.verdict, "LEAK");
  assert.equal(card.severity, "high");
  assert.match(card.title, /Open WiFi/);
});

test("P1 WEP is a high LEAK", () => {
  const [card] = judgeProbe({ probe: "P1", ssid: "OldRouter", auth: "WEP", cipher: "WEP" });
  assert.equal(card.verdict, "LEAK");
  assert.equal(card.severity, "high");
  assert.match(card.title, /WEP/);
});

test("P1 TKIP/WPA1 is a medium LEAK", () => {
  const [card] = judgeProbe({ probe: "P1", ssid: "Legacy", auth: "WPA-PSK", cipher: "TKIP" });
  assert.equal(card.verdict, "LEAK");
  assert.equal(card.severity, "medium");
});

test("P1 WPA2-AES is INFO (acceptable), WPA3 is INFO (modern)", () => {
  const wpa2 = judgeProbe({ probe: "P1", ssid: "Home", auth: "WPA2-Personal", cipher: "CCMP" })[0];
  assert.equal(wpa2.verdict, "INFO");
  assert.equal(wpa2.severity, "none");
  const wpa3 = judgeProbe({ probe: "P1", ssid: "Home3", auth: "WPA3-Personal", cipher: "GCMP-256" })[0];
  assert.equal(wpa3.verdict, "INFO");
});

test("P1 no wireless link is INFO, not a leak", () => {
  const [card] = judgeProbe({ probe: "P1", ssid: null, bssid: null, auth: null, cipher: null });
  assert.equal(card.verdict, "INFO");
  assert.match(card.evidence, /no WiFi link/);
});

// ---------------------------------------------------------------------------
// P2 — stored-key exposure (the redaction probe)
// ---------------------------------------------------------------------------

test("P2 keyPresent=true is a medium LEAK and evidence carries ONLY length + 2-char prefix", () => {
  const [card] = judgeProbe({ probe: "P2", ssid: "Home", keyPresent: true, keyLength: 12, keyPrefix: "ab" });
  assert.equal(card.verdict, "LEAK");
  assert.equal(card.severity, "medium");
  assert.match(card.evidence, /length 12/);
  assert.match(card.evidence, /prefix "ab/);
});

test("P2 no key stored is PASS", () => {
  const [card] = judgeProbe({ probe: "P2", ssid: "Home", keyPresent: false });
  assert.equal(card.verdict, "PASS");
});

test("P2 no wifi link is INFO (nothing to inspect)", () => {
  const [card] = judgeProbe({ probe: "P2", keyPresent: null, note: "no wifi link in use" });
  assert.equal(card.verdict, "INFO");
});

// ---------------------------------------------------------------------------
// P3 — gateway / ARP
// ---------------------------------------------------------------------------

test("P3 multiple default gateways is INFO (low) — flagged as an odd path", () => {
  const [card] = judgeProbe({ probe: "P3", gatewayIp: "192.168.1.1", gatewayMac: "00-11-22-33-44-55", gatewayCount: 2, neighborCount: 5 });
  assert.equal(card.verdict, "INFO");
  assert.equal(card.severity, "low");
  assert.match(card.title, /Multiple default gateways/);
});

test("P3 unresolved gateway MAC is INFO (low)", () => {
  const [card] = judgeProbe({ probe: "P3", gatewayIp: "192.168.1.1", gatewayMac: "unresolved", gatewayCount: 1, neighborCount: 3 });
  assert.equal(card.verdict, "INFO");
  assert.equal(card.severity, "low");
});

test("P3 clean single gateway is INFO (none)", () => {
  const [card] = judgeProbe({ probe: "P3", gatewayIp: "192.168.1.1", gatewayMac: "00-11-22-33-44-55", gatewayCount: 1, neighborCount: 8 });
  assert.equal(card.verdict, "INFO");
  assert.equal(card.severity, "none");
});

// ---------------------------------------------------------------------------
// P4 — broadcast reach
// ---------------------------------------------------------------------------

test("P4 services advertised is INFO (low) and lists the services", () => {
  const [card] = judgeProbe({ probe: "P4", sent: true, services: ["Microsoft Windows Network", "ssdp-notify"] });
  assert.equal(card.verdict, "INFO");
  assert.equal(card.severity, "low");
  assert.match(card.evidence, /Microsoft Windows Network/);
});

test("P4 no services heard is INFO (none)", () => {
  const [card] = judgeProbe({ probe: "P4", sent: true, services: [] });
  assert.equal(card.verdict, "INFO");
  assert.equal(card.severity, "none");
});

// ---------------------------------------------------------------------------
// P5 — poisoning / relay surface (the multi-finding probe)
// ---------------------------------------------------------------------------

test("P5 LLMNR on is a high LEAK", () => {
  const cards = judgeProbe({ probe: "P5", llmnrEnabled: true, smbServerSigningRequired: true, smbClientSigningRequired: true, lmCompatibilityLevel: 3 });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].verdict, "LEAK");
  assert.equal(cards[0].severity, "high");
  assert.match(cards[0].title, /LLMNR/);
});

test("P5 SMB signing off (server) is a high LEAK", () => {
  const cards = judgeProbe({ probe: "P5", llmnrEnabled: false, smbServerSigningRequired: false, smbClientSigningRequired: true, lmCompatibilityLevel: 3 });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].verdict, "LEAK");
  assert.match(cards[0].title, /SMB signing/);
});

test("P5 weak NTLM (LmCompatibilityLevel<=2) is a high LEAK", () => {
  const cards = judgeProbe({ probe: "P5", llmnrEnabled: false, smbServerSigningRequired: true, smbClientSigningRequired: true, lmCompatibilityLevel: 1 });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].verdict, "LEAK");
  assert.match(cards[0].title, /NTLM/i);
});

test("P5 all three exposures at once raises THREE independent LEAK cards", () => {
  const cards = judgeProbe({ probe: "P5", llmnrEnabled: true, smbServerSigningRequired: false, smbClientSigningRequired: false, lmCompatibilityLevel: 2 });
  assert.equal(cards.length, 3);
  assert.ok(cards.every((c) => c.verdict === "LEAK"));
});

test("P5 hardened (LLMNR off, signing required, LmCompat 3) is PASS", () => {
  const cards = judgeProbe({ probe: "P5", llmnrEnabled: false, smbServerSigningRequired: true, smbClientSigningRequired: true, lmCompatibilityLevel: 3 });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].verdict, "PASS");
});

// ---------------------------------------------------------------------------
// P6 — listening sockets
// ---------------------------------------------------------------------------

test("P6 is INFO with a bounded endpoint list", () => {
  const [card] = judgeProbe({ probe: "P6", count: 2, listening: [{ proto: "TCP", local: "0.0.0.0:135" }, { proto: "TCP", local: "[::]:135" }] });
  assert.equal(card.verdict, "INFO");
  assert.match(card.evidence, /2 listening endpoint/);
});

test("P6 probe error is INFO (probe failed, other results still stand)", () => {
  const [card] = judgeProbe({ probe: "P6", error: "access denied" });
  assert.equal(card.verdict, "INFO");
  assert.match(card.evidence, /access denied/);
});

test("unknown probe yields no cards", () => {
  assert.deepEqual(judgeProbe({ probe: "P99" }), []);
});



// ---------------------------------------------------------------------------
// Batch judging — LEAK-first ordering and the summary roll-up
// ---------------------------------------------------------------------------

test("judgeAudit sorts LEAK cards first and counts verdicts + worst severity", () => {
  const results: RawProbeResult[] = [
    { probe: "P6", count: 0, listening: [] }, // INFO
    { probe: "P1", ssid: "Open", auth: "Open", cipher: "none" }, // LEAK high
    { probe: "P2", ssid: "Home", keyPresent: false }, // PASS
    { probe: "P5", llmnrEnabled: true, smbServerSigningRequired: true, smbClientSigningRequired: true, lmCompatibilityLevel: 3 }, // LEAK high
  ];
  const { cards, summary } = judgeAudit(results);
  assert.equal(cards[0].verdict, "LEAK");
  assert.equal(cards[1].verdict, "LEAK");
  assert.equal(summary.leaks, 2);
  assert.equal(summary.passes, 1);
  assert.equal(summary.infos, 1);
  assert.equal(summary.worstSeverity, "high");
});

// ---------------------------------------------------------------------------
// Marker parsing — the ONLY stdout contract with the probe pack
// ---------------------------------------------------------------------------

test("parseAuditOutput extracts the JSON array between the markers", () => {
  const stdout = `some preamble\n${AUDIT_JSON_BEGIN}\n[{"probe":"P1","ssid":"Home","auth":"WPA2-Personal"}]\n${AUDIT_JSON_END}\n`;
  const results = parseAuditOutput(stdout);
  assert.ok(results);
  assert.equal(results.length, 1);
  assert.equal(results[0].probe, "P1");
});

test("parseAuditOutput normalizes a single-object (non-array) payload", () => {
  const stdout = `${AUDIT_JSON_BEGIN}\n{"probe":"P1","ssid":"Home"}\n${AUDIT_JSON_END}`;
  const results = parseAuditOutput(stdout);
  assert.ok(results);
  assert.equal(results.length, 1);
});

test("parseAuditOutput returns null when markers are absent (offline / old agent)", () => {
  assert.equal(parseAuditOutput("Agent not reachable"), null);
  assert.equal(parseAuditOutput(""), null);
  assert.equal(parseAuditOutput(null), null);
});

test("parseAuditOutput returns null on malformed JSON between markers", () => {
  const stdout = `${AUDIT_JSON_BEGIN}\n{not json}\n${AUDIT_JSON_END}`;
  assert.equal(parseAuditOutput(stdout), null);
});

// ---------------------------------------------------------------------------
// HARD — binding safety rule #2: key material can NEVER reach evidence
// ---------------------------------------------------------------------------

test("scrubSecrets redacts a planted WiFi key / password assignment", () => {
  const planted = "s3cr3t-wifi-key-42";
  const dirty = `Key Content    : ${planted}\npassword=${planted}`;
  const clean = scrubSecrets(dirty);
  assert.ok(!clean.includes(planted), "planted secret must not survive scrub");
  assert.match(clean, /\[redacted\]/);
});

test("HARD: a P2 result that somehow carries a raw key never leaks it into evidence", () => {
  const planted = "super-secret-psk-value";
  // Simulate a probe bug: the raw key leaks into a field the judge renders.
  const [card] = judgeProbe({
    probe: "P2",
    ssid: "Home",
    keyPresent: true,
    keyLength: 24,
    keyPrefix: "su",
    note: `Key Content: ${planted}`,
  });
  const all = `${card.title} ${card.evidence} ${card.remediation}`;
  assert.ok(!all.includes(planted), "raw key must not appear in any card field");
  // And the scrubber itself kills an assignment-shaped key.
  assert.ok(!scrubSecrets(`Key Content: ${planted}`).includes(planted));
});
