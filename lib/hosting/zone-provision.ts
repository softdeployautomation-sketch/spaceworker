import { getAdminSettings } from "../admin-settings";

import { createZone, verifyCredential, type CfCredential } from "./cloudflare";
import { recordDomainZoneState } from "./domain-registry";
import { resolvePlatformCredential } from "./platform-accounts";
import { getZoneByName } from "./workers";

// TASK_158 W1 — AUTOMATIC ZONE CREATION, the capability the dedicated
// `HostingPlatformAccount.zoneToken` slot was added for.
//
// THE PROBLEM THIS SOLVES. Until now every new domain was a TWO-STEP MANUAL HANDOFF:
// the user typed their domain into our panel, we read the user's own Cloudflare
// account for a zone that does not exist yet, and told them "Add it there, then set
// the nameservers we show you" — except we could not show them any nameservers,
// because we had not created anything. The user had to leave, go to Cloudflare,
// create the zone themselves, come back, and hope we noticed. The note was honest
// and useless.
//
// WHAT IT DOES INSTEAD. Creating a zone is an ACCOUNT-scoped Cloudflare permission
// (`com.cloudflare.api.account.zone.create`) that neither the Pages token nor the
// Workers token carries — both answer 403 for it. So the operator stores a THIRD,
// narrowly-scoped token (Zones) on a platform account, and this module uses it to:
//
//   1. look for the zone in that account (a domain already in OUR account is
//      recorded, never duplicated), then
//   2. create it if it is genuinely absent, then
//   3. record the zone id, the two NAMESERVERS Cloudflare assigned, and the real
//      status, so the panel can show the user exactly what to paste at their
//      registrar.
//
// WHY IT LANDS IN THE PREMIUM-SITES ACCOUNT. The zone is pinned with the SAME
// AdminSetting that pins site deploys (`hostingPremiumSitesAccountId`), so the zone
// and the Pages project it will serve from are in ONE Cloudflare account. A custom
// domain can only be attached to a Pages project in the same account, so pinning
// both is what stops this feature from silently creating a zone in an account that
// could never bind to the user's site.
//
// IT NEVER THROWS AND NEVER FAILS THE ADD. Every outcome is a plain-language `note`
// on a row that already exists. A missing token, a 403, a rate limit or a zone that
// belongs to somebody else's account all degrade to the ORIGINAL manual two-step
// message — still correct, just no longer the only path.

export interface ZoneProvisionOutcome {
  /** True only when a zone id was recorded (not "the domain is live"). */
  ok: boolean;
  zoneId: string | null;
  status: string;
  nameservers: string[] | null;
  /** Plain-language detail for the UI. Never contains a token. Null = all good. */
  note: string | null;
}

/**
 * The manual two-step instruction, used whenever automatic creation cannot run.
 * Kept in ONE place so the fallback wording cannot drift from the route's.
 */
export const MANUAL_ZONE_NOTE =
  "This domain isn't in the Cloudflare account we publish to yet. Add it to Cloudflare, then set the nameservers we show you.";

/**
 * Ensure a zone exists for `apex` in the pinned platform account, and record what
 * Cloudflare says about it on the user's row.
 *
 * Returns the outcome rather than throwing, because the caller's job is to answer
 * an HTTP request about a domain that has ALREADY been added — a provisioning
 * failure must not turn a successful add into an error the user re-submits.
 */
