// TASK_249 — the shared public host behind /hf/* (file downloads) and
// /link/vantra/* (installer links), served by the sw-public-proxy Worker.
//
// AdminSetting.hostingPublicLinkHost is the single source of truth when set.
// It is read per request with a SHORT module-level TTL cache (~60s): every
// request gets a fresh-enough answer without hammering the DB, and an admin
// change surfaces within a minute without a redeploy. Empty means "unset",
// and each family falls back to its own env base exactly as today:
//
//   /hf/*             → HOSTING_PUBLIC_BASE_URL (or APP_BASE_URL)
//   /link/vantra/*    → PUBLIC_LINK_BASE_URL (or APP_BASE_URL)
//
// IMPORTANT: this module must stay import-safe for pure/unit code. lib/env
// validates required secrets at import time, and lib/prisma imports
// `server-only`; importing either here pulled both into lib/hosting/providers.ts
// and broke six pre-existing hosting test files (TASK_249 verification). So the
// settings read is DYNAMIC and the env is read lazily at call time.
//
// The setting stores a HOST ("dl.example.com"); both getters return a full
// BASE URL with a scheme, because every caller concatenates a path onto it
// (`${base}/hf/<token>`). Returning a bare host produced scheme-less links.

import { normalizeHostInput } from "./domain-select";

const CACHE_TTL_MS = 60_000;

type SharedHostReader = () => Promise<{ hostingPublicLinkHost?: string | null }>;

let sharedHostReader: SharedHostReader | null = null;
let cached: { shared: string | null; at: number } | null = null;

/** Test seam: read the setting without Prisma/server-only. Pass null to reset. */
export function setPublicBaseSettingsReader(reader: SharedHostReader | null): void {
  sharedHostReader = reader;
  cached = null;
}

/** Drop the 60s cache (tests, and after an admin PATCH in the same process). */
export function resetPublicBaseCache(): void {
  cached = null;
}

function appBase(): string {
  return (process.env.APP_BASE_URL ?? "").trim().replace(/\/+$/, "");
}

function envBase(name: string): string {
  const value = (process.env[name] ?? "").trim().replace(/\/+$/, "");
  return value || appBase();
}

/** Pure: the stored shared host (bare), or null. */
export function normalizeSharedHost(
  value: string | null | undefined
): string | null {
  return normalizeHostInput(value);
}

/**
 * Pure: resolve the shared setting against its env fallback.
 * A set shared host becomes `https://<host>`; the fallback is returned as-is
 * (it is already a full base URL from env). Empty shared = fallback.
 */
export function resolvePublicBase(
  shared: string | null | undefined,
  fallback: string
): string {
  const host = normalizeSharedHost(shared ?? null);
  if (!host) return fallback.trim().replace(/\/+$/, "");
  return `https://${host}`;
}

async function readSharedHost(): Promise<string | null> {
  if (cached && Date.now() - cached.at <= CACHE_TTL_MS) return cached.shared;

  let shared: string | null = null;
  try {
    let settings: { hostingPublicLinkHost?: string | null };
    if (sharedHostReader) {
      settings = await sharedHostReader();
    } else {
      const mod = await import("@/lib/admin-settings");
      settings = await mod.getAdminSettings();
    }
    shared = normalizeSharedHost(settings.hostingPublicLinkHost ?? null);
  } catch {
    // A settings read must never break file serving. Unit/pure callers (and any
    // transient DB failure) fall back to the env base, and the miss is cached
    // for the same TTL so we do not retry on every request.
    shared = null;
  }
  cached = { shared, at: Date.now() };
  return cached.shared;
}

/** The base URL file downloads are served from: /hf/<token>. */
export async function getFileBaseUrl(): Promise<string> {
  return resolvePublicBase(
    await readSharedHost(),
    envBase("HOSTING_PUBLIC_BASE_URL")
  );
}

/** The base URL installer links are served from: /link/vantra/<token>. */
export async function getPublicLinkHost(): Promise<string> {
  return resolvePublicBase(
    await readSharedHost(),
    envBase("PUBLIC_LINK_BASE_URL")
  );
}
