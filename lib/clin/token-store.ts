import "server-only";
import { getValidClineCredentials } from "@cline/sdk";
import { db } from "@/lib/db";
import { getClineApiBaseUrl } from "./config";
import {
  decryptCredentials,
  decryptValue,
  encryptCredentials,
  encryptValue,
  isEncryptedValue,
  type StoredClineCredentials,
} from "./token-crypto";

/**
 * TASK_246 — the one place that reads/writes the Cline OAuth credentials.
 *
 * Before this file, `clineOAuthTokenEnc` held a bare XOR'd access token and
 * `lib/lab/cline-agent.ts` handed that ciphertext to the SDK as if it were the
 * key. Everything now round-trips through `StoredClineCredentials` and is
 * refreshed through the SDK before use.
 */

export type { StoredClineCredentials };

export type ClineCredentialRead =
  | { ok: true; credentials: StoredClineCredentials }
  | { ok: false; reason: "missing" | "unreadable" };

const REFRESH_BUFFER_MS = 60_000;

export async function readClineCredentials(userId: string): Promise<ClineCredentialRead> {
  const row = await db.cyberLabAgentSettings.findUnique({
    where: { userId },
    select: { clineOAuthTokenEnc: true, clineRefreshTokenEnc: true },
  });
  if (!row?.clineOAuthTokenEnc) return { ok: false, reason: "missing" };

  let credentials: StoredClineCredentials;
  if (isEncryptedValue(row.clineOAuthTokenEnc)) {
    try {
      credentials = decryptCredentials(row.clineOAuthTokenEnc);
    } catch {
      // AES-GCM is authenticated: a wrong/rotated key is a real failure, not
      // "no credentials". Callers must ask the user to log in again.
      return { ok: false, reason: "unreadable" };
    }
  } else {
    // Pre-TASK_246 row: bare access token under the old XOR scheme.
    try {
      credentials = { access: decryptValue(row.clineOAuthTokenEnc) };
    } catch {
      return { ok: false, reason: "unreadable" };
    }
  }

  if (!credentials.access) return { ok: false, reason: "unreadable" };

  if (!credentials.refresh && row.clineRefreshTokenEnc) {
    try {
      credentials.refresh = decryptValue(row.clineRefreshTokenEnc);
    } catch {
      // Leave refresh undefined; a non-expiring legacy token still works.
    }
  }

  return { ok: true, credentials };
}

export async function persistClineCredentials(
  userId: string,
  credentials: StoredClineCredentials,
): Promise<void> {
  const data = {
    clineOAuthTokenEnc: encryptCredentials(credentials),
    clineRefreshTokenEnc: credentials.refresh ? encryptValue(credentials.refresh) : null,
  };
  await db.cyberLabAgentSettings.upsert({
    where: { userId },
    update: data,
    create: { userId, ...data },
  });
}

export async function clearClineCredentials(userId: string): Promise<void> {
  // updateMany, not update: logging out before ever connecting must not 500.
  await db.cyberLabAgentSettings.updateMany({
    where: { userId },
    data: { clineOAuthTokenEnc: null, clineRefreshTokenEnc: null },
  });
}

/**
 * Access token for the Cline SDK, refreshed when close to expiry.
 *
 * - returns a usable token when we have one (fresh or just refreshed)
 * - returns `null` only when the refresh token was rejected → credentials were
 *   cleared and the user must log in again
 * - a transient refresh failure returns the current token so the SDK can try;
 *   stored credentials are left untouched (never destroy a good refresh token
 *   because a network blip happened)
 */
export async function getClineAccessToken(userId: string): Promise<string | null> {
  const read = await readClineCredentials(userId);
  if (!read.ok) return null;

  const current = read.credentials;
  const expiresSoon = !current.expires || current.expires - Date.now() < REFRESH_BUFFER_MS;
  if (!expiresSoon) return current.access;

  if (!current.refresh) return current.access;

  try {
    const refreshed = await getValidClineCredentials(
      {
        access: current.access,
        refresh: current.refresh,
        expires: current.expires ?? 0,
        email: current.email ?? undefined,
        accountId: current.accountId ?? undefined,
        metadata: current.metadata,
      },
      { apiBaseUrl: getClineApiBaseUrl() },
    );

    if (refreshed === null) {
      await clearClineCredentials(userId);
      return null;
    }

    const next: StoredClineCredentials = {
      access: refreshed.access,
      refresh: refreshed.refresh ?? current.refresh,
      expires: refreshed.expires || current.expires,
      email: refreshed.email ?? current.email ?? null,
      accountId: refreshed.accountId ?? current.accountId ?? null,
      metadata: refreshed.metadata ?? current.metadata,
    };
    await persistClineCredentials(userId, next);
    return next.access;
  } catch {
    // Transient (network/5xx/timeout): keep credentials, use what we have.
    return current.access;
  }
}
