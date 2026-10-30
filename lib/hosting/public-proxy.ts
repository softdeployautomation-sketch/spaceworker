// TASK_249 — the shared public Worker proxy.
//
// One Cloudflare host serves /hf/* (file downloads) and /link/vantra/* (installer
// links), proxying every request to APP_BASE_URL. Any other path is 404 at the
// edge, so the proxy can never be used as an open proxy onto arbitrary paths.
//
// provisionPublicHost(host) publishes the sw-public-proxy Worker to <host>:
//   1. ensureZoneActive   — the host's zone exists AND is active in THIS account
//   2. ensureProxiedRecord — AAAA 100::, proxied; adopts an existing record
//   3. uploadWorkerScript — sw-public-proxy (PUT overwrites, so re-publishing is safe)
//   4. putWorkerRoute     — <host>/* → sw-public-proxy (identical route = no-op)
// It is fully idempotent: provisioning the same host twice is a no-op success.
//
// On a host change the caller tears down the previous host first
// (teardownPublicHost: delete its route, then the script) and then provisions
// the new host — the script is re-uploaded as part of provisioning.
//
// Tokens are decrypted on the fly and never returned or logged here.

import { prisma } from "../prisma";
import { env } from "@/lib/env";
import { readWorkerToken } from "./credentials";
import type { CfCredential } from "./cloudflare";
import { apexOfHost } from "./domain-select";
import {
  ensureZoneActive,
  ensureProxiedRecord,
  deleteWorkerRoute,
  deleteWorkerScript,
  getZoneByName,
  listActiveZones,
  listWorkerRoutes,
  putWorkerRoute,
  uploadWorkerScript,
} from "./workers";
import { getAdminSettings } from "@/lib/admin-settings";

export const PUBLIC_PROXY_SCRIPT = "sw-public-proxy";

/** The only path prefixes the public proxy serves — everything else 404s. */
export const PUBLIC_PATH_PREFIXES = ["/hf/", "/link/vantra/"] as const;

/**
 * The Worker module source, with the origin embedded at upload time (the edge
 * has no access to our env vars). `redirect: "manual"` keeps the installer's
 * 302 a 302 instead of following it; bodies stream through.
 */
export function publicProxySource(origin: string): string {
  return (
    "export default {\n" +
    `  async fetch(request) {\n` +
    `    const url = new URL(request.url);\n` +
    `    const path = url.pathname;\n` +
    `    let allowed = false;\n` +
    `    for (const prefix of ${JSON.stringify(PUBLIC_PATH_PREFIXES)}) {\n` +
    `      if (path.startsWith(prefix)) allowed = true;\n` +
    `    }\n` +
    `    if (!allowed) return new Response(null, { status: 404 });\n` +
    `    const headers = new Headers(request.headers);\n` +
    `    headers.delete("host");\n` +
    `    const target = new URL(path + url.search, ${JSON.stringify(origin)});\n` +
    `    const init = {\n` +
    `      method: request.method,\n` +
    `      headers,\n` +
    `      redirect: "manual",\n` +
    `    };\n` +
    `    if (request.method !== "GET" && request.method !== "HEAD") {\n` +
    `      init.body = request.body;\n` +
    `    }\n` +
    `    return fetch(target, init);\n` +
    `  },\n` +
    "};\n"
  );
}

export interface ProvisionPublicHostResult {
  ok: boolean;
  host: string;
  zoneId: string | null;
  zoneName: string | null;
  dnsCreated: boolean;
  /** Plain-language error when ok is false; never contains a token. */
  error: string | null;
}

/**
 * The account that serves the public proxy: public pin → LINKS pin → priority.
 * Files and installer links are Workers/DNS traffic, so they follow the links
 * account by default (owner ruling) — never the sites account.
 */
function publicAccountPin(settings: {
  hostingPublicLinksAccountId?: string | null;
  hostingPremiumLinksAccountId?: string | null;
}): string | null {
  return (
    settings.hostingPublicLinksAccountId?.trim() ||
    settings.hostingPremiumLinksAccountId?.trim() ||
    null
  );
}

async function resolvePublicCredential(accountIdOverride?: string | null): Promise<{
  row: { accountId: string; label: string } | null;
  cred: CfCredential | null;
}> {
  const settings = await getAdminSettings();
  // An explicit override is used by the admin PATCH: it provisions with the
  // account the admin is SAVING, before the setting is written.
  const pin =
    accountIdOverride !== undefined
      ? accountIdOverride?.trim() || null
      : publicAccountPin(settings);
  const row = pin
    ? await prisma.hostingPlatformAccount.findFirst({ where: { accountId: pin } })
    : await prisma.hostingPlatformAccount.findFirst({
        where: { status: "active", workerTokenCiphertext: { not: null } },
        orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
      });
  if (!row) return { row: null, cred: null };
  const token = readWorkerToken(row);
  if (!token) return { row: { accountId: row.accountId, label: row.label }, cred: null };
  return {
    row: { accountId: row.accountId, label: row.label },
    cred: { accountId: row.accountId, token },
  };
}


