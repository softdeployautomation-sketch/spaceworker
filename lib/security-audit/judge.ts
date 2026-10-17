// TASK_217 D2 — the judging service: the layer that TELLS the owner a leak
// exists. Normalizes the probe pack's marker-delimited JSON (see probes.ts)
// into verdict cards `{probe, title, verdict, severity, evidence, remediation}`
// — PASS | LEAK | INFO with a plain-language "what this means / how to fix it".
//
// DELIBERATELY PURE (no server-only, no db, no imports except the marker
// constants) so the D4 fixture tests drive the REAL judging logic with zero
// stubbing: every probe fixture → expected card is asserted against this module.
//
// Binding safety rule #2 lives here as defense in depth: even though the probe
// pack never emits key material (probes.ts P2), `scrubSecrets` re-scrubs every
// evidence string before it can reach a run record — and the D4 test asserts
// it with a planted secret.

import { AUDIT_JSON_BEGIN, AUDIT_JSON_END } from "./probes";

export type Verdict = "PASS" | "LEAK" | "INFO";
export type Severity = "none" | "low" | "medium" | "high";

export interface VerdictCard {
  probe: string;
  title: string;
  verdict: Verdict;
  severity: Severity;
  evidence: string;
  remediation: string;
}

/** One raw probe result as ConvertTo-Json emits it (all fields optional). */
export interface RawProbeResult {
  probe?: string;
  error?: string;
  ssid?: string | null;
  bssid?: string | null;
  auth?: string | null;
  cipher?: string | null;
  keyPresent?: boolean | null;
  keyLength?: number;
  keyPrefix?: string;
  note?: string;
  gatewayIp?: string | null;
  gatewayMac?: string | null;
  gatewayCount?: number;
  neighborCount?: number;
  entries?: Array<{ ip?: string; mac?: string }>;
  sent?: boolean;
  services?: string[];
  llmnrEnabled?: boolean;
  netbiosNodeType?: number | null;
  smbServerSigningRequired?: boolean | null;
  smbClientSigningRequired?: boolean | null;
  lmCompatibilityLevel?: number;
  count?: number;
  listening?: Array<{ proto?: string; local?: string }>;
}

// ---------------------------------------------------------------------------
// Secret scrub — defense in depth. Anything shaped like a WiFi key / password
// assignment is replaced before evidence text can be persisted or rendered.
// The D4 hard test plants a secret in a fixture and asserts it never survives.
// ---------------------------------------------------------------------------
const SECRET_PATTERNS: RegExp[] = [
  /Key Content\s*:\s*\S+/gi,
  /(passphrase|password|psk|key\s*content|key\s*value)\s*[:=]\s*\S+/gi,
];

export function scrubSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "$1: [redacted]");
  return out;
}

// ---------------------------------------------------------------------------
// Marker extraction — the ONLY stdout contract with the probe pack.
// Returns null when the markers are absent (device offline, Vantra error text,
// an old agent, truncated output) so the caller can report "no audit data".
// ---------------------------------------------------------------------------
export function parseAuditOutput(stdout: string | null | undefined): RawProbeResult[] | null {
  if (!stdout) return null;
  const begin = stdout.indexOf(AUDIT_JSON_BEGIN);
  const end = stdout.indexOf(AUDIT_JSON_END);
  if (begin === -1 || end === -1 || end <= begin) return null;
  const json = stdout.slice(begin + AUDIT_JSON_BEGIN.length, end).trim();
  try {
    const parsed: unknown = JSON.parse(json);
    // ConvertTo-Json emits a single object (not a 1-element array) when the
    // batch produced exactly one result — normalize both shapes.
    if (Array.isArray(parsed)) return parsed as RawProbeResult[];
    if (parsed && typeof parsed === "object") return [parsed as RawProbeResult];
    return null;
  } catch {
    return null;
  }
}

function scrubCard(card: VerdictCard): VerdictCard {
  return {
    ...card,
    evidence: scrubSecrets(card.evidence),
    remediation: scrubSecrets(card.remediation),
  };
}

function judgeError(probe: string, error: string): VerdictCard {
  return scrubCard({
    probe,
    title: `${probe} did not complete`,
    verdict: "INFO",
    severity: "low",
    evidence: `Probe error: ${error}`,
    remediation:
      "The probe failed on the device (service missing, access denied, or no such interface). The other probes' results still stand.",
  });
}

