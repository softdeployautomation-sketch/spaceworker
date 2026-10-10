// TASK_195 S1 — QA health battery CORE.
//
// Owner's ask: "all possible tests that a QA engineer would test and automate …
// correct status on all endpoints WITHOUT costing or causing issues …
// transparent on the admin UI … I can run to check if all is well after deploy."
//
// Design rules (from TASK_195_QA_HEALTH_BATTERY.md, hard constraints):
//   1. READ-ONLY. Sweep routes are POSTed WITHOUT the bearer key so
//      requireInternalBearer 401s BEFORE any work — we assert the guard exists,
//      we never run a sweep. No email, no telegram, no writes.
//   2. No schema change / no migration / no env edits. Missing config = WARN,
//      values NEVER printed (booleans only).
//   3. Bounded: every HTTP probe carries its own timeout (PROBE_TIMEOUT_MS).
//   4. Dependency-INJECTED (fetch, db, fs, env, clock) in the same fake-able
//      style as the rest of the suite. NO "server-only", NO Next imports, NO
//      prisma import — the db side is a STRUCTURAL QaDb interface so the CLI
//      supplies a real PrismaClient and tests supply a fake.
//   5. Drift detector: internal routes are DISCOVERED by the caller (CLI/route)
//      from app/api/internal/** — a new sweep is covered the day it ships.

import { readdirSync, readFileSync, statSync, statfsSync } from "node:fs";
import { join } from "node:path";
import { renderCarrierVbs } from "../vantra-carrier";

export type QaStatus = "pass" | "warn" | "fail" | "skip";

export type QaGroup =
  | "platform"
  | "access"
  | "internal"
  | "freshness"
  | "carrier"
  | "build"
  | "vantra"
  | "config";

export const QA_GROUPS: readonly QaGroup[] = [
  "platform",
  "access",
  "internal",
  "freshness",
  "carrier",
  "build",
  "vantra",
  "config",
] as const;

export interface QaProbe {
  id: string;
  group: QaGroup;
  label: string;
  status: QaStatus;
  /** Human detail. NEVER contains secret values — booleans/counts only. */
  detail?: string;
  ms?: number;
}

export interface QaReport {
  ranAt: string;
  origin: string;
  durationMs: number;
  probes: QaProbe[];
  counts: { pass: number; warn: number; fail: number; skip: number };
}

/** Structural DB contract — the CLI implements it with a real PrismaClient. */
export interface QaDb {
  /** Cheap round-trip (SELECT 1). Throw = connection broken. */
  ping(): Promise<void>;
  /**
   * Unfinished or rolled-back rows in `_prisma_migrations` that have NO
   * successful sibling row with the same name — i.e. migrations that never
   * applied at all. A rolled-back first attempt superseded seconds later by a
   * successful retry is NORMAL Prisma history (proven pair on the box:
   * assistant_foundation, 2026-09-22) and is counted by
   * `staleMigrationArtifacts` instead — not here.
   * Returns -1 when the table itself is unreadable (treated as FAIL — a
   * platform without a migration ledger is not a healthy platform).
   */
  unfinishedMigrations(): Promise<number>;
  /** Rolled-back rows superseded by a successful same-name row (cosmetic ledger noise → WARN). */
  staleMigrationArtifacts(): Promise<number>;
  /** Newest `createdAt` of DeviceScreenshot / UserPresenceEvent, or null. */
  newestCreatedAt(model: "DeviceScreenshot" | "UserPresenceEvent"): Promise<Date | null>;
  /** Device rows — used to detect a silent 2xx on the anon register probe. */
  deviceCount(): Promise<number>;
}

export interface QaDeps {
  db: QaDb;
  fetchImpl: typeof fetch;
  env: Record<string, string | undefined>;
  /** Own-origin base URL for the access probes, e.g. http://127.0.0.1:3500. */
  origin: string;
  now?: () => number;
  /** `.next/BUILD_ID` contents, or null when no build is present. */
  readBuildId(): Promise<string | null>;
  /** Age of that build in ms, or null. */
  buildAgeMs(): Promise<number | null>;
  /** Files under `.next/static/chunks` containing the secret admin string. */
  secretAdminChunkHits(): Promise<number | null>;
  /** Free disk %, or null when unmeasurable. */
  diskFreePct(): Promise<number | null>;
  /** Process uptime seconds. */
  uptimeSec(): number;

