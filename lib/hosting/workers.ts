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
 *
 * TASK_157 Phase 4 — `mainaccess.top` joined this list on the owner's explicit
 * instruction (2026-10-03): "i don't want to use mainaccess at all". It is
 * enforced here rather than merely hidden from the UI, so it is refused at every
 * write path (DNS record, Worker route, script) exactly like `broks.beauty`.
 */
export const RESERVED_ZONES: readonly string[] = ["broks.beauty", "mainaccess.top"];

/**
 * TASK_157 Phase 4 — zones that exist in a platform Cloudflare account but must
 * never be OFFERED TO A USER, because a user may only ever select a domain they
 * own.
 *
 * This is deliberately WEAKER than RESERVED_ZONES, and the difference matters:
 *
 *   RESERVED_ZONES        = never write here, by anyone, ever. A hard write guard.
 *   PLATFORM_ONLY_ZONES   = we may publish here ourselves; a USER may not select
 *                           it. A SELECTION filter only.
 *
 * `instaweb.top` is the platform's public host, so admin-driven publishes may
 * still use it — the owner asked that users not be able to pick it, not that it
 * be decommissioned. Keeping the two sets separate is what lets us honour both
 * instructions; collapsing them into one list would either wrongly retire
 * `instaweb.top` or wrongly expose it.
 */
export const PLATFORM_ONLY_ZONES: readonly string[] = ["instaweb.top"];

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

// ---------------------------------------------------------------------------
// TASK_157 Phase 4 — the SELECTION guard (a separate, weaker rule than the write
// guard above).
// ---------------------------------------------------------------------------

/** Is this a platform zone a USER must not be offered? */
export function isPlatformOnlyZone(input: string | null | undefined): boolean {
  const host = normalizeZoneName(input);
  if (!host) return false;
  const apex = apexOf(host);
  if (!apex) return false;
  return PLATFORM_ONLY_ZONES.includes(apex);
}

export interface SelectionGuardResult {
  ok: boolean;
  /** The apex that was refused — for the error message. */
  zone?: string;
}

/**
 * May a USER select this domain for their own hosting?
 *
 * This is the rule behind "users can only select the domain they own or added"
 * (owner, 2026-10-03). It refuses two different things, and the caller is told
 * which via `reason`:
 *
 *   - a RESERVED zone            — nobody may write here, so offering it is wrong
 *   - a PLATFORM-ONLY zone       — we may use it, the user may not
 *
 * Fail CLOSED, like `assertZoneWritable`: an unparseable host is not allowed.
 *
 * This checks the STATIC policy list only. Whether a domain is the user's OWN is a
 * database question and is answered by the registry's per-user query — a domain
 * being absent from this list never makes it claimable, it only makes it not
 * forbidden BY NAME.
 */
