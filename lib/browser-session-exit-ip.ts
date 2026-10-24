import type { IpCheckResult } from "./browser-proxy";

/**
 * TASK_239 — the audit record for one exit-IP check.
 *
 * `path` is not cosmetic: a host-side curl proves the proxy works from THIS
 * box, not that the session's container can reach it (the container dials the
 * Docker bridge gateway, not loopback). `"container"` is recorded only when
 * browser-server's own `/dev/tcp` probe inside the container succeeded;
 * otherwise the host path is what was measured.
 */
export type ExitIpPath = "host" | "container";

/** Stable codes persisted in `BrowserSession.exitIpError`. */
export type ExitIpErrorCode =
  | "timeout"
  | "unreachable"
  | "bad_response"
  | "empty"
  | "container_unreachable";

export interface ExitIpAudit {
  exitIpSnapshot: string | null;
  exitIpError: ExitIpErrorCode | null;
  exitIpCheckedAt: Date;
  exitIpPath: ExitIpPath;
}

/**
 * Combine the typed IP check with browser-server's container-reachability
 * verdict. A failed container probe is itself an error even when the host
 * check succeeded — that is the "route OK from a host-only probe" lie this
 * task exists to stop. The host-measured IP is still kept: it is evidence of
 * what the proxy egresses as, not a claim about the container's path.
 */
export function buildExitIpAudit(
  result: IpCheckResult,
  opts: { proxyReachable: boolean | null; now?: Date },
): ExitIpAudit {
  const containerProven = opts.proxyReachable === true;
  const error: ExitIpErrorCode | null = result.ok
    ? opts.proxyReachable === false
      ? "container_unreachable"
      : null
    : result.error;
  return {
    exitIpSnapshot: result.ok ? result.ip : null,
    exitIpError: error,
    exitIpCheckedAt: opts.now ?? new Date(),
    exitIpPath: containerProven ? "container" : "host",
  };
}
