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