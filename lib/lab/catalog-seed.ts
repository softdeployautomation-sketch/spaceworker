import "server-only";

import { db } from "@/lib/db";
import { getAdminSettings } from "@/lib/admin-settings";

import { ATTACK_RELEASE } from "./tools";

// TASK_156 C1 (PLAN_TASK_156 §12.1) — the STARTER LabToolCatalog.
//
// §12.1: "One row per capability … A capability whose staleAfter has passed is
// hidden from the UI automatically." §12.8: C1 gains the LabToolCatalog table + the
// staleAfter/last-reviewed columns + the read-only Research page.
//
// This is the SEED, not the finished catalog. It covers all four classes the §12
// addendum defines (network / email / dns / defensive) with the capabilities named
// in §5.1 + §12.2 + §12.3. `lastReviewedAt` is the C1 pin date and `staleAfter` is
// derived from `now + AdminSetting.cyberlabToolStaleAfterDays`, so currency is
// enforced by the window even before the full research loop completes each row's
// `upstreamVersion`/`upstreamReleasedAt`. Those two fields are left null in the seed
// deliberately: §12.1 pins VERSIONS at each review, and we do not fabricate release
// dates we have not measured. The ATT&CK release itself IS pinned (ATTACK_RELEASE).
//
// HONEST LIMITS: licence identifiers are recorded where confidently known and left
// null otherwise (re-verified at each review, §12.1); `audience` is an AUDIENCE/tier
// label (§12.9), NOT a role gate; every offensive row is allow-list/attested-target
// bound (§5.2.1).

const PINNED_AT = new Date(`${ATTACK_RELEASE.pinnedAt}T00:00:00Z`);

interface SeedRow {
  slug: string;
  name: string;
  klass: "network" | "email" | "dns" | "defensive";
  kind: "offensive" | "defensive";
  techniqueIds: string[];
  licence: string | null;
  derivation: string;
  audience: "staff" | "pro" | "all";
  legalBasis: string;
}

