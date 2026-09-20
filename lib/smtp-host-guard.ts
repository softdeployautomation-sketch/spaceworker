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

/** True when an IPv6 address is loopback/link-local/ULA/multicast. */
function v6IsNonRoutable(addr: string): boolean {
  const clean = addr.toLowerCase().split("%")[0]; // strip any zone index
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
 */
export async function validatePublicSmtpHost(host: string): Promise<void> {
  const trimmed = (host ?? "").trim();
  if (!trimmed) {
    throw new NonRoutableSmtpHostError(host, []);
  }

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