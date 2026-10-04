import { prisma } from "../prisma";
import { getAdminSettings } from "../admin-settings";
import { encryptSecret, decryptSecretOrThrow } from "../mailbox-crypto";
// TASK_155 P6c — the Workers/DNS-token helpers live with the credential module
// that owns the encryption discipline, so the roster and the BYO credential can
// never drift apart on how a second token is stored.
import { buildWorkerTokenFields, readWorkerToken, buildZoneTokenFields, readZoneToken, verifyStoredSecret } from "./credentials";
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
  // --- TASK_155 P6c — the optional Workers/DNS token, NEVER the token itself.
  /** Non-secret hint: the last 4 chars of the Workers token, or "" when unset. */
  workerTokenHint: string;
  /** True when a Workers/DNS token is stored on this row. */
  hasWorkerToken: boolean;
  /** Plain-language reason the Workers token failed, or NULL when healthy/unset. */
  workerTokenError: string | null;
  // --- TASK_158 W0 — the optional Zones token, NEVER the token itself.
  /** Non-secret hint: the last 4 chars of the Zones token, or "" when unset. */
  zoneTokenHint: string;
  /**
   * True when a Zones token is stored on this row. False is the NORMAL state —
   * it only means this account cannot auto-create zones, so custom domains stay
   * on the manual two-step path. It is never treated as a failure.
   */
  hasZoneToken: boolean;
  /** Plain-language reason the Zones token failed, or NULL when healthy/unset. */
  zoneTokenError: string | null;
  // --- TASK_157 Phase 1 — the workers.dev hostname for the FREE tier.
  /**
   * The workers.dev account subdomain we have configured (e.g. "spaceworker"),
   * or NULL when never set. Public data — it is part of the hostname — so it is
   * returned plainly; the TOKEN is the secret, not this.
   */
  workersDevSubdomain: string | null;
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
  // Present so the view can report `hasWorkerToken`; never surfaced.
  workerTokenCiphertext?: string | null;
  workerTokenHint?: string | null;
  workerTokenError?: string | null;
  // Present so the view can report `hasZoneToken`; never surfaced.
  zoneTokenCiphertext?: string | null;
  zoneTokenIv?: string | null;
  zoneTokenTag?: string | null;
  zoneTokenHint?: string | null;
  zoneTokenError?: string | null;
  // TASK_157 Phase 1 — the workers.dev account subdomain (public, not a secret).
  workersDevSubdomain?: string | null;
  createdAt: Date;
};

