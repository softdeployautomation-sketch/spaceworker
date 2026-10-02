import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdminSession } from "@/lib/admin-auth";
import { getAdminSettings } from "@/lib/admin-settings";

// TASK_156 C1 (scaffolding, owner 2026-10-01) — the admin dials for the Cyber
// Lab, mirroring app/api/admin/hosting: master switch + every cap, read
// server-side, so a limit change is live without a redeploy (CROSS-TRACK RULE 7).
//
// The owner was explicit that the lab is RAM-heavy ("if it's going to take a lot
// of ram … we need every hard load monitored and queued properly"), so the RAM
// envelope is a first-class dial here (`rangeRamMb`, `hostRamBudgetMb`) that the
// resource governor (TASK_105) will queue against once the lab ships. Nothing
// reads these yet — the lab models do not exist — so this route changes no
// behaviour; it exists so the owner can see and tune the load envelope up front.
//
// PATCH is a SUBSET update, exact the same shape as /api/admin/hosting: the panel
// sends only the field it changed, so editing one dial never clobbers another.

const WRITABLE_FIELDS = {
  enabled: { column: "cyberlabEnabled", kind: "bool" },
  freeMaxConcurrentRanges: { column: "cyberlabFreeMaxConcurrentRanges", kind: "int" },
  freeMaxRangeMinutes: { column: "cyberlabFreeMaxRangeMinutes", kind: "int" },
  rangeRamMb: { column: "cyberlabRangeRamMb", kind: "int" },
  hostRamBudgetMb: { column: "cyberlabHostRamBudgetMb", kind: "int" },
  maxTargetsPerScenario: { column: "cyberlabMaxTargetsPerScenario", kind: "int" },
  maxEpisodesPerMonth: { column: "cyberlabMaxEpisodesPerMonth", kind: "int" },
  modulePriceUsd: { column: "cyberlabModulePriceUsd", kind: "money" },
  // TASK_156 C1 (§12.8) — the §12 sentinel/research/consent dials, added to the
  // admin surface so the load envelope AND the abuse-sentinel thresholds are
  // tunable before the heavy tooling lands. `consentTermsVersion` is a string: the
  // AUP version the C0 gate enforces (§12.9). Changing it forces every user to
  // re-accept the AUP (a stale-version LabConsent row no longer matches).
  consentTermsVersion: { column: "cyberlabConsentTermsVersion", kind: "string" },
  maxTargetsPerUser: { column: "cyberlabMaxTargetsPerUser", kind: "int" },
  maxRunsPerDay: { column: "cyberlabMaxRunsPerDay", kind: "int" },
  sentinelDnsQueriesPerMinute: { column: "cyberlabSentinelDnsQueriesPerMinute", kind: "int" },
  sentinelEntropyThreshold: { column: "cyberlabSentinelEntropyThreshold", kind: "int" },
  sentinelFreezeOnRefusals: { column: "cyberlabSentinelFreezeOnRefusals", kind: "int" },
  toolStaleAfterDays: { column: "cyberlabToolStaleAfterDays", kind: "int" },
  researchRefreshDays: { column: "cyberlabResearchRefreshDays", kind: "int" },
} as const;

const WRITABLE_KEYS = Object.keys(WRITABLE_FIELDS) as Array<keyof typeof WRITABLE_FIELDS>;

type CyberLabSettingRow = {
  cyberlabEnabled: boolean;
  cyberlabFreeMaxConcurrentRanges: number;
  cyberlabFreeMaxRangeMinutes: number;
  cyberlabRangeRamMb: number;
  cyberlabHostRamBudgetMb: number;
  cyberlabMaxTargetsPerScenario: number;
  cyberlabMaxEpisodesPerMonth: number;
  cyberlabModulePriceUsd: number;
  cyberlabConsentTermsVersion: string;
  cyberlabMaxTargetsPerUser: number;
  cyberlabMaxRunsPerDay: number;
  cyberlabSentinelDnsQueriesPerMinute: number;
  cyberlabSentinelEntropyThreshold: number;
  cyberlabSentinelFreezeOnRefusals: number;
  cyberlabToolStaleAfterDays: number;
  cyberlabResearchRefreshDays: number;
};

function toPayload(settings: CyberLabSettingRow) {
  return {
    enabled: settings.cyberlabEnabled,
    caps: {
      freeMaxConcurrentRanges: settings.cyberlabFreeMaxConcurrentRanges,
      freeMaxRangeMinutes: settings.cyberlabFreeMaxRangeMinutes,
      rangeRamMb: settings.cyberlabRangeRamMb,
      hostRamBudgetMb: settings.cyberlabHostRamBudgetMb,
      maxTargetsPerScenario: settings.cyberlabMaxTargetsPerScenario,
      maxEpisodesPerMonth: settings.cyberlabMaxEpisodesPerMonth,
      modulePriceUsd: settings.cyberlabModulePriceUsd,
      maxTargetsPerUser: settings.cyberlabMaxTargetsPerUser,
      maxRunsPerDay: settings.cyberlabMaxRunsPerDay,
      sentinelDnsQueriesPerMinute: settings.cyberlabSentinelDnsQueriesPerMinute,
      sentinelEntropyThreshold: settings.cyberlabSentinelEntropyThreshold,
      sentinelFreezeOnRefusals: settings.cyberlabSentinelFreezeOnRefusals,
      toolStaleAfterDays: settings.cyberlabToolStaleAfterDays,
      researchRefreshDays: settings.cyberlabResearchRefreshDays,
      consentTermsVersion: settings.cyberlabConsentTermsVersion,
    },
  };
}

export async function GET() {
  const isAdmin = await requireAdminSession();
  if (!isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const settings = await getAdminSettings();
  return NextResponse.json(toPayload(settings));
}

export async function PATCH(req: Request) {
  const isAdmin = await requireAdminSession();
  if (!isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const data: Record<string, boolean | number | string> = {};
  for (const [key, value] of Object.entries(body)) {
    if (!WRITABLE_KEYS.includes(key as keyof typeof WRITABLE_FIELDS)) {
      return NextResponse.json({ error: `Unknown setting: ${key}` }, { status: 400 });
    }
    const { column, kind } = WRITABLE_FIELDS[key as keyof typeof WRITABLE_FIELDS];
    if (kind === "bool") {
      if (typeof value !== "boolean") {
        return NextResponse.json({ error: `${key} must be a boolean` }, { status: 400 });
      }
      data[column] = value;
    } else if (kind === "string") {
      // The AUP version string — non-empty, trimmed, so a blank version can never
      // be set (a blank version would match a blank hash and break the gate).
      if (typeof value !== "string" || value.trim().length === 0) {
        return NextResponse.json({ error: `${key} must be a non-empty string` }, { status: 400 });
      }
      data[column] = value.trim();
    } else if (kind === "money") {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) {
        return NextResponse.json({ error: `${key} must be a number >= 0` }, { status: 400 });
      }
      data[column] = n;
    } else {
      const n = Number(value);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
        return NextResponse.json({ error: `${key} must be a positive integer` }, { status: 400 });
      }
      data[column] = n;
    }
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const updated = await prisma.adminSetting.upsert({
    where: { id: "singleton" },
    update: data,
    create: data,
  });
  return NextResponse.json(toPayload(updated));
}
