import { NextResponse } from "next/server";
import { z } from "zod";

import { getSession } from "@/lib/session";
import {
  mintInstallLink,
  mintPublicPsCommand,
  mintPublicVbsFile,
  validateInstallerPdf,
  type InstallerNames,
  type InstallerPdf,
} from "@/lib/vantra-link";

export const dynamic = "force-dynamic";

// Task 93 + 2026-10 console follow-up — mint install assets, per tier:
//   POST {}                      → public one-time link (raw exe)
//   POST {names:{…}}             → public one-time link to the launcher ZIP
//   POST {names:{…}, pdf,…}      → …with an install-guide PDF inside the ZIP
//   POST {kind:"private"}        → private PowerShell install command
//   POST {kind:"public-powershell"} → PUBLIC PowerShell install command
//   POST {kind:"public-vbs", vbsName?} → PUBLIC one-click .vbs carrier (inline)
// Private is entitlement-gated in mintInstallLink ("devices" entitlement —
// premium tier 5 covers it; free/trial users 403).
//
// TASK_178 stage 1 — the public VBS carrier: the SAME org mint as
// public-powershell, normalised to one line, guaranteed `--silent` (the
// TASK_172 fix Vantra's psCommand lacks) and bound into one double-clickable
// `.vbs`. It takes neither the names nor the guide PDF (those describe the
// launcher ZIP), it is inline-only like public-powershell, and `vbsName` is
// the stage-1 file-rename field (invalid ⇒ default, never a 400 — the same
// posture as the zip names).
//
// TASK_128 §15 — the PUBLIC PowerShell command (owner request). Public needs NO
// entitlement gate: the device it enrolls lands in the same public org the
// shareable link already targets, so this grants a user nothing they did not
// already have — it only skips the download step. It takes neither the names
// nor the guide PDF (those describe the launcher ZIP, which this path does not
// build), and the result is returned inline rather than stored, because the
// public tier's primary artifact stays the link.
//
// TASK_125 — the optional guide PDF. The three NAMES are dropped when invalid
// (a typo must never block an install); the PDF is NOT, because the user
// explicitly picked a file and silently shipping a ZIP without it would be a
// lie. So an unusable PDF is a 400/413 with a code the client can act on,
// while Vantra's own gate drops one defensively (defense in depth, both sides
// validated independently).

// Task 121 (OOB-13) — the optional renameable names of the public artifact.
// The SAME bare-name rule Vantra's own gate uses
// (app/api/devices/deployments/route.ts:41-43 + lib/zip-generator.ts:52-57):
// trim, ≤64 chars, no `/ \ "`, no control chars, no "..". zod validates here and
// lib/vantra-link sanitises again on the way out, so nothing path-like can
// reach the generator from this side.
const bareNameSchema = z
  .string()
  .trim()
  .max(64)
  .refine((value) => !/[/\\"\u0000-\u001f]/.test(value) && !value.includes(".."), {
    message: "invalid_name",
  });

/**
 * A validated name, or undefined when it is blank/invalid. An INVALID value
 * drops that one field — never a 400: a typo (or a probe like `../evil`) must
 * not be able to block somebody's install, and the generator default applies.
 */
function bareName(value: unknown): string | undefined {
  const parsed = bareNameSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const name = parsed.data.trim();
  return name.length > 0 ? name : undefined;
}

/**
 * `names` present (even `{}`) ⇒ the caller is asking for the launcher ZIP, with
 * the generator's defaults for whatever is blank/invalid.
 * `names` absent or an unusable shape ⇒ the caller is asking for today's raw
 * exe: mintInstallLink then sends the byte-identical `{}` body (the rollback).
 */
function parseNames(value: unknown): InstallerNames | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const names: InstallerNames = {};
  const zipName = bareName(raw.zipName);
  if (zipName) names.zipName = zipName;
  const updateLinkName = bareName(raw.updateLinkName);
  if (updateLinkName) names.updateLinkName = updateLinkName;
  const innerFolder = bareName(raw.innerFolder);
  if (innerFolder) names.innerFolder = innerFolder;
  return names;
}

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as {
    kind?: unknown;
    names?: unknown;
    pdf?: unknown;
    pdfName?: unknown;
    pdfDelaySec?: unknown;
    vbsName?: unknown;
  };
  const kind =
    body.kind === "private"
      ? "private"
      : body.kind === "public-powershell"
        ? "public-powershell"
        : body.kind === "public-vbs"
          ? "public-vbs"
          : "public";
  // The private tier is out of scope (D1/D2): its PowerShell command never
  // takes the installer block. Same for the public-PowerShell and public-VBS
  // paths — the names and the guide PDF describe the launcher ZIP, which they
  // do not build.
  const names = kind === "public" ? parseNames(body.names) : undefined;

  // TASK_125 — the LOUD gate for the optional guide PDF (public only). The
  // validator mirrors Vantra's reference rules exactly, so a request accepted
  // here is accepted there too; the difference is only that a bad PDF is an
  // actionable status here instead of a silent drop.
  let pdf: InstallerPdf | null = null;
  if (kind === "public") {
    const validated = validateInstallerPdf({
      pdf: body.pdf,
      pdfName: body.pdfName,
      pdfDelaySec: body.pdfDelaySec,
    });
    if (!validated.ok) {
      return NextResponse.json(
        { error: validated.code },
        { status: validated.code === "pdf_too_large" ? 413 : 400 },
      );
    }
    pdf = validated.pdf;
  }

  try {
    // TASK_128 §15 — the public PowerShell command, minted on demand and
    // returned inline (never stored: the public tier's primary artifact is the
    // shareable link, and this is a 72 h-scoped convenience).
    if (kind === "public-powershell") {
      const minted = await mintPublicPsCommand(session.userId);
      return NextResponse.json({
        ok: true,
        command: minted.command,
        expiresAt: minted.expiresAt,
      });
    }
    // TASK_178 stage 1 — the one-click `.vbs` carrier, returned inline
    // (fileName + content): the client saves it as a Blob. `vbsName` is the
    // rename field; the route's bareName drop plus lib-level re-sanitise
    // mean a typo falls back to the default name, never a 400.
    if (kind === "public-vbs") {
      const minted = await mintPublicVbsFile(session.userId, bareName(body.vbsName));
      return NextResponse.json({
        ok: true,
        fileName: minted.fileName,
        content: minted.content,
        expiresAt: minted.expiresAt,
      });
    }
    const link = await mintInstallLink(session.userId, kind, names, pdf);
    return NextResponse.json({ ok: true, link });
  } catch (err) {
    const code = err instanceof Error ? err.message : "mint_failed";
    const status =
      code === "no_link" ? 404
      : code === "private_not_granted" ? 403
      // `vantra_deploy_outdated` is Vantra not knowing the public-PowerShell
      // flag yet — a deploy-order problem, not a client error.
      : code === "vantra_not_configured" || code === "vantra_deploy_outdated" ? 503
      : 502;
    return NextResponse.json({ error: code }, { status });
  }
}