export function toPlatformAccountView(row: PlatformAccountRow): HostingPlatformAccountView {
  return {
    id: row.id,
    accountId: row.accountId,
    label: row.label,
    tokenHint: row.tokenHint,
    workerTokenHint: row.workerTokenHint ?? "",
    hasWorkerToken: !!row.workerTokenCiphertext && !!(row.workerTokenHint ?? ""),
    workerTokenError: row.workerTokenError ?? null,
    zoneTokenHint: row.zoneTokenHint ?? "",
    hasZoneToken: !!row.zoneTokenCiphertext && !!(row.zoneTokenHint ?? ""),
    zoneTokenError: row.zoneTokenError ?? null,
    workersDevSubdomain: row.workersDevSubdomain ?? null,
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
  /**
   * TASK_155 P6c — the optional Workers/DNS token (`Workers Scripts:Edit` +
   * `DNS:Edit`) for this account. Omitted = Pages-only, which is exactly the
   * pre-P6c behaviour.
   */
  workerToken?: string;
  /**
   * TASK_158 W0 — the optional account-scoped Zones token (zone CREATE +
   * `Zone:DNS:Edit`). Omitted = this account cannot auto-create zones, which is
   * the normal state and not an error; user domains then stay on the manual
   * two-step path.
   */
  zoneToken?: string;
  /** Optional explicit rotation slot; defaults to one past the current max. */
  priority?: number;
}

/**
 * TASK_158 W2 — re-read a freshly written row from the DATABASE and prove each
 * token that was just submitted is actually stored and readable.
 *
 * This is deliberately a SECOND query rather than a check on the object Prisma
 * returned. Prisma echoes back what we asked it to write, so asserting on that
 * object can only ever confirm our own intent — the exact illusion that made a
 * lost token look saved three times. Reading the row back is the only assertion
 * that can fail, and it is the one the owner can be shown.
 *
 * Returns a plain-language message for the FIRST token that did not land, or null
 * when every submitted token round-tripped.
 */
async function confirmTokensStored(
  id: string,
  submitted: { token?: string; workerToken?: string; zoneToken?: string }
): Promise<string | null> {
  const fresh = await prisma.hostingPlatformAccount.findUnique({ where: { id } });
  if (!fresh) {
    return "The account could not be read back after saving. Try again.";
  }
  const checks: Array<[string, string | undefined, { ciphertext: string | null; iv: string | null; tag: string | null; hint: string | null }]> = [
    ["token", submitted.token, { ciphertext: fresh.tokenCiphertext, iv: fresh.tokenIv, tag: fresh.tokenTag, hint: fresh.tokenHint }],
    [
      "workerToken",
      submitted.workerToken,
      { ciphertext: fresh.workerTokenCiphertext ?? null, iv: fresh.workerTokenIv ?? null, tag: fresh.workerTokenTag ?? null, hint: fresh.workerTokenHint ?? null },
    ],
    [
      "zoneToken",
      submitted.zoneToken,
      { ciphertext: fresh.zoneTokenCiphertext ?? null, iv: fresh.zoneTokenIv ?? null, tag: fresh.zoneTokenTag ?? null, hint: fresh.zoneTokenHint ?? null },
    ],
  ];
  for (const [field, value, stored] of checks) {
    if (value === undefined) continue; // not part of this write
    const result = verifyStoredSecret(value, stored, field);
    if (!result.ok) return result.message;
  }
  return null;
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
  // Optional second credential — `undefined` spreads to nothing, so Prisma keeps
  // the column defaults (NULL ciphertext, "" hint) = "Pages only".
  const workerFields = buildWorkerTokenFields(input.workerToken) ?? {};
  // Same deal for the third token: `undefined` spreads to nothing, so Prisma keeps
  // the column defaults (NULL ciphertext, "" hint) = "cannot create zones".
  const zoneFields = buildZoneTokenFields(input.zoneToken) ?? {};
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
      ...workerFields,
      ...zoneFields,
    },
  });
  // Prove the write before telling anyone it worked.
  const failure = await confirmTokensStored(row.id, {
    token,
    workerToken: input.workerToken,
    zoneToken: input.zoneToken,
  });
  if (failure) {
    return { ok: false, status: 500, code: "token_not_persisted", message: failure };
  }
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
  /**
   * TASK_155 P6c — the Workers/DNS token. This is the owner's REPLACE path: send
   * a new value and the stored Workers/DNS credential is swapped and its red
   * mark cleared, without touching the Pages token or the rotation order.
   */
  workerToken?: string;
  /**
   * TASK_158 W0 — the Zones token. This is the owner's REPLACE path: send a new
   * value and the stored Zones credential is swapped and its red mark cleared,
   * without touching the Pages token, the Workers token, or the rotation order.
   * An empty string is REFUSED rather than treated as "clear it", so a stray
   * space can never blank a working zone credential.
   */
  zoneToken?: string;
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
  if (input.workerToken !== undefined) {
    const workerFields = buildWorkerTokenFields(input.workerToken);
    if (!workerFields) {
      return {
        ok: false,
        status: 400,
        code: "invalid_worker_token",
        message: "Enter the Workers/DNS API token, or leave the field empty to keep the current one.",
      };
    }
    Object.assign(data, workerFields);
  }
  if (input.zoneToken !== undefined) {
    const zoneFields = buildZoneTokenFields(input.zoneToken);
    if (!zoneFields) {
      return {
        ok: false,
        status: 400,
        code: "invalid_zone_token",
        message: "Enter the Zones API token, or leave the field empty to keep the current one.",
      };
    }
    Object.assign(data, zoneFields);
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
  // TASK_158 W2 — read the row back and prove every token in THIS write landed.
  // This is the path the admin panel's "Replace token" button uses, i.e. exactly
  // the one that was reported as silently not sticking.
  const failure = await confirmTokensStored(row.id, {
    token: input.token,
    workerToken: input.workerToken,
    zoneToken: input.zoneToken,
  });
  if (failure) {
    return { ok: false, status: 500, code: "token_not_persisted", message: failure };
  }
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
  /**
   * TASK_155 P6c — the row's decrypted Workers/DNS token, or null when the
   * account is Pages-only. A link publish needs this to upload a Worker script;
   * null means "keep the local /r/<token> fallback". Server-side engine calls
   * only — never a route response, exactly like `token`.
   */
  workerToken: string | null;
  /**
   * TASK_158 W0 — the row's decrypted Zones token, or null when this account has
   * none. This is the credential that can actually CREATE a zone, which nothing
   * else in the roster can do. Null is normal (it is the state of every account
   * today) and callers fall back to the manual two-step path rather than
   * failing. Server-side engine calls only — never a route response, exactly
   * like `token` and `workerToken`.
   */
  zoneToken: string | null;
}

