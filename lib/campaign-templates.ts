import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";

// Task 28, item 5 — recognition of "ready-made" (tier (b)) campaign templates.
//
// The owner chose the admin-owned-EmailCampaign approach: NO new CampaignTemplate
// model and NO new EmailCampaign fields. A template is simply an EmailCampaign
// owned by a designated system/admin account — distinguished purely by ownership.
// The automation builder lists those alongside the user's own campaigns as a
// second "Ready-made templates" group, and clones them through the exact same
// createCampaign() path as a user's own campaign (tier (a)).
//
// The account is configured by env SYSTEM_TEMPLATES_USER_EMAIL. When it's unset,
// the feature is inert: no ready-made templates exist and only the user's own
// campaigns are usable (exactly today's behaviour).

/** The email of the account whose campaigns are surfaced as ready-made templates. */
export function systemTemplatesOwnerEmail(): string {
  return (env.systemTemplatesUserEmail ?? "").trim().toLowerCase();
}

/** True when a ready-made-template account has been configured. */
export function systemTemplatesConfigured(): boolean {
  return systemTemplatesOwnerEmail().length > 0;
}

/** Id of the ready-made-templates account, or null when unconfigured / absent. */
export async function resolveSystemTemplatesOwnerId(): Promise<string | null> {
  const email = systemTemplatesOwnerEmail();
  if (!email) return null;
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  return user?.id ?? null;
}

/**
 * Resolve the ready-made-templates account, creating it on first use. The system
 * account exists only to own template campaigns; its password hash is an
 * unusable placeholder so it can never sign in. Called by the admin authoring
 * API (never from a read path), so merely viewing the panel can't create rows.
 */
export async function ensureSystemTemplatesOwner(): Promise<string> {
  const email = systemTemplatesOwnerEmail();
  if (!email) {
    throw new Error(
      "SYSTEM_TEMPLATES_USER_EMAIL is not configured — set it to enable ready-made campaign templates.",
    );
  }
  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (existing) return existing.id;
  const created = await prisma.user.create({
    data: {
      email,
      // Unusable on purpose — this account must never be able to sign in. The
      // value is never fed to bcrypt.compare() unless someone tries to log in
      // as it, which the account's existence as a non-interactive owner forbids.
      passwordHash: "!",
      emailVerified: true,
      tier: 0,
    },
    select: { id: true },
  });
  return created.id;
}

/**
 * Prisma `where` that matches a campaign usable as an automation template for
 * `userId`: either the user's OWN campaign (tier a) or, when configured, a
 * system-owned ready-made one (tier b). Shared by the create/edit gates and by
 * the run-time clone loader so every path accepts exactly the same set.
 */
export async function usableTemplateWhere(
  campaignId: string,
  userId: string,
): Promise<Prisma.EmailCampaignWhereInput> {
  const systemOwnerId = await resolveSystemTemplatesOwnerId();
  return systemOwnerId
    ? {
        OR: [
          { id: campaignId, userId },
          { id: campaignId, userId: systemOwnerId },
        ],
      }
    : { id: campaignId, userId };
}