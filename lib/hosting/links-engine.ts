import { prisma } from "../prisma";
import { getAdminSettings } from "../admin-settings";
import { verifyCredential, type CfCredential } from "./cloudflare";
import { getHostingCredentialById } from "./credentials";
import type { HostingResult } from "./files";
import { resolvePlatformCredential } from "./platform-accounts";
import { isWorkersDevHost } from "./domains";
import {
  buildWorkerMapSource,
  assertZoneWritable,
  defaultLinkHost,
  deleteWorkerRoute,
  deleteWorkerScript,
  enableWorkerOnWorkersDev,
  ensureProxiedRecord,
  ensureZoneActive,
  hostFromRoutePattern,
  legacyWorkerNameForUser,
  listActiveZones,
  listWorkerRoutes,
  putWorkerRoute,
  reservedZoneMessage,
  routePatternFor,
  uploadWorkerScript,
  workerNameForUser,
} from "./workers";

// TASK_155 P6c — publishing a user's redirect map to Cloudflare Workers (PLAN §19.12).
//
// This is the layer BETWEEN the CRUD (links.ts) and the wire (workers.ts). It owns
// the two things that are easy to get subtly wrong and that the tests pin:
//
//   * CREDENTIAL RESOLUTION — a link is published with a WORKERS token, never the
//     Pages token that the same rows already hold. Getting this backwards produces
//     a 403 from Cloudflare long after the link looked fine.
//   * THE WHOLE-USER MAP — the script holds EVERY link the user owns on that host,
//     so the query is scoped by userId and by engine, and by nothing else. There is
//     no "just append this one link" path, which is exactly how another user's
//     target leaks into someone else's script.
//
// NOTHING HERE DELETES A LINK. If publishing fails, the link row stays (with
// deployStatus "error") and /r/<token> still resolves it — a broken Worker must
// never cost the user a link they already had.

export type LinkEngine = "local" | "cloudflare";

/** The WORKERS-scoped credential for one publish. `token` never leaves this module. */
interface WorkerCredential extends CfCredential {
  credentialId: string | null;
}

const WORKER_TOKEN_MISSING =
  "That Cloudflare account needs a Workers API token with Workers Scripts, Workers Routes and DNS edit rights. Add one in Settings, then try again.";

/**
 * Resolve the Workers credential for a publish.
 *
 * A NAMED credential resolves ONLY to that credential — never to the platform
 * roster, never to a default. That mirrors resolveDeployCredential (sites.ts): if
 * the user picked "Yours" and we silently used ours instead, we would publish their
 * link into our account and they would never know why it is not on their domain.
 */
export async function resolveWorkerCredential(
  userId: string,
  credentialId: string | null
): Promise<HostingResult<WorkerCredential>> {
  if (credentialId) {
    const named = await getHostingCredentialById(userId, credentialId);
    if (!named) {
      return {
        ok: false,
        status: 400,
        code: "no_credential",
        message: "That account is no longer connected. Reconnect it in Settings.",
      };
    }
    if (!named.workerToken) {
      return { ok: false, status: 403, code: "worker_token_missing", message: WORKER_TOKEN_MISSING };
    }
    return { ok: true, value: { accountId: named.accountId, token: named.workerToken, credentialId: named.id } };
  }

  // Platform roster. `requireWorkerToken: true` makes rotation SKIP any healthy but
  // Pages-only row instead of landing on one and failing the publish — a roster
  // where row A has no Workers token and row B does must still work.
  //
  // TASK_157 Phase 2 — `pinAccountId` lets an admin dedicate ONE Cloudflare account
  // to premium LINKS. Without it this call is pure ascending-priority rotation, and
  // priority alone cannot separate links from sites: sites.ts picks the first
  // healthy row from the same list, so any account placed first to win links would
  // silently take over site deploys too. With the pin set, links are served by that
  // account and ONLY that account — a failure there surfaces as an error rather
  // than quietly landing premium links on the free/Pages account.
  //
  // Read here rather than at the call site because BYO credentials never consult
  // the pin: a user who connected their own Cloudflare account is unaffected by
  // platform routing, which is the "ours vs yours" contract in resolveDeployCredential.
  const settings = await getAdminSettings();
  const resolved = await resolvePlatformCredential(verifyCredential, {
    requireWorkerToken: true,
    pinAccountId: settings.hostingPremiumLinksAccountId,
  });
  if (!resolved.ok) {
    return { ok: false, status: 503, code: resolved.code, message: resolved.message };
  }
  if (!resolved.value.workerToken) {
    return { ok: false, status: 403, code: "worker_token_missing", message: WORKER_TOKEN_MISSING };
  }
  return {
    ok: true,
    value: {
      accountId: resolved.value.accountId,
      token: resolved.value.workerToken,
      // NULL for the platform roster, on purpose. LinkRedirect.credentialId holds
      // a HostingCredential id; a platform account id written there would later be
      // resolved by getHostingCredentialById (which matches on userId), find
      // nothing, and leave the route and script behind with no error reported.
      credentialId: null,
    },
  };
}

