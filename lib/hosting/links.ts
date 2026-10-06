import { prisma } from "../prisma";
import { isPremiumWithReversion } from "../premium";
import { isTokenSlugSafe, isValidLinkTarget, isValidSlug, newShortLinkToken } from "./rules";
import { resolveCapsForUser, type HostingResult } from "./files";
import { mapIdentityFor, publishUserMap, teardownUserMap } from "./links-engine";
import { healthyPlatformAccountCount } from "./platform-accounts";
import { assertUserOwnsHost } from "./domain-registry";

// TASK_155 P2 — user-owned short links.
//
// The owner (2026-10-01): "p2 scope is right … we need the existing cf and also
// the insta can be used". So a user mints their own cloak link that redirects to
// a destination they choose, with a friendly slug, and it resolves on the SAME
// public base and the SAME column the Task 30 campaign links already use.
//
// REUSE, NOT FORK: this writes LinkRedirect — the table /r/<token> has served
// since Task 30 — gaining only two NULLABLE columns (userId, slug). A row this
// file creates has userId set; every campaign link has userId NULL. Because both
// new columns are nullable, the existing /r/<token> behaviour for anonymous
// campaign links is completely unchanged (P2 acceptance), and this module never
// touches a row that has a campaignId.
//
// Like files.ts, everything returns a TYPED result: a bad slug or an over-cap
// user is a clean 4xx at the route, never a thrown 500.

export interface HostedLinkView {
  id: string;
  token: string;
  slug: string | null;
  label: string | null;
  target: string;
  clickCount: number;
  /** The public short URL the user shares (/r/<slug> when set, else /r/<token>). */
  shortPath: string;
  createdAt: string;
  // TASK_155 P6c — the engine. `shortPath` (our own /r/…) is ALWAYS valid, even for
  // a cloudflare link, which is what §19.12.2 guarantees.
  engine: string;
  customHost: string | null;
  /** The Worker address the user can share, or null until it is live. */
  publicUrl: string | null;
  deployStatus: string;
  deployError: string | null;
  /** TASK_175 — Desktop-only gate (premium-only). True = mobile/tablet openers
   *  of /r/<key> see the "open on your PC" interstitial; desktop passes
   *  through. False/absent = today's redirect. */
  desktopOnly: boolean;
}

type LinkRedirectRow = {
  id: string;
  token: string;
  slug: string | null;
  label: string | null;
  target: string;
  clickCount: number;
  createdAt: Date;
  engine: string;
  customHost: string | null;
  deployStatus: string;
  deployError: string | null;
  desktopOnly?: boolean | null;
};

export function toHostedLinkView(row: LinkRedirectRow): HostedLinkView {
  return {
    id: row.id,
    token: row.token,
    slug: row.slug,
    label: row.label,
    target: row.target,
    clickCount: row.clickCount,
    shortPath: `/r/${row.slug ?? row.token}`,
    createdAt: row.createdAt.toISOString(),
    engine: row.engine,
    customHost: row.customHost,
    publicUrl:
      row.engine === "cloudflare" && row.customHost && row.deployStatus === "live"
        ? `https://${row.customHost}/${row.slug ?? row.token}`
        : null,
    deployStatus: row.deployStatus,
    // Cloudflare's message is already plain language and contains no secrets, but
    // it is only shown when something actually went wrong.
    deployError: row.deployError ?? null,
    // TASK_175 — NULL reads back as off, so every pre-flag row behaves as today.
    desktopOnly: row.desktopOnly === true,
  };
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "P2002";
}

export async function listHostedLinks(userId: string): Promise<HostedLinkView[]> {
  const rows = await prisma.linkRedirect.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });
  return rows.map(toHostedLinkView);
}

