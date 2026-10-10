// TASK_195 S1 — QA health battery unit tests (fully hermetic: fake deps, no
// network, no DB, no fs). Pins every probe's verdict mapping so the battery's
// own judgments can never drift silently — including the two trap classes:
// the anonymous-register side-effect check and the secret-surface redirect
// false-fail (redirect:"manual" is asserted via the shared http() contract).

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROBE_TIMEOUT_MS,
  QA_GROUPS,
  SECRET_ADMIN_FRAGMENT,
  discoverInternalRoutes,
  runBattery,
  type QaDb,
  type QaDeps,
  type QaGroup,
  type QaProbe,
  type QaReport,
} from "../lib/qa/battery";

// ---------------------------------------------------------------------------
// Fake deps — every dependency injectable, matching the core's DI contract.
// ---------------------------------------------------------------------------

type FetchResult = number | "throw";

/** Minimal fetchImpl: routes PATH → fixed status, "*" → network throw. */
function fakeFetch(routes: Record<string, FetchResult>): typeof fetch {
  return (async (url: RequestInfo | URL) => {
    const path = new URL(String(url)).pathname;
    const hit = routes[path] ?? routes["*"] ?? 404;
    if (hit === "throw") throw new Error(`ECONNREFUSED ${path}`);
    return { status: hit, text: async () => "" } as unknown as Response;
  }) as typeof fetch;
}

interface FakeDbOpts {
  pingThrows?: boolean;
  unfinished?: number;
  unfinishedThrows?: boolean;
  stale?: number;
  newest?: Partial<Record<"DeviceScreenshot" | "UserPresenceEvent", Date | null>>;
  newestThrows?: boolean;
  devices?: number;
}

function fakeDb(o: FakeDbOpts = {}): QaDb {
  return {
    async ping() {
      if (o.pingThrows) throw new Error("db down");
    },
    async unfinishedMigrations() {
      if (o.unfinishedThrows) throw new Error("ledger unreadable");
      return o.unfinished ?? 0;
    },
    async staleMigrationArtifacts() {
      return o.stale ?? 0;
    },
    async newestCreatedAt(model) {
      if (o.newestThrows) throw new Error("query failed");
      return o.newest?.[model] ?? null;
    },
    async deviceCount() {
      return o.devices ?? 10;
    },
  };
}

const HEALTHY_ROUTES: Record<string, FetchResult> = {
  "/login": 200,
  "/api/devices": 401,
  "/api/admin/users": 401,
  "/api/internal/retention-sweep": 401,
  "/api/internal/screen-notify-sweep": 401,
  [`/admin=${SECRET_ADMIN_FRAGMENT}`]: 307,
};

function baseDeps(over: Partial<QaDeps> = {}): QaDeps {
  return {
    db: fakeDb(),
    fetchImpl: fakeFetch(HEALTHY_ROUTES),
    env: {
      INTERNAL_BEARER_TOKEN: "x",
      TELEGRAM_BOT_TOKEN: "x",
      RESEND_API_KEY: "x",
      // TASK_200 S1 — production configures the app via VANTRA_INTERNAL_URL;
      // VANTRA_URL is legacy and only honored as a fallback by the probe.
      VANTRA_INTERNAL_URL: "https://vantra.test",
    },
    origin: "http://qa.test",
    readBuildId: async () => "build-abc",
    buildAgeMs: async () => 3_600_000,
    secretAdminChunkHits: async () => 0,
    diskFreePct: async () => 40,
    uptimeSec: () => 3_600,
    internalRoutes: async () => ["/api/internal/retention-sweep", "/api/internal/screen-notify-sweep"],
    ...over,
  };
}

function probe(report: QaReport, id: string): QaProbe {
  const p = report.probes.find((x) => x.id === id);
  assert.ok(p, `expected probe "${id}" in report`);
  return p;
}

function groups(probes: QaProbe[]): Set<string> {
  return new Set(probes.map((p) => p.group));
}

