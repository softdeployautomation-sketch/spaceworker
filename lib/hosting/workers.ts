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

// TASK_155 P6c — RESERVED ZONES (the broks.beauty guard).
//
// WHAT THIS IS FOR. The platform Workers token used to reach every zone in the
// account, including private ones the owner never intended to expose. Nothing in
// the code stopped a publish from choosing such a zone: the default host was
// `go.<first active zone>`, so a token that could see a private zone could also
// WRITE to it (create a proxied DNS record, install a Worker route). Narrowing the
// token's Zone Resources is the real fix, but a token is a bearer secret that gets
// re-issued, and the next one may again be broader than intended. This is the
// belt to that braces: a config-driven denylist that fails CLOSED, so an
// over-broad token cannot reach a reserved zone even by accident.
//
// A denylist (block these) rather than an allowlist (permit these) is deliberate for
// a guard whose job is to protect a named few domains: a denylist protects the
// owner's private zone the day it is added, without anyone having to remember to
// add every future platform domain to an allowlist. The allowlist is still the right
// long-term shape and is tracked separately — see the handoff.
//
// FAIL CLOSED. If this module cannot answer, callers must refuse. A guard that
// fails OPEN on an unexpected shape is worse than no guard at all.
//
// Pure module: no DB, no network. Safe to import from anywhere.

/** The default host a premium link is published under: go.<zone>. */
export function defaultLinkHost(zoneName: string): string {
  return `go.${zoneName.replace(/^\.+/, "")}`;
}

/**
 * Domains the platform must NEVER write to, whatever a token can reach.
 * Lower-case, apex form. `broks.beauty` is the owner's private domain — its DNS is
 * not ours to manage.
 */
export const RESERVED_ZONES: readonly string[] = ["broks.beauty"];

/** A normalised apex domain, or null when the input is not a usable hostname. */
export function normalizeZoneName(input: string | null | undefined): string | null {
  if (!input) return null;
  let host = input.trim().toLowerCase();
  if (!host) return null;
  // Accept a full URL or a host:port by keeping only the authority.
  if (host.includes("://")) {
    try {
      host = new URL(host).hostname;
    } catch {
      return null;
    }
  }
  host = host.split("/")[0].split(":")[0];
  // Drop a trailing dot ("example.com." is the same zone, spelled absolutely).
  host = host.replace(/\.+$/, "");
  if (!host || !/^[a-z0-9.-]+$/.test(host)) return null;
  if (!host.includes(".")) return null; // a bare label is never a zone apex
  return host;
}

/** The registrable apex of a host: `go.records.example.com` → `example.com`. */
export function apexOf(input: string | null | undefined): string | null {
  const host = normalizeZoneName(input);
  if (!host) return null;
  const parts = host.split(".");
  if (parts.length <= 2) return host;
  // Good enough for the reserved set below, which is all apex (2-label) domains.
  return parts.slice(-2).join(".");
}

/**
 * Is this zone reserved? Matches the zone ITSELF and any host under it, so
 * `go.broks.beauty` and `broks.beauty` are both refused — the publish path always
 * works in terms of a HOST (go.<zone>), never a bare apex.
 */
export function isReservedZone(input: string | null | undefined): boolean {
  const host = normalizeZoneName(input);
  if (!host) return false;
  const apex = apexOf(host);
  if (!apex) return false;
  return RESERVED_ZONES.includes(apex);
}

export interface ZoneGuardResult {
  ok: boolean;
  /** The apex that was refused — for the error message. */
  zone?: string;
}

/**
 * The guard to call before ANY zone-scoped write (route, script, DNS record,
 * zone create/delete). Returns ok:false with a message naming the zone.
 *
 * Kept separate from isReservedZone so the reason a caller failed is always
 * explicit at the call site, and so a future policy (allowlist, per-account
 * consent) can return a different message without touching every caller.
 */
export function assertZoneWritable(input: string | null | undefined): ZoneGuardResult {
  const host = normalizeZoneName(input);
  // An unparseable host is NOT allowed to proceed. Fail closed.
  if (!host) return { ok: false };
  const apex = apexOf(host);
  if (!apex) return { ok: false };
  if (RESERVED_ZONES.includes(apex)) return { ok: false, zone: apex };
  return { ok: true };
}

/** The operator-facing message for a refusal. Never contains a token. */
export function reservedZoneMessage(zone: string | undefined): string {
  return zone
    ? `${zone} is a reserved domain and cannot be used for links. Pick another domain.`
    : "That domain could not be verified and cannot be used for links.";
}

/** The route pattern for a host. EXACT host + everything under it — never a wildcard subdomain. */
export function routePatternFor(host: string): string {
  return `${host.toLowerCase()}/*`;
}

/**
 * The host out of a route pattern: `go.example.com/*` → `go.example.com`.
 *
 * Teardown is handed only a stored pattern, and since Routes is a ZONE-scoped
 * API the zone has to be recovered from that pattern before a route can be
 * listed or deleted at all.
 */
