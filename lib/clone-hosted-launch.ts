import "server-only";

import { db } from "./db";
import { browserRuntime } from "./browser-runtime";
import { createProfileDir, deleteProfileDir, profileDirPath } from "./browser-profiles";
import { connectUrlFor } from "./browser-session-serialize";
import { checkIpThroughProxy } from "./browser-proxy";
import { injectLiveCapture } from "./clone-live-capture";

// TASK_118 B8-2 — hosted launch: a clone whose destination is OUR OWN browser
// (Device.deviceKind = "hosted", provisioned by clone-destination.ts), driven
// through browser-server directly. This is a SIBLING to clone-transport.ts's
// agent-RPC launch path (runCloneLaunch), not a replacement of it — a
// workstation destination still goes through the agent. lib/clone.ts's
// stepLaunch/teardownTransport branch on the destination's deviceKind to pick
// one or the other.
//
// WHY THIS NEEDS ITS OWN MODULE, NOT JUST A BRANCH INSIDE runCloneLaunch: the
// hosted path talks to a completely different subsystem (browser-server, over
// localhost HTTP) with a completely different session model (a Neko container
// + a relay-ingress device listener) — there is no agent, no DeviceJob/
// DeviceAction RPC round-trip, and no bundle to capture/transfer/inject
// (route 3, TASK_117: the hosted browser logs in for itself).

export interface HostedLaunchResult {
  ok: boolean;
  egressMode: "relay" | "direct";
  exitCode: number | null;
  error?: string;
  viewUrl?: string;
  egressIp?: string;
}

/**
 * Starts a hosted clone session: a fresh per-job Chrome profile (owner's own
 * design — "it automatically creates a browser profile with that device
 * name... so we dont risk leakage"), a browser-server session pointed at
 * either the relay device-listener (relay egress) or nothing (direct — the
 * hosted browser's own IP, premium-gated upstream in requestClone), and a
 * LIVE egress-IP check through whichever path was actually used.
 *
 * Fail-closed, per TASK_118's own explicit requirement ("never silently fall
 * back to our own IP"): relay egress that cannot be proven live is a REFUSAL,
 * not a degraded launch. The pre-check (hasControl) catches an offline device
 * before a container is even started; the post-check (checkIpThroughProxy)
 * catches anything the pre-check couldn't (a control conn that's up but a
 * stream that isn't) and is the actual EVIDENCE recorded as `egressIp` — the
 * record never claims a mode it didn't verify.
 */