// Ordered network → email → dns → defensive, matching §5.1's matrix groups.
export const CATALOG_SEED: SeedRow[] = [
  {
    slug: "nmap",
    name: "Nmap",
    klass: "network",
    kind: "offensive",
    techniqueIds: ["T1046"],
    licence: "NPSL",
    derivation: "Network service discovery — the first step in essentially every modern intrusion; default recon in public red-team reports.",
    audience: "pro",
    legalBasis: "Recon only, against allow-listed lab/attested targets — never third-party or public ranges (§5.2.1).",
  },
  {
    slug: "nuclei",
    name: "Nuclei",
    klass: "network",
    kind: "offensive",
    techniqueIds: ["T1595.002"],
    licence: "MIT",
    derivation: "Template-driven vulnerability scanning; template packs track newly disclosed CVEs within days.",
    audience: "pro",
    legalBasis: "Vulnerability scanning against attested targets only; template pack refreshed by the §12.1 research cadence.",
  },
  {
    slug: "httpx",
    name: "httpx",
    klass: "network",
    kind: "offensive",
    techniqueIds: ["T1595"],
    licence: "MIT",
    derivation: "HTTP surface probing/fingerprinting, standard companion to nmap/nuclei in current recon chains.",
    audience: "pro",
    legalBasis: "Surface probing against attested targets only (§5.2.1).",
  },
  {
    slug: "ffuf",
    name: "ffuf",
    klass: "network",
    kind: "offensive",
    techniqueIds: ["T1595.002"],
    licence: "MIT",
    derivation: "Content/parameter fuzzing for hidden endpoints; widely used in current web-app assessments.",
    audience: "pro",
    legalBasis: "Fuzzing against attested targets only; rate/velocity watched by the §5.2.4 sentinel.",
  },
  {
    slug: "testssl.sh",
    name: "testssl.sh",
    klass: "network",
    kind: "offensive",
    techniqueIds: ["T1595.002"],
    licence: "GPL-2.0",
    derivation: "TLS/SSL configuration auditing — finds the weak-crypto weaknesses present in most breach post-mortems.",
    audience: "pro",
    legalBasis: "Configuration probing against attested targets only.",
  },
  {
    slug: "caldera",
    name: "MITRE Caldera",
    klass: "network",
    kind: "offensive",
    techniqueIds: ["T1059"],
    licence: "Apache-2.0",
    derivation: "The adversary-emulation engine (ATT&CK-mapped abilities). Must stay isolated — its own docs warn the UI is not hardened.",
    audience: "staff",
    legalBasis: "Emulation engine; runs only on an isolated lab host against attested targets (§4), never the production app host.",
  },
  {
    slug: "hydra",
    name: "Hydra",
    klass: "network",
    kind: "offensive",
    techniqueIds: ["T1110.001"],
    licence: "AGPL-3.0",
    derivation: "Credential brute-forcing; still a top initial-access and lateral-movement technique in current incident data.",
    audience: "staff",
    legalBasis: "Range + attested targets only, against YOUR own range services (§5.1 'staff-only v1').",
  },
  {
    slug: "checkdmarc",
    name: "checkdmarc",
    klass: "email",
    kind: "defensive",
    techniqueIds: ["T1566"],
    licence: "MPL-2.0",
    derivation: "SPF/DKIM/DMARC/BIMI/MTA-STS deliverability audit — explains why a spoof fails vs lands.",
    audience: "all",
    legalBasis: "Pure analysis of YOUR own domains; no email is sent (§12.2).",
  },
  {
    slug: "gophish",
    name: "GoPhish",
    klass: "email",
    kind: "offensive",
    techniqueIds: ["T1566.002"],
    licence: "MIT",
    derivation: "Phishing-simulation campaign orchestration; the standard OSS engine for consent-based training.",
    audience: "staff",
    legalBasis: "Self-hosted on the lab host; recipients must be consenting, attested in-org addresses (§12.2 hard lines).",
  },
  {
    slug: "swaks",
    name: "swaks",
    klass: "email",
    kind: "offensive",
    techniqueIds: ["T1566"],
    licence: "GPL-2.0",
    derivation: "SMTP transaction tooling — relay abuse, STARTTLS downgrade and header-injection testing.",
    audience: "staff",
    legalBasis: "Range mail VM + attested targets only (§12.2).",
  },
  {
    slug: "dnsrecon",
    name: "dnsrecon",
    klass: "dns",
    kind: "offensive",
    techniqueIds: ["T1590.002"],
    licence: "GPL-2.0",
    derivation: "Zone/record enumeration and dangling-record (takeover) discovery.",
    audience: "pro",
    legalBasis: "Attested names only; DNS queries watched by the §5.2.2 egress sentinel.",
  },
  {
    slug: "dnscat2",
    name: "dnscat2",
    klass: "dns",
    kind: "offensive",
    techniqueIds: ["T1071.004"],
    licence: "BSD-3-Clause",
    derivation: "DNS tunnelling / covert exfiltration — demonstrated (and detected) on our own lab domain only.",
    audience: "staff",
    legalBasis: "Range + own-lab-domain only; the demo runs on our own domain (§12.3).",
  },
  {
    slug: "tcpdump",
    name: "tcpdump",
    klass: "defensive",
    kind: "defensive",
    techniqueIds: ["T1040"],
    licence: "BSD-3-Clause",
    derivation: "Packet capture — already installed on the box; produces the episode's network evidence.",
    audience: "all",
    legalBasis: "Defensive capture on victim VMs / the lab host (§5.1).",
  },
  {
    slug: "suricata",
    name: "Suricata",
    klass: "defensive",
    kind: "defensive",
    techniqueIds: ["T1040"],
    licence: "GPL-2.0",
    derivation: "IDS/NSM — signature + anomaly detection that feeds the detect-then-defend loop (§8.4).",
    audience: "all",
    legalBasis: "Defensive monitoring of lab/range traffic (§12.3 DNS logs).",
  },
  {
    slug: "sigma",
    name: "Sigma",
    klass: "defensive",
    kind: "defensive",
    techniqueIds: [],
    licence: "DRL",
    derivation: "Generic, vendor-neutral detection rules — the rule format DetectionPack (C5) is built from.",
    audience: "all",
    legalBasis: "Defensive detection rules; rule packs refreshed by the §12.1 research cadence.",
  },
  {
    slug: "yara",
    name: "YARA",
    klass: "defensive",
    kind: "defensive",
    techniqueIds: [],
    licence: "BSD-3-Clause",
    derivation: "Pattern matching for malware/attachment hygiene — 'does this attachment actually detonate?' (§12.2).",
    audience: "all",
    legalBasis: "Sandboxed analysis on the range VM; never a real inbox (§12.2).",
  },
];

/**
 * Idempotently insert the starter catalog. Safe to call on every Research-page load
 * and from a migration/seed step: `slug` is unique and `skipDuplicates` means an
 * existing row is never overwritten (a human's later edits survive).
 *
 * `staleAfter` is derived here, not hard-coded: each seeded row goes stale
 * `cyberlabToolStaleAfterDays` after the C1 pin date, so the owner can widen/narrow
 * the currency window from admin and re-seeding respects it. Rows already present
 * keep their own dates.
 *
 * Returns how many rows were actually created (0 on a warm catalog).
 */
export async function ensureCatalogSeed(): Promise<number> {
  const settings = await getAdminSettings();
  const staleDays = settings.cyberlabToolStaleAfterDays;
  const staleAfter = new Date(PINNED_AT.getTime() + staleDays * 24 * 60 * 60 * 1000);

  const result = await db.labToolCatalog.createMany({
    data: CATALOG_SEED.map((row) => ({
      slug: row.slug,
      name: row.name,
      klass: row.klass,
      kind: row.kind,
      techniqueIds: row.techniqueIds,
      // §12.1: version + release date are pinned at each REVIEW — not fabricated here.
      upstreamVersion: null,
      upstreamReleasedAt: null,
      lastReviewedAt: PINNED_AT,
      staleAfter,
      cveHistory: [],
      licence: row.licence,
      derivation: row.derivation,
      audience: row.audience,
      legalBasis: row.legalBasis,
      enabled: true,
    })),
    skipDuplicates: true,
  });
  return result.count;
}