describe("TASK_195 — battery core shape", () => {
  it("runs all 8 groups by default and counts add up", async () => {
    const r = await runBattery(baseDeps());
    assert.deepEqual(groups(r.probes), new Set(QA_GROUPS));
    const total = r.counts.pass + r.counts.warn + r.counts.fail + r.counts.skip;
    assert.equal(total, r.probes.length, "counts must equal probe count");
    assert.equal(r.origin, "http://qa.test");
    assert.ok(!Number.isNaN(Date.parse(r.ranAt)), "ranAt must be an ISO timestamp");
    assert.equal(typeof r.durationMs, "number");
  });

  it("honours the groups filter — only requested groups run", async () => {
    const r = await runBattery(baseDeps(), { groups: ["platform"] });
    assert.deepEqual(groups(r.probes), new Set<QaGroup>(["platform"]));
  });

  it("healthy everything ⇒ zero FAILs (the green baseline)", async () => {
    const r = await runBattery(baseDeps());
    assert.equal(r.counts.fail, 0, JSON.stringify(r.probes.filter((p) => p.status === "fail"), null, 2));
  });
});

describe("TASK_195 — platform probes", () => {
  it("db-ping: throw ⇒ fail with the error surfaced", async () => {
    const r = await runBattery(baseDeps({ db: fakeDb({ pingThrows: true }) }), { groups: ["platform"] });
    assert.equal(probe(r, "db-ping").status, "fail");
    assert.match(probe(r, "db-ping").detail ?? "", /db down/);
  });

  it("migrations: 0 ⇒ pass; N>0 ⇒ fail; -1 (unreadable ledger) ⇒ fail", async () => {
    assert.equal(probe(await runBattery(baseDeps({ db: fakeDb({ unfinished: 0 }) }), { groups: ["platform"] }), "migrations").status, "pass");
    const bad = await runBattery(baseDeps({ db: fakeDb({ unfinished: 2 }) }), { groups: ["platform"] });
    assert.equal(probe(bad, "migrations").status, "fail");
    assert.match(probe(bad, "migrations").detail ?? "", /2 unfinished/);
    const unreadable = await runBattery(baseDeps({ db: fakeDb({ unfinished: -1 }) }), { groups: ["platform"] });
    assert.equal(probe(unreadable, "migrations").status, "fail");
  });

  it("stale ledger rows (retry later succeeded) ⇒ migrations PASS + artifacts PASS (TASK_200 S1: history, not signal)", async () => {
    // assistant_foundation pair: rolled-back first attempt + successful retry
    // 3s later. Unresolved count 0, artifacts 1 ⇒ no FAIL and no false WARN —
    // the real-danger case (no successful retry) is the migrations FAIL above.
    const r = await runBattery(baseDeps({ db: fakeDb({ unfinished: 0, stale: 1 }) }), { groups: ["platform"] });
    assert.equal(probe(r, "migrations").status, "pass");
    const art = probe(r, "migration-artifacts");
    assert.equal(art.status, "pass");
    assert.match(art.detail ?? "", /superseded by successful retries/);
  });

  it("build-id: absent ⇒ warn; >7d ⇒ warn stale; fresh ⇒ pass", async () => {
    const absent = await runBattery(baseDeps({ readBuildId: async () => null }), { groups: ["platform"] });
    assert.equal(probe(absent, "build-id").status, "warn");
    const stale = await runBattery(baseDeps({ buildAgeMs: async () => 8 * 24 * 3_600_000 }), { groups: ["platform"] });
    assert.equal(probe(stale, "build-id").status, "warn");
    assert.match(probe(stale, "build-id").detail ?? "", /stale/);
    assert.equal(probe(await runBattery(baseDeps(), { groups: ["platform"] }), "build-id").status, "pass");
  });

  it("disk: <5% ⇒ fail, <15% ⇒ warn, else pass, null ⇒ skip", async () => {
    const at = async (pct: number | null) => probe(await runBattery(baseDeps({ diskFreePct: async () => pct }), { groups: ["platform"] }), "disk").status;
    assert.equal(await at(2), "fail");
    assert.equal(await at(10), "warn");
    assert.equal(await at(40), "pass");
    assert.equal(await at(null), "skip");
  });
});