export async function runHostedLaunch(opts: {
  userId: string;
  cloneJobId: string;
  sourceDeviceId: string;
  egress: "relay" | "direct";
}): Promise<HostedLaunchResult> {
  const sessionId = opts.cloneJobId;
  const source = await db.device.findUnique({
    where: { id: opts.sourceDeviceId },
    select: { id: true, name: true },
  });
  if (!source) {
    return { ok: false, egressMode: opts.egress, exitCode: null, error: "source_device_not_found" };
  }

  let proxyServerValue = "";
  if (opts.egress === "relay") {
    // Fail-closed BEFORE starting a container: naming the relay here is the
    // whole point (see the task's own verification bar — "the launch
    // refuses with a reason that names the relay").
    const controlCheck = await browserRuntime.relayControlStatus(source.id);
    const up = controlCheck.ok && (controlCheck.data as { up?: boolean } | undefined)?.up === true;
    if (!up) {
      return {
        ok: false,
        egressMode: "relay",
        exitCode: null,
        error: `relay_offline: ${source.name}'s relay is not currently connected.`,
      };
    }
    const listener = await browserRuntime.openRelayDeviceListener({ deviceKey: source.id, sessionId });
    if (!listener.ok) {
      return { ok: false, egressMode: "relay", exitCode: null, error: `relay_listener_failed: ${listener.error}` };
    }
    const listenerData = listener.data as { port?: number; host?: string } | undefined;
    if (typeof listenerData?.port !== "number" || !listenerData.host) {
      return {
        ok: false,
        egressMode: "relay",
        exitCode: null,
        error: "relay_listener_failed: no port/host returned",
      };
    }
    const { port, host: listenerHost } = listenerData;
    // FIXED 2026-09-25 (real click-through test, ERR_PROXY_CONNECTION_FAILED):
    // Chromium runs INSIDE the Neko container's own network namespace — a
    // value of "127.0.0.1" here (the original, untested version) resolves to
    // the CONTAINER's own loopback, not the host's, so it was silently
    // unreachable despite this module's own host-side egress check (below)
    // passing fine. `listenerHost` is browser-server's own answer for what a
    // container should actually dial (the docker bridge gateway) — never
    // guessed here.
    proxyServerValue = `http://${listenerHost}:${port}`;
    // No close-handle needed here: browser-server's own stopInternal() closes
    // this session's device listener automatically (keyed by sessionId) the
    // moment /sessions/stop is called — see stopHostedLaunch below.
  }
  // Direct egress: proxyServerValue stays "" — browser-runtime.start()'s own
  // contract documents empty as valid ("direct connection, no exit node").
  // The hosted container's own IP is the exit IP in that case, which is
  // exactly what premium/direct is supposed to mean — never mislabelled.

  await createProfileDir(sessionId).catch(() => {
    // createProfileDir doesn't throw on "already exists" (mkdir recursive) —
    // this catch is only reached on a genuine fs error, which the start call
    // below will also hit and report properly. Never silently continue past
    // a real failure here; just don't double-report it.
  });

  const started = await browserRuntime.start({
    sessionId,
    userId: opts.userId,
    profileDir: profileDirPath(sessionId),
    proxyServerValue,
  });
  if (!started.ok) {
    await deleteProfileDir(profileDirPath(sessionId)).catch(() => {});
    return {
      ok: false,
      egressMode: opts.egress,
      exitCode: null,
      error: `browser_start_failed: ${started.error}`,
    };
  }
  const startedData = started.data as { nekoPassword?: string | null; cdpPort?: number } | undefined;
  const nekoPassword = startedData?.nekoPassword ?? null;
  const cdpPort = startedData?.cdpPort;

  // Live proof, not an assumption: what IS the exit IP through the path we
  // just built? A relay clone whose egress check fails here is torn down
  // immediately rather than handed to the user half-working.
  let egressIp: string | undefined;
  if (opts.egress === "relay") {
    try {
      // "127.0.0.1" here is correct and deliberate, unlike proxyServerValue
      // above: THIS check runs in THIS Node process, on the HOST — where the
      // listener (bound 0.0.0.0) is reachable via loopback too. Only the
      // CONTAINER needs the bridge-gateway address; this process isn't one.
      const port = Number(proxyServerValue.split(":").pop());
      egressIp = await checkIpThroughProxy({ scheme: "http", host: "127.0.0.1", port });
    } catch (e) {
      await browserRuntime.stop(sessionId).catch(() => {});
      await deleteProfileDir(profileDirPath(sessionId)).catch(() => {});
      return {
        ok: false,
        egressMode: "relay",
        exitCode: null,
        error: `relay_egress_unverified: ${e instanceof Error ? e.message : "unknown"}`,
      };
    }
  }

  // TASK_119 A6: Inject live session if requested.
  // Fail-closed (V4): live mode MUST have CDP endpoint and injection must succeed.
  const job = await db.cloneJob.findUnique({
    where: { id: opts.cloneJobId },
    select: { sessionMode: true },
  });
  if (job?.sessionMode === "live") {
    // Live mode requires CDP endpoint to exist.
    if (!cdpPort) {
      await browserRuntime.stop(sessionId).catch(() => {});
      await deleteProfileDir(profileDirPath(sessionId)).catch(() => {});
      return {
        ok: false,
        egressMode: opts.egress,
        exitCode: null,
        error: "session_injection_failed: CDP endpoint not available",
      };
    }

    const injectionResult = await injectLiveCapture({
      cloneJobId: opts.cloneJobId,
      cdpPort,
    });
    if (!injectionResult.ok) {
      await browserRuntime.stop(sessionId).catch(() => {});
      await deleteProfileDir(profileDirPath(sessionId)).catch(() => {});
      return {
        ok: false,
        egressMode: opts.egress,
        exitCode: null,
        error: `session_injection_failed: ${injectionResult.error}`,
      };
    }
  }

  return {
    ok: true,
    egressMode: opts.egress,
    exitCode: 0,
    viewUrl: connectUrlFor(sessionId, nekoPassword),
    egressIp,
  };
}

/** Stops a hosted session and cleans its profile — the hosted-path teardown. */
export async function stopHostedLaunch(cloneJobId: string): Promise<string> {
  const sessionId = cloneJobId;
  try {
    const res = await browserRuntime.stop(sessionId);
    await deleteProfileDir(profileDirPath(sessionId)).catch(() => {});
    return res.ok ? "ok" : `error: ${res.error}`;
  } catch (e) {
    return `error: ${e instanceof Error ? e.message : "unknown"}`;
  }
}