export type PlatformResolveResult =
  | { ok: true; value: ResolvedPlatformCredential }
  | {
      ok: false;
      /**
       * TASK_157 Phase 2 — `pinned_account_missing` / `pinned_account_unavailable`
       * mean an admin PINNED this purpose to one Cloudflare account and that
       * account could not serve it. They are deliberately NOT folded into
       * `platform_exhausted`: that message tells the user to "add your own
       * Cloudflare account", which is useless advice for an operator whose own
       * account is merely disabled or red. The admin is the one who can fix this,
       * and the message says so.
       */
      code:
        | "platform_disabled"
        | "platform_empty"
        | "platform_exhausted"
        | "pinned_account_missing"
        | "pinned_account_unavailable";
      message: string;
    };

/** The exhausted-roster message, shared so both branches read identically. */
const EXHAUSTED_MESSAGE =
  "Premium hosting is being set up right now — try again shortly, or add your own Cloudflare account.";
const SETUP_MESSAGE = "Premium hosting is being set up right now — try again shortly.";

/**
 * TASK_157 Phase 2 — pin-failure messages. Both are ADMIN-facing on purpose: the
 * user cannot fix a pinned account, so they must not be told to go add their own
 * Cloudflare account the way `EXHAUSTED_MESSAGE` does. Phrased as "try again
 * shortly" rather than naming the account id, which is infrastructure detail the
 * end user has no way to act on.
 */
const PIN_MISSING_MESSAGE =
  "Premium hosting is being set up right now — try again shortly.";
const PIN_DISABLED_MESSAGE =
  "Premium hosting is being set up right now — try again shortly.";

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
  verify: (cred: { accountId: string; token: string }) => Promise<{ ok: boolean; error?: string }>,
  /**
   * TASK_155 P6c — the Workers engine needs a token that can publish a SCRIPT, which
   * is a different permission set from the Pages token these rows already carry.
   * When set, rows with no encrypted Workers token are skipped during rotation
   * instead of being picked and failing the publish: a roster where row A is
   * Pages-only and row B has a Workers token must resolve to B, not to A. Default
   * (omitted) keeps the Pages behaviour byte-for-byte unchanged.
   *
   * TASK_157 Phase 2 — `pinAccountId` narrows rotation to ONE Cloudflare account,
   * chosen by an AdminSetting rather than by priority. Omitted/empty = today's
   * ascending-priority rotation, unchanged.
   *
   * A pin is a HARD constraint, not a preference: if the pinned account is
   * missing, disabled, red or fails to verify, this returns
   * `pinned_account_missing`/`pinned_account_unavailable` and NEVER rotates on to
   * the next row. That is the entire point. The owner is running a dedicated
   * Cloudflare account purely for premium links, and if it falls over the only
   * acceptable outcomes are "fail and tell the admin" or "serve the links from
   * the pinned account" — publishing them to some other account instead would
   * put premium links on the free account's subdomain, which is the exact
   * mixing-up the pin exists to prevent.
   */
  opts: { requireWorkerToken?: boolean; requireZoneToken?: boolean; pinAccountId?: string | null } = {}
): Promise<PlatformResolveResult> {
  if (!(await isPlatformEngineEnabled())) {
    return { ok: false, code: "platform_disabled", message: SETUP_MESSAGE };
  }

  // A pin is matched on the Cloudflare ACCOUNT ID, not the row id, so the setting
  // survives deleting and re-adding a roster row. The `status: "active"` filter is
  // deliberately NOT applied when pinned: a disabled row must be REPORTED as
  // unavailable, not silently omitted so the query returns nothing.
  const pin = opts.pinAccountId?.trim() || null;
  const roster = await prisma.hostingPlatformAccount.findMany({
    where: pin ? { accountId: pin } : { status: "active" },
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
  });
  if (roster.length === 0) {
    return pin
      ? { ok: false, code: "pinned_account_missing", message: PIN_MISSING_MESSAGE }
      : { ok: false, code: "platform_empty", message: SETUP_MESSAGE };
  }
  if (pin && roster[0].status !== "active") {
    return { ok: false, code: "pinned_account_unavailable", message: PIN_DISABLED_MESSAGE };
  }

  /**
   * The one place a "nothing usable" outcome is reported. With a pin, that is a
   * PIN failure and must carry the pin code + admin-facing message; without one it
   * stays today's `platform_exhausted`. Routing every sub-case through this
   * closure is what stops a pinned account from being misreported as a general
   * outage (which would send the user off to add their own Cloudflare account).
   */
  const nothingUsable = (): PlatformResolveResult =>
    pin
      ? { ok: false, code: "pinned_account_unavailable", message: PIN_DISABLED_MESSAGE }
      : { ok: false, code: "platform_exhausted", message: EXHAUSTED_MESSAGE };

  // Rows already marked red are skipped WITHOUT a decrypt (and without a network
  // call) — that is what makes rotation cheap once an account dies.
  const candidates = roster.filter((row) => !row.verifyError);
  if (candidates.length === 0) {
    return nothingUsable();
  }

  // Pages-only rows are dropped ONLY for a Workers publish, and they are dropped
  // without a decrypt or a network call — same cheapness as the red-row skip above.
  // Falling through to an empty list reports `platform_exhausted`, whose message
  // already tells the user to add their own account, so no new error code is needed.
  //
  // TASK_158 W1 — `requireZoneToken` is the same idea for the one capability with
  // its own dedicated slot: creating a ZONE. It drops rows with no Zones token for
  // exactly the same reason (a row that would fail the call must never be chosen
  // over one that can serve it), and it is checked INDEPENDENTLY of the Workers
  // filter so a caller can ask for either, both, or neither.
  const usable = candidates
    .filter((row) => (opts.requireWorkerToken ? !!row.workerTokenCiphertext : true))
    .filter((row) => (opts.requireZoneToken ? !!row.zoneTokenCiphertext : true));
  if (usable.length === 0) {
    return nothingUsable();
  }

  for (const row of usable) {
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
      value: {
        accountId: row.accountId,
        token,
        platformAccountId: row.id,
        label: row.label,
        workerToken: readWorkerToken(row),
        zoneToken: readZoneToken(row),
      },
    };
  }

  // Every candidate was tried and every one failed: each is now marked red (above)
  // and we report the exhaustion — never a silent local fallback. A pin that got
  // this far means its account's own token failed verification.
  return nothingUsable();
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

