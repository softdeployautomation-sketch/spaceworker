import "server-only";

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { env } from "./env";

// TASK_114 — one-click clone-device setup, part 1: the engine artifact
// distribution manifest + the signed download URLs the agent fetches from.
//
// WHY THE BINARIES ARE HOSTED HERE AND NOT RUN HERE: the browser-clone engine
// (`hack-browser-clone.exe`, its GUI-subsystem service twin and the egress
// relay `hack-relay.exe`) is a WINDOWS binary that has to run ON THE CUSTOMER'S
// DEVICE. It cannot run on our VPS: the relay exists precisely to make the
// hosted clone browser's traffic egress from the WORK PC's public IP, so a
// VPS-hosted relay would hand the clone the VPS IP and burn every carried
// session. "Automated" therefore means: our server HOSTS the artifacts, the
// agent DOWNLOADS + hash-verifies + installs them locally over the existing
// transport. Nobody visits the machine.
//
// Layout (deploy-time, deliberately NOT in git — no build outputs in history):
//   engine-dist/manifest.json          { files: [{ name, sha256, bytes }] }
//   engine-dist/<artifact>             the rsynced build outputs
// Built from `michael/browser-clone/engine` (scripts/build.ps1, or the go
// cross-build) and rsynced with the deploy.
//
// Every download URL is HMAC-signed, short-lived and bound to ONE device id,
// so the artifacts are never publicly enumerable: possession of a URL proves a
// signed-in owner asked for a setup on that device moments ago. The signature
// is the whole auth (the device agent has no session cookie), which is why the
// secret fails CLOSED when missing.

export interface EngineArtifact {
  name: string;
  sha256: string;
  bytes: number;
}

interface EngineManifest {
  generatedAt?: string;
  files: EngineArtifact[];
}

/** Absolute artifact names only — no traversal, no subpaths. */
const ARTIFACT_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

let cached: { manifest: EngineManifest; mtimeMs: number; file: string } | null = null;

function distDir(): string {
  return process.env.CLONE_ENGINE_DIST_DIR ?? path.join(process.cwd(), "engine-dist");
}

function signingSecret(): string {
  const secret = process.env.CLONE_ENGINE_SECRET ?? env.sessionSecret;
  if (!secret || secret.trim().length === 0) throw new Error("clone_engine_secret_missing");
  return secret;
}

/**
 * Reads + validates engine-dist/manifest.json (cached by mtime). Throws
 * `clone_engine_dist_missing` when the deploy has not rsynced the artifacts —
 * failing loudly beats half-installing a device.
 */
export async function readEngineManifest(): Promise<EngineManifest> {
  const file = path.join(distDir(), "manifest.json");
  const stat = await fs.stat(file).catch(() => null);
  if (!stat) throw new Error("clone_engine_dist_missing");
  if (cached && cached.file === file && cached.mtimeMs === stat.mtimeMs) return cached.manifest;

  const raw = await fs.readFile(file, "utf8").catch(() => null);
  if (!raw) throw new Error("clone_engine_dist_missing");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("clone_engine_dist_invalid");
  }
  const files = (parsed as { files?: unknown }).files;
  if (!Array.isArray(files) || files.length === 0) throw new Error("clone_engine_dist_invalid");
  const generatedAt = (parsed as { generatedAt?: unknown }).generatedAt;
  const manifest: EngineManifest = {
    ...(typeof generatedAt === "string" ? { generatedAt } : {}),
    files: files.filter((f): f is EngineArtifact => {
      const o = f as Partial<EngineArtifact>;
      return (
        typeof o?.name === "string" &&
        ARTIFACT_NAME_RE.test(o.name) &&
        typeof o.sha256 === "string" &&
        /^[0-9a-f]{64}$/.test(o.sha256) &&
        typeof o.bytes === "number" &&
        o.bytes > 0
      );
    }),
  };
  if (manifest.files.length === 0) throw new Error("clone_engine_dist_invalid");
  cached = { manifest, mtimeMs: stat.mtimeMs, file };
  return manifest;
}

/** The artifacts the one-click setup installs (order = download order). */
export async function engineBundle(): Promise<EngineArtifact[]> {
  const { files } = await readEngineManifest();
  const wanted = [
    "hack-browser-clone.exe",
    "hack-browser-clone-svc.exe",
    "hack-relay.exe",
    "install-relay.ps1",
    "install-hosted.ps1",
  ];
  const byName = new Map(files.map((f) => [f.name, f]));
  return wanted
    .map((name) => byName.get(name))
    .filter((f): f is EngineArtifact => !!f);
}

/** Owner-scoped path for one artifact, or null when the name is unknown. */
export async function engineArtifactPath(name: string): Promise<string | null> {
  if (!ARTIFACT_NAME_RE.test(name)) return null;
  const { files } = await readEngineManifest();
  if (!files.some((f) => f.name === name)) return null;
  return path.join(distDir(), name);
}

function sign(file: string, deviceId: string, exp: number): string {
  return crypto
    .createHmac("sha256", signingSecret())
    .update(`${file}\n${deviceId}\n${exp}`)
    .digest("hex");
}

/**
 * Signed, single-device, short-lived download URL. `deviceId` is the
 * SpaceWorker Device id (not the agent id), so a leaked URL is useless without
 * a live setup request for that same device.
 */
export async function signedEngineUrl(opts: {
  file: string;
  deviceId: string;
  ttlSeconds?: number;
}): Promise<string> {
  const ttl = Math.min(3600, Math.max(60, Math.round(opts.ttlSeconds ?? 900)));
  const exp = Math.floor(Date.now() / 1000) + ttl;
  const sig = sign(opts.file, opts.deviceId, exp);
  const base = env.appBaseUrl.replace(/\/$/, "");
  const query = new URLSearchParams({ d: opts.deviceId, e: String(exp), s: sig });
  return `${base}/api/clone-engine/${encodeURIComponent(opts.file)}?${query.toString()}`;
}

/** Constant-time verification of a download URL. Expiry is enforced here. */
export function verifyEngineSignature(opts: {
  file: string;
  deviceId: string;
  exp: number;
  sig: string;
}): boolean {
  if (!ARTIFACT_NAME_RE.test(opts.file)) return false;
  if (!opts.deviceId || opts.deviceId.length > 64) return false;
  if (!/^[0-9a-f]{64}$/.test(opts.sig)) return false;
  if (!Number.isFinite(opts.exp) || opts.exp <= Math.floor(Date.now() / 1000)) return false;
  let expected: string;
  try {
    expected = sign(opts.file, opts.deviceId, opts.exp);
  } catch {
    return false; // secret missing → fail closed, never "open"
  }
  return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(opts.sig, "hex"));
}

