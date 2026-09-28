import "server-only";
import { randomBytes, createCipheriv, createDecipheriv } from "crypto";

const KEY = Buffer.from(process.env.MAILBOX_ENCRYPTION_KEY!, "hex");

export function encryptSecret(plaintext: string): { ciphertext: string; iv: string; tag: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("hex"),
    iv: iv.toString("hex"),
    tag: cipher.getAuthTag().toString("hex"),
  };
}

export function decryptSecret(ciphertext: string, iv: string, tag: string): string {
  const decipher = createDecipheriv("aes-256-gcm", KEY, Buffer.from(iv, "hex"));
  decipher.setAuthTag(Buffer.from(tag, "hex"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "hex")),
    decipher.final(),
  ]).toString("utf8");
}

/**
 * 2026-09-28 — `decryptSecret` with a failure a human can act on.
 *
 * AES-GCM is authenticated, so a wrong key surfaces as the bare OpenSSL string
 * "Unsupported state or unable to authenticate data" (or "Invalid initialization
 * vector"). That raw text reached the user as a campaign failure reason: 50
 * queued items failed with exactly that, which reads like a mail problem and
 * tells nobody what to do. What it actually means is always the same thing —
 * the row was encrypted under a DIFFERENT `MAILBOX_ENCRYPTION_KEY` than the one
 * this process is holding (the key was rotated, or the row was written by
 * another deployment). No amount of retrying or port-tweaking can fix it; the
 * password has to be re-entered.
 *
 * Callers that fail a whole batch on this (the queue drain) get a stable phrase
 * to classify on; `label` names the thing to go re-save.
 */
export function decryptSecretOrThrow(
  ciphertext: string,
  iv: string,
  tag: string,
  label = "mailbox"
): string {
  try {
    return decryptSecret(ciphertext, iv, tag);
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    if (/unable to authenticate data|Invalid initialization vector|bad decrypt/i.test(raw)) {
      throw new Error(
        `Stored password for this ${label} cannot be decrypted with the server's current ` +
          `MAILBOX_ENCRYPTION_KEY (${raw}). The encryption key changed, or this row was saved by a ` +
          `different deployment — open the ${label} and re-enter its password to fix it. ` +
          `Nothing about the SMTP host, port or security mode is at fault.`
      );
    }
    throw err;
  }
}