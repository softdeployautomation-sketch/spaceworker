import "server-only";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

/**
 * TASK_246 — at-rest protection for the stored Cline OAuth credentials.
 *
 * Before this file the tokens were "encrypted" with XOR against a hardcoded
 * default key, and only the bare access/refresh strings were stored (no expiry,
 * no email). Here we store the whole credential object in a versioned
 * AES-256-GCM envelope:
 *
 *   v1:<iv-b64>.<tag-b64>.<ciphertext-b64>
 *
 * The key is derived from SESSION_SECRET unless an explicit
 * CLINE_TOKEN_ENCRYPTION_KEY is configured, so no new production env var is
 * required. Legacy XOR rows are still readable (base64 has no ":", so the
 * prefix is unambiguous) and are rewritten as v1 on the next save.
 */

const VERSION = "v1";
const KDF_SALT = "spaceworker/cline/v1";
const LEGACY_DEFAULT_KEY = "spaceworker-default-key-change-me";

export interface StoredClineCredentials {
  access: string;
  refresh?: string;
  /** Expiry in epoch milliseconds (SDK `OAuthCredentials.expires`). */
  expires?: number;
  email?: string | null;
  accountId?: string | null;
  metadata?: Record<string, unknown>;
}

let cachedKey: Buffer | null = null;

function resolveKeyMaterial(): string {
  const explicit = process.env.CLINE_TOKEN_ENCRYPTION_KEY?.trim();
  if (explicit) return explicit;
  const session = process.env.SESSION_SECRET?.trim();
  if (!session) {
    throw new Error(
      "Cline tokens cannot be secured: set SESSION_SECRET (or CLINE_TOKEN_ENCRYPTION_KEY) on the server.",
    );
  }
  return session;
}

export function getClineTokenKey(): Buffer {
  if (cachedKey) return cachedKey;
  cachedKey = scryptSync(resolveKeyMaterial(), KDF_SALT, 32);
  return cachedKey;
}

/** Tests flip env vars between cases; production never calls this. */
export function resetClineTokenKeyCacheForTesting(): void {
  cachedKey = null;
}

export function isEncryptedValue(payload: string): boolean {
  return payload.startsWith(`${VERSION}:`);
}

export function encryptValue(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getClineTokenKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [
    `${VERSION}:${iv.toString("base64")}`,
    cipher.getAuthTag().toString("base64"),
    ciphertext.toString("base64"),
  ].join(".");
}

export function decryptValue(payload: string): string {
  if (!isEncryptedValue(payload)) return legacyDecrypt(payload);

  const parts = payload.slice(VERSION.length + 1).split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1]) {
    throw new Error("Malformed encrypted Cline token");
  }
  const [ivB64, tagB64, ciphertextB64] = parts;
  const decipher = createDecipheriv("aes-256-gcm", getClineTokenKey(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

/** Old XOR obfuscation, kept read-only so pre-TASK_246 rows keep working. */
export function legacyDecrypt(payload: string): string {
  const key = process.env.CLINE_TOKEN_ENCRYPTION_KEY ?? LEGACY_DEFAULT_KEY;
  const bytes = Buffer.from(payload, "base64");
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += String.fromCharCode(bytes[i] ^ key.charCodeAt(i % key.length));
  }
  return out;
}

/** Test fixture helper; production never writes legacy rows again. */
export function legacyEncrypt(plaintext: string, key = LEGACY_DEFAULT_KEY): string {
  let out = "";
  for (let i = 0; i < plaintext.length; i++) {
    out += String.fromCharCode(plaintext.charCodeAt(i) ^ key.charCodeAt(i % key.length));
  }
  return Buffer.from(out, "binary").toString("base64");
}

export function encryptCredentials(credentials: StoredClineCredentials): string {
  return encryptValue(JSON.stringify(credentials));
}

export function decryptCredentials(payload: string): StoredClineCredentials {
  const parsed = JSON.parse(decryptValue(payload)) as unknown;
  if (!parsed || typeof parsed !== "object" || typeof (parsed as StoredClineCredentials).access !== "string") {
    throw new Error("Stored Cline credentials are malformed");
  }
  const credentials = parsed as StoredClineCredentials;
  return {
    access: credentials.access,
    refresh: typeof credentials.refresh === "string" ? credentials.refresh : undefined,
    expires: typeof credentials.expires === "number" && credentials.expires > 0 ? credentials.expires : undefined,
    email: credentials.email ?? null,
    accountId: credentials.accountId ?? null,
    metadata: credentials.metadata,
  };
}