export async function provisionDomainZone(userId: string, apex: string): Promise<ZoneProvisionOutcome> {
  const settings = await getAdminSettings();
  const resolved = await resolvePlatformCredential((cred) => verifyCredential(cred), {
    // Both constraints matter: the pin puts the zone in the account the site will
    // deploy to, and `requireZoneToken` guarantees we never pick a healthy row that
    // simply cannot create zones. Without the latter, rotation could land on the
    // Pages-only primary and fail the create for no reason.
    requireZoneToken: true,
    pinAccountId: settings.hostingPremiumSitesAccountId,
  });
  if (!resolved.ok || !resolved.value.zoneToken) {
    return missing(MANUAL_ZONE_NOTE);
  }

  // The resolved `token` is the Pages/general token; the ZONES grant lives in its
  // own slot, so the credential for every call below is rebuilt around `zoneToken`.
  // Using the wrong one here fails closed with Cloudflare's 403 rather than doing
  // something surprising, but it would also make the feature look broken.
  const cred: CfCredential = { accountId: resolved.value.accountId, token: resolved.value.zoneToken };

  // EVERY note below is built from Cloudflare's own words, so every note is passed
  // through the redactor before it can reach a response. The list includes the
  // OTHER tokens on the row, not just the Zones one: they are all secrets, and a
  // shared error-handling path that looked at only the active token would leak the
  // neighbours the day one of them is used by mistake.
  const redact = redactor(resolved.value.token, resolved.value.workerToken, resolved.value.zoneToken);
  const fail = (note: string) => missing(redact(note));

  const existing = await getZoneByName(cred, apex);
  if (existing.ok && existing.value) {
    return record(userId, apex, existing.value, redact);
  }
  if (!existing.ok) {
    return fail(existing.error ?? "Could not reach Cloudflare. Try again shortly.");
  }

  const created = await createZone(cred, apex);
  if (created.ok) {
    if (!created.value) return fail("Cloudflare accepted the request but returned no zone.");
    return record(userId, apex, created.value, redact);
  }

  // "Already exists" is NOT a failure: the zone lives in some OTHER Cloudflare
  // account (very often the user's own). A zone can only ever be in one account, so
  // re-reading is the correct response — and if it is genuinely somebody else's, the
  // read still returns nothing and we fall back to the manual note, exactly as the
  // old behaviour did. Nothing is mutated either way.
  if (created.code === "zone_exists") {
    const reread = await getZoneByName(cred, apex);
    if (reread.ok && reread.value) return record(userId, apex, reread.value, redact);
    return missing(MANUAL_ZONE_NOTE);
  }

  // A 403 is the EXPECTED answer when the token in the Zones slot lacks
  // `com.cloudflare.api.account.zone.create`, and Cloudflare's own wording for it is
  // "Authentication error" — which sends the operator looking at the wrong thing.
  // Name the permission instead; that is the sentence that fixes the deploy.
  if (created.status === 403) {
    return missing(
      "Cloudflare refused to create this zone: the Zones token is missing the Zone Create permission. Grant it, or add the domain to Cloudflare yourself."
    );
  }

  // Otherwise Cloudflare's own words, redacted. A rate limit or a rejected name is
  // something only Cloudflare can explain, and paraphrasing it would lose the one
  // detail that makes it actionable.
  return fail(created.error ?? "Cloudflare would not create this zone. Check the Zones token's permissions.");
}

/** The uniform "nothing was recorded" outcome. */
function missing(note: string): ZoneProvisionOutcome {
  return { ok: false, zoneId: null, status: "pending", nameservers: null, note };
}

/**
 * Strip any credential from a string that is about to be shown to a user.
 *
 * Cloudflare error bodies are echoed into `error` verbatim, and an API (or a proxy,
 * or a future version) that quotes the offending `Authorization` header back at us
 * would put a live token into an HTTP response. That is a full credential leak
 * through a field everyone reasonably treats as prose. The tokens are known exactly
 * here, so they are removed by value rather than pattern-matched — a regex would
 * both miss unusual token shapes and, worse, redact innocent text.
 */
function redactor(...secrets: Array<string | null | undefined>): (note: string) => string {
  const real = secrets.filter((s): s is string => typeof s === "string" && s.length >= 8);
  if (real.length === 0) return (note) => note;
  return (note) => real.reduce((acc, secret) => acc.split(secret).join("[redacted]"), note);
}

/**
 * Persist what Cloudflare reported and describe it for the UI.
 *
 * The recorded status is Cloudflare's own, normalised by `recordDomainZoneState`
 * (never raw — Cloudflare's status enum is open-ended and an unknown value would
 * violate the column's CHECK). A brand-new zone therefore lands as `pending` with
 * its nameservers, which is the honest state: the user must still point their
 * registrar at us before the zone can activate.
 *
 * The registry's own failure message is redacted too: it is an internal error that
 * may quote the request (and therefore the bearer) that caused it, and it ends up in
 * the same HTTP response as every other note here.
 */
async function record(
  userId: string,
  apex: string,
  zone: { zoneId: string; status: string; nameservers: string[] },
  redact: (note: string) => string
): Promise<ZoneProvisionOutcome> {
  const saved = await recordDomainZoneState(userId, apex, {
    zoneId: zone.zoneId,
    status: zone.status,
    nameservers: zone.nameservers,
    note: null,
  });
  // A failed write is still not a reason to report failure of the ADD — the row
  // exists, and the next reconcile will try again.
  if (!saved.ok) return missing(redact(saved.message));

  const view = saved.value;
  return {
    ok: true,
    zoneId: view.zoneId,
    status: view.status,
    nameservers: view.nameservers,
    note: view.selectable
      ? null
      : "Cloudflare is holding this domain as pending. Set the nameservers below at your registrar to finish.",
  };
}