  /**
   * Internal API paths (e.g. ["/api/internal/retention-sweep", …]) discovered
   * from the filesystem by the caller. Dynamic-segment routes are skipped by
   * the discoverer.
   */
  internalRoutes(): Promise<string[]>;
  /** Injected so tests can sabotage it; defaults to the REAL renderer. */
  renderCarrier?: typeof renderCarrierVbs;
}

export interface QaOptions {
  /** Restrict to these groups (default: all). */
  groups?: readonly QaGroup[];
}

/** Per-probe wall-clock budget for HTTP probes (owner: "bounded … in seconds"). */
export const PROBE_TIMEOUT_MS = 5_000;

/** The secret admin surface fragment (a route dir name already in the repo). */
export const SECRET_ADMIN_FRAGMENT = "topsecret6199";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function fmtAge(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 90) return `${m}m ago`;
  const h = Math.round(m / 60);
  return `${h}h ago`;
}

async function timed<T>(
  fn: () => Promise<T> | T,
): Promise<{ ok: true; value: T; ms: number } | { ok: false; error: string; ms: number }> {
  const t0 = Date.now();
  try {
    return { ok: true, value: await fn(), ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), ms: Date.now() - t0 };
  }
}

// ---------------------------------------------------------------------------
// The battery
// ---------------------------------------------------------------------------