describe("TASK_195 — access probes (anon against own origin)", () => {
  it("anon-login must see 200; a 500 fails the probe", async () => {
    const bad = await runBattery(baseDeps({ fetchImpl: fakeFetch({ ...HEALTHY_ROUTES, "/login": 500 }) }), { groups: ["access"] });
    assert.equal(probe(bad, "anon-login").status, "fail");
  });

  it("anon POST /api/devices must 401; a 2xx FAILS (gate regression)", async () => {
    const open = await runBattery(baseDeps({ fetchImpl: fakeFetch({ ...HEALTHY_ROUTES, "/api/devices": 201 }) }), { groups: ["access"] });
    assert.equal(probe(open, "anon-device-register").status, "fail");
  });

  it("405 on anon POST /api/devices is PASS — GET-only route = no write surface (S3 live-run fix)", async () => {
    // The live box answered 405 (register lives in Vantra; this route is
    // GET-only). 405 is an even stricter answer than 401 and must not cry wolf.
    const r = await runBattery(baseDeps({ fetchImpl: fakeFetch({ ...HEALTHY_ROUTES, "/api/devices": 405 }) }), { groups: ["access"] });
    assert.equal(probe(r, "anon-device-register").status, "pass");
    assert.match(probe(r, "anon-device-register").detail ?? "", /405/);
  });

  it("side-effect tripwire: device rows created during the battery ⇒ fail", async () => {
    let calls = 0;
    const counting: QaDb = {
      ...fakeDb(),
      async deviceCount() {
        calls += 1;
        return calls <= 1 ? 10 : 11; // grows between before/after
      },
    };
    const r = await runBattery(baseDeps({ db: counting }), { groups: ["access"] });
    assert.equal(probe(r, "anon-register-side-effect").status, "fail");
    assert.match(probe(r, "anon-register-side-effect").detail ?? "", /401 gate is broken/);
  });

  it("side-effect check passes when the count is unchanged", async () => {
    const r = await runBattery(baseDeps(), { groups: ["access"] });
    assert.equal(probe(r, "anon-register-side-effect").status, "pass");
  });

  it("anon /api/admin/users and the secret surface must NEVER be 200", async () => {
    const leaked = await runBattery(
      baseDeps({
        fetchImpl: fakeFetch({ ...HEALTHY_ROUTES, "/api/admin/users": 200, [`/admin=${SECRET_ADMIN_FRAGMENT}`]: 200 }),
      }),
      { groups: ["access"] },
    );
    assert.equal(probe(leaked, "anon-admin-api").status, "fail");
    assert.equal(probe(leaked, "secret-surface").status, "fail");
  });

  it("secret surface serving a 307 redirect is PASS (manual redirect contract)", async () => {
    // With redirect:"follow" the 307 would resolve to 200 (login) and false-fail.
    const r = await runBattery(baseDeps(), { groups: ["access"] });
    assert.equal(probe(r, "secret-surface").status, "pass");
    assert.match(probe(r, "secret-surface").detail ?? "", /→ 307/);
  });

  it("network failure on any access probe ⇒ fail with 'network:' detail", async () => {
    const down = await runBattery(baseDeps({ fetchImpl: fakeFetch({ "*": "throw" }) }), { groups: ["access"] });
    const p = probe(down, "anon-login");
    assert.equal(p.status, "fail");
    assert.match(p.detail ?? "", /network:/);
  });
});

describe("TASK_195 — internal sweep guards (drift detector)", () => {
  it("probes EVERY discovered route and requires 401 (no sweep ever runs)", async () => {
    const r = await runBattery(baseDeps(), { groups: ["internal"] });
    const guardIds = r.probes.filter((p) => p.id.startsWith("internal-guard:")).map((p) => p.id);
    assert.equal(guardIds.length, 2);
    assert.ok(guardIds.includes("internal-guard:retention-sweep"));
    assert.ok(guardIds.includes("internal-guard:screen-notify-sweep"));
    for (const p of r.probes.filter((x) => x.group === "internal")) {
      assert.equal(p.status, "pass", `${p.id} must 401`);
    }
  });

  it("a guard that answers 200 (bearer-less sweep runs!) ⇒ fail", async () => {
    const open = await runBattery(
      baseDeps({ fetchImpl: fakeFetch({ ...HEALTHY_ROUTES, "/api/internal/retention-sweep": 200 }) }),
      { groups: ["internal"] },
    );
    assert.equal(probe(open, "internal-guard:retention-sweep").status, "fail");
  });

  it("discovery failure / empty list ⇒ warn, never a crash", async () => {
    const boom = await runBattery(baseDeps({ internalRoutes: async () => { throw new Error("app dir gone"); } }), { groups: ["internal"] });
    assert.equal(probe(boom, "internal-discovery").status, "warn");
    const empty = await runBattery(baseDeps({ internalRoutes: async () => [] }), { groups: ["internal"] });
    assert.equal(probe(empty, "internal-discovery").status, "warn");
  });
});

