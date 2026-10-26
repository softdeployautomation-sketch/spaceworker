import "server-only";

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { decryptSecret, encryptSecret } from "./mailbox-crypto";
import { stateCacheDirForTarget } from "./clone-state-ingest";
import type { CdpCookie } from "./cdp";

// TASK_243 — the sign-in half, made durable.
//
// A clone used to hold its captured cookies only in RAM for 5 minutes and
// inject them into the ONE hosted session it launched. The moment that session
// ended (idle TTL, revoke, a browser-server restart) the sign-in was gone, so
// "open my cloned browser again later — even with my PC off" could not work.
//
// This stores the captured cookie jar ENCRYPTED (the same AES-256-GCM secret
// Mailbox uses) in the existing per-TARGET state cache directory, which already
// survives between clones and is purged with the target. It is keyed by
// (device, browser, profile) — never by a session — so a new clone started
// while the PC is offline can be signed in from the last capture.
//
// The file never leaves the server, is 0600, and only the counts are ever
// logged/audited; the plaintext exists only while injecting into CDP.

const JAR_FILE = "cookie-jar.enc";

export interface CookieJarTarget {
  deviceId: string;
  browser: string;
  profileName: string | null | undefined;
}

function jarPath(parts: CookieJarTarget): string {
  return join(stateCacheDirForTarget(parts), JAR_FILE);
}

/** Persist a captured jar for a target. Best-effort callers decide on failure. */
export async function persistCookieJar(parts: CookieJarTarget, cookies: CdpCookie[]): Promise<void> {
  if (!Array.isArray(cookies) || cookies.length === 0) return;
  const dir = stateCacheDirForTarget(parts);
  await mkdir(dir, { recursive: true });
  const payload = JSON.stringify({ capturedAt: new Date().toISOString(), cookies });
  const { ciphertext, iv, tag } = encryptSecret(payload);
  await writeFile(jarPath(parts), [iv, tag, ciphertext].join(":"), { mode: 0o600 });
}

/** Read the persisted jar for a target, or null when absent/undecryptable. */
export async function loadCookieJar(
  parts: CookieJarTarget,
): Promise<{ cookies: CdpCookie[]; capturedAt: string | null } | null> {
  let file: string;
  try {
    file = jarPath(parts);
  } catch {
    // Unknown profile / no base dir: there is no jar to read, and a caller
    // deciding "can this launch offline?" must get a plain no, not a throw.
    return null;
  }
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return null;
  }
  const [iv, tag, ciphertext] = raw.split(":");
  if (!iv || !tag || !ciphertext) return null;
  try {
    const parsed = JSON.parse(decryptSecret(ciphertext, iv, tag)) as {
      capturedAt?: unknown;
      cookies?: unknown;
    };
    if (!Array.isArray(parsed.cookies) || parsed.cookies.length === 0) return null;
    return {
      cookies: parsed.cookies as CdpCookie[],
      capturedAt: typeof parsed.capturedAt === "string" ? parsed.capturedAt : null,
    };
  } catch {
    return null;
  }
}

export async function hasCookieJar(parts: CookieJarTarget): Promise<boolean> {
  return (await loadCookieJar(parts)) !== null;
}
