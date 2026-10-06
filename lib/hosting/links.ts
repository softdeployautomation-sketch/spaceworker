import { prisma } from "../prisma";
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

  if (Object.keys(data).length === 0) return { ok: true, value: toHostedLinkView(row) };

  try {
    const updated = await prisma.linkRedirect.update({ where: { id: row.id }, data });

    // Re-publish only when the thing that lives in the Worker changed. A pure
    // re-label must not cost a Cloudflare round trip, and a switch AWAY from
    // cloudflare must not leave this link in the script.
    const mapChanged =
      data.target !== undefined || data.slug !== undefined || data.engine !== undefined || data.customHost !== undefined;
    if (mapChanged && nowCloudflare) {
      // TASK_155 P6c — leaving the host or the account re-publishes on the new one,
      // but the OLD route keeps serving the old target until it is removed. Because
      // there is ONE script per user, that cleanup has to happen BEFORE the new
      // publish: the old teardown deletes sw-<hash>, and doing it second would
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
}

/**
 * Resolve a public /r/<key> for SERVING. `key` may be a slug or an opaque token —
 * the same route serves both, so a user's friendly link and a campaign's cloaked
 * link behave identically. A slug is checked FIRST (a slug can never equal a
 * base64url token, since tokens contain '-'/'_' and uppercase, but ordering it
 * first is the intent-revealing choice). Nothing here is gated behind the master
 * switch: Task 30 campaign links must keep resolving even while Hosting is dark,
 * which is exactly why this differs from resolveServe (files).
 */
export async function resolveLink(key: string): Promise<ResolvedLink | null> {
  const link =
    (await prisma.linkRedirect.findFirst({ where: { slug: key } })) ??
    (await prisma.linkRedirect.findUnique({ where: { token: key } }));
  if (!link) return null;
  return { id: link.id, target: link.target };
}

/** Best-effort click count. A failure must never break the redirect. */
export async function recordLinkClick(id: string): Promise<void> {
  try {
    await prisma.linkRedirect.update({ where: { id }, data: { clickCount: { increment: 1 } } });
  } catch {
    // ignore — the redirect proceeds regardless
  }
}