describe("TASK_195 — freshness probes", () => {
  it("no rows ⇒ skip (pipeline unused is not a red)", async () => {
    const r = await runBattery(baseDeps(), { groups: ["freshness"] });
    assert.equal(probe(r, "fresh-screenshots").status, "skip");
    assert.equal(probe(r, "fresh-presence").status, "skip");
  });

  it("recent rows ⇒ pass; stale rows ⇒ warn 'STALE' (6h / 30m thresholds)", async () => {
    const now = Date.now();
    const fresh = await runBattery(
      baseDeps({ db: fakeDb({ newest: { DeviceScreenshot: new Date(now - 60_000), UserPresenceEvent: new Date(now - 60_000) } }), now: () => now }),
      { groups: ["freshness"] },
    );
    assert.equal(probe(fresh, "fresh-screenshots").status, "pass");
    assert.equal(probe(fresh, "fresh-presence").status, "pass");
    const stale = await runBattery(
      baseDeps({ db: fakeDb({ newest: { DeviceScreenshot: new Date(now - 7 * 3_600_000), UserPresenceEvent: new Date(now - 40 * 60_000) } }), now: () => now }),
      { groups: ["freshness"] },
    );
    assert.equal(probe(stale, "fresh-screenshots").status, "warn");
    assert.equal(probe(stale, "fresh-presence").status, "warn");
    assert.match(probe(stale, "fresh-presence").detail ?? "", /STALE/);
  });

  it("query error ⇒ fail (a broken freshness query hides staleness)", async () => {
    const r = await runBattery(baseDeps({ db: fakeDb({ newestThrows: true }) }), { groups: ["freshness"] });
    assert.equal(probe(r, "fresh-screenshots").status, "fail");
  });
});

describe("TASK_195 — carrier tripwire (the TASK_194 regression class)", () => {
  it("real renderer ⇒ pass (Hidden + --silent, no sc.exe/unins000)", async () => {
    const r = await runBattery(baseDeps(), { groups: ["carrier"] });
    const p = probe(r, "carrier-shape");
    assert.equal(p.status, "pass");
    assert.match(p.detail ?? "", /Hidden \+ --silent/);
  });

  it("sabotaged renderer (console window returns) ⇒ fail names the regression", async () => {
    const r = await runBattery(
      baseDeps({ renderCarrier: () => "run cmd /c sc.exe delete tacticalrmm :: WindowStyle Hidden --silent" }),
      { groups: ["carrier"] },
    );
    const p = probe(r, "carrier-shape");
    assert.equal(p.status, "fail");
    assert.match(p.detail ?? "", /sc\.exe/);
  });

  it("renderer crash ⇒ fail, battery never dies", async () => {
    const r = await runBattery(baseDeps({ renderCarrier: () => { throw new Error("renderer broke"); } }), { groups: ["carrier"] });
    assert.equal(probe(r, "carrier-shape").status, "fail");
  });
});

describe("TASK_195 — build leak gate", () => {
  it("no .next here ⇒ skip; 0 hits ⇒ pass; hits ⇒ fail", async () => {
    assert.equal(probe(await runBattery(baseDeps({ secretAdminChunkHits: async () => null }), { groups: ["build"] }), "build-leak").status, "skip");
    assert.equal(probe(await runBattery(baseDeps({ secretAdminChunkHits: async () => 0 }), { groups: ["build"] }), "build-leak").status, "pass");
    const leak = await runBattery(baseDeps({ secretAdminChunkHits: async () => 3 }), { groups: ["build"] });
    assert.equal(probe(leak, "build-leak").status, "fail");
    assert.match(probe(leak, "build-leak").detail ?? "", /3 chunk/);
  });
});

