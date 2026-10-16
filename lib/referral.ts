import "server-only";

import { prisma } from "@/lib/prisma";

/** Length of the generated short referral code. */
const REFERRAL_CODE_LEN = 8;

const CHARS =
  "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/1/I/L/O to avoid look-alikes

function generateCode(): string {
  let out = "";
  for (let i = 0; i < REFERRAL_CODE_LEN; i++) {
    out += CHARS[Math.floor(Math.random() * CHARS.length)];
  }
  return out;
}

/** A referral link together with its owner. */
export type ReferralLinkView = {
  id: string;
  code: string;
  ownerId: string;
  ownerEmail: string;
  clicks: number;
  conversions: number;
  isActive: boolean;
  createdAt: string;
};

/** A referred user (someone who signed up through a link). */
export type ReferredUserView = {
  id: string;
  email: string;
  referredBy: string | null;
  createdAt: string;
};

/**
 * Get (creating if necessary) the referral link owned by `userId`.
 * Every user owns exactly one link they can share to invite others.
 */
export async function getUserReferralLink(userId: string): Promise<ReferralLinkView> {
  let link = await prisma.referralLink.findUnique({
    where: { userId },
    select: {
      id: true, code: true, userId: true, clicks: true,
      conversions: true, isActive: true, createdAt: true,
      user: { select: { email: true } },
    },
  });
  if (link) {
    return mapLink(link);
  }

  // Create a fresh link with a unique short code.
  let code: string;
  let existing: { code: string } | null;
  do {
    code = generateCode();
    existing = await prisma.referralLink.findUnique({ where: { code }, select: { code: true } });
  } while (existing);

  const owner = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });
  if (!owner) throw new Error(`User ${userId} not found`);

  link = await prisma.referralLink.create({
    data: { code, userId },
    select: {
      id: true, code: true, userId: true, clicks: true,
      conversions: true, isActive: true, createdAt: true,
      user: { select: { email: true } },
    },
  });
  return mapLink(link);
}

/** Look up a referral link by its short code, with owner info. */
export async function getReferralLinkByCode(code: string): Promise<ReferralLinkView | null> {
  const link = await prisma.referralLink.findUnique({
    where: { code },
    select: {
      id: true, code: true, userId: true, clicks: true,
      conversions: true, isActive: true, createdAt: true,
      user: { select: { email: true } },
    },
  });
  if (!link) return null;
  return mapLink(link);
}

/** Increment the click counter on a link (called when /r/:code is hit). */
export async function recordReferralClick(code: string): Promise<void> {
  await prisma.referralLink.update({
    where: { code },
    data: { clicks: { increment: 1 } },
  });
}

/**
 * Validate that a referral code points at an active link.
 * Returns the link view or null.
 */
export async function validateReferral(code: string): Promise<ReferralLinkView | null> {
  const link = await getReferralLinkByCode(code);
  if (!link || !link.isActive) return null;
  return link;
}

/**
 * Attribute `userId` to the referral that brought them in.
 * Sets referredBy (referrer's code/email) + referredByLinkId (FK), and bumps
 * the link's conversion counter. Safe to call multiple times (idempotent-ish:
 * only writes when the link actually changed).
 */
export async function attributeReferral({
  userId,
  linkId,
  referrerCode,
  referrerEmail,
}: {
  userId: string;
  linkId: string;
  referrerCode: string;
  referrerEmail: string;
}): Promise<void> {
  const existing = await prisma.user.findUnique({
    where: { id: userId },
    select: { referredByLinkId: true, referredBy: true },
  });
  if (!existing) return;
  if (existing.referredByLinkId === linkId && existing.referredBy === referrerCode) {
    return; // already attributed
  }

  await prisma.$transaction([
    prisma.user.update({
      where: { id: userId },
      data: { referredBy: referrerCode, referredByLinkId: linkId },
    }),
    prisma.referralLink.update({
      where: { id: linkId },
      data: { conversions: { increment: 1 } },
    }),
  ]);
}

/**
 * Admin link-tree: the link owned by `userId` plus everyone referred through it.
 */
export async function getReferralTree(userId: string): Promise<{
  link: ReferralLinkView | null;
  referred: ReferredUserView[];
}> {
  const link = await prisma.referralLink.findUnique({
    where: { userId },
    select: {
      id: true, code: true, userId: true, clicks: true,
      conversions: true, isActive: true, createdAt: true,
      user: { select: { email: true } },
    },
  });
  const referred = await prisma.user.findMany({
    where: { referredByLinkId: link?.id ?? null },
    select: { id: true, email: true, referredBy: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });
  return {
    link: link ? mapLink(link) : null,
    referred: referred.map((u) => ({
      id: u.id,
      email: u.email,
      referredBy: u.referredBy,
      createdAt: u.createdAt.toISOString(),
    })),
  };
}

/**
 * Admin link-tree for ALL users: every link with its owner and referral stats.
 */
export async function listReferralLinks(): Promise<ReferralLinkView[]> {
  const links = await prisma.referralLink.findMany({
    select: {
      id: true, code: true, userId: true, clicks: true,
      conversions: true, isActive: true, createdAt: true,
      user: { select: { email: true } },
    },
    orderBy: { createdAt: "desc" },
  });
  return links.map(mapLink);
}

function mapLink(l: {
  id: string; code: string; userId: string; clicks: number;
  conversions: number; isActive: boolean; createdAt: Date;
  user: { email: string };
}): ReferralLinkView {
  return {
    id: l.id,
    code: l.code,
    ownerId: l.userId,
    ownerEmail: l.user.email,
    clicks: l.clicks,
    conversions: l.conversions,
    isActive: l.isActive,
    createdAt: l.createdAt.toISOString(),
  };
}