export async function runBattery(deps: QaDeps, opts: QaOptions = {}): Promise<QaReport> {
  const t0 = Date.now();
  const now = deps.now ?? Date.now;
  const render = deps.renderCarrier ?? renderCarrierVbs;
  const wanted = new Set<QaGroup>(opts.groups ?? QA_GROUPS);
  const probes: QaProbe[] = [];
  const push = (p: QaProbe): void => void probes.push(p);

  const http = async (
    id: string,
    group: QaGroup,
    label: string,
    path: string,
    init: RequestInit,
    expect: (status: number) => boolean,
    okDetail: (status: number) => string,
  ): Promise<void> => {
    const r = await timed(async () => {
      const res = await deps.fetchImpl(`${deps.origin}${path}`, {
        ...init,
        // See FIRST-response status only. With the default redirect:"follow",
        // a 307→/login would land on 200 and false-fail probes like the secret
        // surface check ("must never be 200").
        redirect: "manual",
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      // Consume the body so sockets don't linger; content is irrelevant.
      await res.text().catch(() => undefined);
      return res.status;
    });
    if (!r.ok) {
      push({ id, group, label, status: "fail", detail: `network: ${r.error}`, ms: r.ms });
      return;
    }
    push({
      id,
      group,
      label,
      status: expect(r.value) ? "pass" : "fail",
      detail: okDetail(r.value),
      ms: r.ms,
    });
  };


  // -- platform ------------------------------------------------------------

  if (wanted.has("platform")) {
    const ping = await timed(() => deps.db.ping());
    push({
      id: "db-ping",
      group: "platform",
      label: "Database round-trip (SELECT 1)",
      status: ping.ok ? "pass" : "fail",
      detail: ping.ok ? "connected" : `error: ${ping.error}`,
      ms: ping.ms,
    });

    const mig = await timed(() => deps.db.unfinishedMigrations());
    if (!mig.ok) {
      push({ id: "migrations", group: "platform", label: "Migration ledger", status: "fail", detail: mig.error, ms: mig.ms });
    } else if (mig.value === 0) {
      push({ id: "migrations", group: "platform", label: "Migration ledger", status: "pass", detail: "0 unfinished / rolled-back", ms: mig.ms });
    } else if (mig.value < 0) {
      push({ id: "migrations", group: "platform", label: "Migration ledger", status: "fail", detail: "_prisma_migrations unreadable", ms: mig.ms });
    } else {
      push({ id: "migrations", group: "platform", label: "Migration ledger", status: "fail", detail: `${mig.value} unfinished with NO successful retry (real)`, ms: mig.ms });
    }

    const stale = await timed(() => deps.db.staleMigrationArtifacts());
    if (!stale.ok) {
      push({ id: "migration-artifacts", group: "platform", label: "Ledger stale rows", status: "warn", detail: stale.error, ms: stale.ms });
    } else if (stale.value < 0) {
      push({ id: "migration-artifacts", group: "platform", label: "Ledger stale rows", status: "warn", detail: "_prisma_migrations unreadable", ms: stale.ms });
    } else if (stale.value === 0) {
      push({ id: "migration-artifacts", group: "platform", label: "Ledger stale rows", status: "pass", detail: "0 superseded rows", ms: stale.ms });
    } else {
      // Cosmetic: a failed first attempt later superseded by a successful
      // retry (assistant_foundation, 2026-09-22 — rolled back 12:37:52,
      // succeeded 12:37:55). The schema IS applied; only the ledger row noise remains.
      push({ id: "migration-artifacts", group: "platform", label: "Ledger stale rows", status: "warn", detail: `${stale.value} rolled-back row(s) superseded by successful retries (cosmetic)`, ms: stale.ms });
    }

    const bid = await timed(() => deps.readBuildId());
    const age = await timed(() => deps.buildAgeMs());
    const buildId = bid.ok ? bid.value : null;
    const ageMs = age.ok ? age.value : null;
    if (!buildId) {
      push({ id: "build-id", group: "platform", label: "Next.js build", status: "warn", detail: "no .next/BUILD_ID found" });
    } else if (ageMs !== null && ageMs > 7 * 24 * 3600_000) {
      push({ id: "build-id", group: "platform", label: "Next.js build", status: "warn", detail: `${buildId} (stale: ${fmtAge(ageMs)})` });
    } else {
      push({ id: "build-id", group: "platform", label: "Next.js build", status: "pass", detail: ageMs !== null ? `${buildId} (${fmtAge(ageMs)})` : buildId });
    }

    const disk = await timed(() => deps.diskFreePct());
    if (!disk.ok || disk.value === null) {
      push({ id: "disk", group: "platform", label: "Free disk", status: "skip", detail: "unmeasurable here" });
    } else if (disk.value < 5) {
      push({ id: "disk", group: "platform", label: "Free disk", status: "fail", detail: `${disk.value.toFixed(1)}% free (<5%)` });
    } else if (disk.value < 15) {
      push({ id: "disk", group: "platform", label: "Free disk", status: "warn", detail: `${disk.value.toFixed(1)}% free (<15%)` });
    } else {
      push({ id: "disk", group: "platform", label: "Free disk", status: "pass", detail: `${disk.value.toFixed(1)}% free` });
    }

    const up = deps.uptimeSec();
    const upH = up / 3600;
    push({
      id: "uptime",
      group: "platform",
      label: "Process uptime",
      status: "pass",
      detail: upH >= 1 ? `${upH.toFixed(1)}h` : `${Math.round(up / 60)}m`,
    });
  }


  // -- access (anonymous HTTP against our own origin) ----------------------

  if (wanted.has("access")) {
    const before = await timed(() => deps.db.deviceCount());

    await http(
      "anon-login",
      "access",
      "Anonymous GET /login",
      "/login",
      { method: "GET" },
      (s) => s === 200,
      (s) => `GET /login → ${s} (expect 200)`,
    );

    await http(
      "anon-device-register",
      "access",
      "Anonymous POST /api/devices {}",
      "/api/devices",
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      // TASK_195 S3 live-run correction: this route is GET-only (agent
      // registration lives in Vantra), so a bare POST correctly answers 405 —
      // no anon WRITE surface exists at all, which is even stricter than the
      // 401 the probe originally expected. Both are secure answers.
      (s) => s === 401 || s === 405,
      (s) => `POST /api/devices → ${s} (expect 401 or 405 — no anon write surface)`,
    );

    // If that ever slips through as 2xx it may have CREATED a row — surface it.
    const after = await timed(() => deps.db.deviceCount());
    if (before.ok && after.ok && after.value > before.value) {
      push({
        id: "anon-register-side-effect",
        group: "access",
        label: "Anon register created rows?!",
        status: "fail",
        detail: `Device count grew ${before.value} → ${after.value} during the battery — the 401 gate is broken`,
      });
    } else {
      push({
        id: "anon-register-side-effect",
        group: "access",
        label: "Anon register side-effect check",
        status: "pass",
        detail: before.ok && after.ok ? `Device count unchanged (${after.value})` : "count unavailable — skipped",
      });
    }

    await http(
      "anon-admin-api",
      "access",
      "Anonymous GET /api/admin/users",
      "/api/admin/users",
      { method: "GET" },
      (s) => s !== 200,
      (s) => `→ ${s} (must not be 200)`,
    );

    await http(
      "secret-surface",
      "access",
      `Secret admin surface /admin=${SECRET_ADMIN_FRAGMENT}`,
      `/admin=${SECRET_ADMIN_FRAGMENT}`,
      { method: "GET" },
      (s) => s !== 200,
      (s) => `→ ${s} (must never be 200)`,
    );
  }


  // -- internal sweep guards (drift detector) ------------------------------

  if (wanted.has("internal")) {
    const routes = await timed(() => deps.internalRoutes());
    if (!routes.ok) {
      push({ id: "internal-discovery", group: "internal", label: "Internal route discovery", status: "warn", detail: routes.error });
    } else if (routes.value.length === 0) {
      push({ id: "internal-discovery", group: "internal", label: "Internal route discovery", status: "warn", detail: "no internal routes discovered — is the app dir mounted?" });
    } else {
      for (const path of routes.value) {
        const id = `internal-guard:${path.replace(/^\/api\/internal\//, "")}`;
        await http(
          id,
          "internal",
          `Guard ${path} (POST, no bearer)`,
          path,
          { method: "POST" },
          (s) => s === 401,
          (s) => `→ ${s} (expect 401 before any work)`,
        );
      }
    }
  }

  // -- freshness (derived from row ages — no run history, stateless v1) ----

  if (wanted.has("freshness")) {
    const ageProbe = async (
      id: string,
      label: string,
      model: "DeviceScreenshot" | "UserPresenceEvent",
      staleWarnMs: number,
    ): Promise<void> => {
      const r = await timed(() => deps.db.newestCreatedAt(model));
      if (!r.ok) {
        push({ id, group: "freshness", label, status: "fail", detail: r.error, ms: r.ms });
        return;
      }
      if (r.value === null) {
        push({ id, group: "freshness", label, status: "skip", detail: "no rows — pipeline unused (not a red)" });
        return;
      }
      const age = now() - r.value.getTime();
      const detail = `newest ${r.value.toISOString()} (${fmtAge(age)})`;
      push({
        id,
        group: "freshness",
        label,
        status: age > staleWarnMs ? "warn" : "pass",
        detail: age > staleWarnMs ? `STALE — ${detail}` : detail,
        ms: r.ms,
      });
    };
    await ageProbe("fresh-screenshots", "Screenshot pipeline freshness", "DeviceScreenshot", 6 * 3600_000);
    await ageProbe("fresh-presence", "Presence pipeline freshness", "UserPresenceEvent", 30 * 60_000);
  }


  // -- carrier (in-process tripwire for the TASK_194 R1/R2 class) ----------

  if (wanted.has("carrier")) {
    const r = await timed(() => {
      // Shape identical to a real mint: single-line, double-quote-free.
      const vbs = render("irm https://vantra.test/i.ps1 | iex -m install --silent", {});
      const has = (s: string): boolean => vbs.includes(s);
      const problems: string[] = [];
      if (!has("WindowStyle Hidden")) problems.push("missing WindowStyle Hidden");
      if (!has("--silent")) problems.push("missing --silent");
      if (has("sc.exe")) problems.push("contains sc.exe (console window regression)");
      if (has("unins000")) problems.push("contains unins000 (uninstall leak)");
      if (problems.length > 0) throw new Error(problems.join("; "));
      return vbs.length;
    });
    push({
      id: "carrier-shape",
      group: "carrier",
      label: "VBS carrier shape (silent-install tripwire)",
      status: r.ok ? "pass" : "fail",
      detail: r.ok ? `rendered ${r.value} chars — Hidden + --silent, no sc.exe/unins000` : r.error,
      ms: r.ms,
    });
  }

  // -- build (the secret-string leak gate, automated) ----------------------

  if (wanted.has("build")) {
    const r = await timed(() => deps.secretAdminChunkHits());
    if (!r.ok || r.value === null) {
      push({ id: "build-leak", group: "build", label: "Secret admin string in client chunks", status: "skip", detail: ".next not present here" });
    } else if (r.value === 0) {
      push({ id: "build-leak", group: "build", label: "Secret admin string in client chunks", status: "pass", detail: "0 hits", ms: r.ms });
    } else {
      push({ id: "build-leak", group: "build", label: "Secret admin string in client chunks", status: "fail", detail: `${r.value} chunk file(s) leak the admin string`, ms: r.ms });
    }
  }

  // -- vantra (the R5 class: link minting dies when the twin is down) ------

  if (wanted.has("vantra")) {
    const url = deps.env.VANTRA_URL?.trim();
    if (!url) {
      push({ id: "vantra-reach", group: "vantra", label: "Vantra reachable", status: "skip", detail: "VANTRA_URL not configured" });
    } else {
      const r = await timed(async () => {
        const res = await deps.fetchImpl(url, { method: "GET", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
        await res.text().catch(() => undefined);
        return res.status;
      });
      // ANY HTTP response = the twin is alive; only a network error is a red.
      push({
        id: "vantra-reach",
        group: "vantra",
        label: "Vantra reachable",
        status: r.ok ? "pass" : "fail",
        detail: r.ok ? `HTTP ${r.value} from VANTRA_URL` : `unreachable: ${r.error}`,
        ms: r.ms,
      });
    }
  }

  // -- config (presence booleans only — values NEVER printed) --------------

  if (wanted.has("config")) {
    const keys = [
      ["INTERNAL_BEARER_TOKEN", "internal bearer"],
      ["TELEGRAM_BOT_TOKEN", "telegram"],
      ["RESEND_API_KEY", "resend"],
    ] as const;
    for (const [key, label] of keys) {
      const configured = (deps.env[key] ?? "").trim().length > 0;
      push({
        id: `config-${key.toLowerCase().replace(/_/g, "-")}`,
        group: "config",
        label: `${label} configured`,
        status: configured ? "pass" : "warn",
        detail: configured ? "configured: yes" : "configured: no (feature degraded)",
      });
    }
  }

  const counts = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const p of probes) counts[p.status] += 1;
  return {
    ranAt: new Date(now()).toISOString(),
    origin: deps.origin,
    durationMs: Date.now() - t0,
    probes,
    counts,
  };
}


// ---------------------------------------------------------------------------
// Real-dependency adapters — SHARED by the CLI (scripts/qa-battery.ts) and the
// admin /api/admin/health route (TASK_195 S2) so both run the IDENTICAL
// battery. Dependency-INJECTED by design (header rule 4): the db adapter takes
// a STRUCTURAL client, never importing @prisma/client here.
// ---------------------------------------------------------------------------

/** Structural shape of the Prisma client the battery needs (nothing more). */
export interface QaPrismaLike {
  $queryRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
  deviceScreenshot: {
    findFirst(args: Record<string, unknown>): Promise<{ createdAt: Date } | null>;
  };
  userPresenceEvent: {
    findFirst(args: Record<string, unknown>): Promise<{ createdAt: Date } | null>;
  };
  device: { count(): Promise<number> };
}

/** Structural QaDb backed by any client matching QaPrismaLike (real or fake). */
export function createQaDb(client: QaPrismaLike): QaDb {
  return {
    async ping() {
      await client.$queryRaw`SELECT 1`;
    },
    async unfinishedMigrations() {
      try {
        const rows = await client.$queryRaw`SELECT 1 FROM "_prisma_migrations" r WHERE ("finished_at" IS NULL OR "rolled_back_at" IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM "_prisma_migrations" r2 WHERE r2."migration_name" = r."migration_name" AND r2."finished_at" IS NOT NULL AND r2."rolled_back_at" IS NULL)`;
        return (rows as unknown[]).length;
      } catch {
        return -1;
      }
    },
    async staleMigrationArtifacts() {
      try {
        const rows = await client.$queryRaw`SELECT 1 FROM "_prisma_migrations" r WHERE "rolled_back_at" IS NOT NULL AND EXISTS (SELECT 1 FROM "_prisma_migrations" r2 WHERE r2."migration_name" = r."migration_name" AND r2."finished_at" IS NOT NULL AND r2."rolled_back_at" IS NULL)`;
        return (rows as unknown[]).length;
      } catch {
        return -1;
      }
    },
    async newestCreatedAt(model) {
      if (model === "DeviceScreenshot") {
        const r = await client.deviceScreenshot.findFirst({ orderBy: { createdAt: "desc" }, select: { createdAt: true } });
        return r?.createdAt ?? null;
      }
      const r = await client.userPresenceEvent.findFirst({ orderBy: { createdAt: "desc" }, select: { createdAt: true } });
      return r?.createdAt ?? null;
    },
    async deviceCount() {
      return client.device.count();
    },
  };
}

/** Filesystem-truth deps: .next build state, disk, uptime. */
export function createFsDeps(root: string = process.cwd()): Pick<QaDeps, "readBuildId" | "buildAgeMs" | "secretAdminChunkHits" | "diskFreePct" | "uptimeSec"> {
  return {
    async readBuildId() {
      try {
        return readFileSync(join(root, ".next/BUILD_ID"), "utf8").trim();
      } catch {
        return null;
      }
    },
    async buildAgeMs() {
      try {
        return Date.now() - statSync(join(root, ".next/BUILD_ID")).mtimeMs;
      } catch {
        return null;
      }
    },
    async secretAdminChunkHits() {
      const dir = join(root, ".next/static/chunks");
      let files: string[];
      try {
        files = readdirSync(dir, { recursive: true }) as unknown as string[];
      } catch {
        return null; // no build here → battery marks SKIP
      }
      let hits = 0;
      for (const f of files) {
        if (!f.endsWith(".js")) continue;
        try {
          if (readFileSync(join(dir, f), "utf8").includes(SECRET_ADMIN_FRAGMENT)) hits += 1;
        } catch {
          /* unreadable chunk — ignore */
        }
      }
      return hits;
    },
    async diskFreePct() {
      try {
        const s = statfsSync("/");
        const total = s.blocks * s.bsize;
        const free = s.bavail * s.bsize;
        return total > 0 ? (free / total) * 100 : null;
      } catch {
        return null;
      }
    },
    uptimeSec: () => process.uptime(),
  };
}

/**
 * Drift detector: static internal routes from the app dir (dynamic → skipped).
 * A directory only counts when it actually CONTAINS a `route.ts` — app/api
 * trees legitimately hold dirs with just a `[id]` subdir (no endpoint), and
 * listing those made the guard probe 404 and cry wolf (TASK_195 S3 live run).
 */
export function discoverInternalRoutes(root: string = process.cwd()): string[] {
  const dir = join(root, "app/api/internal");
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith("[")) continue; // v1: static paths only
    try {
      if (!statSync(join(dir, name, "route.ts")).isFile()) continue;
    } catch {
      continue; // no route.ts at the top of this dir → not a route
    }
    out.push(`/api/internal/${name}`);
  }
  return out.sort();
}

/**
 * Own-origin resolution for the access probes: QA_ORIGIN → PORT → :3500 →
 * :3000, first to ANSWER wins. (The box's .env PORT=3400 disagrees with its
 * true listener :3500 — TASK_194 S6 fact — so we probe instead of trusting
 * one source.) `extra` lets the CLI prepend its --origin= flag.
 */
export async function resolveOwnOrigin(
  extra: string[] = [],
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const candidates: string[] = [...extra];
  if (process.env.QA_ORIGIN) candidates.push(process.env.QA_ORIGIN.replace(/\/$/, ""));
  const port = process.env.PORT ?? "3400";
  candidates.push(`http://127.0.0.1:${port}`);
  candidates.push("http://127.0.0.1:3500");
  candidates.push("http://127.0.0.1:3000");

  const seen = new Set<string>();
  for (const url of candidates) {
    if (seen.has(url)) continue;
    seen.add(url);
    try {
      const res = await fetchImpl(`${url}/login`, { signal: AbortSignal.timeout(2_000) });
      await res.text().catch(() => undefined);
      return url; // any HTTP answer = this is our origin
    } catch {
      /* try next */
    }
  }
  // Nothing answered — fall back to the first candidate so the battery's
  // access probes run anyway and report their own network failures.
  return [...seen][0] ?? "http://127.0.0.1:3500";
}