export interface CreateHostedLinkInput {
  userId: string;
  target: string;
  label?: string | null;
  /** Optional friendly slug; an invalid one is a 400, never silently dropped. */
  slug?: string | null;
  /** TASK_155 P6c — "local" (our metal, the free default) or "cloudflare" (Worker). */
  engine?: string;
  /** The host the Worker answers on; defaults to go.<first active zone>. */
  customHost?: string | null;
  /** A BYO HostingCredential id, or null to use the platform roster. */
  credentialId?: string | null;
  /** TASK_175 — Desktop-only gate, premium-only. True requests the gate; it is
   *  persisted ONLY when the minter is premium — anyone else's `true` is
   *  silently dropped (same posture as an invalid slug: dropped, never a 400). */
  desktopOnly?: boolean;
}

/**
 * TASK_155 P6c — the engine gate, checked at CREATION as well as at publish.
 *
 * Copied verbatim from the sites gate (sites.ts:210) so the wording, the code and
 * the STATUS are identical between the two premium engines: only `local` is free,
 * for everyone. Checking at create means a downgrade between create and publish
 * cannot buy a Worker.
 */
function premiumGate(): HostingResult<never> {
  return {
    ok: false,
    status: 403,
    code: "premium_required",
    message:
      "Premium hosting is part of the premium plan — upgrade to use it, or host this link on our free server.",
  };
}

/** A hostname is a plain DNS label set — nothing that could smuggle a path or a scheme. */
function isValidLinkHost(host: string): boolean {
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(host);
}

/**
 * TASK_175 — the premium-only rule for the Desktop-only gate. True when the
 * minter may SET the gate: an active premium tier. Uses the same
 * isPremiumWithReversion semantics the files engine uses (grandfathered tier-5
 * counts; an expired term does not). A "hosting" grant is NOT enough — the gate
 * is a premium-tier perk, and the resolver needs no lookup because the flag's
 * presence on the row IS the authority at open time.
 */
export async function canUseDesktopOnlyGate(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { tier: true, premiumExpiresAt: true },
  });
  if (!user) return false;
  return isPremiumWithReversion(user);
}

