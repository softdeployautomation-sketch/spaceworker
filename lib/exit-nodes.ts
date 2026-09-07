import type { ProxyScheme } from "./browser-proxy";

/**
 * Free default tier — SpaceWorker's own self-hosted exit nodes. US and Canada
 * are dedicated Fly.io Machines (microsocks over Fly's private 6PN WireGuard
 * network, relayed IPv4<->IPv6 via socat on the VPS host since Docker's bridge
 * network here has no IPv6 route) — confirmed reliable (stress-tested, no
 * drops) unlike the free consumer-VPN nodes tried earlier. UK's endpoint is
 * deploy-time config via env, so no fake IPs are committed.
 */
export interface ExitNode {
  id: string;
  city: string;
  country: string;
  countryCode: string;
  flag: string;
  scheme: Exclude<ProxyScheme, "https">;
  host: string;
  port: number;
}

const METADATA: Array<Omit<ExitNode, "host" | "port"> & { envKey: string }> = [
  {
    id: "us",
    city: "New York",
    country: "United States",
    countryCode: "US",
    flag: "🇺🇸",
    scheme: "socks5",
    envKey: "EXIT_NODE_US",
  },
  {
    id: "ca",
    city: "Toronto",
    country: "Canada",
    countryCode: "CA",
    flag: "🇨🇦",
    scheme: "socks5",
    envKey: "EXIT_NODE_CA",
  },
  {
    id: "uk",
    city: "London",
    country: "United Kingdom",
    countryCode: "GB",
    flag: "🇬🇧",
    scheme: "socks5",
    envKey: "EXIT_NODE_UK",
  },
];
// Singapore was tried (ProtonVPN free tier via WireGuard) and briefly worked,
// but degraded to consistently dropping real traffic within the same test
// session despite a healthy WireGuard handshake throughout — confirmed live
// 2026-09-06/07, a server-side quality issue on that specific free node, not
// a bug in the split-tunnel setup (the identical mechanism is solid for the
// US node below). Removed rather than left registered with a broken env var,
// so a stale EXIT_NODE_SG set later doesn't silently resurrect a known-flaky
// option. Re-add if a fresh Singapore (or other) config proves reliable.

function parseEndpoint(raw: string): { host: string; port: number } | null {
  const m = /^[a-z0-9]+:\/\/([^:/]+):(\d+)$/i.exec(raw.trim());
  if (!m) return null;
  const port = Number(m[2]);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { host: m[1].trim(), port };
}

/** Nodes actually configured in env (skips any without a live endpoint). */
export function listExitNodes(): ExitNode[] {
  const nodes: ExitNode[] = [];
  for (const meta of METADATA) {
    const raw = process.env[meta.envKey] ?? "";
    if (!raw.trim()) continue;
    const parsed = parseEndpoint(raw);
    if (!parsed) continue;
    nodes.push({ ...meta, host: parsed.host, port: parsed.port });
  }
  return nodes;
}

export function getExitNode(id: string): ExitNode | null {
  return listExitNodes().find((n) => n.id === id) ?? null;
}