// ---------------------------------------------------------------------------
// Per-probe judging. Each function returns the card(s) for its probe. P5 can
// surface up to FOUR independent findings (LLMNR / SMB server / SMB client /
// NTLM), so it returns an array; the others return one card.
// ---------------------------------------------------------------------------

function judgeP1(r: RawProbeResult): VerdictCard {
  if (r.error) return judgeError("P1", r.error);
  const auth = (r.auth ?? "").toLowerCase();
  const cipher = (r.cipher ?? "").toLowerCase();
  const link = r.ssid ? `SSID "${r.ssid}"` : "no WiFi link (wired or disconnected)";
  const base = `BSSID ${r.bssid ?? "n/a"}, auth ${r.auth ?? "n/a"}, cipher ${r.cipher ?? "n/a"}.`;

  if (!r.ssid) {
    return {
      probe: "P1",
      title: "WiFi link audit — no wireless link",
      verdict: "INFO",
      severity: "none",
      evidence: `${link}. ${base}`,
      remediation: "Nothing wireless to audit right now; re-run this probe on the WiFi network you want to judge.",
    };
  }
  if (auth.includes("open")) {
    return {
      probe: "P1",
      title: `Open WiFi network "${r.ssid}"`,
      verdict: "LEAK",
      severity: "high",
      evidence: `The connected network "${r.ssid}" uses NO encryption (${base}) — everyone on the same WiFi can read your traffic and join the network.`,
      remediation: "Move this device to a WPA2/WPA3 network; treat anything sent on this network as public.",
    };
  }
  if (auth.includes("wep")) {
    return {
      probe: "P1",
      title: `WEP network "${r.ssid}"`,
      verdict: "LEAK",
      severity: "high",
      evidence: `WEP is broken: the key can be recovered from a few minutes of captured traffic (${base}).`,
      remediation: "Reconfigure the access point to WPA2-AES or WPA3; WEP cannot be patched.",
    };
  }
  if (cipher.includes("tkip") || (auth.includes("wpa") && !auth.includes("wpa2") && !auth.includes("wpa3"))) {
    return {
      probe: "P1",
      title: `Weak legacy settings on "${r.ssid}"`,
      verdict: "LEAK",
      severity: "medium",
      evidence: `TKIP/WPA1 is in use (${base}) — both have known weaknesses and block WPA3 transition features.`,
      remediation: "Set the access point to WPA2-AES (CCMP) or WPA3-only; disable TKIP and WPA1.",
    };
  }
  if (auth.includes("wpa3")) {
    return {
      probe: "P1",
      title: `WPA3 network "${r.ssid}"`,
      verdict: "INFO",
      severity: "none",
      evidence: `Modern protection in use (${base}).`,
      remediation: "None — keep firmware current so WPA3 stays enabled.",
    };
  }
  return {
    probe: "P1",
    title: `WPA2 network "${r.ssid}"`,
    verdict: "INFO",
    severity: "none",
    evidence: `WPA2 in use (${base}) — acceptable; WPA3 is the upgrade path.`,
    remediation: "Consider moving to WPA3 when your devices support it.",
  };
}

function judgeP2(r: RawProbeResult): VerdictCard {
  if (r.error) return judgeError("P2", r.error);
  if (r.keyPresent === null || r.keyPresent === undefined) {
    return {
      probe: "P2",
      title: "Stored-key exposure — no WiFi link",
      verdict: "INFO",
      severity: "none",
      evidence: r.note || "No wireless profile in use, so no stored key to inspect.",
      remediation: "Re-run on the WiFi network you want to audit.",
    };
  }
  if (!r.keyPresent) {
    return {
      probe: "P2",
      title: "No recoverable key stored",
      verdict: "PASS",
      severity: "none",
      evidence: `No plaintext key is stored for profile "${r.ssid ?? "unknown"}".`,
      remediation: "None — this is the good outcome.",
    };
  }
  // keyPresent === true — the finding. Evidence carries length + 2-char prefix
  // hint ONLY; scrubSecrets guarantees no key material can ride along.
  return scrubCard({
    probe: "P2",
    title: `WiFi key for "${r.ssid ?? "unknown"}" stored in recoverable form`,
    verdict: "LEAK",
    severity: "medium",
    evidence: `The WPA preshared key is stored on this device in recoverable form (length ${r.keyLength ?? "?"}, prefix "${r.keyPrefix ?? ""}…"). Every device that ever joined this WiFi holds the same key — anyone who compromises any one of them has it.`,
    remediation:
      "Treat the PSK as shared knowledge: rotate it when a member device is sold/lost/compromised, and prefer WPA2-Enterprise/802.1X or WPA3-Enterprise so no static key exists on endpoints.",
  });
}