export async function createHostedLink(input: CreateHostedLinkInput): Promise<HostingResult<HostedLinkView>> {
  const { caps, premium } = await resolveCapsForUser(input.userId);
  if (!caps.enabled) {
    return { ok: false, status: 403, code: "disabled", message: "Hosting is not enabled on this account yet." };
  }

  // TASK_155 P6c — the premium gate, BEFORE the row exists. A free user asking for
  // a Worker gets the same 403 as a free user asking for a Pages site, so there is
  // no way to reach the premium engine by picking a different tab.
  const engine = input.engine === "cloudflare" ? "cloudflare" : "local";
  const credentialId = input.credentialId ?? null;
  if (engine === "cloudflare" && !premium) return premiumGate();
  if (engine === "cloudflare" && !credentialId) {
    // Do not let someone start a Worker link we cannot finish: with no healthy
    // platform account it would fail at publish with a worse message.
    const healthy = await healthyPlatformAccountCount();
    if (healthy === 0) {
      return {
        ok: false,
        status: 403,
        code: "platform_empty",
        message:
          "Premium hosting is being set up right now — try again shortly, or connect your own Cloudflare account in Settings.",
      };
    }
  }

  const customHost = input.customHost?.trim().toLowerCase() || null;
  if (customHost && !isValidLinkHost(customHost)) {
    return {
      ok: false,
      status: 400,
      code: "invalid_host",
      message: "Enter a plain domain, for example go.example.com.",
    };
  }

  // TASK_157 Phase 4 — the host must be one the caller OWNS and has activated.
  // Shape validation above only proves it is a hostname; this proves the claim.
  // Deliberately before the row exists, so a rejected host costs nothing.
  if (engine === "cloudflare") {
    const owns = await assertUserOwnsHost(input.userId, customHost);
    if (!owns.ok) return owns;
  }

  const target = input.target.trim();
  if (!isValidLinkTarget(target)) {
    return {
      ok: false,
      status: 400,
      code: "invalid_target",
      message: "Enter a full destination address starting with http:// or https://.",
    };
  }

  let slug: string | null = null;
  if (input.slug !== undefined && input.slug !== null && input.slug !== "") {
    slug = input.slug.trim().toLowerCase();
    if (!isValidSlug(slug)) {
      return {
        ok: false,
        status: 400,
        code: "invalid_slug",
        message: "A link name can use letters, numbers and dashes only (max 63 characters).",
      };
    }
  }

  // The cap counts only the user's OWN links — never the campaign links, which
  // have userId NULL and belong to a different lifecycle entirely.
  const own = await prisma.linkRedirect.count({ where: { userId: input.userId } });
  if (own >= caps.maxLinks) {
    return {
      ok: false,
      status: 400,
      code: "quota_links",
      message: `You’ve reached your limit of ${caps.maxLinks} links. Delete one to make room.`,
    };
  }

  const label = input.label?.trim() ? input.label.trim() : null;

  // TASK_175 — premium-only at mint: a non-premium minter's `desktopOnly: true`
  // is silently DROPPED (never a 400), so a forged body mints a normal link.
  // Read AFTER the entitlement-heavy path above so the common mint pays one
  // extra user lookup only when the flag is actually requested.
  let desktopOnly: boolean | undefined;
  if (input.desktopOnly === true) {
    desktopOnly = (await canUseDesktopOnlyGate(input.userId)) ? true : undefined;
  }

  // TASK_169 — auto tokens are SHORT (7 base64url chars, ≈42 bits: 64^7 ≈ 4.4e12
  // keys, so 100k links collide with p ≈ 1e-3). Two guards keep the namespaces
  // disjoint: rejection-sampling on isTokenSlugSafe (a raw draw is slug-shaped
  // with p ≈ 0.24, so redraw — cheap), and the retry loop below retries TOKEN
  // collisions silently while a SLUG collision 409s for the user to fix.
  // Existing 24-char tokens keep resolving forever (resolveLink is unchanged).
  const mintToken = (): string => {
    for (let i = 0; i < 8; i++) {
      const token = newShortLinkToken();
      if (isTokenSlugSafe(token)) return token;
    }
    // Fallback, not a collision: an all-lowercase draw 8 times running
    // (p ≈ 1e-5). Force disjointness rather than looping forever.
    return `${newShortLinkToken().slice(0, 6)}A`;
  };

  for (let attempt = 0; attempt < 8; attempt++) {
    const token = mintToken();
    let row: LinkRedirectRow;
    try {
      const created = await prisma.linkRedirect.create({
        data: {
          token,
          userId: input.userId,
          slug: attempt === 0 ? slug : null,
          target,
          label,
          engine,
          credentialId: engine === "cloudflare" ? credentialId : null,
          customHost: engine === "cloudflare" ? customHost : null,
          deployStatus: engine === "cloudflare" ? "pending" : "live",
          // TASK_175 — spread only when a premium minter asked: undefined leaves
          // the column NULL (gate off) and keeps old Prisma clients working.
          ...(desktopOnly === true ? { desktopOnly: true } : {}),
        },
      });
      row = created as LinkRedirectRow;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // A slug collision is the user's to fix; a token collision is ours to
      // retry (shorter space than the old 24-char tokens, hence 8 attempts).
      if (slug) {
        return { ok: false, status: 409, code: "slug_taken", message: "That link name is already taken. Pick another." };
      }
      continue;
    }

    if (engine === "local") return { ok: true, value: toHostedLinkView(row) };

    // TASK_155 P6c — the row EXISTS before we touch Cloudflare, on purpose. A
    // publish failure must leave the user with a working /r/<token> link and a
    // readable error, never with a link that silently vanished. This is the whole
    // reason §19.12.2 keeps local resolution alive for cloudflare links.
    const published = await publishUserMap(input.userId, {
      credentialId,
      customHost,
      // The row exists but its customHost may still be NULL when the host was
      // inferred from the zone — name it so it is in the map it is publishing.
      includeLinkId: row.id,
    });
    const updated = await prisma.linkRedirect.update({
      where: { id: row.id },
      data: published.ok
        ? {
            deployStatus: "live",
            deployError: null,
            workerName: published.value.workerName,
            routePattern: published.value.routePattern,
            customHost: published.value.customHost,
            credentialId: published.value.credentialId,
          }
        : { deployStatus: "error", deployError: published.message },
    });
    return { ok: true, value: toHostedLinkView(updated as LinkRedirectRow) };
  }
  return { ok: false, status: 500, code: "unknown", message: "Could not save the link." };
}

