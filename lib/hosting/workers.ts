import { createHash } from "node:crypto";

import { cfFetch, firstError, type CfCredential, type CfResult } from "./cloudflare";

// TASK_155 P6c — the Workers engine for short links (PLAN §19.12).
//
// WHY A WORKER AT ALL: /r/<token> already answers from our own metal, so a Worker
// is not needed to make a link work. It is the PREMIUM engine — the user's own
// Cloudflare account serves the redirect, on their own domain, so the click never
// touches our server. That is also why a Worker link keeps its local /r/<token>
// resolution as a fallback (§19.12.2): the two coexist, and /r is what proves the
// link still lives if the Worker route is ever wrong.
//
// ONE SCRIPT PER USER. Not one per link: a route is created once for `<host>/*`
// and that single Worker holds a Map of EVERY link that user owns (token and slug
// → target). Adding a link rewrites the map; removing the LAST cloudflare link
// deletes the route and then the script.
//
// ORDER IS LOAD-BEARING (§19.12.3):
//   1. verify the zone is ACTIVE   — never create a route on a zone that isn't
//   2. upload/overwrite the script — PUT is idempotent, so republish is safe
//   3. create the route            — only `go.<zone>/*`, never `*.<zone>/*`
// and on teardown the ROUTE goes BEFORE the script (a route pointing at a deleted
// script is a 500 at the edge, not a clean 404).
//
// The token here is a Workers/DNS-scoped token in `cred.token`. It is never
// logged, never persisted in this file, and never returned — same rule as
// cloudflare.ts.

/** The default host a premium link is published under: go.<zone>. */
export function defaultLinkHost(zoneName: string): string {
  return `go.${zoneName.replace(/^\.+/, "")}`;
}

/** The route pattern for a host. EXACT host + everything under it — never a wildcard subdomain. */
export function routePatternFor(host: string): string {
  return `${host.toLowerCase()}/*`;
}

/**
 * A stable, DNS-label-safe Worker name for one user: `sw-` + 32 hex chars.
 *
 * 32 hex chars of the userId is enough that two users never collide, and keeping
 * it short keeps the name readable in the Cloudflare dashboard. Hashing also means
 * a userId — which we never send to Cloudflare — does not appear in the account.
 */
export function workerNameForUser(userId: string): string {
  return `sw-${createHash("sha256").update(userId).digest("hex").slice(0, 32)}`;
}

export interface WorkerRoute {
  id: string;
  pattern: string;
  script: string;
}

interface ZoneResult {
  id: string;
  name: string;
  status: string;
}

/** A bare hostname to its registrable zone name (go.instaweb.top → instaweb.top). */
function zoneNameOf(host: string): string {
  const parts = host.toLowerCase().split(".").filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join(".") : host.toLowerCase();
}

/**
 * Step 1 of publish: confirm `host`'s zone exists AND is active.
 *
 * This deliberately comes FIRST, before any script or route call. A pending /
 * paused / moved zone answers the route call with something unhelpful; catching it
 * here turns "your link never works" into "add instaweb.top to your Cloudflare
 * account and try again", the only message the user can act on.
 */
/** The zone filter that pins a query to THIS credential's account. Without it
 *  `/zones` returns every zone the token can see — so an admin-style token that
 *  spans accounts could match a domain belonging to a different account, and we
 *  would report "your domain is ready" for a zone we cannot actually route. */
function zoneScope(cred: CfCredential): string {
  return `account.id=${encodeURIComponent(cred.accountId)}`;
}

export async function ensureZoneActive(
  cred: CfCredential,
  host: string
): Promise<CfResult<{ zoneId: string; zoneName: string }>> {
  const res = await cfFetch<ZoneResult[]>(
    cred,
    "GET",
    `/zones?name=${encodeURIComponent(zoneNameOf(host))}&${zoneScope(cred)}`
  );
  if (!res.ok) return { ok: false, status: res.status, error: res.error };

  const zone = (res.value ?? [])[0];
  if (!zone) {
    return {
      ok: false,
      status: 404,
      error: `${zoneNameOf(host)} is not in this Cloudflare account yet. Add the domain to Cloudflare, then try again.`,
    };
  }
  if (zone.status !== "active") {
    const state = zone.status === "pending" ? "still being set up" : zone.status;
    return {
      ok: false,
      status: 409,
      error: `${zone.name} is ${state} in Cloudflare. Finish activating it, then try again.`,
    };
  }
  return { ok: true, status: res.status, value: { zoneId: zone.id, zoneName: zone.name } };
}
/**
 * The account's active zones, used to DEFAULT a link's host when the user did not
 * name one: go.<first active zone>. An account with zero active zones is the
 * normal state of a brand-new BYO connection, and returns `[]` so the caller can
 * say "add your domain to Cloudflare" instead of inventing a host that cannot work.
 */
export async function listActiveZones(cred: CfCredential): Promise<CfResult<ZoneResult[]>> {
  const res = await cfFetch<ZoneResult[]>(cred, "GET", `/zones?per_page=50&${zoneScope(cred)}`);
  if (!res.ok) return { ok: false, status: res.status, error: res.error };
  return { ok: true, status: res.status, value: (res.value ?? []).filter((z) => z.status === "active") };
}