/**
 * The user's cloudflare links on ONE host, as map entries. Token AND slug both
 * resolve, so a link shared by its friendly name keeps working after publishing.
 */
async function mapEntriesFor(
  userId: string,
  host: string | null,
  /** Rows that must be included regardless of customHost — the row being published
   *  right now, whose customHost may still be NULL when the host was INFERRED from
   *  the zone. Without this the first link a user ever creates is written to a
   *  script that does not contain it, and the live host 404s. */
  extraIds: string[] = []
): Promise<{ key: string; target: string; desktopOnly: boolean }[]> {
  const rows = await prisma.linkRedirect.findMany({
    where: { userId, engine: "cloudflare", ...(host ? { customHost: host } : {}) },
    select: { id: true, token: true, slug: true, target: true, customHost: true, desktopOnly: true },
  });

  // The in-flight row, if the host filter excluded it. Fetched by id and scoped to
  // this user, so an extraId can never smuggle in somebody else's link.
  const seen = new Set(rows.map((r) => r.id));
  const missing = extraIds.filter((id) => !seen.has(id));
  if (missing.length > 0) {
    const extra = await prisma.linkRedirect.findMany({
      where: { id: { in: missing }, userId, engine: "cloudflare" },
      select: { id: true, token: true, slug: true, target: true, customHost: true, desktopOnly: true },
    });
    rows.push(...extra);
  }

  const entries: { key: string; target: string; desktopOnly: boolean }[] = [];
  for (const row of rows) {
    // TASK_175 — the gate flag rides the map per key (token AND slug each get
    // it), so the edge gates a friendly slug exactly like its token.
    const gated = (row as { desktopOnly?: boolean | null }).desktopOnly === true;
    entries.push({ key: row.token, target: row.target, desktopOnly: gated });
    if (row.slug) entries.push({ key: row.slug, target: row.target, desktopOnly: gated });
  }
  return entries;
}

export interface PublishOutcome {
  workerName: string;
  routePattern: string | null;
  customHost: string | null;
  credentialId: string | null;
}

/**
 * Publish the user's whole map: zone check, script, then route — in that order.
 *
 * Every link the user owns on `customHost` goes into ONE script. Adding, editing
 * or deleting any single link re-runs this, which is why the entries are always
 * recomputed from the database rather than patched in memory: a stale incremental
 * map is the one failure mode a re-run can never produce.
 */
