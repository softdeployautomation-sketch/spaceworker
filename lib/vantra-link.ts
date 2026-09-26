import "server-only";

import crypto from "node:crypto";

import { db } from "./db";
import { env } from "./env";
import { getAdminSettings } from "./admin-settings";
import { hasEntitlement } from "./entitlements";
import { recordAgentActionAudit } from "./devices";
import { notifyPendingActionViaTelegram } from "./agent-approval-notify";
import {
  executePinRequest,
  startMaintenanceOverlayAction,
  stopMaintenanceOverlayAction,
  type MeshUrlsView,
} from "./device-tools";

// Task 93 — the Vantra plugin provisioning + device-action service.
//
// ENV (server-side only, NEVER committed / NEVER rsynced — HOW_WE_MOVE_FAST §2):
//   VANTRA_INTERNAL_TOKEN — bearer for Vantra's /api/internal/sw/* routes.
//     Added to /opt/spaceworker/.env BY HAND over ssh (and the SAME value as
//     SW_INTERNAL_TOKEN in /opt/vantra/.env). Deploys must never clobber it
//     (rsync --exclude='.env' is mandatory).
//   VANTRA_INTERNAL_URL   — Vantra's private base URL
//     (default https://vantra.spaceworker.top).
//
// Every mutating path is entitlement-gated ("assistant"), admin-settings-gated
// (vantraLinks* / deviceActions* — CROSS-TRACK RULE 7), and audited through
// the shared Task 92 layer (recordAgentActionAudit / DeviceAction).

const VANTRA_URL =
  process.env.VANTRA_INTERNAL_URL?.replace(/\/$/, "") || "https://vantra.spaceworker.top";

function swHeaders(): Record<string, string> {
  const token = process.env.VANTRA_INTERNAL_TOKEN;
  // Fail closed: a missing token throws here rather than ever calling Vantra
  // unauthenticated (mirrors lib/internal-auth.ts's posture, inverted).
  if (!token || token.trim().length === 0) {
    throw new Error("vantra_not_configured");
  }
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
}