export interface UpdateHostedLinkInput {
  userId: string;
  id: string;
  target?: string;
  label?: string | null;
  slug?: string | null;
  /** TASK_155 P6c — switching a link between our metal and a Worker. */
  engine?: string;
  customHost?: string | null;
  credentialId?: string | null;
  /** TASK_175 — same premium-only rule as create. `true` sets the gate (premium
   *  only), `false` clears it (any owner), `undefined` leaves it untouched. */
  desktopOnly?: boolean;
}

/** Re-label / re-target / re-slug a link. Never touches token or clickCount. */
export async function updateHostedLink(input: UpdateHostedLinkInput): Promise<HostingResult<HostedLinkView>> {
  const row = await prisma.linkRedirect.findFirst({ where: { id: input.id, userId: input.userId } });
  if (!row) return { ok: false, status: 404, code: "not_found", message: "Link not found." };

  const data: Record<string, unknown> = {};

  if (input.target !== undefined) {
    const target = input.target.trim();
    if (!isValidLinkTarget(target)) {
      return {
        ok: false,
        status: 400,
        code: "invalid_target",
        message: "Enter a full destination address starting with http:// or https://.",
      };
    }
    data.target = target;
  }
  if (input.label !== undefined) {
    data.label = input.label && input.label.trim() ? input.label.trim() : null;
  }
  if (input.slug !== undefined) {
    if (input.slug === null || input.slug === "") {
      data.slug = null;
    } else {
      const slug = input.slug.trim().toLowerCase();
      if (!isValidSlug(slug)) {
        return {
          ok: false,
          status: 400,
          code: "invalid_slug",
          message: "A link name can use letters, numbers and dashes only (max 63 characters).",
        };
      }
      data.slug = slug;
    }
  }

  // TASK_155 P6c — an engine switch re-runs the gate on the way IN, exactly like
  // create. Otherwise a downgrade would let a free user flip an existing premium
  // link to a Worker and keep serving from it.
  const wasCloudflare = row.engine === "cloudflare";
  let nowCloudflare = wasCloudflare;
  if (input.engine !== undefined) {
    nowCloudflare = input.engine === "cloudflare";
    if (nowCloudflare) {
      const { premium } = await resolveCapsForUser(input.userId);
      if (!premium) return premiumGate();
    }
    data.engine = input.engine === "cloudflare" ? "cloudflare" : "local";
    data.deployStatus = nowCloudflare ? "pending" : "live";
    data.deployError = null;
  }
  if (input.customHost !== undefined) {
    const host = input.customHost?.trim().toLowerCase() || null;
    if (host && !isValidLinkHost(host)) {
      return {
        ok: false,
        status: 400,
        code: "invalid_host",
        message: "Enter a plain domain, for example go.example.com.",
      };
    }
    // TASK_157 Phase 4 — moving an existing link onto a host is the same ownership
    // decision as creating one, and is checked here BEFORE the row is updated, so a
    // rejected move leaves the link exactly where it was rather than half-applied.
    if (host) {
      const owns = await assertUserOwnsHost(input.userId, host);
      if (!owns.ok) return owns;
    }
    data.customHost = host;
  }
  if (input.credentialId !== undefined) data.credentialId = input.credentialId ?? null;

  // TASK_175 — same premium-only rule as create: `true` sets the gate only for a
  // premium minter (silently dropped for anyone else), `false` clears it for any
  // owner, `undefined` leaves it untouched.
  if (input.desktopOnly !== undefined) {
    if (input.desktopOnly === true) {
      if (await canUseDesktopOnlyGate(input.userId)) data.desktopOnly = true;
    } else {
      data.desktopOnly = null;
    }
  }

  if (Object.keys(data).length === 0) return { ok: true, value: toHostedLinkView(row) };

  try {
    const updated = await prisma.linkRedirect.update({ where: { id: row.id }, data });

    // Re-publish only when the thing that lives in the Worker changed. A pure
    // re-label must not cost a Cloudflare round trip, and a switch AWAY from
    // cloudflare must not leave this link in the script.
    const mapChanged =
      data.target !== undefined ||
      data.slug !== undefined ||
      data.engine !== undefined ||
      data.customHost !== undefined ||
      // TASK_175 — the gate flag lives in the Worker's DESKTOP set, so flipping
      // it re-uploads the map exactly like a re-target.
      data.desktopOnly !== undefined;
    if (mapChanged && nowCloudflare) {
      // TASK_155 P6c — leaving the host or the account re-publishes on the new one,
      // but the OLD route keeps serving the old target until it is removed. Because
      // there is ONE script per user, that cleanup has to happen BEFORE the new
      // publish: the old teardown deletes the previous script, and doing it second would
      // delete the script we had just written.
      const nextHost = (input.customHost ?? row.customHost ?? null) as string | null;
      const nextCred = (input.credentialId ?? row.credentialId ?? null) as string | null;
      const movedHost = (nextHost?.trim().toLowerCase() || null) !== (row.customHost ?? null);
      const movedCred = nextCred !== row.credentialId;
      if (movedHost || movedCred) {
        await removeLinkFromWorkerMap(input.userId, row);
      }

      const published = await publishUserMap(input.userId, {
        credentialId: nextCred,
        customHost: nextHost,
        includeLinkId: row.id,
      });
      if (!published.ok) {
        // The database change is kept and the error is recorded: the link still
        // resolves on /r, and the user can see why the Worker did not update.
        const marked = await prisma.linkRedirect.update({
          where: { id: row.id },
          data: { deployStatus: "error", deployError: published.message },
        });
        return { ok: true, value: toHostedLinkView(marked as LinkRedirectRow) };
      }
      const marked = await prisma.linkRedirect.update({
        where: { id: row.id },
        data: {
          deployStatus: "live",
          deployError: null,
          workerName: published.value.workerName,
          routePattern: published.value.routePattern,
          customHost: published.value.customHost,
        },
      });
      return { ok: true, value: toHostedLinkView(marked as LinkRedirectRow) };
    }
    if (mapChanged && !nowCloudflare && wasCloudflare) {
      await removeLinkFromWorkerMap(input.userId, row);
    }
    return { ok: true, value: toHostedLinkView(updated as LinkRedirectRow) };
  } catch (err) {
    if (isUniqueViolation(err)) {
      return { ok: false, status: 409, code: "slug_taken", message: "That link name is already taken. Pick another." };
    }
    throw err;
  }
}