export async function provisionPublicHost(
  host: string,
  options?: { accountId?: string | null }
): Promise<ProvisionPublicHostResult> {
  const { row, cred } = await resolvePublicCredential(options?.accountId);
  if (!cred || !row) {
    return {
      ok: false,
      host,
      zoneId: null,
      zoneName: null,
      dnsCreated: false,
      error:
        "No active platform account with a Workers/DNS token is configured for public links. Pin one in the admin panel, or add a Workers token to an account row.",
    };
  }

  const zone = await ensureZoneActive(cred, host);
  if (!zone.ok) {
    return {
      ok: false,
      host,
      zoneId: null,
      zoneName: null,
      dnsCreated: false,
      error: zone.error ?? `Could not confirm the zone for ${host}.`,
    };
  }

  const record = await ensureProxiedRecord(cred, zone.value!.zoneId, host);
  if (!record.ok) {
    return {
      ok: false,
      host,
      zoneId: zone.value!.zoneId,
      zoneName: zone.value!.zoneName,
      dnsCreated: false,
      error: record.error ?? `Could not create the DNS record for ${host}.`,
    };
  }

  const uploaded = await uploadWorkerScript(
    cred,
    PUBLIC_PROXY_SCRIPT,
    publicProxySource(env.appBaseUrl)
  );
  if (!uploaded.ok) {
    return {
      ok: false,
      host,
      zoneId: zone.value!.zoneId,
      zoneName: zone.value!.zoneName,
      dnsCreated: record.value!.created,
      error: uploaded.error ?? `Could not upload the public proxy Worker.`,
    };
  }

  const routed = await putWorkerRoute(
    cred,
    zone.value!.zoneId,
    `${host}/*`,
    PUBLIC_PROXY_SCRIPT
  );
  if (!routed.ok) {
    return {
      ok: false,
      host,
      zoneId: zone.value!.zoneId,
      zoneName: zone.value!.zoneName,
      dnsCreated: record.value!.created,
      error: routed.error ?? `Could not route ${host}/* to the public proxy.`,
    };
  }

  return {
    ok: true,
    host,
    zoneId: zone.value!.zoneId,
    zoneName: zone.value!.zoneName,
    dnsCreated: record.value!.created,
    error: null,
  };
}

export interface TeardownPublicHostResult {
  ok: boolean;
  host: string;
  error: string | null;
}

/** Detach the previous host: delete its route, then the shared script. */
export async function teardownPublicHost(
  host: string,
  options?: { accountId?: string | null }
): Promise<TeardownPublicHostResult> {
  const { row, cred } = await resolvePublicCredential(options?.accountId);
  if (!cred || !row) {
    return { ok: true, host, error: null };
  }

  // Find the zone from the LIVE list, longest suffix first, so a deeper zone
  // (example.co.uk) is not mistaken for its last two labels. `apexOfHost` is
  // only the fallback when the list call fails: teardown is best-effort, and a
  // leftover route is harmless.
  let zoneId: string | null = null;
  const listed = await listActiveZones(cred);
  if (listed.ok) {
    const match = (listed.value ?? [])
      .filter((z) => {
        const name = z.name?.toLowerCase();
        return !!name && (host.toLowerCase() === name || host.toLowerCase().endsWith(`.${name}`));
      })
      .sort((a, b) => b.name.length - a.name.length)[0];
    zoneId = match?.id ?? null;
  }
  if (!zoneId) {
    const apex = apexOfHost(host);
    if (!apex) return { ok: true, host, error: null };
    const zone = await getZoneByName(cred, apex);
    if (!zone.ok || !zone.value) {
      return { ok: true, host, error: null };
    }
    zoneId = zone.value.zoneId;
  }

  const routes = await listWorkerRoutes(cred, zoneId);
  if (routes.ok) {
    const route = routes.value!.find(
      (r) => r.pattern === `${host}/*` && r.script === PUBLIC_PROXY_SCRIPT
    );
    if (route) {
      const deleted = await deleteWorkerRoute(cred, zoneId, route.id);
      if (!deleted.ok) {
        return {
          ok: false,
          host,
          error: deleted.error ?? `Could not remove the old route for ${host}.`,
        };
      }
    }
  }

  const removed = await deleteWorkerScript(cred, PUBLIC_PROXY_SCRIPT);
  if (!removed.ok) {
    return {
      ok: false,
      host,
      error: removed.error ?? `Could not remove the public proxy Worker script.`,
    };
  }

  return { ok: true, host, error: null };
}