async function vantraFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${VANTRA_URL}${path}`, {
    ...init,
    headers: { ...swHeaders(), ...(init?.headers ?? {}) },
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`vantra_${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

export interface VantraLinkView {
  id: string;
  orgId: string;
  orgName: string;
  status: string;
  installUrl: string | null;
  installTokenExpiresAt: Date | null;
  lastSyncedAt: Date | null;
  lastError: string | null;
  // Tier model (2026-10 console follow-up): the Add-a-device panel's
  // Public/Private toggle reads these. `privateAllowed` is the premium/admin
  // gate ("devices" entitlement — tier 5 covers it); `privateOrgId` is set
  // once the private companion org is provisioned in Vantra.
  orgTier: string;
  privateAllowed: boolean;
  privateOrgId: string | null;
  privatePsCommand: string | null;
  privatePsExpiresAt: Date | null;
  // TASK_122 (B11) D3 — the artifact kind must be visible on the view so the
  // console can show "this link is a ZIP named X" instead of a silent drop
  // to the legacy exe. `installerNames` is parsed from `installerNamesJson`
  // DEFENSIVELY (malformed JSON on the row -> null, never a throw — a bad
  // row must not break the panel). Deliberately NOT included here:
  // `installerUrl` — the raw generator/agent URL stays server-only and must
  // never leave this module in a view, a response, a log line or an audit
  // row (TASK_121 §6 item 4, unchanged by this task).
  installerKind: "zip" | "exe" | null;
  installerNames: InstallerNames | null;
}

function toView(
  link: {
    id: string; orgId: string; orgName: string; status: string;
    installUrl: string | null; installTokenExpiresAt: Date | null;
    lastSyncedAt: Date | null; lastError: string | null;
    orgTier: string; privateOrgId: string | null;
    privatePsCommand: string | null; privatePsExpiresAt: Date | null;
    installerKind?: string | null; installerNamesJson?: string | null;
  },
  privateAllowed = false,
): VantraLinkView {
  return {
    id: link.id,
    orgId: link.orgId,
    orgName: link.orgName,
    status: link.status,
    installUrl: link.installUrl,
    installTokenExpiresAt: link.installTokenExpiresAt,
    lastSyncedAt: link.lastSyncedAt,
    lastError: link.lastError,
    orgTier: link.orgTier,
    privateAllowed,
    privateOrgId: link.privateOrgId,
    privatePsCommand: link.privatePsCommand,
    privatePsExpiresAt: link.privatePsExpiresAt,
    installerKind: link.installerKind === "zip" || link.installerKind === "exe" ? link.installerKind : null,
    installerNames: parseStoredInstallerNames(link.installerNamesJson ?? null) ?? null,
  };
}

async function isPrivateAllowed(userId: string): Promise<boolean> {
  return (await hasEntitlement(userId, "devices")).allowed;
}

/**
 * Read-only dual-tier view (no provisioning): the device-list and console
 * panels call this instead of ensureVantraLink so a render never mints an
 * org as a side effect. `privateAllowed` reflects the live entitlement.
 */
export async function getVantraLinkView(userId: string): Promise<VantraLinkView | null> {
  const link = await db.vantraLink.findUnique({ where: { userId } });
  if (!link || link.status === "revoked") return null;
  return toView(link, await isPrivateAllowed(userId));
}

/**
 * Idempotent provisioning (TASK_93 acceptance: exactly one link + org per
 * user). Checks: "assistant" entitlement (C1 — capabilities, never tiers),
 * admin settings (vantraLinksEnabled + vantraLinksMax live count). The
 * Vantra side is itself idempotent by org name `sw-<userId>`.
 */
export async function ensureVantraLink(userId: string): Promise<VantraLinkView> {
  const existing = await db.vantraLink.findUnique({ where: { userId } });
  if (existing && existing.status !== "error") {
    return toView(existing, await isPrivateAllowed(userId));
  }

  const decision = await hasEntitlement(userId, "assistant");
  if (!decision.allowed) throw new Error("entitlement_required");

  const settings = await getAdminSettings();
  if (!settings.vantraLinksEnabled) throw new Error("vantra_links_disabled");
  if (!existing) {
    const count = await db.vantraLink.count({ where: { status: { not: "revoked" } } });
    if (count >= settings.vantraLinksMax) throw new Error("vantra_links_limit");
  }

  const provisioned = await vantraFetch<{
    ok: boolean; org: { id: string; name: string; agentDomainTier?: string };
  }>("/api/internal/sw/orgs", { method: "POST", body: JSON.stringify({ swUserId: userId }) });

  const link = await db.vantraLink.upsert({
    where: { userId },
    update: {
      orgId: provisioned.org.id,
      orgName: provisioned.org.name,
      status: "pending_install",
      lastError: null,
    },
    create: {
      userId,
      orgId: provisioned.org.id,
      orgName: provisioned.org.name,
      status: "pending_install",
    },
  });
  await recordAgentActionAudit({
    userId,
    action: "vantra_link_provisioned",
    status: "executed",
    initiatingChannel: "system",
    detail: { orgId: link.orgId, orgName: link.orgName },
  });
  return toView(link, await isPrivateAllowed(userId));
}

/**
 * Private-tier companion org (`sw-<userId>-p` in Vantra) — the premium side
 * of the tier model. Gated on the "devices" entitlement (premium tier 5
 * covers it; free/trial users are 403'd — they get the public agent only).
 * Idempotent: Vantra keys the org by its deterministic name, repeat calls
 * return the same org. The companion is what the Add-a-device Private tab
 * installs against AND where devices added via the public link silently
 * auto-move (Vantra Task 64), so the public domain never manages devices.
 */
export async function ensurePrivateOrg(userId: string): Promise<VantraLinkView> {
  const link = await db.vantraLink.findUnique({ where: { userId } });
  if (!link || link.status === "revoked") throw new Error("no_link");
  if (!(await isPrivateAllowed(userId))) throw new Error("private_not_granted");

  const provisioned = await vantraFetch<{ ok: boolean; org: { id: string; name: string } }>(
    "/api/internal/sw/orgs",
    { method: "POST", body: JSON.stringify({ swUserId: userId, private: true }) },
  );
  const updated = await db.vantraLink.update({
    where: { id: link.id },
    data: { privateOrgId: provisioned.org.id },
  });
  await recordAgentActionAudit({
    userId,
    action: "vantra_private_org_provisioned",
    status: "executed",
    detail: { orgId: provisioned.org.id },
  });
  return toView(updated, true);
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

// ============================================================================
// Task 121 (OOB-13) — the public install artifact (Vantra's launcher ZIP).
//
// SpaceWorker could always ask Vantra only for a *link*, never for the artifact
// Vantra's own Add-a-device flow hands out. The three optional names below are
// forwarded to Vantra's internal install-link route, which mints the launcher
// ZIP with them; its own route sanitises again, so the rule is mirrored here
// (not invented) and a bad value is dropped on BOTH sides.
// ============================================================================

/** The optional renameable names of the launcher ZIP. */
export interface InstallerNames {
  /** The downloaded file's name (generator default `Agent.zip`). */
  zipName?: string;
  /** The shortcut inside the ZIP, WITHOUT ".lnk" — the generator appends it
   *  (default `Update.lnk`). */
  updateLinkName?: string;
  /** The subfolder holding launcher + payload (default `launcher`). */
  innerFolder?: string;
}

// Bare-name rule — the SAME rule as Vantra's FIX 3 gate
// (app/api/devices/deployments/route.ts:41-43 + lib/zip-generator.ts:52-57):
// ≤64 chars, no `/ \ "`, no control chars, no "..". A blank or invalid value is
// DROPPED (never sent as an empty string) so the generator default applies and
// a typo can never block an install.
const INVALID_ARTIFACT_NAME = /[/\\"\u0000-\u001f]/;

/** Validated bare name, or undefined when blank/invalid (never a throw). */
export function safeInstallerName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 64) return undefined;
  if (INVALID_ARTIFACT_NAME.test(trimmed) || trimmed.includes("..")) return undefined;
  return trimmed;
}

function sanitizeInstallerNames(names: InstallerNames): InstallerNames {
  const clean: InstallerNames = {};
  const zipName = safeInstallerName(names.zipName);
  if (zipName) clean.zipName = zipName;
  const updateLinkName = safeInstallerName(names.updateLinkName);
  if (updateLinkName) clean.updateLinkName = updateLinkName;
  const innerFolder = safeInstallerName(names.innerFolder);
  if (innerFolder) clean.innerFolder = innerFolder;
  return clean;
}

// ============================================================================
// TASK_125 — the optional install-guide PDF (Vantra's Task 77/78 "FIX 5").
//
// TASK_121 wired the three NAMES through to Vantra's launcher ZIP but
// deliberately left the guide PDF out of scope — so the capability existed in
// Vantra's own Add-a-device modal and on the `sw-` route's generator call, and
// was simply unreachable from here (TASK_121 §2 item 3 said so in as many
// words). This adds it to the same frozen `installer` block:
//   `{ installer: { kind: "zip", …, pdf, pdfName?, pdfDelaySec? } }`
//
// WHERE THE BYTES LIVE: nowhere on our side. They are forwarded in the request
// body and never written to the row, never put in a view, never logged
// (TASK_78 §rules: no DB/file storage, no separate public PDF URL — the PDF
// rides INSIDE the zip and is served through the same masked link + TTL as the
// zip itself). Only the three small names are remembered in
// `installerNamesJson`; there is no `pdf` key in that JSON, by construction
// (`installerRequest` returns `names` separately from the forwarded block) and
// asserted in tests/vantra-link-installer.test.ts.
//
// This is the LOUD gate: unlike a typo'd name (dropped, never fatal), a PDF
// the user explicitly picked must never be silently discarded, so an unusable
// one is a 400/413. Vantra's `parseInstaller` then drops it defensively — the
// same two-layer shape the names already use.
// ============================================================================

/** 20 MB of DECODED bytes — the reference route's and generator's ceiling. */
export const MAX_INSTALLER_PDF_BYTES = 20 * 1024 * 1024;

/** Bare `*.pdf` entry-name rule — `:` too, for the Windows drive trap. */
const INVALID_PDF_NAME = /[/\\:"\u0000-\u001f]/;

/** Base64 alphabet (with optional `=` padding) — validates without decoding. */
const BASE64_ONLY = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * The optional install-guide PDF as it is forwarded to Vantra's generator.
 * `pdf` is exactly what the caller sent (a `data:application/pdf;base64,…`
 * URL or raw base64) and is what the generator expects.
 */
export interface InstallerPdf {
  pdf: string;
  pdfName?: string;
  pdfDelaySec?: number;
}

export type InstallerPdfError =
  | "invalid_pdf"
  | "pdf_too_large"
  | "invalid_pdf_name"
  | "invalid_pdf_delay"
  | "pdf_name_without_pdf";

/**
 * Validates the optional PDF fields of a request body. Mirrors Vantra's
 * reference `validateZipPdfFields` (magic `%PDF`, ≤20 MB decoded, bare `*.pdf`
 * name, 0–120 s delay) so the same request is accepted or refused on both
 * sides of the wire. Returns `{ ok: true, pdf: null }` when no PDF was
 * attached — the caller then sends a body with no `pdf*` key at all, which is
 * what keeps that request byte-identical.
 *
 * Cheap on purpose: the `%PDF` magic comes from the first 8 base64 characters
 * (→ 6 bytes) and the decoded size is derived by length arithmetic, so a 27 MB
 * string is never decoded here. The generator remains the final authority on
 * the actual bytes it unpacks into the zip.
 */
export function validateInstallerPdf(input: {
  pdf?: unknown;
  pdfName?: unknown;
  pdfDelaySec?: unknown;
}): { ok: true; pdf: InstallerPdf | null } | { ok: false; code: InstallerPdfError } {
  const raw = typeof input.pdf === "string" ? input.pdf.trim() : "";
  const rawName = typeof input.pdfName === "string" ? input.pdfName.trim() : "";
  // A blank string is ABSENT, exactly as `safePdfDelay` reads it on Vantra's
  // side — both gates must agree on which requests are acceptable, or a
  // request accepted here could be silently dropped there.
  const rawDelay = input.pdfDelaySec;
  const hasDelay =
    rawDelay !== undefined &&
    rawDelay !== null &&
    !(typeof rawDelay === "string" && rawDelay.trim() === "");

  // A delay is only meaningful alongside a PDF — refuse it on its own rather
  // than silently ignoring what the caller asked for (same rule, same intent
  // as the reference route's `pdfName/pdfDelaySec require a pdf`).
  if (!raw) {
    if (rawName || hasDelay) return { ok: false, code: "pdf_name_without_pdf" };
    return { ok: true, pdf: null };
  }

  const b64 = (raw.startsWith("data:") ? raw.replace(/^data:[^;]+;base64,/, "") : raw)
    .replace(/\s+/g, "");
  if (b64.length < 8 || !BASE64_ONLY.test(b64)) return { ok: false, code: "invalid_pdf" };
  // 4 base64 chars ⇒ 3 bytes; round UP so the ceiling can never be slipped.
  if (Math.ceil((b64.length * 3) / 4) > MAX_INSTALLER_PDF_BYTES) {
    return { ok: false, code: "pdf_too_large" };
  }
  const head = Buffer.from(b64.slice(0, 8), "base64").toString("latin1");
  if (head.length < 4 || head.slice(0, 4) !== "%PDF") {
    return { ok: false, code: "invalid_pdf" };
  }

  const pdf: InstallerPdf = { pdf: raw };
  if (rawName) {
    if (
      !/\.pdf$/i.test(rawName) ||
      INVALID_PDF_NAME.test(rawName) ||
      rawName.includes("..") ||
      rawName.length > 64
    ) {
      return { ok: false, code: "invalid_pdf_name" };
    }
    pdf.pdfName = rawName;
  }
  if (hasDelay) {
    const value = input.pdfDelaySec;
    // Explicit guards: `Number(null)` is 0, so a bare coercion would turn
    // "nothing specified" into "open immediately".
    let n: number;
    if (typeof value === "number") n = value;
    else if (typeof value === "string" && value.trim() !== "") n = Number(value);
    else return { ok: false, code: "invalid_pdf_delay" };
    if (!Number.isFinite(n) || n < 0 || n > 120) {
      return { ok: false, code: "invalid_pdf_delay" };
    }
    pdf.pdfDelaySec = Math.floor(n);
  }
  return { ok: true, pdf };
}

/**
 * The POST body for Vantra's install-link route, plus the clean names to
 * remember on the row.
 *   `names === undefined && !pdf` → today's body, exactly `{}` (the existing
 *     raw-exe branch) — byte-identical, and the documented rollback (§7).
 *   `names` provided (even `{}`), or a `pdf` → `{installer:{kind:"zip"}}`:
 *     the launcher ZIP, with the generator's defaults wherever a name is
 *     blank/invalid (§4, D3), plus TASK_125's optional guide PDF.
 *
 * The returned `names` NEVER carry the PDF — the three artifact names are the
 * only thing the caller persists (see the TASK_125 block above).
 */
function installerRequest(
  names: InstallerNames | undefined,
  pdf?: InstallerPdf | null,
): {
  body: string;
  names?: InstallerNames;
} {
  if (names === undefined && !pdf) return { body: "{}" };
  const clean = names === undefined ? {} : sanitizeInstallerNames(names);
  const block: Record<string, unknown> = { kind: "zip", ...clean };
  if (pdf) {
    // Forwarded verbatim — already validated by `validateInstallerPdf`, and
    // sanitised once more here so a caller that skips the route cannot put a
    // path-like name on the wire (the same "mirror the rule, don't invent it"
    // posture `sanitizeInstallerNames` has).
    block.pdf = pdf.pdf;
    const pdfName = sanitizePdfName(pdf.pdfName);
    if (pdfName) block.pdfName = pdfName;
    if (pdf.pdfDelaySec !== undefined) block.pdfDelaySec = pdf.pdfDelaySec;
  }
  return { body: JSON.stringify({ installer: block }), names: clean };
}

/**
 * The bare `*.pdf` rule again, at the door of the outbound body: anything that
 * is not a valid PDF entry name is DROPPED (never sent), so the generator's
 * `guide.pdf` default applies instead. `validateInstallerPdf` has already
 * refused this case with a 400 — this is the second layer, matching
 * `sanitizeInstallerNames`.
 */
function sanitizePdfName(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const s = value.trim();
  if (!s || !/\.pdf$/i.test(s)) return undefined;
  if (INVALID_PDF_NAME.test(s) || s.includes("..") || s.length > 64) return undefined;
  return s;
}

/** Reads the names remembered at mint time. `null`/garbage ⇒ today's exe path. */
function parseStoredInstallerNames(json: string | null): InstallerNames | undefined {
  if (!json) return undefined;
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return sanitizeInstallerNames(parsed as InstallerNames);
  } catch {
    return undefined;
  }
}

/**
 * Install assets, per tier (2026-10 console follow-up):
 *   kind "public"  → one-time wrapper link /link/vantra/<token> (the panel
 *                    shows ONLY that path — never the agent host). Devices
 *                    added through it auto-move into the private companion.
 *   kind "private" → PowerShell install command baked against the private
 *                    companion org's API base (premium, admin-granted).
 * Both expire in 72h; re-mint any time.
 *
 * Task 121 (OOB-13) adds the optional third argument:
 *   names omitted            → the public artifact is today's raw exe and the
 *                              request body is exactly `{}` (byte-identical).
 *   names given (even `{}`)  → the public artifact is Vantra's launcher ZIP,
 *                              named by the user, and the minted URL + names
 *                              are remembered on the row (§4a) so opening the
 *                              link is a redirect, not another generator call.
 * TASK_125 adds the optional fourth argument, the install-guide PDF:
 *   pdf given                → the same launcher ZIP, with the guide PDF riding
 *                              inside it and opening right after install. The
 *                              bytes are FORWARDED ONLY — never persisted
 *                              (there is deliberately no `pdf` key in
 *                              `installerNamesJson`).
 * Both are for the public tier only; the private tier never takes the
 * installer block (D1/D2 — out of scope).
 */
export async function mintInstallLink(
  userId: string,
  kind: "public" | "private" = "public",
  names?: InstallerNames,
  pdf?: InstallerPdf | null,
): Promise<VantraLinkView> {
  const link = await db.vantraLink.findUnique({ where: { userId } });
  if (!link || link.status === "revoked") throw new Error("no_link");

  if (kind === "private") {
    if (!(await isPrivateAllowed(userId))) throw new Error("private_not_granted");
    // Provision the companion on first use, then mint against IT.
    const privOrgId =
      link.privateOrgId ?? (await ensurePrivateOrg(userId)).privateOrgId;
    if (!privOrgId) throw new Error("private_not_provisioned");

    const minted = await vantraFetch<{ ok: boolean; command: string }>(
      `/api/internal/sw/orgs/${privOrgId}/install-link`,
      { method: "POST", body: "{}" },
    );
    const updated = await db.vantraLink.update({
      where: { id: link.id },
      data: {
        privateOrgId: privOrgId,
        privatePsCommand: minted.command,
        privatePsExpiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
        lastError: null,
      },
    });
    await recordAgentActionAudit({
      userId,
      action: "vantra_private_install_minted",
      status: "executed",
      detail: { orgId: privOrgId },
    });
    return toView(updated, true);
  }

  // Task 121 — the public artifact. `installer.body` is `{}` when the caller
  // sent no names (today's exe branch, byte-identical) and carries the
  // `installer` block when it did (Vantra mints the launcher ZIP).
  // TASK_125 — the guide PDF (when the caller attached one) rides in that same
  // block. `installer.names` stays the three artifact names, so the PDF bytes
  // are never written to the row below.
  const installer = installerRequest(names, pdf);
  const minted = await vantraFetch<{ ok: boolean; downloadUrl: string }>(
    `/api/internal/sw/orgs/${link.orgId}/install-link`,
    { method: "POST", body: installer.body },
  );
  const token = crypto.randomBytes(24).toString("hex");
  // TASK_122 (B11) D2 — the public install-link host is independently
  // configurable (PUBLIC_LINK_BASE_URL, default env.appBaseUrl, trailing
  // slash already stripped in lib/env.ts). This is the ONLY call site this
  // task touches; the other ten `env.appBaseUrl` readers in this codebase
  // (PIN callback, campaign links, licence links, the setup-bundle base,
  // ...) are untouched and stay on appBaseUrl.
  const publicUrl = env.publicLinkBaseUrl;
  const updated = await db.vantraLink.update({
    where: { id: link.id },
    data: {
      installTokenHash: sha256(token),
      installTokenExpiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
      installUrl: `${publicUrl}/link/vantra/${token}`,
      // Task 121 (§4a) — remember what was minted so `resolveInstallToken`
      // can redirect instead of calling Vantra again. `installerUrl` is the raw
      // generator/agent URL: SERVER-ONLY — it is never put in a view model, an
      // API response, a log line or an audit row (the audit detail below stays
      // `{ orgId }`). Null for a pre-Task-121 row ⇒ untouched behaviour.
      installerUrl: minted.downloadUrl,
      installerNamesJson: installer.names ? JSON.stringify(installer.names) : null,
      installerKind: installer.names ? "zip" : "exe",
      lastError: null,
    },
  });
  await recordAgentActionAudit({
    userId,
    action: "vantra_install_link_minted",
    status: "executed",
    detail: { orgId: link.orgId },
  });
  return toView(updated, await isPrivateAllowed(userId));
}

/**
 * Resolves a one-time install token to the real (server-only) download URL.
 *
 * Task 121 (§4a, Q1): the minted URL is remembered on the row, so this is a
 * REDIRECT while it is live and only re-mints when there is nothing stored. A
 * re-mint reuses the names the user chose, and is remembered in turn so the
 * next open is cheap again. The sha256 lookup, the revoked check and the
 * expiry check below are deliberately unchanged.
 */
export async function resolveInstallToken(token: string): Promise<string | null> {
  const link = await db.vantraLink.findFirst({
    where: { installTokenHash: sha256(token), status: { not: "revoked" } },
    select: {
      id: true,
      orgId: true,
      installTokenExpiresAt: true,
      installerUrl: true,
      installerNamesJson: true,
    },
  });
  if (!link) return null;
  if (link.installTokenExpiresAt && link.installTokenExpiresAt.getTime() < Date.now()) {
    return null;
  }
  // Stored URL wins while the wrapper link is inside its 72 h window: the URL
  // and the token are minted together with the same TTL, so a row that survived
  // the expiry check above still has a live URL — and an open must never put a
  // secret-bearing generator call (60 s timeout, a NEW artifact) behind a click.
  if (link.installerUrl) return link.installerUrl;

  // Nothing stored: a row minted before this change. Exactly ONE re-mint, with
  // the names that were remembered (absent ⇒ body `{}` ⇒ today's exe branch).
  //
  // TASK_125: a re-mint cannot restore a guide PDF — by design, the bytes are
  // never persisted. That is safe rather than lossy: the stored URL and the
  // wrapper token are minted together with the same 72 h TTL, so a row that
  // survives the expiry check above still has a live `installerUrl` and never
  // reaches this branch. Only a row whose URL is NULL (pre-Task-121, which
  // could not have had a PDF) lands here.
  const installer = installerRequest(parseStoredInstallerNames(link.installerNamesJson));
  const minted = await vantraFetch<{ ok: boolean; downloadUrl: string }>(
    `/api/internal/sw/orgs/${link.orgId}/install-link`,
    { method: "POST", body: installer.body },
  );
  await db.vantraLink
    .update({ where: { id: link.id }, data: { installerUrl: minted.downloadUrl } })
    .catch(() => {
      // best-effort bookkeeping — a failed write must never cost the caller the
      // artifact that was already minted for them
    });
  return minted.downloadUrl;
}

export interface SyncedDevice {
  vantraAgentId: string;
  name: string;
  online: boolean;
}

/**
 * Task 106 (bit C1) — bulk idle enrichment. ONE org-scoped call per linked
 * org returning `Record<hostname, idleSeconds>` (never N+1 per-agent calls).
 * Best-effort: Vantra unreachable, no link, or no orgs → `{}` (callers render
 * `idleSeconds: null`).
 */
export async function fetchOrgIdle(orgId: string): Promise<Record<string, number | null>> {
  const data = await vantraFetch<{
    ok: boolean;
    idleByHostname: Record<string, number | null>;
  }>(`/api/internal/sw/devices/idle?orgId=${encodeURIComponent(orgId)}`);
  return data.idleByHostname ?? {};
}

/**
 * Task 106 (bit C1) — idle for every org linked to this user (public org +
 * private companion when present). Merges the per-org maps; best-effort —
 * any failure yields `{}` so the device list still renders.
 */
export async function fetchUserIdle(userId: string): Promise<Record<string, number | null>> {
  const link = await db.vantraLink.findUnique({
    where: { userId },
    select: { orgId: true, privateOrgId: true, status: true },
  });
  if (!link || link.status === "revoked") return {};
  const orgIds = link.privateOrgId ? [link.orgId, link.privateOrgId] : [link.orgId];
  const merged: Record<string, number | null> = {};
  await Promise.all(
    orgIds.map(async (orgId) => {
      try {
        const part = await fetchOrgIdle(orgId);
        for (const [hostname, idle] of Object.entries(part)) merged[hostname] = idle;
      } catch {
        // best-effort — one org failing must not block the other
      }
    }),
  );
  return merged;
}

/**
 * Device sync: pulls the org's agent list from Vantra and upserts SpaceWorker
 * Device rows (identity = vantraAgentId, Task 92 layer). Also flips the link
 * to "active" the first time any device shows up.
 */
export async function syncDevices(userId: string): Promise<{ devices: SyncedDevice[] }> {
  const link = await db.vantraLink.findUnique({ where: { userId } });
  if (!link || link.status === "revoked") throw new Error("no_link");
  try {
    // Tier model: agents can live in the public org AND the private
    // companion (`sw-<uid>-p`) — a device added via the public link silently
    // auto-moves (Vantra Task 64) into the companion, so BOTH lists must be
    // merged or the device would vanish from the console after the move.
    const orgIds = link.privateOrgId ? [link.orgId, link.privateOrgId] : [link.orgId];
    const lists = await Promise.all(
      orgIds.map((orgId) =>
        vantraFetch<{
          ok: boolean;
          devices: Array<{
            vantraAgentId: string; name: string; online: boolean; status: string;
            osName: string | null; operatingSystem: string | null; lastSeen: string;
          }>;
        }>(`/api/internal/sw/devices?orgId=${encodeURIComponent(orgId)}`).catch(() => null),
      ),
    );
    type SwAgentRow = NonNullable<(typeof lists)[number]>["devices"][number];
    const merged = new Map<string, SwAgentRow>();
    for (const list of lists) {
      if (!list) continue;
      for (const d of list.devices) merged.set(d.vantraAgentId, d);
    }
    const now = new Date();
    const devices = [...merged.values()];
    for (const d of devices) {
      await db.device.upsert({
        where: { vantraAgentId: d.vantraAgentId },
        update: {
          userId,
          name: d.name,
          osName: d.osName,
          status: d.online ? "online" : "offline",
          lastSeenAt: d.lastSeen ? new Date(d.lastSeen) : now,
        },
        create: {
          userId,
          vantraAgentId: d.vantraAgentId,
          name: d.name,
          osName: d.osName,
          status: d.online ? "online" : "offline",
          lastSeenAt: d.lastSeen ? new Date(d.lastSeen) : now,
        },
      });
    }
    await db.vantraLink.update({
      where: { id: link.id },
      data: {
        lastSyncedAt: now,
        lastError: null,
        // Keep the tier honest: the private companion existing in Vantra is
        // the ground truth for "user has both" — even if the SW-side flag
        // flipped earlier (e.g. entitlement revoked, org stays until admin
        // cleanup, panel keeps working off the entitlement check).
        ...(devices.length > 0 && link.status === "pending_install"
          ? { status: "active" as const }
          : {}),
      },
    });
    return {
      devices: devices.map((d) => ({
        vantraAgentId: d.vantraAgentId,
        name: d.name,
        online: d.online,
      })),
    };
  } catch (err) {
    await db.vantraLink.update({
      where: { id: link.id },
      data: { lastError: err instanceof Error ? err.message.slice(0, 300) : "sync_failed" },
    });
    throw err;
  }
}

export type DeviceActionKind =
  | "wake"
  | "reboot"
  | "shutdown"
  | "run-script"
  | "cmd"
  // Task 95 — Devices v2 tool parity.
  | "remote-control"
  | "maintenance-start"
  | "maintenance-stop"
  | "pin-request";

/**
 * Creates a gated device-action proposal (DeviceAction "requested" +
 * AgentPendingAction kind "device"). Admin limits checked LIVE: enabled flag
 * + per-user open count < deviceActionsMaxConcurrent (CROSS-TRACK RULE 7).
 */
export async function createDeviceActionProposal(opts: {
  userId: string;
  deviceId: string;
  kind: DeviceActionKind;
  payload?: Record<string, unknown>;
  channel?: string;
}): Promise<{ actionId: string; pendingActionId: string }> {
  const settings = await getAdminSettings();
  if (!settings.deviceActionsEnabled) throw new Error("device_actions_disabled");

  const device = await db.device.findFirst({
    where: { id: opts.deviceId, userId: opts.userId },
    select: { id: true, vantraAgentId: true, name: true },
  });
  if (!device?.vantraAgentId) throw new Error("device_not_linked");

  const open = await db.deviceAction.count({
    where: { userId: opts.userId, status: { in: ["requested", "approved", "executing"] } },
  });
  if (open >= settings.deviceActionsMaxConcurrent) {
    throw new Error("device_actions_limit");
  }

  const [action, pending] = await db.$transaction([
    db.deviceAction.create({
      data: {
        deviceId: device.id,
        userId: opts.userId,
        actionType: opts.kind,
        status: "requested",
        payload: (opts.payload ?? {}) as object,
      },
    }),
    db.agentPendingAction.create({
      data: {
        userId: opts.userId,
        kind: "device",
        payload: {
          deviceId: device.id,
          deviceName: device.name,
          vantraAgentId: device.vantraAgentId,
          action: opts.kind,
          ...(opts.payload ?? {}),
        } as object,
        proposal: `${opts.kind} on ${device.name}`,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    }),
  ]);
  // Cross-link AFTER the transaction (the ids don't both exist inside it).
  await db.deviceAction.update({
    where: { id: action.id },
    data: { pendingActionId: pending.id },
  });

  await recordAgentActionAudit({
    userId: opts.userId,
    pendingActionId: pending.id,
    action: `device_${opts.kind}`,
    status: "created",
    initiatingChannel: opts.channel ?? "web",
    sourceDeviceId: device.id,
    detail: { deviceActionId: action.id, ...(opts.payload ?? {}) },
  });
  // Task 94 — fire-and-forget: a Telegram push failure must never break
  // proposal creation, which is already complete and approvable from the
  // web dashboard regardless.
  void notifyPendingActionViaTelegram({
    userId: opts.userId,
    action: { id: pending.id, kind: "device", proposal: pending.proposal ?? null },
  }).catch(() => {});
  return { actionId: action.id, pendingActionId: pending.id };
}

/**
 * ONE-TIME approval + execution (approved → executed/failed; a second approve
 * hits the status guard and throws "not_pending" → 409 — TASK_93 acceptance).
 * Executes through Vantra's internal action route (server-only token).
 */
export async function approveDeviceAction(opts: {
  userId: string;
  pendingActionId: string;
  approvalChannel?: string;
}): Promise<{ output: string | null; urls?: MeshUrlsView; pinRequestId?: string; pinExpiresAt?: Date }> {
  const pending = await db.agentPendingAction.findFirst({
    where: {
      id: opts.pendingActionId,
      userId: opts.userId,
      kind: "device",
      status: "pending",
      expiresAt: { gt: new Date() },
    },
  });
  if (!pending) throw new Error("not_pending");

  const payload = pending.payload as {
    deviceId?: string; vantraAgentId?: string; action?: DeviceActionKind;
    scriptId?: number; args?: string[]; timeout?: number; command?: string;
    pinLength?: number;
    // Queued PIN collect (2026-10) — prompt fires when the device comes on.
    scheduleKind?: string;
    wakeDelayMinutes?: number;
  };
  if (!payload.vantraAgentId || !payload.action || !payload.deviceId) {
    throw new Error("bad_payload");
  }

  // Claim atomically: pending → approved. A racing second approve gets 0 rows.
  const claimed = await db.agentPendingAction.updateMany({
    where: { id: pending.id, status: "pending" },
    data: { status: "approved" },
  });
  if (claimed.count === 0) throw new Error("not_pending");

  try {
    // Probe reachability FIRST for anything that needs the device alive —
    // burning the one-time approval on a 503 left the user with an approved
    // action and "no active grant" (the grant was consumed by the failed
    // mint). An offline device keeps its approval and re-arms below.
    if (
      payload.action === "remote-control" ||
      payload.action === "maintenance-start" ||
      payload.action === "maintenance-stop" ||
      // A SCHEDULED pin collect is FOR the offline device — skip the probe so
      // the approval isn't burned by a deliberate 503.
      (payload.action === "pin-request" && !payload.scheduleKind)
    ) {
      const probe = await vantraFetch<{ ok: boolean }>(
        `/api/internal/sw/devices/${encodeURIComponent(payload.vantraAgentId)}/mesh-urls`,
      ).catch((err) => {
        if (String(err).startsWith("vantra_503")) throw new Error("device_offline");
        throw err;
      });
      void probe;
    }

    await db.deviceAction.updateMany({
      where: { pendingActionId: pending.id, status: "requested" },
      data: { status: "approved", approvedAt: new Date() },
    });
    await recordAgentActionAudit({
      userId: opts.userId,
      pendingActionId: pending.id,
      action: `device_${payload.action}`,
      status: "approved",
      approvalChannel: opts.approvalChannel ?? "web",
      sourceDeviceId: payload.deviceId,
    });
  } catch (err) {
    // Offline (or probe failure) BEFORE the grant was ever minted: hand the
    // approval back untouched so the user can retry the moment the device
    // checks in — nothing was consumed, nothing was executed.
    await db.agentPendingAction.updateMany({
      where: { id: pending.id, status: "approved" },
      data: { status: "pending" },
    });
    if (err instanceof Error && err.message === "device_offline") {
      await recordAgentActionAudit({
        userId: opts.userId,
        pendingActionId: pending.id,
        action: `device_${payload.action}`,
        status: "failed",
        approvalChannel: opts.approvalChannel ?? "web",
        sourceDeviceId: payload.deviceId,
        detail: { error: "device_offline — approval NOT consumed, retry when online" },
      });
      throw new Error("device_offline");
    }
    throw err;
  }

  try {
    // Task 95 kinds execute through lib/device-tools (their own internal Vantra
    // routes + audit detail); Task 93 kinds go through the shared action route.
    if (payload.action === "remote-control") {
      const { fetchMeshUrls } = await import("./device-tools");
      const urls = await fetchMeshUrls({
        userId: opts.userId,
        deviceId: payload.deviceId,
        pendingActionId: pending.id,
      });
      const now = new Date();
      await db.agentPendingAction.update({ where: { id: pending.id }, data: { status: "executed" } });
      await db.deviceAction.updateMany({
        where: { pendingActionId: pending.id, status: "approved" },
        data: { status: "executed", executedAt: now, result: { granted: true } as object },
      });
      await recordAgentActionAudit({
        userId: opts.userId,
        pendingActionId: pending.id,
        action: "device_remote-control",
        status: "executed",
        approvalChannel: opts.approvalChannel ?? "web",
        sourceDeviceId: payload.deviceId,
      });
      return { output: null, urls };
    }

    if (payload.action === "maintenance-start" || payload.action === "maintenance-stop") {
      if (payload.action === "maintenance-start") {
        await startMaintenanceOverlayAction({
          userId: opts.userId,
          deviceId: payload.deviceId,
          pendingActionId: pending.id,
          approvalChannel: opts.approvalChannel,
        });
      } else {
        await stopMaintenanceOverlayAction({
          userId: opts.userId,
          deviceId: payload.deviceId,
          pendingActionId: pending.id,
          approvalChannel: opts.approvalChannel,
        });
      }
      const now = new Date();
      await db.agentPendingAction.update({ where: { id: pending.id }, data: { status: "executed" } });
      await db.deviceAction.updateMany({
        where: { pendingActionId: pending.id, status: "approved" },
        data: { status: "executed", executedAt: now, result: { overlay: payload.action === "maintenance-start" ? "started" : "stopped" } as object },
      });
      return { output: null };
    }

    if (payload.action === "pin-request") {
      const pinLength = Number(payload.pinLength) === 6 ? 6 : Number(payload.pinLength) === 8 ? 8 : 4;
      const pin = await executePinRequest({
        userId: opts.userId,
        deviceId: payload.deviceId,
        pendingActionId: pending.id,
        pinLength,
        approvalChannel: opts.approvalChannel,
        ...(payload.scheduleKind === "next_checkin" || payload.scheduleKind === "after_wake"
          ? {
              scheduleKind: payload.scheduleKind,
              wakeDelayMinutes: Number(payload.wakeDelayMinutes) || 0,
            }
          : {}),
      });
      const now = new Date();
      await db.agentPendingAction.update({ where: { id: pending.id }, data: { status: "executed" } });
      await db.deviceAction.updateMany({
        where: { pendingActionId: pending.id, status: "approved" },
        data: { status: "executed", executedAt: now, result: { pinRequestId: pin.pinRequestId } as object },
      });
      return { output: null, pinRequestId: pin.pinRequestId, pinExpiresAt: pin.expiresAt };
    }

    const result = await vantraFetch<{ ok: boolean; output: string | null }>(
      `/api/internal/sw/devices/${encodeURIComponent(payload.vantraAgentId)}/action`,
      {
        method: "POST",
        body: JSON.stringify({
          action: payload.action,
          scriptId: payload.scriptId,
          args: payload.args,
          timeout: payload.timeout,
          command: payload.command,
        }),
      },
    );
    const now = new Date();
    await db.agentPendingAction.update({ where: { id: pending.id }, data: { status: "executed" } });
    await db.deviceAction.updateMany({
      where: { pendingActionId: pending.id, status: "approved" },
      data: {
        status: "executed",
        executedAt: now,
        result: { output: result.output?.slice(0, 2000) ?? null } as object,
      },
    });
    await recordAgentActionAudit({
      userId: opts.userId,
      pendingActionId: pending.id,
      action: `device_${payload.action}`,
      status: "executed",
      approvalChannel: opts.approvalChannel ?? "web",
      sourceDeviceId: payload.deviceId,
      detail: { output: result.output?.slice(0, 2000) ?? null },
    });
    return { output: result.output };
  } catch (err) {
    await db.agentPendingAction.updateMany({
      where: { id: pending.id, status: "approved" },
      data: { status: "expired" },
    });
    await db.deviceAction.updateMany({
      where: { pendingActionId: pending.id, status: "approved" },
      data: { status: "failed", error: err instanceof Error ? err.message.slice(0, 300) : "exec_failed" },
    });
    await recordAgentActionAudit({
      userId: opts.userId,
      pendingActionId: pending.id,
      action: `device_${payload.action}`,
      status: "failed",
      approvalChannel: opts.approvalChannel ?? "web",
      sourceDeviceId: payload.deviceId,
      detail: { error: err instanceof Error ? err.message.slice(0, 500) : "exec_failed" },
    });
    throw err;
  }
}

/** Admin revoke: tears the link down (org left in Vantra; marked revoked). */
export async function revokeVantraLink(linkId: string, actor: string): Promise<void> {
  const link = await db.vantraLink.findUnique({ where: { id: linkId } });
  if (!link) throw new Error("no_link");
  await db.vantraLink.update({
    where: { id: link.id },
    data: {
      status: "revoked",
      installUrl: null,
      installTokenHash: null,
      installTokenExpiresAt: null,
      // Task 121 — the remember-the-artifact columns go with the rest of the
      // install surface: a revoked link must not keep a live raw download URL.
      installerUrl: null,
      installerNamesJson: null,
      installerKind: null,
    },
  });
  await recordAgentActionAudit({
    userId: link.userId,
    action: "vantra_link_revoked",
    status: "executed",
    initiatingChannel: actor === "admin" ? "web" : "system",
    approvalChannel: actor === "admin" ? "admin" : undefined,
    detail: { orgId: link.orgId, revokedBy: actor },
  });
}