/**
 * Step 2: PUT the script. A plain `PUT` on an existing name OVERWRITES it, which
 * is exactly the semantics "republish this user's map" needs — no delete, no race
 * with the live script, and re-running a failed publish is safe.
 *
 * The body must be multipart with TWO parts, and this is the part that is easy to
 * get wrong (§19.12.3): a `metadata` JSON part naming `main_module`, and the
 * module itself as a FILE part whose filename equals that name. Sending the source
 * as a plain string field makes Cloudflare treat it as a classic service worker
 * and reject the `export default`.
 */
export async function uploadWorkerScript(
  cred: CfCredential,
  name: string,
  moduleSource: string
): Promise<CfResult<{ name: string }>> {
  const form = new FormData();
  form.append(
    "metadata",
    new Blob([JSON.stringify({ main_module: "worker.mjs", compatibility_date: "2024-09-23" })], {
      type: "application/json",
    })
  );
  form.append(
    "worker.mjs",
    new Blob([moduleSource], { type: "application/javascript+module" }),
    "worker.mjs"
  );

  let res: Response;
  try {
    res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${cred.accountId}/workers/scripts/${name}`,
      // No Content-Type header: fetch must set the multipart boundary itself.
      { method: "PUT", headers: { Authorization: `Bearer ${cred.token}` }, body: form }
    );
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : "Network error reaching Cloudflare." };
  }

  let body: unknown = undefined;
  try {
    body = await res.json();
  } catch {
    // The script PUT answers 200 with an empty body on success.
  }
  if (!res.ok) {
    return { ok: false, status: res.status, error: firstError(body) ?? `Cloudflare returned ${res.status}.` };
  }
  return { ok: true, status: res.status, value: { name } };
}

/** Every route on the account — used to find ours by pattern before deleting it. */
export async function listWorkerRoutes(cred: CfCredential): Promise<CfResult<WorkerRoute[]>> {
  const res = await cfFetch<WorkerRoute[]>(cred, "GET", `/accounts/${cred.accountId}/workers/routes`);
  if (!res.ok) return { ok: false, status: res.status, error: res.error };
  return { ok: true, status: res.status, value: res.value ?? [] };
}

/**
 * Step 3: point `<host>/*` at the script.
 *
 * An EXISTING IDENTICAL route is a SUCCESS, not an error: republishing a link
 * re-runs this step, and Cloudflare answers a duplicate route with an error that
 * would otherwise turn a working publish into a reported failure.
 */
export async function putWorkerRoute(
  cred: CfCredential,
  pattern: string,
  script: string
): Promise<CfResult<{ pattern: string }>> {
  const existing = await listWorkerRoutes(cred);
  if (existing.ok) {
    const same = existing.value?.find((r) => r.pattern === pattern);
    if (same) {
      if (same.script === script) return { ok: true, status: 200, value: { pattern } };
      // A DIFFERENT script already owns this host — steal the binding rather than
      // failing, so switching accounts on a host actually takes effect.
      const del = await deleteWorkerRoute(cred, same.id);
      if (!del.ok) return { ok: false, status: del.status, error: del.error };
    }
  }

  const res = await cfFetch<unknown>(cred, "POST", `/accounts/${cred.accountId}/workers/routes`, {
    pattern,
    script,
  });
  if (res.ok) return { ok: true, status: res.status, value: { pattern } };

  // Lost a race with a concurrent publish for the same user: re-read and accept.
  const reread = await listWorkerRoutes(cred);
  if (reread.ok && reread.value?.some((r) => r.pattern === pattern)) {
    return { ok: true, status: 200, value: { pattern } };
  }
  return { ok: false, status: res.status, error: res.error };
}

export interface WorkerMapEntry {
  /** The link's opaque token OR its friendly slug — whichever /r accepts. */
  key: string;
  target: string;
}

/**
 * Generate the redirect Worker for one user (§19.12.3).
 *
 * Pure and exported so the map contents are unit-testable WITHOUT any network —
 * that is how "this user's map never contains another user's target" is proved.
 *
 * The handler is deliberately tiny and dependency-free: no imports, no bindings,
 * no KV, no self-fetch. Everything it needs is the literal Map below, which is what
 * makes "rewrite the map and re-PUT" the entire update story.
 */
export function buildWorkerMapSource(entries: WorkerMapEntry[]): string {
  const map: Record<string, string> = {};
  for (const entry of entries) {
    if (!entry.key || !entry.target) continue;
    map[entry.key] = entry.target;
  }
  return (
    "// Generated by SpaceWorker — links engine. Do not edit by hand.\n" +
    `const MAP = ${JSON.stringify(map)};\n` +
    "export default {\n" +
    "  async fetch(request) {\n" +
    "    const url = new URL(request.url);\n" +
    '    const key = url.pathname.replace(/^\\/+/, "").split("/")[0];\n' +
    "    const target = key ? MAP[key] : undefined;\n" +
    '    if (!target) return new Response("Not found", { status: 404 });\n' +
    "    return Response.redirect(target, 302);\n" +
    "  },\n" +
    "};\n"
  );
}
/** Delete the route by id. Always called BEFORE the script is removed. */
export async function deleteWorkerRoute(cred: CfCredential, id: string): Promise<CfResult<unknown>> {
  return cfFetch<unknown>(cred, "DELETE", `/accounts/${cred.accountId}/workers/routes/${id}`);
}

/** Remove the script entirely. Only reached once the route is gone. */
export async function deleteWorkerScript(cred: CfCredential, name: string): Promise<CfResult<unknown>> {
  return cfFetch<unknown>(cred, "DELETE", `/accounts/${cred.accountId}/workers/scripts/${name}`);
}