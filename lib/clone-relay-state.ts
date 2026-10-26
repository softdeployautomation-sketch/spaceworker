import "server-only";

import { browserRuntime } from "./browser-runtime";

// TASK_243 — the relay's control-connection probe, isolated in its own module
// so callers (the launch gate, the fail-closed sweep) and tests depend on the
// tri-state answer alone, not on the whole hosted-launch surface.
//
// "up"   — browser-server says the device's dial-out tunnel is live.
// "down" — browser-server answered and said it is not live.
// "unknown" — the probe could not answer (browser-server hiccup, bad response).
//   Unknown NEVER tears a clone down; only a definite "down" does.

export async function relayTunnelState(deviceId: string): Promise<"up" | "down" | "unknown"> {
  try {
    const res = await browserRuntime.relayControlStatus(deviceId);
    if (!res.ok) return "unknown";
    const up = (res.data as { up?: boolean } | undefined)?.up;
    return up === true ? "up" : up === false ? "down" : "unknown";
  } catch {
    return "unknown";
  }
}

export async function isRelayTunnelUp(deviceId: string): Promise<boolean> {
  return (await relayTunnelState(deviceId)) === "up";
}
