import { prisma } from "../prisma";
import { isValidLinkTarget, isValidSlug, newHostingToken } from "./rules";
import { resolveCapsForUser, type HostingResult } from "./files";

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
}

type LinkRedirectRow = {
  id: string;
  token: string;
  slug: string | null;
  label: string | null;
  target: string;
  clickCount: number;
  createdAt: Date;
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
}

export async function createHostedLink(input: CreateHostedLinkInput): Promise<HostingResult<HostedLinkView>> {
  const { caps } = await resolveCapsForUser(input.userId);
  if (!caps.enabled) {
    return { ok: false, status: 403, code: "disabled", message: "Hosting is not enabled on this account yet." };
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

  for (let attempt = 0; attempt < 2; attempt++) {
    const token = newHostingToken();
    try {
      const row = await prisma.linkRedirect.create({
        data: { token, userId: input.userId, slug: attempt === 0 ? slug : null, target, label },
      });
      return { ok: true, value: toHostedLinkView(row) };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // A slug collision is the user's to fix; a token collision is ours to
      // retry (improbable — 18 random bytes).
      if (slug) {
        return { ok: false, status: 409, code: "slug_taken", message: "That link name is already taken. Pick another." };
      }
    }
  }
  return { ok: false, status: 500, code: "unknown", message: "Could not save the link." };
}

export interface UpdateHostedLinkInput {
  userId: string;
  id: string;
  target?: string;
  label?: string | null;
  slug?: string | null;
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

  if (Object.keys(data).length === 0) return { ok: true, value: toHostedLinkView(row) };

  try {
    const updated = await prisma.linkRedirect.update({ where: { id: row.id }, data });
    return { ok: true, value: toHostedLinkView(updated) };
  } catch (err) {
    if (isUniqueViolation(err)) {
      return { ok: false, status: 409, code: "slug_taken", message: "That link name is already taken. Pick another." };
    }
    throw err;
  }
}

/**
 * Delete ONLY a user's own link. `userId` is in the WHERE clause, so this can
 * never remove a campaign link (userId NULL) or another user's link.
 */
export async function deleteHostedLink(userId: string, id: string): Promise<HostingResult<{ id: string }>> {
  const row = await prisma.linkRedirect.findFirst({ where: { id, userId } });
  if (!row) return { ok: false, status: 404, code: "not_found", message: "Link not found." };
  await prisma.linkRedirect.delete({ where: { id: row.id } });
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

