import "server-only";

import { db } from "@/lib/db";

// TASK_156 C1 (PLAN_TASK_156 §12.1 BINDING) — the research gate: the LabToolCatalog.
//
// "A tool is not added because it is famous; it is added because it is CURRENT."
// Every capability is ONE row carrying its ATT&CK technique id(s), last-reviewed
// date, upstream version + release date, CVE history, licence, real-world derivation
// and a `staleAfter` date. A row whose `staleAfter` has PASSED is hidden from the UI
// automatically and shows "refresh required" in admin — the opposite of a tool list
// that quietly rots.
//
// This module is READ-ONLY with respect to attacks: it reads/writes catalog rows and
// nothing else. "Nothing in this gate runs an attack." (§12.1)
//
// The pinned ATT&CK release is recorded as a CONSTANT, not a live call, because the
// plan's provenance note (§12.1) requires C1 to PIN the current release and record
// the date it did — that timestamp is the whole point of "not stale".

/**
 * The MITRE ATT&CK release this catalog was pinned against, and the date we pinned
 * it (§12.1 provenance note). ATT&CK's own releases are the versioned spine the
 * research cadence refreshes from. Recorded as constants so the pin is auditable in
 * code — a future research pull updates these and bumps `pinnedAt`.
 *
 * Source: MITRE ATT&CK version history (attack.mitre.org/resources/versions) — "ATT&CK
 * v19.2, 28 April 2026 – current" at the time of writing; the `mitre/cti` tag
 * ATT&CK-v19.2 was cut 5 August 2026.
 */
export const ATTACK_RELEASE = {
  version: "19.2",
  /** The MITRE ATT&CK v19 line opened 2026-04-28 (its version-history date). */
  lineOpenedAt: "2026-04-28",
  /** The `mitre/cti` ATT&CK-v19.2 tag date (the last content cut). */
  releasedAt: "2026-08-05",
  /** The date THIS catalog was pinned to that release (C1 build date). */
  pinnedAt: "2026-10-02",
  source: "https://attack.mitre.org/resources/versions/",
} as const;

/** What a catalog row looks like once loaded (the columns the Research page reads). */
export interface CatalogRow {
  id: string;
  slug: string;
  name: string;
  klass: string;
  kind: string;
  techniqueIds: unknown;
  upstreamVersion: string | null;
  upstreamReleasedAt: Date | null;
  lastReviewedAt: Date | null;
  staleAfter: Date | null;
  cveHistory: unknown;
  licence: string | null;
  derivation: string | null;
  audience: string;
  legalBasis: string;
  enabled: boolean;
}

/** True when a row's staleAfter has passed (=> hidden from the UI, "refresh required"). */
export function isCatalogStale(row: Pick<CatalogRow, "staleAfter">, now: Date = new Date()): boolean {
  return row.staleAfter != null && row.staleAfter.getTime() <= now.getTime();
}

/**
 * The full catalog as admin sees it: every row, WITH the computed `stale` flag so
 * the Research page can show "refresh required" instead of silently hiding it.
 * Ordered newest-reviewed first, then by class/slug so the list is stable.
 */
export async function listCatalog(): Promise<Array<CatalogRow & { stale: boolean }>> {
  const rows = await db.labToolCatalog.findMany({
    orderBy: [{ lastReviewedAt: "desc" }, { klass: "asc" }, { slug: "asc" }],
  });
  const now = new Date();
  return rows.map((r) => ({ ...(r as CatalogRow), stale: isCatalogStale(r, now) }));
}

/**
 * The UI-visible set: enabled AND not stale. This is what a customer-facing tool
 * chooser (C2+) may ever offer — a stale row is filtered out here automatically.
 */
export async function listVisibleCatalog(): Promise<CatalogRow[]> {
  const now = new Date();
  const rows = await db.labToolCatalog.findMany({
    where: { enabled: true, OR: [{ staleAfter: null }, { staleAfter: { gt: now } }] },
    orderBy: [{ klass: "asc" }, { slug: "asc" }],
  });
  return rows as CatalogRow[];
}

/** Counts for the admin dials / research page — no attack, just row maths. */
export async function catalogSummary(): Promise<{
  total: number;
  visible: number;
  stale: number;
  disabled: number;
  byClass: Record<string, number>;
}> {
  const rows = await listCatalog();
  const byClass: Record<string, number> = {};
  let visible = 0;
  let stale = 0;
  let disabled = 0;
  for (const r of rows) {
    byClass[r.klass] = (byClass[r.klass] ?? 0) + 1;
    if (r.stale) stale += 1;
    if (!r.enabled) disabled += 1;
    if (r.enabled && !r.stale) visible += 1;
  }
  return { total: rows.length, visible, stale, disabled, byClass };
}