export function assertZoneUserSelectable(input: string | null | undefined): SelectionGuardResult {
  const host = normalizeZoneName(input);
  if (!host) return { ok: false };
  const apex = apexOf(host);
  if (!apex) return { ok: false };
  if (RESERVED_ZONES.includes(apex)) return { ok: false, zone: apex };
  if (PLATFORM_ONLY_ZONES.includes(apex)) return { ok: false, zone: apex };
  return { ok: true };
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
 * A stable, DNS-label-safe Worker name for one user: `lnk-` + 8 hex chars.
 *
 * Short by design: this name becomes the left label of the premium
 * `<worker>.swdocs.workers.dev` host, so every extra char is paid on every
 * shared link. 16^8 (4.3B) names is ample for a per-user script.
 *
 * 32 hex chars of the userId is enough that two users never collide, and keeping
 * it short keeps the name readable in the Cloudflare dashboard. Hashing also means
 * a userId — which we never send to Cloudflare — does not appear in the account.
 */
export function workerNameForUser(userId: string): string {
  return `lnk-${createHash("sha256").update(userId).digest("hex").slice(0, 8)}`;
}

/**
 * The pre-rename worker name (`sw-` + 32 hex). Kept so publish/teardown can
 * delete the orphaned long-named script after the cutover — old test links
 * were abandoned, so no migration of their URLs is attempted.
 */
export function legacyWorkerNameForUser(userId: string): string {
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
  /**
   * TASK_157 Phase 4 — the two nameservers Cloudflare assigned. Present on the
   * full zone resource; absent on the trimmed shape some list endpoints return,
   * so callers must tolerate an absent array.
   */
  name_servers?: string[];
}

/**
 * TASK_157 Phase 4 — read ONE zone by its exact apex, with the nameservers.
 *
 * Used by the domain registry to reconcile a user's own domain against their
 * Cloudflare account: it answers "is this domain active yet, and what must the
 * user set at their registrar?"
 *
 * Two details that make this safe to call with a user-supplied name:
 *
 *   1. `zoneScope(cred)` pins the query to THIS credential's account. Without it,
 *      `/zones?name=` returns any zone the token can see, so a broad token could
 *      match a domain in a DIFFERENT account and we would report "your domain is
 *      ready" for a zone we cannot actually route. (Same rule as `zoneScope` on
 *      `listActiveZones`.)
 *   2. The result is matched on the EXACT name, not just "something came back".
 *      Cloudflare treats `name` as a substring filter, so `example.com` also
 *      matches `notexample.com`; trusting the length of the list would mark the
 *      WRONG domain active.
 *
 * A 404 is returned as `{ ok: true, value: null }` — "this account does not have
 * that domain" is a normal answer here, not an error, because the user may not
 * have added it to Cloudflare yet.
 */
export async function getZoneByName(
  cred: CfCredential,
  apex: string
): Promise<CfResult<{ zoneId: string; name: string; status: string; nameservers: string[] } | null>> {
  const name = normalizeZoneName(apex);
  if (!name) return { ok: false, status: 400, error: "That is not a domain name." };

  const res = await cfFetch<ZoneResult[]>(
    cred,
    "GET",
    `/zones?name=${encodeURIComponent(name)}&${zoneScope(cred)}&per_page=50`
  );
  if (!res.ok) return { ok: false, status: res.status, error: res.error };

  // The exact-name match above is the important part — see the note on (2).
  const zone = (res.value ?? []).find((z) => z.name?.toLowerCase() === name);
  if (!zone) return { ok: true, status: res.status, value: null };

  return {
    ok: true,
    status: res.status,
    value: {
      zoneId: zone.id,
      name: zone.name,
      // Cloudflare's own status, passed through unchanged. `active` is the only
      // one that can serve traffic; `pending` is still propagating nameservers.
      status: zone.status ?? "unknown",
      nameservers: zone.name_servers ?? [],
    },
  };
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

// ---------------------------------------------------------------------------
// TASK_157 Phase 1 — the account's workers.dev subdomain.
//
// Cloudflare scopes this to the ACCOUNT, not to a Worker, so one call re-points
// EVERY Worker in the account at once. That blast radius is why the admin panel
// warns before changing it — but it is also why it is the cheapest possible way to
// give the FREE tier a real hostname: `<worker>.<sub>.workers.dev` answers with no
// DNS record, no zone and no registrar action at all.
//
// This is public information — it is literally part of the hostname — so it is
// never treated as a secret and never redacted. The TOKEN is the secret; this is
// a domain name.
// ---------------------------------------------------------------------------

export interface WorkersDevSubdomain {
  /** The subdomain Cloudflare currently has configured for this account. */
  subdomain: string;
  /** Whether the account has workers.dev enabled at all. */
  enabled: boolean;
}

/** The account's current workers.dev subdomain, or null when never configured. */
export async function getWorkersDevSubdomain(
  cred: CfCredential
): Promise<CfResult<WorkersDevSubdomain | null>> {
  const res = await cfFetch<{ subdomain?: string; enabled?: boolean }>(
    cred,
    "GET",
    `/accounts/${cred.accountId}/workers/subdomain`
  );
  // A 403 here is the cold-start state: the account has never opened the Workers
  // dashboard, so no subdomain exists yet. That is not an error — it is the
  // "nothing configured" answer the caller renders as "not set up yet".
  if (res.status === 403) return { ok: true, status: 403, value: null };
  if (!res.ok) return { ok: false, status: res.status, error: res.error };
  const subdomain = res.value?.subdomain;
  if (!subdomain) return { ok: true, status: res.status, value: null };
  return { ok: true, status: res.status, value: { subdomain, enabled: res.value?.enabled !== false } };
}

export interface SubdomainAvailability {
  /** True when Cloudflare says this name can be claimed. */
  available: boolean;
  /** True when the name is already the one configured on THIS account. */
  current: boolean;
  /** Cloudflare's own wording, shown verbatim when the name is taken. */
  message?: string;
}

/**
 * Ask Cloudflare whether a candidate subdomain can be claimed.
 *
 * `ok: true` on this function means "the question was answered", NOT "the name is
 * free" — the verdict is in `value.available`. Cloudflare answers with a bare
 * status code rather than an `available` boolean, and the codes are inverted from
 * what you would expect (see the comments below), so they are translated once,
 * here, instead of at every call site.
 */
export async function checkWorkersDevSubdomain(
  cred: CfCredential,
  name: string
): Promise<CfResult<SubdomainAvailability>> {
  const res = await cfFetch<{ subdomain?: string; enabled?: boolean }>(
    cred,
    "GET",
    `/accounts/${cred.accountId}/workers/subdomains/${encodeURIComponent(name)}`
  );
  if (res.ok) {
    const isCurrent = res.value?.subdomain === name;
    return { ok: true, status: res.status, value: { available: true, current: isCurrent } };
  }
  // 404 (code 10032) is Cloudflare's "available but not configured" — i.e. FREE.
  if (res.status === 404) {
    return { ok: true, status: res.status, value: { available: true, current: false } };
  }
  // 403 (code 10031) is "unavailable, pick another". Any other status is treated
  // the same way: fail CLOSED, because claiming a name Cloudflare rejects would
  // leave the account in a half-configured state.
  return {
    ok: true,
    status: res.status,
    value: { available: false, current: false, message: res.error },
  };
}

/** What the caller should do after Cloudflare has answered an availability check. */
export type SubdomainPlan =
  /** Refuse: Cloudflare says the name belongs to someone else. */
  | { kind: "taken"; message?: string }
  /** Nothing to do — Cloudflare has this name and we already recorded it. */
  | { kind: "noop" }
  /**
   * Cloudflare ALREADY has this name but our row does not. Record Cloudflare's
   * truth and stop — do NOT PUT. See the note below.
   */
  | { kind: "stamp" }
  /** A genuinely new name: claim it with the create-only PUT. */
  | { kind: "claim" };

/**
 * Decide what to do about a candidate workers.dev subdomain, given what
 * Cloudflare reports and what WE have recorded.
 *
 * Extracted from `setAccountWorkersDevSubdomain` purely so the rule is provable
 * without a network call: the caller reaches `checkWorkersDevSubdomain` through
 * a DYNAMIC `import("./workers")`, which module-loader test stubs cannot
 * intercept (tsx resolves it internally, so it never passes through
 * `Module._load`). A pure function is directly testable; the loader problem is
 * an artefact of the harness, not of the rule.
 *
 * The `stamp` case is the one that matters. Cloudflare's
 * `PUT /accounts/:id/workers/subdomain` is CREATE-ONLY — it cannot rename, and
 * pointing it at the name the account already holds is rejected with error
 * 10036. An account whose subdomain was claimed directly in the Cloudflare
 * dashboard (which is how `swdocs` was set up) therefore has Cloudflare holding
 * the name while our row still says NULL, and falling through to the PUT would
 * report a hard failure for an account that is in fact configured correctly.
 */
export function planWorkersDevSubdomainChange(
  availability: SubdomainAvailability,
  recordedSubdomain: string | null | undefined,
  name: string
): SubdomainPlan {
  if (!availability.available) return { kind: "taken", message: availability.message };
  if (!availability.current) return { kind: "claim" };
  return recordedSubdomain === name ? { kind: "noop" } : { kind: "stamp" };
}

/**
 * Claim (or rename to) a workers.dev subdomain for the whole account.
 *
 * Callers MUST check availability first and MUST refuse a reserved-looking name;
 * this function deliberately does not re-validate, so a single source of truth
 * (lib/hosting/domains.ts) decides what a legal name is.
 */
export async function setWorkersDevSubdomain(
  cred: CfCredential,
  name: string
): Promise<CfResult<WorkersDevSubdomain>> {
  const res = await cfFetch<{ subdomain?: string }>(
    cred,
    "PUT",
    `/accounts/${cred.accountId}/workers/subdomain`,
    { subdomain: name }
  );
  if (!res.ok) return { ok: false, status: res.status, error: res.error };
  return { ok: true, status: res.status, value: { subdomain: res.value?.subdomain ?? name, enabled: true } };
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
 * TASK_157 — switch ON the workers.dev route for a script we just uploaded.
 *
 * A script created through the API is born with its workers.dev route DISABLED
 * (`GET .../subdomain` answers `{enabled:false}`). The dashboard turns it on for
 * you when you click "Create Worker", which is precisely why the gap stayed
 * invisible: the PUT returns 200, the script really does exist, and
 * `<name>.<sub>.workers.dev` answers 404 / error code 1042 forever. Live-verified
 * against the Premium Links account on 2026-10-04:
 *
 *   PUT  script                          -> 200; GET script/subdomain {enabled:false}
 *   GET  <name>.swdocs.workers.dev       -> 404
 *   POST script/subdomain {enabled:true} -> 200
 *   GET  <name>.swdocs.workers.dev       -> 200
 *
 * Called ONLY from the workers.dev publish path. It is deliberately NOT folded
 * into `uploadWorkerScript`, because the zoned/BYO path shares that function and
 * enabling there would publish a user's worker on a public `*.workers.dev`
 * hostname they never asked for — a silent exposure on top of the domain they
 * actually configured.
 *
 * Idempotent: enabling an already-enabled script is a no-op, so a republish
 * costs one extra call and can never flip anything off.
 */
export async function enableWorkerOnWorkersDev(
  cred: CfCredential,
  name: string
): Promise<CfResult<{ name: string }>> {
  const res = await cfFetch<{ enabled?: boolean }>(
    cred,
    "POST",
    // The name is hashed but still user-derived, so encode it rather than
    // trusting it to be URL-safe.
    `/accounts/${cred.accountId}/workers/scripts/${encodeURIComponent(name)}/subdomain`,
    { enabled: true }
  );
  if (!res.ok) return { ok: false, status: res.status, error: res.error };
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