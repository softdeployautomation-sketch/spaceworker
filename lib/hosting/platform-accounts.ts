import { prisma } from "../prisma";
import { getAdminSettings } from "../admin-settings";
import { encryptSecret, decryptSecretOrThrow } from "../mailbox-crypto";
import type { HostingResult } from "./files";

// TASK_155 P6a (PLAN §19) — OUR Cloudflare accounts: the premium engine's
// zero-setup path.
//
// The owner (2026-10-02): "ours should be the premium, while byo should be for
// the users added cloudflare … i thought it was going to be 3 options, free
// which is the instaweb, then premium which is the cloudflare and option to add
// more to rotate at the admin, and then byo which is the users own cloudflare to
// get more."
//
// So the premium engine stops requiring the USER to paste anything. The platform
// owns one or MORE Cloudflare accounts in the admin panel; a premium deploy that
// names no credential resolves the platform roster here. This module is the only
// place that decrypts a platform token, and only for a server-side engine call.
//
// SECURITY — identical discipline to HostingCredential (P2): the token is
// AES-256-GCM encrypted with the same MAILBOX_ENCRYPTION_KEY helpers, is NEVER
// returned by any route or view, and the view carries only `tokenHint` (last 4).
//
// ROTATION (PLAN §19.2): walk the roster by ASCENDING `priority` (1 = primary),
// skipping rows that are not `status: "active"` or that already carry a
// `verifyError`; verify each candidate ON USE (§16.4 shared with BYO) and on
// failure mark it red and move to the next. When the roster is exhausted the
// caller gets a clean 403 with plain language — NEVER a silent downgrade to the
// `local` engine, and never a raw Cloudflare error.

export interface HostingPlatformAccountView {
  id: string;
  accountId: string;
  label: string;
  /** Non-secret hint: the last 4 chars of the token, for labelling only. */
  tokenHint: string;
  /** Rotation order — the healthy row with the LOWEST number serves. */
  priority: number;
  status: string;
  /** ISO time of the last successful verify, or NULL when never confirmed. */
  lastVerifiedAt: string | null;
  /** Plain-language reason the last verify failed, or NULL when healthy. */
  verifyError: string | null;
  createdAt: string;
}

type PlatformAccountRow = {
  id: string;
  accountId: string;
  label: string;
  tokenHint: string;
  priority: number;
  status: string;
  lastVerifiedAt?: Date | null;
  verifyError?: string | null;
  createdAt: Date;
};