export async function publishUserMap(
  userId: string,
  opts: { credentialId: string | null; customHost?: string | null; /** The row being
   *  published, included in the map even when its own customHost is still NULL. */
   includeLinkId?: string }
): Promise<HostingResult<PublishOutcome>> {
  const cred = await resolveWorkerCredential(userId, opts.credentialId);
  if (!cred.ok) return cred;
  const cf = cred.value;

  // Step 1 — the host, then the zone. Defaulting to go.<first active zone> is why
  // a fresh BYO account with no domain gets a clear message instead of a hostname
  // that will never resolve.
  let host = opts.customHost?.trim().toLowerCase() || null;

  // TASK_157 — the admin's PREMIUM link domain wins over the zone default. This is
  // the "instaweb or anything I can change from admin" dial: it is read here, at
  // the one place a link's host is actually decided, so changing it in the panel
  // changes where the next publish lands. An empty value is the default "" and
  // must fall through, not produce a link on the empty host.
  if (!host) {
    const settings = await getAdminSettings();
    const premium = settings.hostingPremiumLinkDomain?.trim().toLowerCase() || null;
    if (premium) {
      // A workers.dev "domain" is a SUFFIX, not a host: Cloudflare answers
      // `<script>.workers.dev`, so the admin's `swdocs.workers.dev` becomes
      // `lnk-<shorthash>.swdocs.workers.dev`. Without this prefix every user in the
      // account would claim the SAME host and the last publish would overwrite
      // everyone else's links. A zoned host like `go.instaweb.top` needs no
      // prefix — that name is genuinely shared, and is the point of a zone.
      host = isWorkersDevHost(premium)
        ? `${workerNameForUser(userId)}.${premium}`
        : premium;
    }
  }

  if (!host) {
    const zones = await listActiveZones(cf);
    if (!zones.ok) {
      return { ok: false, status: zones.status, code: "cf_error", message: zones.error ?? "Could not read your Cloudflare zones." };
    }
    // Skip reserved zones when defaulting. Picking `zones[0]` blindly meant a
    // token that could SEE the owner's private domain could be steered onto it,
    // and the resulting DNS record + Worker route would live on that domain.
    // If the ONLY active zone is reserved, say so instead of failing obscurely.
    const usable = (zones.value ?? []).filter((z) => assertZoneWritable(z.name).ok);
    const first = usable[0];
    if (!first) {
      const onlyReserved = (zones.value ?? []).some((z) => !assertZoneWritable(z.name).ok);
      return {
        ok: false,
        status: onlyReserved ? 403 : 400,
        code: onlyReserved ? "reserved_zone" : "no_zone",
        message: onlyReserved
          ? reservedZoneMessage((zones.value ?? []).map((z) => z.name).find((n) => !assertZoneWritable(n).ok) ?? undefined)
          : "Add a domain to your Cloudflare account and try again — we need somewhere to publish the link.",
      };
    }
    host = defaultLinkHost(first.name);
  }

  // TASK_157 — the workers.dev FAST PATH, placed BEFORE every zone-scoped step
  // below. A workers.dev host is served by Cloudflare's own edge: the script named
  // `<worker>` answers on `<worker>.<sub>.workers.dev` the moment it is uploaded.
  // There is no zone to resolve, no DNS record to create and no route to install,
  // so the zoned steps are not merely unnecessary here — each one FAILS (no such
  // zone; not your DNS) and aborts the publish before the script is ever uploaded.
  //
  // That ordering is the whole reason this block sits here and not beside the
  // script upload further down: `ensureZoneActive` below would otherwise reject a
  // perfectly valid workers.dev host with "That domain is not ready yet."
  if (isWorkersDevHost(host)) {
    const entries = await mapEntriesFor(userId, host, opts.includeLinkId ? [opts.includeLinkId] : []);
    const workerName = workerNameForUser(userId);
    const uploaded = await uploadWorkerScript(cf, workerName, buildWorkerMapSource(entries));
    if (!uploaded.ok) {
      return { ok: false, status: uploaded.status, code: "cf_error", message: uploaded.error ?? "Could not upload the link." };
    }
    // A script uploaded through the API lands with its workers.dev route OFF, so
    // the hostname would 404 (error 1042) for as long as it lives. Turn it on
    // before claiming success: "published but unreachable" is the one outcome the
    // rest of this function exists to avoid, and it is invisible from the PUT's
    // 200. Idempotent — republish just re-enables what is already enabled.
    const exposed = await enableWorkerOnWorkersDev(cf, workerName);
    if (!exposed.ok) {
      return {
        ok: false,
        status: exposed.status,
        code: "cf_error",
        message: exposed.error ?? "Could not switch on the link's workers.dev address.",
      };
    }
    // Post-rename cleanup: the old `sw-<32hex>` script (if any) is orphaned now
    // that the short `lnk-<8hex>` name serves the map. Best-effort — a failure
    // here must not fail the publish that just succeeded.
    if (legacyWorkerNameForUser(userId) !== workerName) {
      await deleteWorkerScript(cf, legacyWorkerNameForUser(userId));
    }
    // routePattern is null BY DESIGN, not "unknown": teardown reads it to decide
    // whether a route needs deleting, and there is no route. Reporting a pattern
    // here would send teardown hunting for a route that never existed, and its
    // fail-closed rule would then refuse to delete the script.
    return { ok: true, value: { workerName, routePattern: null, customHost: host, credentialId: cf.credentialId } };
  }

  const zone = await ensureZoneActive(cf, host);
  if (!zone.ok) {
    return { ok: false, status: zone.status, code: "no_zone", message: zone.error ?? "That domain is not ready yet." };
  }

  // The RESERVED-ZONE GUARD, before any write. Narrowing the platform token is the
  // real fix, but an over-broad token must not be able to install a DNS record and
  // a Worker route on a private zone just because it can SEE the zone. Checked on
  // the HOST (which is what becomes the route) and again on the resolved zone.
  for (const candidate of [host, zone.value?.zoneName]) {
    const guard = assertZoneWritable(candidate);
    if (!guard.ok) {
      return {
        ok: false,
        status: 403,
        code: "reserved_zone",
        message: reservedZoneMessage(guard.zone),
      };
    }
  }

  // CfResult is not a discriminated union, so `zone.value` is optional by type even
  // after an `ok` check. Bind it ONCE here, with a guard, instead of scattering a
  // non-null assertion over every later use — and because every remaining step of
  // the publish is zone-scoped now, an empty zone id would silently produce
  // nonsense URLs rather than an obvious failure.
  const zoneId = zone.value?.zoneId;
  if (!zoneId) {
    return {
      ok: false,
      status: 502,
      code: "no_zone",
      message: "Cloudflare did not return a zone for that domain. Try again in a moment.",
    };
  }

  const entries = await mapEntriesFor(userId, host, opts.includeLinkId ? [opts.includeLinkId] : []);
  const workerName = workerNameForUser(userId);
  const pattern = routePatternFor(host);

  // Step 1b — the DNS record that makes `host` RESOLVE. A route is not a host: a
  // Worker route only runs for requests that already reach Cloudflare's edge, so
  // without this record the route below is created perfectly and the hostname
  // still answers ERR_NAME_NOT_RESOLVED — every step reports success while the
  // link is dead on arrival. That is the failure this call exists to prevent.
  const record = await ensureProxiedRecord(cf, zoneId, host);
  if (!record.ok) {
    // A token that can publish Workers but NOT touch DNS is the common case, and
    // it is not obvious from the dashboard: DNS sits behind its OWN permission
    // group, so a token built from "Workers Scripts" + "Workers Routes" alone
    // fails right here with a bare "Authentication error" that names no cause.
    // Say exactly what to add, because there is nothing else the owner can act on.
    const needsDns = record.status === 403;
    return {
      ok: false,
      status: record.status,
      code: needsDns ? "dns_permission_missing" : "cf_error",
      message: needsDns
        ? `That Cloudflare token cannot manage DNS for ${host}. Add DNS:Edit and DNS:Read to it, then publish again.`
        : record.error ?? "Could not point DNS at Cloudflare for this hostname.",
    };
  }

  // Step 2 — the script.
  const uploaded = await uploadWorkerScript(cf, workerName, buildWorkerMapSource(entries));
  if (!uploaded.ok) {
    return { ok: false, status: uploaded.status, code: "cf_error", message: uploaded.error ?? "Could not upload the link." };
  }

  // Step 3 — the route, LAST. So the script a route points at always exists.
  const routed = await putWorkerRoute(cf, zoneId, pattern, workerName);
  if (!routed.ok) {
    return { ok: false, status: routed.status, code: "cf_error", message: routed.error ?? "Could not create the route." };
  }

  return { ok: true, value: { workerName, routePattern: pattern, customHost: host, credentialId: cf.credentialId } };
}

