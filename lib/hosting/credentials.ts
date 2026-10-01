import { prisma } from "../prisma";
import { encryptSecret, decryptSecretOrThrow } from "../mailbox-crypto";
import type { HostingResult } from "./files";

// TASK_155 P2 — user-owned hosting credentials (BYO Cloudflare).
//
// The owner (2026-10-01): "option for users to add their own cf tokens and id,
// and if users add multiple like 3, we should be able to switch between them for
// hosting". So a user can store one or MORE Cloudflare credentials (account id +
// API token) and pick which one hosts. `isDefault` marks the one a request uses
// when it does not name a credential, so the simple "start with one" case is the
// default-marked single row, and the multi case needs no schema change later.
//
// SECURITY: the token is AES-256-GCM-encrypted with the existing
// MAILBOX_ENCRYPTION_KEY helpers (lib/mailbox-crypto.ts) — the exact pattern the
// SMTP passwords already use — and is NEVER returned by any route or view. The
// view carries only `tokenHint` (last 4 chars). This module is the only place
// that decrypts, and only for a server-side engine call.

export interface HostingCredentialView {
  id: string;
  provider: string;
  accountId: string;
  label: string;
  /** Non-secret hint: the last 4 chars of the token, for labelling only. */
  tokenHint: string;
  isDefault: boolean;
  status: string;
  createdAt: string;
}

type CredentialRow = {
  id: string;
  provider: string;
  accountId: string;
  label: string;
  tokenHint: string;
  isDefault: boolean;
  status: string;
  createdAt: Date;
};

