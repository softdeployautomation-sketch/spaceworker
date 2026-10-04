import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/session-user";
import {
  addUserDomain,
  listUserDomains,
  recordDomainZoneState,
  type UserDomainView,
} from "@/lib/hosting/domain-registry";
import { getDefaultHostingCredential } from "@/lib/hosting/credentials";
import { provisionDomainZone } from "@/lib/hosting/zone-provision";
import { getZoneByName } from "@/lib/hosting/workers";

// TASK_157 Phase 4 — GET  /api/hosting/domains   (only the caller's OWN domains)
//                 POST /api/hosting/domains   (add one the caller owns)
//
// THE OWNERSHIP RULE (owner, 2026-10-03): "the platform domains are only selectable
// by admin, users can only select the domain they own or added". This route is the
// only place a user's domain list can be produced, and it calls `listUserDomains`,
// which filters on `ownerKind = "user"` AND `ownerUserId = <caller>` together.
//
// There is deliberately no "list all domains" query parameter here. A user asking
// `?scope=all` gets their own domains, because the parameter does not exist.
//
// The user's id always comes from the SESSION, never from the body — otherwise a
// crafted request could add a domain to somebody else's account.

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const domains = await listUserDomains(user.id);
  if (!domains.ok) {
    return NextResponse.json({ error: domains.message, code: domains.code }, { status: domains.status });
  }
  return NextResponse.json({ domains: domains.value });
}

const postSchema = z.object({
  domain: z.string().min(1).max(253),
  /**
   * Verify against the caller's Cloudflare now and record the real zone state.
   *
   * Defaults to TRUE because "my domain still says pending" is the most common
   * confusing outcome: the user added the name, and without this they have to wait
   * for a second page load to learn whether Cloudflare actually knows it. Set it
   * false to add the name first (the 4b "prefilled support ticket" path).
   */
  verify: z.boolean().optional().default(true),
});

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let parsed;
  try {
    parsed = postSchema.parse(await request.json());
  } catch (e) {
    const msg = e instanceof z.ZodError ? e.errors[0]?.message : "Invalid request body";
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  // Ownership guards (Cloudflare's own name rules, the reserved/platform-only
  // denylists, and claim-once) all live in `addUserDomain`, so they cannot drift
  // between this route and any other caller.
  const added = await addUserDomain(user.id, parsed.domain, { source: "byo" });
  if (!added.ok) {
    return NextResponse.json({ error: added.message, code: added.code }, { status: added.status });
  }

  // Verification is BEST EFFORT and deliberately non-fatal. The domain IS added at
  // this point — the row exists and the user owns it. If the user has no Cloudflare
  // credential yet, or Cloudflare is briefly down, failing the whole request would
  // leave them re-submitting a domain that was actually saved, which is worse than
  // showing the domain as `pending` with a note. So a failed verify returns 201 with
  // the unsynced row plus the reason, rather than an error.
  if (!parsed.verify) {
    return NextResponse.json({ domain: added.value }, { status: 201 });
  }

  const refreshed = await refreshOne(user.id, added.value);
  return NextResponse.json(
    { domain: refreshed.domain, verified: refreshed.ok, verifyNote: refreshed.note ?? null },
    { status: 201 }
  );
}

/**
 * Reconcile ONE just-added domain against the caller's Cloudflare.
 *
 * Takes `added` — the row the registry just wrote — so that EVERY path returns that
 * row. A verify that cannot run (no credential, Cloudflare unreachable, zone not
 * present yet) still resolves to the SAVED domain with a `note`, never to null: the
 * row exists either way, and handing the panel a null would render an empty card
 * for a domain the user genuinely owns and just added.
 *
 * Uses the caller's DEFAULT Cloudflare credential, because that is the account a
 * BYO domain lives in. The token is decrypted server-side and never returned; the
 * whole helper returns only plain-language `note` text, so there is no path by
 * which a credential can reach the response.
 *
 * This deliberately does NOT call `refreshUserDomainsFromCloudflare`. That helper
 * reconciles the user's ENTIRE list, so using it here would mean adding one domain
 * fired one `/zones` call per domain the user owns — N+1 API calls, slower and
 * rate-limit-prone, for a request that concerns exactly one domain.
 */
async function refreshOne(
  userId: string,
  added: UserDomainView
): Promise<{ ok: boolean; domain: UserDomainView; note: string | null }> {
  // The user's OWN Cloudflare account is authoritative for a domain they already
  // put there — reconcile against it first so a live domain's real status, and
  // nameservers, come from the account that actually hosts it.
  const cred = await getDefaultHostingCredential(userId);
  if (cred) {
    const res = await getZoneByName(cred, added.apex);
    if (!res.ok) {
      return { ok: false, domain: added, note: res.error ?? "Could not reach Cloudflare." };
    }
    if (res.value) return recordFromCredential(userId, added, res.value);
  }

  // TASK_158 W1 — no BYO credential, or the user's own account does not have this
  // zone: CREATE it in the platform account we publish from, using the dedicated
  // Zones token. This is what replaces the dead-end "Add it there, then set the
  // nameservers we show you" note with the ACTUAL assigned nameservers, which is the
  // whole reason the token slot exists.
  //
  // Reached only AFTER the user's own account is checked: a domain already live in
  // the user's Cloudflare must keep reconciling against THEIR account, and skipping
  // straight to a create would either duplicate the zone (Cloudflare refuses) or,
  // worse, report OUR account's state as theirs.
  //
  // A user with no Cloudflare account at all now lands here too, instead of being
  // told to go and connect one — which is the point: the domain is provisioned FOR
  // them.
  const provisioned = await provisionDomainZone(userId, added.apex);
  if (!provisioned.ok) {
    return { ok: false, domain: added, note: provisioned.note };
  }
  // Re-read the row so the response carries the recorded zone id, nameservers and
  // status. Falling back to `added` keeps every path returning a real row.
  const rows = await listUserDomains(userId);
  const fresh = rows.ok ? rows.value.find((d) => d.apex === added.apex) : undefined;
  return { ok: provisioned.status === "active", domain: fresh ?? added, note: provisioned.note };
}

/** Record the facts Cloudflare reports for a zone in the CALLER's own account. */
async function recordFromCredential(
  userId: string,
  added: UserDomainView,
  zone: { zoneId: string; status: string; nameservers: string[] }
): Promise<{ ok: boolean; domain: UserDomainView; note: string | null }> {
  // `added.apex` is passed, not `zone`'s name, because recordDomainZoneState
  // matches on the row's own apex — Cloudflare's spelling is not the authority on
  // which of our rows it is.
  const recorded = await recordDomainZoneState(userId, added.apex, {
    zoneId: zone.zoneId,
    status: zone.status,
    nameservers: zone.nameservers,
    note: null,
  });
  // A failed write is still not a reason to report failure of the ADD — fall back
  // to the row as we already have it.
  if (!recorded.ok) return { ok: false, domain: added, note: recorded.message };

  return {
    ok: recorded.value.selectable,
    domain: recorded.value,
    note: recorded.value.selectable
      ? null
      : "Cloudflare is still activating this zone. Try again in a few minutes.",
  };
}