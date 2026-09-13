import "server-only";
import { prisma } from "@/lib/prisma";
import { encryptSecret } from "@/lib/mailbox-crypto";

// The shape runTestSend (lib/deliverability.ts) needs from a seed mailbox.
export interface ResolvedSeedMailbox {
  id: string;
  label: string;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  encryptedPassword: string;
  passwordIv: string;
  passwordTag: string;
}

/**
 * Bootstrap/ensure the platform's SeedMailbox row exists.
 *
 * The test-send-confirm gate needs at least one platform-owned seed mailbox to
 * prove a customer's SMTP genuinely delivers. For v1 we keep the (single) row
 * configured via env vars — SEED_MAILBOX_HOST / _PORT / _SECURE / _USERNAME /
 * _PASSWORD / _LABEL — and upsert it here (marking it active and refreshing the
 * encrypted password whenever env changes). The door is left open for more rows
 * (or an admin UI) later; the model already supports N.
 *
 * Returns the active SeedMailbox row, or null if it isn't configured.
 */
export async function ensureSeedMailbox(): Promise<ResolvedSeedMailbox | null> {
  const host = process.env.SEED_MAILBOX_HOST;
  const username = process.env.SEED_MAILBOX_USERNAME;
  const password = process.env.SEED_MAILBOX_PASSWORD;
  if (!host || !username || !password) return null;

  const port = Number(process.env.SEED_MAILBOX_PORT ?? 993);
  const secure = String(process.env.SEED_MAILBOX_SECURE ?? "true") === "true";
  const label = process.env.SEED_MAILBOX_LABEL ?? "Deliverability seed";
  const { ciphertext, iv, tag } = encryptSecret(password);

  const row = await prisma.seedMailbox.upsert({
    where: { username },
    create: {
      label,
      host,
      port,
      username,
      encryptedPassword: ciphertext,
      passwordIv: iv,
      passwordTag: tag,
      secure,
      active: true,
    },
    update: {
      label,
      host,
      port,
      encryptedPassword: ciphertext,
      passwordIv: iv,
      passwordTag: tag,
      secure,
      active: true,
    },
  });

  return {
    id: row.id,
    label: row.label,
    host: row.host,
    port: row.port,
    secure: row.secure,
    username: row.username,
    encryptedPassword: row.encryptedPassword,
    passwordIv: row.passwordIv,
    passwordTag: row.passwordTag,
  };
}

// Task 29, item 5 — pick which seed/test mailbox a user's deliverability probe
// should target. A user who registered their OWN test account (a SeedMailbox row
// with their userId — e.g. their own Gmail, which may filter differently than the
// platform's shared seed) uses that; otherwise they keep using the platform-shared
// default exactly as today. Additive: no current user's flow changes until they
// register their own row.
export async function resolveSeedMailbox(userId: string): Promise<ResolvedSeedMailbox | null> {
  const own = await prisma.seedMailbox.findFirst({
    where: { userId, active: true },
    orderBy: { createdAt: "asc" },
  });
  if (own) {
    return {
      id: own.id,
      label: own.label,
      host: own.host,
      port: own.port,
      secure: own.secure,
      username: own.username,
      encryptedPassword: own.encryptedPassword,
      passwordIv: own.passwordIv,
      passwordTag: own.passwordTag,
    };
  }
  // No personal test mailbox → the platform default (env-bootstrapped, else any
  // active platform-shared row with userId null).
  return ensureSeedMailbox()
    ?? await prisma.seedMailbox.findFirst({
      where: { active: true, userId: null },
      select: {
        id: true, label: true, host: true, port: true, secure: true, username: true,
        encryptedPassword: true, passwordIv: true, passwordTag: true,
      },
    });
}