/**
 * The deterministic identity of a user's map on a host: ONE script and ONE route
 * per user+host, both pure functions of those inputs.
 *
 * This exists because the LinkRedirect row we are tearing down is NOT a reliable
 * source for these. A link whose own publish FAILED (say the token lacked DNS
 * permission) has workerName and routePattern still NULL — it never got as far as
 * creating anything. Deleting that row must still remove the route its SIBLINGS
 * published, and `routePattern: null` makes teardown skip route deletion entirely
 * and leave a live route behind that answers 500 at the edge forever.
 */
export function mapIdentityFor(
  userId: string,
  customHost: string | null
): { workerName: string; routePattern: string | null } {
  const host = customHost?.trim().toLowerCase() || null;
  return {
    workerName: workerNameForUser(userId),
    // TASK_157 — a workers.dev host has no route, exactly as publishUserMap
    // reports. This must stay in step with it: a pattern recorded here but never
    // created would make teardown hunt for a route that does not exist, fail to
    // clear it, and then refuse to delete the script — leaving the user's Worker
    // alive forever after they deleted their last link.
    routePattern: host && !isWorkersDevHost(host) ? routePatternFor(host) : null,
  };
}

/**
 * Teardown, called when a user's LAST cloudflare link goes away.
 *
 * ROUTE FIRST, THEN SCRIPT — always, and not as a matter of taste: a route bound to
 * a script that has been deleted answers 500 at the edge, so the reverse order
 * leaves a customer's live domain throwing errors for as long as the failure takes
 * to notice. A missing route or script is treated as success, because the goal
 * (nothing of ours left behind) is already met.
 */