export function toHostingCredentialView(row: CredentialRow): HostingCredentialView {
  return {
    id: row.id,
    provider: row.provider,
    accountId: row.accountId,
    label: row.label,
    tokenHint: row.tokenHint,
    isDefault: row.isDefault,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Last 4 characters, for a non-secret UI hint. Never stores the full token. */
function hintOf(token: string): string {
  return token.length <= 4 ? token : token.slice(-4);
}

export async function listHostingCredentials(userId: string): Promise<HostingCredentialView[]> {
  const rows = await prisma.hostingCredential.findMany({
    where: { userId, status: "active" },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
  });
  return rows.map(toHostingCredentialView);
}

export interface CreateHostingCredentialInput {
  userId: string;
  provider?: string;
  accountId: string;
  label: string;
  token: string;
}

export async function createHostingCredential(
  input: CreateHostingCredentialInput
): Promise<HostingResult<HostingCredentialView>> {
  const accountId = input.accountId.trim();
  const label = input.label.trim();
  const token = input.token.trim();
  const provider = (input.provider ?? "cloudflare").trim() || "cloudflare";

  if (!accountId) {
    return { ok: false, status: 400, code: "invalid_account", message: "Enter your Cloudflare account id." };
  }
  if (!token) {
    return { ok: false, status: 400, code: "invalid_token", message: "Enter an API token." };
  }
  if (!label) {
    return { ok: false, status: 400, code: "invalid_label", message: "Give this credential a name." };
  }

  // The FIRST credential for a provider becomes the default automatically, so the
  // single-credential case needs no extra action from the user.
  const existing = await prisma.hostingCredential.count({ where: { userId: input.userId, provider, status: "active" } });
  const { ciphertext, iv, tag } = encryptSecret(token);

  const row = await prisma.hostingCredential.create({
    data: {
      userId: input.userId,
      provider,
      accountId,
      label,
      tokenCiphertext: ciphertext,
      tokenIv: iv,
      tokenTag: tag,
      tokenHint: hintOf(token),
      isDefault: existing === 0,
    },
  });
  return { ok: true, value: toHostingCredentialView(row) };
}

export interface UpdateHostingCredentialInput {
  userId: string;
  id: string;
  accountId?: string;
  label?: string;
  /** Only sent when the user re-enters a token; absent leaves the stored one. */
  token?: string;
}

export async function updateHostingCredential(
  input: UpdateHostingCredentialInput
): Promise<HostingResult<HostingCredentialView>> {
  const row = await prisma.hostingCredential.findFirst({
    where: { id: input.id, userId: input.userId, status: "active" },
  });
  if (!row) return { ok: false, status: 404, code: "not_found", message: "Credential not found." };

  const data: Record<string, unknown> = {};
  if (input.accountId !== undefined) {
    const accountId = input.accountId.trim();
    if (!accountId) return { ok: false, status: 400, code: "invalid_account", message: "Enter your Cloudflare account id." };
    data.accountId = accountId;
  }
  if (input.label !== undefined) {
    const label = input.label.trim();
    if (!label) return { ok: false, status: 400, code: "invalid_label", message: "Give this credential a name." };
    data.label = label;
  }
  if (input.token !== undefined) {
    const token = input.token.trim();
    if (!token) return { ok: false, status: 400, code: "invalid_token", message: "Enter an API token." };
    const { ciphertext, iv, tag } = encryptSecret(token);
    data.tokenCiphertext = ciphertext;
    data.tokenIv = iv;
    data.tokenTag = tag;
    data.tokenHint = hintOf(token);
  }

  if (Object.keys(data).length === 0) return { ok: true, value: toHostingCredentialView(row) };
  const updated = await prisma.hostingCredential.update({ where: { id: row.id }, data });
  return { ok: true, value: toHostingCredentialView(updated) };
}

export async function deleteHostingCredential(userId: string, id: string): Promise<HostingResult<{ id: string }>> {
  const row = await prisma.hostingCredential.findFirst({ where: { id, userId, status: "active" } });
  if (!row) return { ok: false, status: 404, code: "not_found", message: "Credential not found." };

  await prisma.hostingCredential.update({ where: { id: row.id }, data: { status: "revoked" } });

  // If the default was revoked, promote the oldest remaining active credential
  // for that provider so a user with several never ends up default-less.
  if (row.isDefault) {
    const next = await prisma.hostingCredential.findFirst({
      where: { userId, provider: row.provider, status: "active" },
      orderBy: { createdAt: "asc" },
    });
    if (next) await prisma.hostingCredential.update({ where: { id: next.id }, data: { isDefault: true } });
  }
  return { ok: true, value: { id: row.id } };
}

/**
 * Make one credential the default, un-setting any other for the same provider in
 * the same transaction so "exactly one default" always holds.
 */
export async function setDefaultHostingCredential(
  userId: string,
  id: string
): Promise<HostingResult<HostingCredentialView>> {
  const row = await prisma.hostingCredential.findFirst({ where: { id, userId, status: "active" } });
  if (!row) return { ok: false, status: 404, code: "not_found", message: "Credential not found." };

  const [, updated] = await prisma.$transaction([
    prisma.hostingCredential.updateMany({
      where: { userId, provider: row.provider, isDefault: true, NOT: { id: row.id } },
      data: { isDefault: false },
    }),
    prisma.hostingCredential.update({ where: { id: row.id }, data: { isDefault: true } }),
  ]);
  return { ok: true, value: toHostingCredentialView(updated) };
}

export interface DecryptedCredential {
  id: string;
  accountId: string;
  token: string;
}

/**
 * The default active credential for a provider, DECRYPTED — the only function
 * that returns a usable token, and it exists for server-side engine calls only
 * (the Cloudflare P3 engine). Never wire this to a route response. Returns null
 * when the user has no credential, so the caller falls back to the platform
 * engine.
 */
export async function getDefaultHostingCredential(
  userId: string,
  provider = "cloudflare"
): Promise<DecryptedCredential | null> {
  const row = await prisma.hostingCredential.findFirst({
    where: { userId, provider, status: "active" },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
  });
  if (!row) return null;
  const token = decryptSecretOrThrow(row.tokenCiphertext, row.tokenIv, row.tokenTag, "hosting credential");
  return { id: row.id, accountId: row.accountId, token };
}

