import "server-only";
import { lookup } from "dns/promises";

// Task 51 — SMTP SSRF guard. The mailbox "Test connection" endpoint used to
// accept any host:port from a signed-in user and pass it straight into
// nodemailer's verify(), which turned it into an authenticated internal
// port-scan oracle (probing loopback/private ranges on the VPS, plus a cloud
// metadata endpoint if the host is ever moved to one). This guard rejects any
// host whose DNS resolution lands on a loopback, RFC1918 private, link-local,
// CGNAT, or otherwise non-routable range — resolving the hostname rather than
// string-matching the literal, so a hostname that resolves to a private IP via
// DNS rebinding is caught too.
//
// Applied at mailbox save time (app/api/mailboxes/route.ts and
// app/api/mailboxes/[id]/route.ts) so a private-IP host can never be stored at
// all, AND in app/api/mailboxes/test-connection before any transport/verify()
// call — the save-time check is what protects the real send path going forward.

export class NonRoutableSmtpHostError extends Error {
  readonly host: string;
  readonly resolved: string[];
  constructor(host: string, resolved: string[]) {
    const what = resolved.length ? resolved.join(", ") : "no resolvable address";
    super(
      `SMTP host "${host}" resolves to a non-routable/internal address (${what}) and is not allowed.`
    );
    this.name = "NonRoutableSmtpHostError";
    this.host = host;
    this.resolved = resolved;
  }
}

// ---------------------------------------------------------------------------
// Operator-only escape hatch for the platform's OWN sending relay.
//
// Task 51 blocked every loopback/private SMTP host to close an authenticated
// port-scan oracle. That remains right for any host a USER types — but it also
// blocked the one internal SMTP target that is deliberately ours: the local
// Postfix sending relay this platform runs bound to 127.0.0.1. That relay exists
// precisely so a customer's broken or unreachable third-party SMTP server
// cannot stop campaigns from going out.
//
// The allowlist is read from the OPERATOR's environment and never from request
// data, so a signed-in user still cannot point a mailbox at 127.0.0.1 unless
// the operator explicitly allowed it. Two further constraints keep the original
// hole closed:
//
//   1. Entries MUST carry an explicit port ("127.0.0.1:587"). A portless entry
//      is ignored (fail closed) — otherwise the allowlist would re-permit
//      probing EVERY loopback port, which is exactly what Task 51 fixed.
//   2. A port must also be supplied to validatePublicSmtpHost(). Callers that
//      don't know the port get the old, strict behaviour.
//
// Accepted syntax: "127.0.0.1:587", "::1" bracket form "[::1]:587", or any
// hostname the operator owns that resolves to the relay's address.
const INTERNAL_RELAY_HOSTS_ENV = "SMTP_INTERNAL_RELAY_HOSTS";

export interface InternalRelayAllowEntry {
  host: string;
  port: number;
}

/** Lowercase, strip a trailing FQDN root dot and IPv6 brackets. */
function normalizeHostToken(value: string): string {
  let s = (value ?? "").trim().toLowerCase();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  if (s.endsWith(".")) s = s.slice(0, -1);
  return s;
}

/** Parsed operator allowlist. Malformed/portless entries are skipped. */
export function internalRelayAllowlist(): InternalRelayAllowEntry[] {
  const out: InternalRelayAllowEntry[] = [];
  for (const raw of (process.env[INTERNAL_RELAY_HOSTS_ENV] ?? "").split(",")) {
    const token = raw.trim();
    if (!token) continue;
    const m = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(token);
    if (!m) continue; // no port => ignored, see note 1 above
    const port = Number(m[2]);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) continue;
    out.push({ host: normalizeHostToken(m[1]), port });
  }
  return out;
}

/**
 * True when `host` (+ optional already-resolved addresses) is the operator's
 * own relay ON the allowlisted port. Exact-token match only — no wildcards, no
 * suffix matching.
 */
export function isInternalRelayAllowed(
  host: string,
  port: number | undefined,
  resolved: string[] = []
): boolean {
  if (!Number.isInteger(port)) return false;
  const entries = internalRelayAllowlist();
  if (entries.length === 0) return false;
  const tokens = [normalizeHostToken(host), ...resolved.map(normalizeHostToken)];
  return entries.some((e) => e.port === port && tokens.includes(e.host));
}

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isLiteralIPv4(s: string): boolean {
  const m = IPV4_RE.exec(s);
  if (!m) return false;
  return m.slice(1).every((o) => {
    const n = Number(o);
    return n >= 0 && n <= 255;
  });
}

