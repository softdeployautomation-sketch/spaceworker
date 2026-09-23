import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdminSession } from "@/lib/admin-auth";
import { getAdminSettings } from "@/lib/admin-settings";
import { resolveCloneSettings, type CloneSettings } from "@/lib/clone-settings";

// TASK_107 (B1) deliverable 3 — the admin dials for Browser Clone, mirroring
// app/api/admin/admission-control: enabled + limits + LIVE counts, so the owner
// can see "1 of 2 in use" while deciding a cap instead of only the static number
// (CROSS-TRACK RULE 7 — every limit is an AdminSetting, nothing hardwired).
//
// PATCH is a subset update: the panel sends only the field it changed, so editing
// one dial can never clobber another. No clone behaviour is driven from here —
// TASK_109/110 read the same settings through lib/clone-settings.ts.

// A clone job in any of these states is FINISHED, so a "live" count only counts
// work still in flight. Keep in sync with the canonical union in TASK_109
// (lib/clone.ts); the bare "expired" is the pre-TASK_109 value.
const TERMINAL_JOB_STATUSES = [
  "expired",
  "expired_idle",
  "expired_hard",
  "revoked",
  "deleted",
  "failed",
];

type LiveCounts = {
  /** Hosted browser sessions starting/running right now (the RAM consumers). */
  activeSessions: number;
  /** Clone jobs not in a terminal state (queued + in-flight + active). */
  activeJobs: number;
  /** Devices provisioned as hosted clone PCs (Device.deviceKind = "hosted"). */
  pooledHosts: number;
  /** Of those, how many are actually holding a live session. */
  sessionHosts: number;
  relaysUp: number;
  relaysDown: number;
  relaysUnknown: number;
};

async function liveCounts(): Promise<LiveCounts> {
  const [
    activeSessions,
    activeJobs,
    pooledHosts,
    sessionHostRows,
    relaysUp,
    relaysDown,
    relaysUnknown,
  ] = await Promise.all([
    prisma.hostedBrowserSession.count({ where: { status: { in: ["starting", "running"] } } }),
    prisma.cloneJob.count({ where: { status: { notIn: TERMINAL_JOB_STATUSES } } }),
    prisma.device.count({ where: { deviceKind: "hosted" } }),
    prisma.hostedBrowserSession.findMany({
      where: { status: { in: ["starting", "running"] } },
      select: { deviceId: true },
      distinct: ["deviceId"],
    }),
    prisma.relayHealth.count({ where: { status: "up" } }),
    prisma.relayHealth.count({ where: { status: "down" } }),
    prisma.relayHealth.count({ where: { status: { notIn: ["up", "down"] } } }),
  ]);

  return {
    activeSessions,
    activeJobs,
    pooledHosts,
    sessionHosts: sessionHostRows.length,
    relaysUp,
    relaysDown,
    relaysUnknown,
  };
}

// The writable subset, mapped to its AdminSetting column. Field names here match
// lib/clone-settings.ts (not the column names), so the API and the panel speak
// the same language as the typed reader.
const WRITABLE_FIELDS = {
  maxConcurrent: { column: "cloneMaxConcurrent", kind: "int" },
  perUserCap: { column: "clonePerUserCap", kind: "int" },
  hostedPoolSize: { column: "hostedPoolSize", kind: "int" },
  idleTtlMinutes: { column: "cloneIdleTtlMinutes", kind: "int" },
  hardTtlMinutes: { column: "cloneHardTtlMinutes", kind: "int" },
  purgeAfterDays: { column: "clonePurgeAfterDays", kind: "int" },
  directEgressPremiumOnly: { column: "cloneDirectEgressPremiumOnly", kind: "bool" },
  relayRequired: { column: "cloneRelayRequired", kind: "bool" },
  enabled: { column: "cloneSessionsEnabled", kind: "bool" },
} as const;

const WRITABLE_KEYS = Object.keys(WRITABLE_FIELDS) as Array<keyof typeof WRITABLE_FIELDS>;

// The full state the panel renders, always returned fresh from both GET and PATCH
// so the UI can swap its state wholesale instead of merging field by field.
function toPayload(settings: CloneSettings, live: LiveCounts) {
  return {
    enabled: settings.enabled,
    limits: {
      maxConcurrent: settings.maxConcurrent,
      perUserCap: settings.perUserCap,
      hostedPoolSize: settings.hostedPoolSize,
      idleTtlMinutes: settings.idleTtlMinutes,
      hardTtlMinutes: settings.hardTtlMinutes,
      purgeAfterDays: settings.purgeAfterDays,
    },
    policy: {
      directEgressPremiumOnly: settings.directEgressPremiumOnly,
      relayRequired: settings.relayRequired,
    },
    live,
  };
}

export async function GET() {
  const isAdmin = await requireAdminSession();
  if (!isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const [settings, live] = await Promise.all([getAdminSettings(), liveCounts()]);
  return NextResponse.json(toPayload(resolveCloneSettings(settings), live));
}

// PATCH — body: a SUBSET of { enabled?, maxConcurrent?, perUserCap?, hostedPoolSize?,
// idleTtlMinutes?, hardTtlMinutes?, purgeAfterDays?, directEgressPremiumOnly?,
// relayRequired? }. Counts must be whole numbers >= 1 (a 0 cap would read as "no
// clones ever" and is rejected rather than stored).
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

  const data: Record<string, boolean | number> = {};
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

  // Same upsert-into-singleton pattern getAdminSettings() uses, so the very first
  // PATCH (before any GET created the row) works and nobody else's value is lost.
  const updated = await prisma.adminSetting.upsert({
    where: { id: "singleton" },
    update: data,
    create: data,
  });

  const live = await liveCounts();
  return NextResponse.json(toPayload(resolveCloneSettings(updated), live));
}
