// TASK_171 — the ONE countdown string for a public install link, shared by
// every history row in the Add-a-device panel (components/device-list.tsx).
//
// Client-safe on purpose (no `server-only` import): the panel renders it off
// its existing 1-minute `nowMs` tick with no new fetch loop, and the unit
// tests import this module directly. Counts DOWN to `expiresAt` only — an
// expired link says "expired", never a negative or count-up time.

const MINUTE_MS = 60 * 1000;

export function formatInstallLinkCountdown(expiresAtMs: number, nowMs: number): string {
  const remaining = expiresAtMs - nowMs;
  if (!Number.isFinite(remaining) || remaining <= 0) return "expired";
  const totalMinutes = Math.floor(remaining / MINUTE_MS);
  if (totalMinutes < 1) return "expires in <1m";
  if (totalMinutes < 60) return `expires in ${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `expires in ${hours}h ${String(minutes).padStart(2, "0")}m`;
}

export function formatDownloadCount(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return "No downloads yet";
  return count === 1 ? "1 download" : `${count} downloads`;
}
