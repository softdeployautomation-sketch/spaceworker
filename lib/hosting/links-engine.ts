import { prisma } from "../prisma";
import { verifyCredential, type CfCredential } from "./cloudflare";
import { getHostingCredentialById } from "./credentials";
import type { HostingResult } from "./files";
import { resolvePlatformCredential } from "./platform-accounts";
import {
  buildWorkerMapSource,
  defaultLinkHost,
  deleteWorkerRoute,
  deleteWorkerScript,
  ensureZoneActive,
  listActiveZones,
  listWorkerRoutes,
  putWorkerRoute,
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
  const resolved = await resolvePlatformCredential(verifyCredential, { requireWorkerToken: true });
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
): Promise<{ key: string; target: string }[]> {
  const rows = await prisma.linkRedirect.findMany({
    where: { userId, engine: "cloudflare", ...(host ? { customHost: host } : {}) },
    select: { id: true, token: true, slug: true, target: true, customHost: true },
  });

  // The in-flight row, if the host filter excluded it. Fetched by id and scoped to
  // this user, so an extraId can never smuggle in somebody else's link.
  const seen = new Set(rows.map((r) => r.id));
  const missing = extraIds.filter((id) => !seen.has(id));
  if (missing.length > 0) {
    const extra = await prisma.linkRedirect.findMany({
      where: { id: { in: missing }, userId, engine: "cloudflare" },
      select: { id: true, token: true, slug: true, target: true, customHost: true },
    });
    rows.push(...extra);
  }

  const entries: { key: string; target: string }[] = [];
  for (const row of rows) {
    entries.push({ key: row.token, target: row.target });
    if (row.slug) entries.push({ key: row.slug, target: row.target });
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
  if (!host) {
    const zones = await listActiveZones(cf);
    if (!zones.ok) {
      return { ok: false, status: zones.status, code: "cf_error", message: zones.error ?? "Could not read your Cloudflare zones." };
    }
    const first = zones.value?.[0];
    if (!first) {
      return {
        ok: false,
        status: 400,
        code: "no_zone",
        message: "Add a domain to your Cloudflare account and try again — we need somewhere to publish the link.",
      };
    }
    host = defaultLinkHost(first.name);
  }

  const zone = await ensureZoneActive(cf, host);
  if (!zone.ok) {
    return { ok: false, status: zone.status, code: "no_zone", message: zone.error ?? "That domain is not ready yet." };
  }

  const entries = await mapEntriesFor(userId, host, opts.includeLinkId ? [opts.includeLinkId] : []);
  const workerName = workerNameForUser(userId);
  const pattern = routePatternFor(host);

  // Step 2 — the script.
  const uploaded = await uploadWorkerScript(cf, workerName, buildWorkerMapSource(entries));
  if (!uploaded.ok) {
    return { ok: false, status: uploaded.status, code: "cf_error", message: uploaded.error ?? "Could not upload the link." };
  }

  // Step 3 — the route, LAST. So the script a route points at always exists.
  const routed = await putWorkerRoute(cf, pattern, workerName);
  if (!routed.ok) {
    return { ok: false, status: routed.status, code: "cf_error", message: routed.error ?? "Could not create the route." };
  }

  return { ok: true, value: { workerName, routePattern: pattern, customHost: host, credentialId: cf.credentialId } };
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
  if (routePattern) {
    const routes = await listWorkerRoutes(cf);
    if (routes.ok) {
      const mine = (routes.value ?? []).filter((r) => r.pattern === routePattern && r.script === workerName);
      for (const route of mine) {
        // One failing delete must not stop the rest — a partially-torn-down route
        // set is better than a half-finished loop.
        const del = await deleteWorkerRoute(cf, route.id);
        if (del.ok || del.status === 404) routeDeleted = true;
      }
    }
  }

  // Only now, with no route left pointing at it, does the script go. Deleting it
  // first would be the one order that can strand a 500 on the customer's domain.
  const delScript = await deleteWorkerScript(cf, workerName);
  const scriptDeleted = delScript.ok || delScript.status === 404;

  return { routeDeleted, scriptDeleted };
}