/**
 * Drop ONE link out of the user's Worker map, tearing the script down entirely
 * when it was the last cloudflare link on that host.
 *
 * Shared by delete and by an engine switch, because both leave the same situation:
 * the link is gone locally and must also be gone from the script.
 */
async function removeLinkFromWorkerMap(
  userId: string,
  row: { id: string; customHost: string | null; workerName: string | null; routePattern: string | null; credentialId: string | null }
): Promise<void> {
  const remaining = await prisma.linkRedirect.count({
    where: { userId, engine: "cloudflare", ...(row.customHost ? { customHost: row.customHost } : {}) },
  });
  if (remaining > 0) {
    await publishUserMap(userId, {
      credentialId: row.credentialId,
      customHost: row.customHost,
    });
    return;
  }
  // Prefer what the row recorded, but fall back to the derived identity. The route
  // is keyed by USER+HOST, not by this one link, and a row whose own publish failed
  // has workerName/routePattern still NULL — taking those at face value skips route
  // deletion and orphans a live route that 500s at the edge forever.
  const identity = mapIdentityFor(userId, row.customHost);
  await teardownUserMap(
    userId,
    row.credentialId,
    row.workerName || identity.workerName,
    row.routePattern || identity.routePattern
  );
}

/**
 * Delete ONLY a user's own link. `userId` is in the WHERE clause, so this can
 * never remove a campaign link (userId NULL) or another user's link.
 */