export async function teardownUserMap(
  userId: string,
  credentialId: string | null,
  workerName: string,
  routePattern: string | null
): Promise<{ routeDeleted: boolean; scriptDeleted: boolean }> {
  const cred = await resolveWorkerCredential(userId, credentialId);
  // No usable credential (removed/revoked account): we cannot call Cloudflare, and
  // the local link lifecycle has already succeeded. Report it, never throw.
  if (!cred.ok) return { routeDeleted: false, scriptDeleted: false };
  const cf = cred.value;

  let routeDeleted = false;
  // `routeClear` means "we KNOW nothing of ours is bound to that pattern any more" —
  // either the route was confirmed deleted, or there was nothing matching to begin
  // with, or no route was ever recorded. Anything else (a failed route list, a
  // failed delete) leaves it false, and that is what gates the script below.
  let routeClear = !routePattern;
  if (routePattern) {
    // Routes are a ZONE-scoped API, so the zone has to be recovered from the
    // recorded pattern before anything can be listed at all. A zone we cannot
    // resolve is treated exactly like a list that failed: we could not learn
    // what is out there, so routeClear stays false and the script is left alone.
    const zone = await ensureZoneActive(cf, hostFromRoutePattern(routePattern));
    const zoneId = zone.ok ? zone.value?.zoneId : undefined;
    const routes = zoneId
      ? await listWorkerRoutes(cf, zoneId)
      : { ok: false as const, status: zone.status, error: zone.error };
    if (zoneId && routes.ok) {
      const mine = (routes.value ?? []).filter((r) => r.pattern === routePattern && r.script === workerName);
      // Nothing matching is a confirmed clear: the goal is already met.
      routeClear = mine.length === 0;
      let allGone = true;
      for (const route of mine) {
        // One failing delete must not stop the rest — a partially-torn-down route
        // set is better than a half-finished loop.
        const del = await deleteWorkerRoute(cf, zoneId, route.id);
        if (del.ok || del.status === 404) routeDeleted = true;
        else allGone = false;
      }
      if (mine.length > 0) routeClear = allGone;
    }
    // !routes.ok → routeClear stays false: we could not learn what is out there.
  }

  // FAIL-CLOSED. Delete the script ONLY once the route is confirmed gone. If route
  // discovery or deletion failed, deleting the script would leave a route pointing
  // at a script that no longer exists — a 500 on the customer's domain, which is
  // exactly the outcome the route-then-script order above exists to prevent. A
  // left-behind script is inert and invisible; a stranded route is neither. So we
  // stop here, report it, and let the next teardown for this user finish the job.
  if (!routeClear) return { routeDeleted, scriptDeleted: false };

  const delScript = await deleteWorkerScript(cf, workerName);
  const scriptDeleted = delScript.ok || delScript.status === 404;

  // Post-rename cleanup: also remove the orphaned pre-rename script, if any.
  if (legacyWorkerNameForUser(userId) !== workerName) {
    await deleteWorkerScript(cf, legacyWorkerNameForUser(userId));
  }

  return { routeDeleted, scriptDeleted };
}