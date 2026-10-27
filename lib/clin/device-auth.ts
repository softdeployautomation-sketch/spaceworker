import "server-only";
import { completeClineDeviceAuth } from "@cline/sdk";
import { db } from "@/lib/db";
import { getClineApiBaseUrl } from "./config";
import { persistClineCredentials } from "./token-store";

/**
 * TASK_246 — server-side device-code polling.
 *
 * The old flow only ever called Cline from the "Confirm" click, so the UI's
 * "auto connect" poller could never flip to connected. This module is the one
 * code path that talks to WorkOS/Cline, and both `/poll` and `/callback` use it.
 *
 * Error handling is by duck-typed SDK fields (`errorCode`/`status`), never by
 * regexing a raw message for `fetch failed`: a transport failure must surface as
 * "could not reach Cline", not as Node's internal error string.
 */

export type ClinePollResult =
  | { status: "connected"; email: string | null; accountId: string | null; expires: number | null }
  | { status: "pending"; message: string; retryAfterSeconds: number }
  | { status: "expired"; message: string }
  | { status: "denied"; message: string }
  | { status: "unreachable"; message: string; retryAfterSeconds: number };

const MESSAGES = {
  pending: "Waiting for you to approve the code on Cline.",
  expired: "This Cline code expired. Get a new code to continue.",
  denied: "The Cline login was denied. Get a new code to try again.",
  unreachable: "Could not reach Cline's API from the server. Try again in a moment.",
  none: "No pending Cline login. Start again.",
} as const;

const inFlight = new Set<string>();

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

export function classifyClineDeviceAuthError(
  err: unknown,
): "pending" | "expired" | "denied" | "unreachable" {
  const e = err as { errorCode?: unknown; status?: unknown; message?: unknown } | null;
  const code = typeof e?.errorCode === "string" ? e.errorCode.toLowerCase() : "";
  const message = typeof e?.message === "string" ? e.message.toLowerCase() : String(err ?? "").toLowerCase();

  if (code === "expired_token" || code === "expired" || /expired/.test(message)) return "expired";
  if (code === "access_denied" || /access_denied|was denied|denied by/.test(message)) return "denied";
  if (
    code === "authorization_pending" ||
    code === "slow_down" ||
    /timed out|timeout|authorization_pending|slow_down|still pending|not yet approved/.test(message)
  ) {
    return "pending";
  }
  return "unreachable";
}

async function deleteDeviceRow(deviceCode: string): Promise<void> {
  await db.clineDeviceAuth.delete({ where: { deviceCode } }).catch(() => {});
}

export interface PollClineDeviceAuthInput {
  userId: string;
  deviceCode?: string;
  /** How long this call waits for approval (seconds). 1–20. */
  windowSeconds?: number;
  /** How often the SDK asks WorkOS (seconds). 1–10. */
  pollIntervalSeconds?: number;
}

export async function pollClineDeviceAuth(
  input: PollClineDeviceAuthInput,
): Promise<ClinePollResult> {
  const windowSeconds = clamp(input.windowSeconds ?? 8, 1, 20);
  const pollIntervalSeconds = clamp(input.pollIntervalSeconds ?? 5, 1, 10);

  const row = input.deviceCode
    ? await db.clineDeviceAuth.findUnique({ where: { deviceCode: input.deviceCode } })
    : await db.clineDeviceAuth.findFirst({
        where: { userId: input.userId, expiresAt: { gt: new Date() } },
        orderBy: { expiresAt: "desc" },
      });

  if (!row || row.userId !== input.userId) {
    return { status: "expired", message: MESSAGES.none };
  }

  if (row.expiresAt.getTime() <= Date.now()) {
    await deleteDeviceRow(row.deviceCode);
    return { status: "expired", message: MESSAGES.expired };
  }

  // Two tabs / overlapping timers must not race the same one-time device code.
  if (inFlight.has(row.deviceCode)) {
    return { status: "pending", message: "Checking with Cline…", retryAfterSeconds: 2 };
  }
  inFlight.add(row.deviceCode);

  try {
    const credentials = await completeClineDeviceAuth({
      deviceCode: row.deviceCode,
      expiresInSeconds: windowSeconds,
      pollIntervalSeconds,
      apiBaseUrl: getClineApiBaseUrl(),
    });

    await persistClineCredentials(input.userId, {
      access: credentials.access,
      refresh: credentials.refresh,
      expires: credentials.expires,
      email: credentials.email ?? null,
      accountId: credentials.accountId ?? null,
      metadata: credentials.metadata,
    });
    await deleteDeviceRow(row.deviceCode);

    return {
      status: "connected",
      email: credentials.email ?? null,
      accountId: credentials.accountId ?? null,
      expires: credentials.expires ?? null,
    };
  } catch (err) {
    const kind = classifyClineDeviceAuthError(err);
    if (kind === "expired" || kind === "denied") {
      await deleteDeviceRow(row.deviceCode);
    }
    if (kind === "pending") {
      return { status: "pending", message: MESSAGES.pending, retryAfterSeconds: pollIntervalSeconds };
    }
    if (kind === "expired") return { status: "expired", message: MESSAGES.expired };
    if (kind === "denied") return { status: "denied", message: MESSAGES.denied };
    return { status: "unreachable", message: MESSAGES.unreachable, retryAfterSeconds: 5 };
  } finally {
    inFlight.delete(row.deviceCode);
  }
}