export function toPlatformAccountView(row: PlatformAccountRow): HostingPlatformAccountView {
  return {
    id: row.id,
    accountId: row.accountId,
    label: row.label,
    tokenHint: row.tokenHint,
    priority: row.priority,
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

/** The whole roster, in rotation order — what the admin panel renders. */
export async function listPlatformAccounts(): Promise<HostingPlatformAccountView[]> {
  const rows = await prisma.hostingPlatformAccount.findMany({
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
  });
  return rows.map(toPlatformAccountView);
}

export interface CreatePlatformAccountInput {
  accountId: string;
  label: string;
  token: string;
  /** Optional explicit rotation slot; defaults to one past the current max. */
  priority?: number;
}

export async function createPlatformAccount(
  input: CreatePlatformAccountInput
): Promise<HostingResult<HostingPlatformAccountView>> {
  const accountId = input.accountId.trim();
  const label = input.label.trim();
  const token = input.token.trim();

  if (!accountId) {
    return { ok: false, status: 400, code: "invalid_account", message: "Enter the Cloudflare account id." };
  }
  if (!token) {
    return { ok: false, status: 400, code: "invalid_token", message: "Enter an API token." };
  }
  if (!label) {
    return { ok: false, status: 400, code: "invalid_label", message: "Give this account a name." };
  }

  // A new row lands at the END of the rotation unless the admin names a slot, so
  // adding a backup can never steal traffic from the current primary.
  const priority = input.priority !== undefined ? Math.trunc(input.priority) : await nextPlatformPriority();
  if (!Number.isFinite(priority) || priority < 1) {
    return { ok: false, status: 400, code: "invalid_priority", message: "Priority must be 1 or more (1 = primary)." };
  }

  const { ciphertext, iv, tag } = encryptSecret(token);
  const row = await prisma.hostingPlatformAccount.create({
    data: {
      accountId,
      label,
      tokenCiphertext: ciphertext,
      tokenIv: iv,
      tokenTag: tag,
      tokenHint: hintOf(token),
      priority,
      status: "active",
    },
  });
  return { ok: true, value: toPlatformAccountView(row) };
}

/** One past the current highest priority, so appends keep their order. */
async function nextPlatformPriority(): Promise<number> {
  const last = await prisma.hostingPlatformAccount.findFirst({ orderBy: { priority: "desc" } });
  return (last?.priority ?? 0) + 1;
}

export interface UpdatePlatformAccountInput {
  id: string;
  accountId?: string;
  label?: string;
  /** Only sent when the admin re-enters a token; absent keeps the stored one. */
  token?: string;
  priority?: number;
  /** "active" | "disabled" — disabled rows are kept, never used. */
  status?: string;
}

export async function updatePlatformAccount(
  input: UpdatePlatformAccountInput
): Promise<HostingResult<HostingPlatformAccountView>> {
  const row = await prisma.hostingPlatformAccount.findUnique({ where: { id: input.id } });
  if (!row) return { ok: false, status: 404, code: "not_found", message: "Account not found." };

  const data: Record<string, unknown> = {};
  if (input.accountId !== undefined) {
    const accountId = input.accountId.trim();
    if (!accountId) return { ok: false, status: 400, code: "invalid_account", message: "Enter the Cloudflare account id." };
    data.accountId = accountId;
  }
  if (input.label !== undefined) {
    const label = input.label.trim();
    if (!label) return { ok: false, status: 400, code: "invalid_label", message: "Give this account a name." };
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
    // A re-entered token gets a fresh chance — clear the red mark with it, or the
    // row would keep being skipped by rotation forever after being fixed.
    data.verifyError = null;
  }
  if (input.priority !== undefined) {
    const priority = Math.trunc(input.priority);
    if (!Number.isFinite(priority) || priority < 1) {
      return { ok: false, status: 400, code: "invalid_priority", message: "Priority must be 1 or more (1 = primary)." };
    }
    data.priority = priority;
  }
  if (input.status !== undefined) {
    const status = input.status.trim();
    if (status !== "active" && status !== "disabled") {
      return { ok: false, status: 400, code: "invalid_status", message: "Status must be active or disabled." };
    }
    data.status = status;
  }

  if (Object.keys(data).length === 0) return { ok: true, value: toPlatformAccountView(row) };
  const updated = await prisma.hostingPlatformAccount.update({ where: { id: row.id }, data });
  return { ok: true, value: toPlatformAccountView(updated) };
}

/**
 * Soft-remove a platform account. Sites already deployed on it keep their
 * `credentialId` = NULL (they name the PLATFORM, not the row), so removing a row
 * only changes WHICH account new deploys rotate onto — nothing is orphaned.
 */
export async function disablePlatformAccount(id: string): Promise<HostingResult<{ id: string }>> {
  const row = await prisma.hostingPlatformAccount.findUnique({ where: { id } });
  if (!row) return { ok: false, status: 404, code: "not_found", message: "Account not found." };
  await prisma.hostingPlatformAccount.update({ where: { id }, data: { status: "disabled" } });
  return { ok: true, value: { id } };
}

/** Stamp a verify outcome. `error` NULL = healthy (sets lastVerifiedAt). */
export async function markPlatformAccountVerified(id: string, error: string | null): Promise<void> {
  await prisma.hostingPlatformAccount
    .update({
      where: { id },
      data: error ? { verifyError: error } : { verifyError: null, lastVerifiedAt: new Date() },
    })
    .catch(() => {});
}
// ---------------------------------------------------------------------------
// The §19.2 resolution rule — the whole feature in one function.
// ---------------------------------------------------------------------------

export interface ResolvedPlatformCredential {
  accountId: string;
  token: string;
  /** The platform row that served, so the caller can attribute the deploy. */
  platformAccountId: string;
  label: string;
}

export type PlatformResolveResult =
  | { ok: true; value: ResolvedPlatformCredential }
  | { ok: false; code: "platform_disabled" | "platform_empty" | "platform_exhausted"; message: string };

/** The exhausted-roster message, shared so both branches read identically. */
const EXHAUSTED_MESSAGE =
  "Premium hosting is being set up right now — try again shortly, or add your own Cloudflare account.";
const SETUP_MESSAGE = "Premium hosting is being set up right now — try again shortly.";

/**
 * Is the master kill-switch on? Read on EVERY deploy so an admin can take the
 * premium engine down without a redeploy or touching a row (§19.5).
 */
export async function isPlatformEngineEnabled(): Promise<boolean> {
  const settings = await getAdminSettings();
  return settings.hostingPlatformCfEnabled !== false;
}

/**
 * Resolve the platform account for one deploy — ASCENDING priority, skipping
 * non-active and already-red rows, verifying each candidate on use and moving on
 * when it fails (PLAN §19.2 fail-CLOSED order).
 *
 * `verify` is injected so the tests can drive the real resolution + rotation
 * order with a fake verdict and no network. Production passes Cloudflare's own
 * `verifyCredential`; the call site is shared with BYO, not forked.
 */
export async function resolvePlatformCredential(
  verify: (cred: { accountId: string; token: string }) => Promise<{ ok: boolean; error?: string }>
): Promise<PlatformResolveResult> {
  if (!(await isPlatformEngineEnabled())) {
    return { ok: false, code: "platform_disabled", message: SETUP_MESSAGE };
  }

  // One query fetches the whole roster in rotation order; the loop trims it.
  const roster = await prisma.hostingPlatformAccount.findMany({
    where: { status: "active" },
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
  });
  if (roster.length === 0) {
    return { ok: false, code: "platform_empty", message: SETUP_MESSAGE };
  }

  // Rows already marked red are skipped WITHOUT a decrypt (and without a network
  // call) — that is what makes rotation cheap once an account dies.
  const candidates = roster.filter((row) => !row.verifyError);
  if (candidates.length === 0) {
    return { ok: false, code: "platform_exhausted", message: EXHAUSTED_MESSAGE };
  }

  for (const row of candidates) {
    let token: string;
    try {
      token = decryptSecretOrThrow(row.tokenCiphertext, row.tokenIv, row.tokenTag, "hosting platform account");
    } catch {
      await markPlatformAccountVerified(row.id, "The stored token could not be read. Re-enter it.");
      continue;
    }
    const verdict = await verify({ accountId: row.accountId, token });
    if (!verdict.ok) {
      await markPlatformAccountVerified(row.id, verdict.error ?? "That API token could not be verified.");
      continue;
    }
    await markPlatformAccountVerified(row.id, null);
    return {
      ok: true,
      value: { accountId: row.accountId, token, platformAccountId: row.id, label: row.label },
    };
  }

  // Every candidate was tried and every one failed: each is now marked red (above)
  // and we report the exhaustion — never a silent local fallback.
  return { ok: false, code: "platform_exhausted", message: EXHAUSTED_MESSAGE };
}

/**
 * Verify one platform account right now and stamp the result (the admin panel's
 * "Verify now"). A dead token is a 200 with a red row, never a 4xx — the row is
 * already saved, the admin just needs to SEE why.
 */
export async function verifyPlatformAccount(
  id: string
): Promise<HostingResult<HostingPlatformAccountView>> {
  const row = await prisma.hostingPlatformAccount.findUnique({ where: { id } });
  if (!row) return { ok: false, status: 404, code: "not_found", message: "Account not found." };

  let token: string;
  try {
    token = decryptSecretOrThrow(row.tokenCiphertext, row.tokenIv, row.tokenTag, "hosting platform account");
  } catch {
    await markPlatformAccountVerified(id, "The stored token could not be read. Re-enter it.");
    const refreshed = await prisma.hostingPlatformAccount.findUnique({ where: { id } });
    return { ok: true, value: toPlatformAccountView(refreshed ?? row) };
  }

  // Lazy import so this module stays network-free at load time (the unit tests
  // drive rotation with an injected verifier and never touch Cloudflare).
  const { verifyCredential } = await import("./cloudflare");
  const verdict = await verifyCredential({ accountId: row.accountId, token });
  await markPlatformAccountVerified(id, verdict.ok ? null : verdict.error ?? "That API token could not be verified.");

  const refreshed = await prisma.hostingPlatformAccount.findUnique({ where: { id } });
  return { ok: true, value: toPlatformAccountView(refreshed ?? row) };
}

/**
 * How many accounts can actually serve a premium user right now — the user-facing
 * truth behind the "Premium" option in the sites picker (§19.4). Zero means the
 * option stays disabled with an honest hint instead of failing at deploy time.
 */
export async function healthyPlatformAccountCount(): Promise<number> {
  if (!(await isPlatformEngineEnabled())) return 0;
  return prisma.hostingPlatformAccount.count({ where: { status: "active", verifyError: null } });
}