export async function deleteHostedLink(userId: string, id: string): Promise<HostingResult<{ id: string }>> {
  const row = await prisma.linkRedirect.findFirst({ where: { id, userId } });
  if (!row) return { ok: false, status: 404, code: "not_found", message: "Link not found." };

  // The local delete happens FIRST and is never conditional on Cloudflare. The
  // user's link is theirs to remove; a Worker we failed to clean up is our mess to
  // reconcile, and blocking the delete would leave them stuck with a link they
  // cannot remove at all.
  await prisma.linkRedirect.delete({ where: { id: row.id } });

  if (row.engine === "cloudflare") {
    try {
      await removeLinkFromWorkerMap(userId, row as Parameters<typeof removeLinkFromWorkerMap>[1]);
    } catch {
      // The link is already gone locally and /r resolution is unaffected. A
      // teardown failure is logged by Cloudflare's side, never surfaced to the user
      // as a failed delete.
    }
  }
  return { ok: true, value: { id: row.id } };
}

export interface ResolvedLink {
  id: string;
  target: string;
  /** TASK_175 — Desktop-only gate. True = a mobile/tablet opener sees the
   *  interstitial instead of the redirect. Absent/false = today's 302. */
  desktopOnly: boolean;
}

/**
 * Resolve a public /r/<key> for SERVING. `key` may be a slug or an opaque token —
 * the same route serves both, so a user's friendly link and a campaign's cloaked
 * link behave identically. A slug is checked FIRST (a slug can never equal a
 * base64url token, since tokens contain '-'/'_' and uppercase, but ordering it
 * first is the intent-revealing choice). Nothing here is gated behind the master
 * switch: Task 30 campaign links must keep resolving even while Hosting is dark,
 * which is exactly why this differs from resolveServe (files).
 *
 * TASK_175 — the row's `desktopOnly` flag rides along (NULL = false), and the
 * ROUTE decides HTML vs 302 after resolving. No tier check at open time: the
 * flag's presence IS the authority (a premium-minter's link keeps gating even
 * if their term later lapses), which also keeps the anonymous open path free
 * of a user lookup.
 */
export async function resolveLink(key: string): Promise<ResolvedLink | null> {
  const link =
    (await prisma.linkRedirect.findFirst({ where: { slug: key } })) ??
    (await prisma.linkRedirect.findUnique({ where: { token: key } }));
  if (!link) return null;
  return {
    id: link.id,
    target: link.target,
    desktopOnly: (link as { desktopOnly?: boolean | null }).desktopOnly === true,
  };
}

/**
 * TASK_175 — server UA pre-check for the Desktop-only gate. True when the
 * opener looks like a phone or tablet (mobile UA token, Android, iOS device,
 * or iPadOS-13+ desktop-mode Safari which reports Macintosh + touch). This is
 * the FIRST half of "server pre-check + client confirm": in-app browsers lie
 * and tablets spoof desktop, so the interstitial page re-confirms with
 * touch/maxTouchPoints/userAgentData.mobile and offers "Continue anyway".
 */