describe("TASK_200 S1 — vantra reach uses the app's real key + default, config booleans (TASK_195)", () => {
  /** fetch stub that records every URL it was asked to reach. */
  function recordingFetch(status: number, seen: string[]): typeof fetch {
    return (async (url: RequestInfo | URL) => {
      seen.push(String(url));
      return { status, text: async () => "" } as unknown as Response;
    }) as typeof fetch;
  }

  it("no env at all ⇒ probes the app default (never SKIP); HTTP answer ⇒ pass", async () => {
    const seen: string[] = [];
    const r = await runBattery(baseDeps({ env: {}, fetchImpl: recordingFetch(200, seen) }), { groups: ["vantra"] });
    assert.equal(probe(r, "vantra-reach").status, "pass");
    assert.equal(seen[0], "https://vantra.spaceworker.top", "must probe the app's default Vantra URL");
  });

  it("VANTRA_INTERNAL_URL wins over legacy VANTRA_URL; trailing slash trimmed", async () => {
    const seen: string[] = [];
    const r = await runBattery(
      baseDeps({ env: { VANTRA_INTERNAL_URL: "https://twin.internal/", VANTRA_URL: "https://legacy.test" }, fetchImpl: recordingFetch(200, seen) }),
      { groups: ["vantra"] },
    );
    assert.equal(probe(r, "vantra-reach").status, "pass");
    assert.equal(seen[0], "https://twin.internal");
  });

  it("legacy VANTRA_URL alone still honored (fallback)", async () => {
    const seen: string[] = [];
    const r = await runBattery(baseDeps({ env: { VANTRA_URL: "https://legacy.only" }, fetchImpl: recordingFetch(200, seen) }), { groups: ["vantra"] });
    assert.equal(probe(r, "vantra-reach").status, "pass");
    assert.equal(seen[0], "https://legacy.only");
  });

  it("network error ⇒ fail with the error surfaced", async () => {
    const down = await runBattery(baseDeps({ fetchImpl: fakeFetch({ "/": "throw" }) }), { groups: ["vantra"] });
    assert.equal(probe(down, "vantra-reach").status, "fail");
    assert.match(probe(down, "vantra-reach").detail ?? "", /unreachable/);
  });

  it("config probes report booleans only — NEVER the secret values", async () => {
    const secret = "super-secret-value-hunter2";
    const r = await runBattery(baseDeps({ env: { INTERNAL_BEARER_TOKEN: secret, TELEGRAM_BOT_TOKEN: "", RESEND_API_KEY: "" } }), { groups: ["config"] });
    assert.equal(probe(r, "config-internal-bearer-token").status, "pass");
    assert.equal(probe(r, "config-telegram-bot-token").status, "warn");
    assert.ok(!JSON.stringify(r).includes(secret), "secret value must never appear anywhere in the report");
  });

  it("every HTTP probe carries a bounded timeout", () => {
    assert.ok(PROBE_TIMEOUT_MS > 0 && PROBE_TIMEOUT_MS <= 10_000, "probe timeout must stay small and bounded");
  });

describe("TASK_195 S3 — discoverInternalRoutes only lists dirs WITH a route.ts", () => {
  it("skips a dir that has only a [id] subdir (the live 404 cry-wolf)", () => {
    const root = mkdtempSync(join(tmpdir(), "qa-discover-"));
    try {
      const internal = join(root, "app/api/internal");
      mkdirSync(join(internal, "real-sweep"), { recursive: true });
      writeFileSync(join(internal, "real-sweep", "route.ts"), "export async function POST() {}");
      mkdirSync(join(internal, "phantom-dir/[id]"), { recursive: true }); // dir WITHOUT route.ts
      mkdirSync(join(internal, "[orgId]"), { recursive: true }); // dynamic → skipped
      const found = discoverInternalRoutes(root);
      assert.deepEqual(found, ["/api/internal/real-sweep"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

});