/** True when an IPv4 address is loopback/private/non-routable. */
function v4IsNonRoutable(addr: string): boolean {
  const [a, b] = addr.split(".").map(Number);
  if (a === 0 || a === 10 || a === 127) return true; // this-network / RFC1918 / loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (incl. cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 RFC1918
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 IETF protocol assignments
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 RFC1918
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  if (a >= 224) return true; // multicast (224/4) + reserved (240/4) + broadcast
  return false;
}

/** Extract the embedded IPv4 from an IPv4-mapped IPv6 ("::ffff:a.b.c.d"). */
function v4FromMappedV6(addr: string): string | null {
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(addr.trim());
  return m && isLiteralIPv4(m[1]) ? m[1] : null;
}

/** True when an IPv6 address is loopback/link-local/ULA/multicast. */
function v6IsNonRoutable(addr: string): boolean {
  const clean = addr.toLowerCase().split("%")[0]; // strip any zone index
  // IPv4-mapped IPv6 ("::ffff:172.65.255.143") — some resolvers hand these
  // back even for an A-record lookup. The embedded address is the real
  // routability question; judge it by the v4 rules. Without this, "ffff" reads
  // as the first hextet of the multicast range and EVERY mapped address —
  // including ordinary public SMTP hosts — was rejected (caught live adding a
  // mailbox inside the mailer EXE; would hit any user whose resolver behaves
  // the same way).
  const mapped = v4FromMappedV6(clean);
  if (mapped) return v4IsNonRoutable(mapped);
  if (clean === "::" || clean === "::1") return true; // unspecified / loopback
  let firstHex: string;
  if (clean.startsWith("::")) {
    firstHex = clean.slice(2).split(":")[0] || "0";
  } else {
    firstHex = clean.split(":")[0];
  }
  if (!/^[0-9a-f]{1,4}$/.test(firstHex)) return false;
  const val = parseInt(firstHex, 16);
  if (val >= 0xfe80 && val <= 0xfebf) return true; // fe80::/10 link-local
  if (val >= 0xfc00 && val <= 0xfdff) return true; // fc00::/7 unique local
  if (val >= 0xff00 && val <= 0xffff) return true; // ff00::/8 multicast
  return false;
}

/**
 * Resolve `host` and throw NonRoutableSmtpHostError if any resolved address is
 * loopback/private/link-local/non-routable, or if the hostname does not resolve
 * at all (fail closed — if we can't prove the host is public, it isn't let out).
 *
 * `port` is optional for backwards compatibility but MUST be passed to make the
 * operator's own-relay allowlist reachable (see the internalRelayAllowlist note
 * above): without a port there is nothing to match an allowlist entry against,
 * so the strict public-only rule applies.
 */
export async function validatePublicSmtpHost(host: string, port?: number): Promise<void> {
  const trimmed = (host ?? "").trim();
  if (!trimmed) {
    throw new NonRoutableSmtpHostError(host, []);
  }

  // Operator's own relay, matched by the name the operator wrote down.
  if (isInternalRelayAllowed(trimmed, port)) return;

  let addresses: string[];
  if (isLiteralIPv4(trimmed)) {
    addresses = [trimmed];
  } else {
    // Resolve BOTH families so a hostname cannot smuggle an internal IPv6.
    const [v4, v6] = await Promise.all([
      lookup(trimmed, { family: 4, all: true }).catch(() => []),
      lookup(trimmed, { family: 6, all: true }).catch(() => []),
    ]);
    addresses = [...v4, ...v6].map((r) => r.address);
  }

  // Same relay, reached under another name the operator allowlisted by ADDRESS
  // (e.g. a hostname pointing at 127.0.0.1). Checked before the non-routable
  // rejection so the allowlist is actually usable, and after resolution so DNS
  // rebinding to an unrelated internal host still cannot match by accident.
  if (isInternalRelayAllowed(trimmed, port, addresses)) return;

  if (addresses.length === 0) {
    throw new NonRoutableSmtpHostError(host, []);
  }

  const blocked = addresses.filter((a) =>
    a.includes(":") ? v6IsNonRoutable(a) : v4IsNonRoutable(a)
  );
  if (blocked.length > 0) {
    throw new NonRoutableSmtpHostError(host, blocked);
  }
}