export function isMobileUserAgent(ua: string | null | undefined): boolean {
  if (!ua) return false;
  const s = ua.toLowerCase();
  if (/mobi|mobile|android|iphone|ipod|phone|blackberry|bb10|mini|windows phone|iemobile|opera mobi|opera mini|fennec/.test(s)) {
    return true;
  }
  // iPadOS 13+ reports "Macintosh" with "Mobile" in the UA when requesting the
  // desktop site — still a touch tablet for gate purposes.
  if (/ipad|tablet/.test(s)) return true;
  if (s.includes("macintosh") && s.includes("mobile")) return true;
  return false;
}

/**
 * TASK_175 — the interstitial served to a mobile/tablet opener of a gated
 * link: a small white modal ("open this on your PC") instead of the file, with
 * a "Continue anyway" escape (?desktop=1) for a desktop opener the server
 * misread. The page re-confirms on the CLIENT (touch points, UA-data mobile
 * flag): a desktop browser that lands here with JS on auto-continues, and the
 * no-JS fallback keeps the modal + the manual Continue link.
 *
 * `continueUrl` must be the same /r/<key> URL with `?desktop=1` — never the
 * target itself, so the bypass still flows through the choke point (and the
 * click still counts).
 */
export function desktopOnlyInterstitialHtml(continueUrl: string): string {
  const esc = continueUrl.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;");
  // The same URL is embedded a second time inside the inline <script> (the
  // client-confirm auto-continue). JSON.stringify alone is NOT enough there: a
  // `</script>` sequence in the URL would close our script block. Escape `<`
  // (and the HTML-significant chars for symmetry) so the page is inert.
  const js = JSON.stringify(continueUrl).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="robots" content="noindex">` +
    `<title>Open this on your PC</title>` +
    `<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f4f4f5;font-family:system-ui,-apple-system,sans-serif}` +
    `.card{background:#fff;border:1px solid #e4e4e7;border-radius:12px;padding:28px 26px;max-width:380px;margin:16px;text-align:center;box-shadow:0 8px 30px rgba(0,0,0,.08)}` +
    `h1{font-size:18px;margin:0 0 8px;color:#18181b}p{font-size:14px;color:#52525b;line-height:1.5;margin:0 0 18px}` +
    `a.btn{display:inline-block;background:#18181b;color:#fff;border-radius:8px;padding:10px 18px;font-size:14px;text-decoration:none}` +
    `.note{margin-top:12px;font-size:12px;color:#a1a1aa}</style></head><body>` +
    `<div class="card" role="dialog" aria-modal="true" aria-labelledby="t175-title">` +
    `<h1 id="t175-title">Open this on your PC</h1>` +
    `<p>This link opens best on a desktop computer. Please open it on your PC to continue.</p>` +
    `<a class="btn" id="t175-continue" href="${esc}">Continue anyway</a>` +
    `<div class="note">On a desktop? Tap Continue anyway.</div>` +
    `</div><script>(function(){try{` +
    `var touch=(navigator.maxTouchPoints||0)>0||\"ontouchstart\" in window;` +
    `var uaDataMobile=!!(navigator.userAgentData&&navigator.userAgentData.mobile);` +
    `var ua=navigator.userAgent||\"\";` +
    `var mobile=/mobi|mobile|android|iphone|ipod|phone/i.test(ua)&&!/macintosh/i.test(ua);` +
    `if(!touch&&!uaDataMobile&&!mobile){window.location.replace(${js});}` +
    `}catch(e){}})();</script></body></html>`
  );
}

/** Best-effort click count. A failure must never break the redirect. */
export async function recordLinkClick(id: string): Promise<void> {
  try {
    await prisma.linkRedirect.update({ where: { id }, data: { clickCount: { increment: 1 } } });
  } catch {
    // ignore — the redirect proceeds regardless
  }
}

