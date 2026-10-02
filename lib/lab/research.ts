import "server-only";

import { getAdminSettings } from "@/lib/admin-settings";

import { catalogSummary, ATTACK_RELEASE } from "./tools";

// TASK_156 C1 (PLAN_TASK_156 §12.1) — the READ-ONLY research state.
//
// §12.1 asks for "a small scheduled job + an admin page" that refreshes ATT&CK and
// the newest Sigma/YARA/nuclei/Atomic-Red-Team packs, recording every pull with a
// diff + date so "'we are current' is a timestamp we can show, not a claim".
//
// §12.8 scopes C1 to the RESEARCH ADMIN PAGE, read-only: "the Research admin page
// (read-only feeds; no attack)". So C1 ships the page and the state it reads — the
// pinned ATT&CK release, the feed list, the refresh cadence and the catalog's
// currency — but performs NO network pulls and NO attack. The scheduled pull job is
// C2+ work. This module therefore only READS settings + catalog rows.

export interface ResearchFeed {
  id: string;
  label: string;
  url: string;
  /** What a pull refreshes in the lab. */
  refreshes: string;
}

/**
 * The feeds the §12.1 research cadence refreshes. ATT&CK's own releases are the
 * versioned spine; the rest are the rule/atomic packs a tool's `staleAfter` is
 * re-justified against. Listed (not fetched) in C1.
 */
export const RESEARCH_FEEDS: ResearchFeed[] = [
  {
    id: "attack",
    label: "MITRE ATT&CK",
    url: "https://attack.mitre.org/resources/versions/",
    refreshes: "Technique ids + the versioned spine every catalog row maps to.",
  },
  {
    id: "sigma",
    label: "SigmaHQ rules",
    url: "https://github.com/SigmaHQ/sigma",
    refreshes: "Detection rules DetectionPack (C5) is built from.",
  },
  {
    id: "yara",
    label: "YARA rule packs",
    url: "https://github.com/Yara-Rules/rules",
    refreshes: "Attachment/malware pattern hygiene (§12.2).",
  },
  {
    id: "nuclei",
    label: "nuclei templates",
    url: "https://github.com/projectdiscovery/nuclei-templates",
    refreshes: "Newly disclosed CVEs the scanner can exercise.",
  },
  {
    id: "atomic",
    label: "Atomic Red Team atomics",
    url: "https://github.com/redcanaryco/atomic-red-team",
    refreshes: "Per-technique emulation abilities Caldera runs.",
  },
];

export interface ResearchState {
  /** The pinned ATT&CK release + the date we pinned it (§12.1 provenance). */
  attackRelease: typeof ATTACK_RELEASE;
  /** The feeds the cadence refreshes. */
  feeds: ResearchFeed[];
  /** The refresh window (AdminSetting.cyberlabResearchRefreshDays). */
  refreshDays: number;
  /** When the next refresh is due given the pin date + window. */
  nextRefreshDueAt: string;
  /** The stale window applied to catalog rows (AdminSetting.cyberlabToolStaleAfterDays). */
  toolStaleAfterDays: number;
  /** Catalog currency: total / visible / stale / disabled, by class. */
  catalog: Awaited<ReturnType<typeof catalogSummary>>;
}

/**
 * The read-only research payload the admin page renders. Reads settings + the
 * catalog — no network, no attack.
 */
export async function researchState(): Promise<ResearchState> {
  const [settings, catalog] = await Promise.all([getAdminSettings(), catalogSummary()]);
  const refreshDays = settings.cyberlabResearchRefreshDays;
  const pinned = new Date(`${ATTACK_RELEASE.pinnedAt}T00:00:00Z`);
  const nextRefreshDueAt = new Date(pinned.getTime() + refreshDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  return {
    attackRelease: ATTACK_RELEASE,
    feeds: RESEARCH_FEEDS,
    refreshDays,
    nextRefreshDueAt,
    toolStaleAfterDays: settings.cyberlabToolStaleAfterDays,
    catalog,
  };
}