export function hostFromRoutePattern(pattern: string): string {
  return pattern.replace(/\/\*+$/, "").replace(/\/+$/, "").toLowerCase();
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

interface DnsRecord {
  id: string;
  name: string;
  proxied: boolean;
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
 * Step 1b: make the custom host actually RESOLVE, by ensuring it has a proxied
 * DNS record in its zone.
 *
 * A Worker route is not a host. It only runs for requests that ALREADY reach
 * Cloudflare's edge, and a hostname with no DNS record never gets there —
 * Cloudflare's Workers routes docs state it outright: "All domains and
 * subdomains must have a DNS record to be proxied on Cloudflare and used to
 * invoke a Worker... any request to myname.example.com will result in the error
 * ERR_NAME_NOT_RESOLVED."
 *
 * This is why "the route was created" is NOT "the link works": before this call
 * existed, publishing a link reported success while the hostname resolved to
 * nothing at all. A live check of the owner's zone confirmed the gap — the zone
 * was active and proxied, `go.instaweb.top` had no record, and `dig` returned
 * empty for it.
 *
 * The record is ORIGINLESS — `AAAA 100::`, the reserved IPv6 discard prefix —
 * so it never names a real server. The Worker answers before origin resolution
 * is ever attempted, which is precisely why a discard-prefix address is safe
 * here and why it costs nothing.
 *
 * An existing record is never overwritten. If the user already points
 * `go.example.com` somewhere real we ADOPT theirs and simply make sure it is
 * proxied; replacing someone's address with 100:: would take their host down.
 */
export async function ensureProxiedRecord(
  cred: CfCredential,
  zoneId: string,
  host: string
): Promise<CfResult<{ id: string; created: boolean }>> {
  const name = host.toLowerCase();

  const existing = await cfFetch<DnsRecord[]>(
    cred,
    "GET",
    `/zones/${zoneId}/dns_records?name=${encodeURIComponent(name)}&per_page=1`
  );
  if (!existing.ok) return { ok: false, status: existing.status, error: existing.error };

  const record = (existing.value ?? [])[0];
  if (record) {
    if (record.proxied) return { ok: true, status: 200, value: { id: record.id, created: false } };
    // Their record, not ours — only the proxy flag is ours to set.
    const flipped = await cfFetch<DnsRecord>(
      cred,
      "PATCH",
      `/zones/${zoneId}/dns_records/${record.id}`,
      { proxied: true }
    );
    if (!flipped.ok) return { ok: false, status: flipped.status, error: flipped.error };
    return { ok: true, status: flipped.status, value: { id: record.id, created: false } };
  }

  const created = await cfFetch<DnsRecord>(cred, "POST", `/zones/${zoneId}/dns_records`, {
    type: "AAAA",
    name,
    content: "100::",
    proxied: true,
    ttl: 1,
    comment: "SpaceWorker link redirect",
  });
  if (!created.ok) return { ok: false, status: created.status, error: created.error };
  return { ok: true, status: created.status, value: { id: created.value?.id ?? "", created: true } };
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

/**
 * Every route on the ZONE — used to find ours by pattern before deleting it.
 *
 * ZONE-SCOPED, NOT ACCOUNT-SCOPED — corrected 2026-10-03 against a live account.
 * With a correct account id and a valid `Workers Scripts:Edit` +
 * `Workers Routes:Edit` token, `GET /accounts/{id}/workers/routes` answers
 * **400 / code 7000 "No route for that URI"**, while
 * `GET /zones/{zoneId}/workers/routes` answers **200** for every zone in the same account.
 *
 * `Workers Routes` is a ZONE permission group, so
 * a token built the way the help text tells the owner to build it can never reach
 * an account-scoped routes endpoint. The old path failed EVERY publish and EVERY
 * teardown, and the 7000 message reads like an auth fault rather than a wrong URL
 * — which is exactly why it survived review.
 */
export async function listWorkerRoutes(
  cred: CfCredential,
  zoneId: string
): Promise<CfResult<WorkerRoute[]>> {
  const res = await cfFetch<WorkerRoute[]>(cred, "GET", `/zones/${zoneId}/workers/routes`);
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
  zoneId: string,
  pattern: string,
  script: string
): Promise<CfResult<{ pattern: string }>> {
  const existing = await listWorkerRoutes(cred, zoneId);
  if (existing.ok) {
    const same = existing.value?.find((r) => r.pattern === pattern);
    if (same) {
      if (same.script === script) return { ok: true, status: 200, value: { pattern } };
      // A DIFFERENT script already owns this host — steal the binding rather than
      // failing, so switching accounts on a host actually takes effect.
      const del = await deleteWorkerRoute(cred, zoneId, same.id);
      if (!del.ok) return { ok: false, status: del.status, error: del.error };
    }
  }

  const res = await cfFetch<unknown>(cred, "POST", `/zones/${zoneId}/workers/routes`, {
    pattern,
    script,
  });
  if (res.ok) return { ok: true, status: res.status, value: { pattern } };

  // Lost a race with a concurrent publish for the same user: re-read and accept.
  const reread = await listWorkerRoutes(cred, zoneId);
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
export async function deleteWorkerRoute(
  cred: CfCredential,
  zoneId: string,
  id: string
): Promise<CfResult<unknown>> {
  return cfFetch<unknown>(cred, "DELETE", `/zones/${zoneId}/workers/routes/${id}`);
}

/** Remove the script entirely. Only reached once the route is gone. */
export async function deleteWorkerScript(cred: CfCredential, name: string): Promise<CfResult<unknown>> {
  return cfFetch<unknown>(cred, "DELETE", `/accounts/${cred.accountId}/workers/scripts/${name}`);
}