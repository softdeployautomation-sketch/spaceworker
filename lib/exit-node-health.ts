import "server-only";

import { listExitNodes, type ExitNode } from "./exit-nodes";
import { probeIpThroughProxy, type IpCheckResult } from "./browser-proxy";

/**
 * TASK_239 — is each configured free exit node actually usable right now?
 *
 * The owner report ("none of the fixes worked") was intermittent: both nodes
 * answered 10/10 at one moment and then timed out for whole sessions. A
 * session launch is too late and too expensive to be the only probe, so this
 * gives the admin surface a cheap, cached answer.
 *
 * Deliberately NOT a boot-time probe: `lib/env-health.ts` already flags a
 * missing EXIT_NODE_* key as severe at boot; this is live reachability, on
 * demand, cached for 30s. The prober is injectable so tests never open a
 * socket.
 */
export interface ExitNodeHealth {
  id: string;
  city: string;
  country: string;
  countryCode: string;
  /** True only when a real IP came back through this node's SOCKS route. */
  ok: boolean;
  ip: string | null;
  error: string | null;
  checkedAt: string;
  /** These probes run from the app host, never the container (see TASK_239). */
  path: "host";
}

export type ExitNodeProber = (node: ExitNode) => Promise<IpCheckResult>;

export const EXIT_NODE_HEALTH_TTL_MS = 30_000;

interface HealthCache {
  signature: string;
  at: number;
  nodes: ExitNodeHealth[];
}

let cache: HealthCache | null = null;
let inflight: { signature: string; promise: Promise<ExitNodeHealth[]> } | null = null;

const defaultProber: ExitNodeProber = (node) =>
  probeIpThroughProxy({ scheme: node.scheme, host: node.host, port: node.port });

/** Env config can change between deploys; a changed endpoint must re-probe. */
function signatureOf(nodes: ExitNode[]): string {
  return nodes.map((n) => `${n.id}|${n.host}|${n.port}`).join(",");
}

export function resetExitNodeHealthCache(): void {
  cache = null;
  inflight = null;
}

export async function getExitNodeHealth(
  opts: {
    now?: number;
    ttlMs?: number;
    probe?: ExitNodeProber;
    force?: boolean;
  } = {},
): Promise<ExitNodeHealth[]> {
  const nodes = listExitNodes();
  const signature = signatureOf(nodes);
  const now = opts.now ?? Date.now();
  const ttl = opts.ttlMs ?? EXIT_NODE_HEALTH_TTL_MS;

  if (!opts.force && cache && cache.signature === signature && now - cache.at < ttl) {
    return cache.nodes;
  }
  if (!opts.force && inflight && inflight.signature === signature) {
    return inflight.promise;
  }

  const prober = opts.probe ?? defaultProber;
  const promise = (async () => {
    const checkedAt = new Date(now).toISOString();
    const results = await Promise.all(
      nodes.map(async (node): Promise<ExitNodeHealth> => {
        const result = await prober(node);
        return {
          id: node.id,
          city: node.city,
          country: node.country,
          countryCode: node.countryCode,
          ok: result.ok,
          ip: result.ok ? result.ip : null,
          error: result.ok ? null : result.error,
          checkedAt,
          path: "host",
        };
      }),
    );
    cache = { signature, at: now, nodes: results };
    return results;
  })();

  inflight = { signature, promise };
  try {
    return await promise;
  } finally {
    if (inflight?.promise === promise) inflight = null;
  }
}