// ---------------------------------------------------------------------------
// TASK_157 Phase 1 — the workers.dev account subdomain, from the admin panel.
//
// WHY THIS EXISTS: the FREE tier needs a real hostname that costs nothing, needs
// no domain, no zone and no registrar action. Cloudflare gives exactly that at
// `<worker>.<account-subdomain>.workers.dev` — but the middle label is an
// ACCOUNT-level setting, chosen once and shared by every Worker in the account.
// The owner asked for it by name: "rename the workers subdomain to be something
// like documents.workers.dev ... and can it be automated in the admin to change
// the name". So it is a first-class admin action, not a manual dashboard chore.
//
// BLAST RADIUS: renaming re-points EVERY Worker in the account at once. There is
// no per-Worker override. The route therefore warns before saving and requires
// the availability check to pass — claiming a name Cloudflare rejects would leave
// the account half-configured, and every free link would 404 at the edge.
//
// The subdomain is PUBLIC (it is literally in the hostname) so it is stored and
// returned plainly. The TOKEN stays decrypt-on-the-fly, never returned.
// ---------------------------------------------------------------------------

export interface WorkersDevSubdomainState {
  /** What WE have configured on this row, or null when never set here. */
  configured: string | null;
  /** What Cloudflare reports for the account right now, or null if unset/unknown. */
  live: string | null;
  /** True when the row has no Workers token, so we cannot read or change this. */
  needsWorkerToken: boolean;
}

/**
 * Read the subdomain state for one account WITHOUT changing anything.
 *
 * `configured` comes from our own row (so the panel can show what we set even if
 * the live read fails); `live` comes from Cloudflare (the authority). Showing
 * both means an out-of-band dashboard rename is visible instead of silently
 * disagreeing with what the panel claims.
 */
export async function getWorkersDevSubdomainState(
  id: string
): Promise<HostingResult<WorkersDevSubdomainState>> {
  const row = await prisma.hostingPlatformAccount.findUnique({ where: { id } });
  if (!row) return { ok: false, status: 404, code: "not_found", message: "Account not found." };

  const configured = row.workersDevSubdomain ?? null;

  const workerToken = readWorkerToken(row);
  if (!workerToken) {
    // Pages-only row: honest empty state rather than an error — the admin simply
    // has not given us a Workers token yet.
    return { ok: true, value: { configured, live: null, needsWorkerToken: true } };
  }

  // Lazy import keeps this module network-free at load time, exactly like
  // verifyPlatformAccount above.
  const { getWorkersDevSubdomain } = await import("./workers");
  const res = await getWorkersDevSubdomain({ accountId: row.accountId, token: workerToken });
  const live = res.ok ? (res.value?.subdomain ?? null) : null;

  return { ok: true, value: { configured, live, needsWorkerToken: false } };
}

