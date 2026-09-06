import type { ProxyScheme } from "./browser-proxy";

/**
 * Free default tier — SpaceWorker's own self-hosted WireGuard/OpenVPN exit
 * nodes: small, cheap VPS instances in popular locations. The endpoint each node
 * exposes (its local SOCKS/HTTP proxy) is deploy-time config via env, so no fake
 * IPs are committed. Phase 1 ships two nodes (United States, United Kingdom);
 * provider/count list is a non-blocking follow-up the deployer owns.
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
    id: "uk",
    city: "London",
    country: "United Kingdom",
    countryCode: "GB",
    flag: "🇬🇧",
    scheme: "socks5",
    envKey: "EXIT_NODE_UK",
  },
  {
    id: "sg",
    city: "Singapore",
    country: "Singapore",
    countryCode: "SG",
    flag: "🇸🇬",
    scheme: "socks5",
    envKey: "EXIT_NODE_SG",
  },
];

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