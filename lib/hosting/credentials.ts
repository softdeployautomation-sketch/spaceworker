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
  /**
   * TASK_155 P3 — the §16.4 "last-verified stamp". ISO time of the last successful
   * `GET /user/tokens/verify`, or NULL when it has never been confirmed. A row with
   * a NULL stamp AND a `verifyError` renders red in the chooser.
   */
  lastVerifiedAt: string | null;
  /** Plain-language reason the last verify failed, or NULL when healthy. */
  verifyError: string | null;
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
  lastVerifiedAt?: Date | null;
  verifyError?: string | null;
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
    lastVerifiedAt: row.lastVerifiedAt ? row.lastVerifiedAt.toISOString() : null,
    verifyError: row.verifyError ?? null,
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

/**
 * TASK_155 P3 — a SPECIFIC active credential, decrypted, for a deploy that is
 * bound to a named account (§16.4: a project's account is immutable). Server-side
 * engine calls only; never a route response.
 */
export async function getHostingCredentialById(
  userId: string,
  id: string
): Promise<DecryptedCredential | null> {
  const row = await prisma.hostingCredential.findFirst({ where: { id, userId, status: "active" } });
  if (!row) return null;
  const token = decryptSecretOrThrow(row.tokenCiphertext, row.tokenIv, row.tokenTag, "hosting credential");
  return { id: row.id, accountId: row.accountId, token };
}

// ---------------------------------------------------------------------------
// TASK_155 P3 — verify-on-save and re-verify-on-use (§16.4).
//
// `GET /user/tokens/verify` + a cheap `GET /accounts/{id}/pages/projects?per_page=10`
// confirms the token actually WORKS before it is trusted. The result is stamped on
// the row so the chooser can show "verified 2 min ago" or a red reason — the token
// itself is never involved in the message.
//
// The verify NEVER rejects a save: a user may legitimately add an account while
// offline. It only marks the row RED, and every engine path fails CLOSED on a red
// row — there is no silent fall back to the platform account.
// ---------------------------------------------------------------------------

/** Stamp a verify outcome on a row. `error` NULL = healthy (sets lastVerifiedAt). */
export async function markHostingCredentialVerified(
  userId: string,
  id: string,
  error: string | null
): Promise<void> {
  await prisma.hostingCredential
    .update({
      where: { id },
      data: error
        ? { verifyError: error }
        : { verifyError: null, lastVerifiedAt: new Date() },
    })
    .catch(() => {});
}

/**
 * Verify one of the caller's credentials right now and stamp the result. Returns
 * the refreshed view (with the stamp) so a route can hand the row straight back to
 * the chooser. A dead token is a 200 with a red row — never a 4xx/5xx (the save
 * itself already succeeded; the user needs to SEE why it is red).
 */
export async function verifyHostingCredential(
  userId: string,
  id: string
): Promise<HostingResult<HostingCredentialView>> {
  const row = await prisma.hostingCredential.findFirst({ where: { id, userId, status: "active" } });
  if (!row) return { ok: false, status: 404, code: "not_found", message: "Credential not found." };

  let token: string;
  try {
    token = decryptSecretOrThrow(row.tokenCiphertext, row.tokenIv, row.tokenTag, "hosting credential");
  } catch {
    await markHostingCredentialVerified(userId, id, "The stored token could not be read. Re-enter it.");
    const refreshed = await prisma.hostingCredential.findFirst({ where: { id, userId } });
    return { ok: true, value: toHostingCredentialView(refreshed ?? row) };
  }

  // Lazy import so this module stays network-free at load time (the unit tests
  // drive it without a Cloudflare call unless verification is explicitly asked for).
  const { verifyCredential } = await import("./cloudflare");
  const verdict = await verifyCredential({ accountId: row.accountId, token });
  const error = verdict.ok ? null : verdict.error ?? "That API token could not be verified.";
  await markHostingCredentialVerified(userId, id, error);

  const refreshed = await prisma.hostingCredential.findFirst({ where: { id, userId } });
  return { ok: true, value: toHostingCredentialView(refreshed ?? row) };
}

/**
 * §16.4 — the chooser's per-account project count. One grouped query per user, so
 * the "smooth page" is a single round trip regardless of how many accounts exist.
 */
export async function countSitesByCredential(userId: string): Promise<Record<string, number>> {
  const grouped = await prisma.hostingSite.groupBy({
    by: ["credentialId"],
    where: { userId, credentialId: { not: null } },
    _count: { _all: true },
  });
  const out: Record<string, number> = {};
  for (const g of grouped) {
    if (g.credentialId) out[g.credentialId] = g._count._all;
  }
  return out;
}

