import "server-only";

import { getExitNode } from "./exit-nodes";
import { decryptProxySecret, type ProxySpec } from "./browser-proxy";

export interface SessionProxyInput {
  proxyMode: string;
  exitNodeId: string | null;
  byoProxyHost: string | null;
  byoProxyPort: number | null;
  byoProxyScheme: string | null;
  byoProxyAuth: string | null;
}

/**
 * Reconstructs the concrete ProxySpec a session's traffic is (or was) routed
 * through — the free exit node, or the decrypted per-session BYO snapshot. Used
 * by the live IP checker so the check goes through the SAME surface the
 * session's Chrome uses (never the VPS's own route by accident).
 */
export function specForSession(s: SessionProxyInput): ProxySpec {
  if (s.proxyMode === "byo") {
    if (!s.byoProxyHost || !s.byoProxyPort || !s.byoProxyScheme || !s.byoProxyAuth) {
      throw new Error("Session has no BYO proxy route to check");
    }
    const creds = decryptProxySecret(s.byoProxyAuth);
    return {
      scheme: s.byoProxyScheme as ProxySpec["scheme"],
      host: s.byoProxyHost,
      port: s.byoProxyPort,
      username: creds.username || undefined,
      password: creds.password || undefined,
    };
  }
  if (!s.exitNodeId) {
    throw new Error("Session has no exit-node route to check");
  }
  const node = getExitNode(s.exitNodeId);
  if (!node) {
    throw new Error("Exit node is no longer configured");
  }
  return { scheme: node.scheme, host: node.host, port: node.port };
}