export interface SetWorkersDevSubdomainResult {
  subdomain: string;
  /** True when the account already answered on this name, so nothing changed. */
  unchanged: boolean;
}

/**
 * Claim (or rename to) the workers.dev subdomain, then stamp the row.
 *
 * ORDER IS LOAD-BEARING, the same discipline as the Worker publish path:
 *   1. read + decrypt the Workers token — no token, no subdomain, refuse clearly
 *   2. validate the NAME locally — a dot or a leading dash is rejected before the
 *      network call, so the admin gets an instant, specific message
 *   3. check availability with Cloudflare — never attempt a name that is taken
 *   4. only then PUT, and stamp the row with what Cloudflare confirms
 *
 * Step 3 is not optional: Cloudflare's namespace is global across every account,
 * so a plausible-looking name like `documents` or `securefile` is almost always
 * gone. Failing at step 3 produces "that name is taken, try another"; skipping it
 * produces a confusing provider error at step 4.
 */
export async function setAccountWorkersDevSubdomain(
  id: string,
  subdomain: string
): Promise<HostingResult<SetWorkersDevSubdomainResult>> {
  const row = await prisma.hostingPlatformAccount.findUnique({ where: { id } });
  if (!row) return { ok: false, status: 404, code: "not_found", message: "Account not found." };

  const workerToken = readWorkerToken(row);
  if (!workerToken) {
    return {
      ok: false,
      status: 409,
      code: "no_worker_token",
      message:
        "Add a Workers/DNS token to this account first — it is needed to read and change the workers.dev subdomain.",
    };
  }

  const { isValidAccountSubdomain } = await import("./domains");
  const name = subdomain.trim().toLowerCase();
  if (!isValidAccountSubdomain(name)) {
    return {
      ok: false,
      status: 400,
      code: "invalid_subdomain",
      message:
        "Use one DNS label: letters, digits and dashes only — no dots, and it cannot start or end with a dash.",
    };
  }

  const cred = { accountId: row.accountId, token: workerToken };
  // Lazy import, same reason as getWorkersDevSubdomainState above.
  const { checkWorkersDevSubdomain, planWorkersDevSubdomainChange } = await import("./workers");

  const check = await checkWorkersDevSubdomain(cred, name);
  if (!check.ok) {
    return {
      ok: false,
      status: check.status || 502,
      code: "cf_unreachable",
      message: check.error ?? "Could not reach Cloudflare — try again.",
    };
  }

  // The decision is a PURE function in workers.ts so the create-only PUT can be
  // proven unnecessary for a pre-claimed name — see planWorkersDevSubdomainChange.
  const plan = planWorkersDevSubdomainChange(
    {
      available: check.value?.available === true,
      current: check.value?.current === true,
      message: check.value?.message,
    },
    row.workersDevSubdomain,
    name
  );

  if (plan.kind === "taken") {
    return {
      ok: false,
      status: 409,
      code: "subdomain_taken",
      // Prefer Cloudflare's own wording, exactly like the BYO verifier does.
      message: plan.message ?? `"${name}" is already taken. Try another name.`,
    };
  }
  if (plan.kind === "noop") {
    return { ok: true, value: { subdomain: name, unchanged: true } };
  }
  if (plan.kind === "stamp") {
    await prisma.hostingPlatformAccount.update({
      where: { id },
      data: { workersDevSubdomain: name },
    });
    // `unchanged: false` because OUR state did change — we went from not knowing
    // the subdomain to knowing it. Cloudflare's configuration is untouched.
    return { ok: true, value: { subdomain: name, unchanged: false } };
  }

  // plan.kind === "claim" — the only branch that touches Cloudflare.
  const { setWorkersDevSubdomain } = await import("./workers");
  const saved = await setWorkersDevSubdomain(cred, name);
  if (!saved.ok) {
    return {
      ok: false,
      status: saved.status || 502,
      code: "cf_rejected",
      message: saved.error ?? "Cloudflare refused that subdomain.",
    };
  }

  const confirmed = saved.value?.subdomain ?? name;
  await prisma.hostingPlatformAccount.update({
    where: { id },
    data: { workersDevSubdomain: confirmed },
  });
  return { ok: true, value: { subdomain: confirmed, unchanged: false } };
}