function judgeP3(r: RawProbeResult): VerdictCard {
  if (r.error) return judgeError("P3", r.error);
  const gw = r.gatewayIp ?? "unknown";
  const mac = r.gatewayMac ?? "unresolved";
  const evidence =
    `Gateway ${gw} (MAC ${mac}); ${r.neighborCount ?? 0} neighbor(s) in the ARP table` +
    (r.gatewayCount && r.gatewayCount > 1 ? `; ${r.gatewayCount} default gateways configured` : "") +
    ".";
  if ((r.gatewayCount ?? 0) > 1) {
    return {
      probe: "P3",
      title: "Multiple default gateways configured",
      verdict: "INFO",
      severity: "low",
      evidence: `${evidence} Multiple default routes can mean traffic takes an unexpected path (VPN adapter, misconfig, or something redirecting your egress).`,
      remediation: "Check Routing & Remote Access / `route print` for an unexpected default route you did not configure.",
    };
  }
  if (!r.gatewayIp || mac === "unresolved" || mac === "00-00-00-00-00-00") {
    return {
      probe: "P3",
      title: "Gateway could not be fully resolved",
      verdict: "INFO",
      severity: "low",
      evidence: `${evidence} An unresolved gateway MAC would make ARP-based redirection harder to notice — worth a second look.`,
      remediation: "Verify the gateway IP/MAC on your router's admin page matches what this device sees.",
    };
  }
  return {
    probe: "P3",
    title: "Gateway and neighbor view",
    verdict: "INFO",
    severity: "none",
    evidence,
    remediation:
      "None required. Note: every device that has spoken to this LAN recently is visible here — that visibility itself is the LAN leak surface P4 tests.",
  };
}

function judgeP4(r: RawProbeResult): VerdictCard {
  if (r.error) return judgeError("P4", r.error);
  const services = (r.services ?? []).map((s) => s.trim()).filter(Boolean);
  if (services.length > 0) {
    return {
      probe: "P4",
      title: "Your LAN advertises services to everyone on it",
      verdict: "INFO",
      severity: "low",
      evidence: `A single benign broadcast was answered/observed with: ${services.slice(0, 5).join(", ")}. Any host on this WiFi can send you packets and see these advertisements — that is the broadcast reach test result.`,
      remediation:
        "If any advertised service is unintended (printer sharing, media servers, UPnP devices), disable it on that device; on hostile networks, use a client-isolation SSID or a personal hotspot.",
    };
  }
  return {
    probe: "P4",
    title: "Broadcast reach observed",
    verdict: "INFO",
    severity: "none",
    evidence:
      "A single benign UDP broadcast was sent and no SSDP service replies were heard in the 4-second window. Note this is a passive-observe result: it does NOT block other hosts from reaching you directly.",
    remediation: "None required; re-run near other devices for a fuller advertisement picture.",
  };
}

function judgeP5(r: RawProbeResult): VerdictCard[] {
  if (r.error) return [judgeError("P5", r.error)];
  const cards: VerdictCard[] = [];

  if (r.llmnrEnabled !== false) {
    cards.push({
      probe: "P5",
      title: "LLMNR is enabled (responder-class exposure)",
      verdict: "LEAK",
      severity: "high",
      evidence:
        "Multicast name resolution (LLMNR) is on. Any host on this WiFi can answer the device's name lookups and capture challenge-response material (the Responder playbook) — this is the classic first hop of a LAN compromise.",
      remediation:
        "Disable LLMNR: Group Policy → Computer Configuration → Administrative Templates → Network → DNS Client → 'Turn off multicast name resolution' (or Set-ItemProperty HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows NT\\DNSClient EnableMulticast=0).",
    });
  }
  if (r.smbServerSigningRequired === false || r.smbClientSigningRequired === false) {
    const which =
      r.smbServerSigningRequired === false && r.smbClientSigningRequired === false
        ? "server and client"
        : r.smbServerSigningRequired === false
          ? "server"
          : "client";
    cards.push({
      probe: "P5",
      title: `SMB signing not required on the ${which} (relay-class exposure)`,
      verdict: "LEAK",
      severity: "high",
      evidence:
        "SMB sessions can be relayed: an attacker on the WiFi can intercept an authentication and replay it to another host without seeing the password — the NTLM-relay playbook.",
      remediation:
        "Require signing: Set-SmbServerConfiguration -RequireSecuritySignature $true (and the matching client policy via Group Policy 'Digitally sign communications (always)').",
    });
  }
  if (typeof r.lmCompatibilityLevel === "number" && r.lmCompatibilityLevel <= 2) {
    cards.push({
      probe: "P5",
      title: "Legacy NTLM allowed (LmCompatibilityLevel ≤ 2)",
      verdict: "LEAK",
      severity: "high",
      evidence: `LmCompatibilityLevel is ${r.lmCompatibilityLevel}: the device accepts LM/NTLMv1 responses, which are fast to crack offline from a captured challenge.`,
      remediation:
        "Set LmCompatibilityLevel = 5 (Send NTLMv2 response only. Refuse LM & NTLM) under HKLM\\SYSTEM\\CurrentControlSet\\Control\\Lsa.",
    });
  }
  if (cards.length === 0) {
    cards.push({
      probe: "P5",
      title: "No poisoning/relay surface found",
      verdict: "PASS",
      severity: "none",
      evidence: `LLMNR off, SMB signing required${typeof r.netbiosNodeType === "number" ? ` (NetBIOS node type ${r.netbiosNodeType})` : ""}, LmCompatibilityLevel ${r.lmCompatibilityLevel ?? "default (3+)"} — the Responder/NTLM-relay playbook has nothing to grab here.`,
      remediation: "None — this is the good outcome. Keep these settings through future reimaging.",
    });
  }
  return cards.map(scrubCard);
}

function judgeP6(r: RawProbeResult): VerdictCard {
  if (r.error) return judgeError("P6", r.error);
  const list = (r.listening ?? [])
    .map((s) => `${s.proto ?? "?"} ${s.local ?? "?"}`)
    .slice(0, 12)
    .join(", ");
  return scrubCard({
    probe: "P6",
    title: "Listening sockets",
    verdict: "INFO",
    severity: "none",
    evidence: `${r.count ?? 0} listening endpoint(s)${list ? `: ${list}${(r.count ?? 0) > 12 ? ", …" : ""}` : ""}.`,
    remediation:
      "Review anything you do not recognize: each listening port reachable from the WiFi is a service your LAN (and anything routed to it) can talk to.",
  });
}

/**
 * Judge one raw probe result into zero or more verdict cards (P5 can raise
 * several independent findings). Unknown probes yield no cards — the pack and
 * this judge ship together.
 */
export function judgeProbe(r: RawProbeResult): VerdictCard[] {
  switch (r.probe) {
    case "P1":
      return [scrubCard(judgeP1(r))];
    case "P2":
      return [scrubCard(judgeP2(r))];
    case "P3":
      return [scrubCard(judgeP3(r))];
    case "P4":
      return [scrubCard(judgeP4(r))];
    case "P5":
      return judgeP5(r);
    case "P6":
      return [judgeP6(r)];
    default:
      return [];
  }
}

export interface AuditSummary {
  leaks: number;
  passes: number;
  infos: number;
  worstSeverity: Severity;
}

const SEVERITY_ORDER: Severity[] = ["none", "low", "medium", "high"];

/** Judge a full batch: every probe result → cards, LEAK-first ordering. */
export function judgeAudit(results: RawProbeResult[]): {
  cards: VerdictCard[];
  summary: AuditSummary;
} {
  const cards = results.flatMap(judgeProbe);
  cards.sort((a, b) => {
    const leakDiff = (a.verdict === "LEAK" ? 0 : 1) - (b.verdict === "LEAK" ? 0 : 1);
    if (leakDiff !== 0) return leakDiff;
    return SEVERITY_ORDER.indexOf(b.severity) - SEVERITY_ORDER.indexOf(a.severity);
  });
  const summary: AuditSummary = {
    leaks: cards.filter((c) => c.verdict === "LEAK").length,
    passes: cards.filter((c) => c.verdict === "PASS").length,
    infos: cards.filter((c) => c.verdict === "INFO").length,
    worstSeverity: cards.reduce<Severity>(
      (worst, c) => (SEVERITY_ORDER.indexOf(c.severity) > SEVERITY_ORDER.indexOf(worst) ? c.severity : worst),
      "none",
    ),
  };
  return { cards, summary };
}

