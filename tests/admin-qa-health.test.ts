// TASK_195 S2 — static invariants for the admin QA-health surface:
//   1. /api/admin/health — admin session required BEFORE the battery runs;
//      no-store; no new PrismaClient (uses the shared singleton via createQaDb);
//      no admin-string in the file.
//   2. lib/qa/battery.ts — exports the SHARED adapters (createQaDb /
//      createFsDeps / discoverInternalRoutes / resolveOwnOrigin) so CLI and
//      route run the IDENTICAL battery.
//   3. scripts/qa-battery.ts — imports those adapters (no duplicated fs logic).
//   4. components/admin/health-panel.tsx — click-to-run only (no auto-run),
//      fetches the route, renders PASS/WARN/FAIL/SKIP, no admin-string, and
//      never imports lib/qa (server module → would poison the client bundle).
//   5. admin-panel.tsx — "health" tab registered, rendered, and imported.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ADMIN_FRAGMENT = "topsecret6199";

function read(rel: string): string {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}

test("health route: admin session guard runs BEFORE the battery", () => {
  const src = read("app/api/admin/health/route.ts");
  const guard = src.indexOf("getAdminSession");
  const battery = src.indexOf("runBattery(");
  assert.ok(guard > 0 && battery > guard, "getAdminSession must be called before runBattery");
  assert.match(src, /status: 401/, "anon callers must get 401");
});

test("health route: no-store + shared prisma (no new PrismaClient) + no admin-string", () => {
  const src = read("app/api/admin/health/route.ts");
  assert.match(src, /cache-control": "no-store"/, "every run must be fresh, never cached");
  assert.match(src, /createQaDb\(prisma/, "must use the shared prisma singleton");
  assert.doesNotMatch(src, /new PrismaClient/, "route must not construct its own client");
  assert.ok(!src.includes(ADMIN_FRAGMENT), "admin-string must not appear in the route");
});

test("battery exports the shared adapters used by CLI + route", () => {
  const src = read("lib/qa/battery.ts");
  for (const name of ["createQaDb", "createFsDeps", "discoverInternalRoutes", "resolveOwnOrigin"]) {
    assert.match(src, new RegExp(`export (async )?function ${name}\\b`), `${name} must be exported`);
  }
});

test("CLI imports the shared adapters instead of duplicating them", () => {
  const src = read("scripts/qa-battery.ts");
  assert.match(src, /createFsDeps,\s*\n\s*createQaDb,\s*\n\s*discoverInternalRoutes,\s*\n\s*resolveOwnOrigin/,
    "CLI must import the shared adapters from ../lib/qa/battery");
  assert.doesNotMatch(src, /function fsDeps\(/, "fsDeps must not be redefined in the CLI");
  assert.doesNotMatch(src, /function discoverInternalRoutes\(/, "discoverInternalRoutes must not be redefined");
  assert.doesNotMatch(src, /function resolveOrigin\(/, "origin resolution must not be redefined");
});

test("health panel: click-to-run only (no auto-run) via the admin route", () => {
  const src = read("components/admin/health-panel.tsx");
  assert.match(src, /fetch\("\/api\/admin\/health"/, "must fetch the health route");
  assert.match(src, /cache: "no-store"/, "must not cache the verdict");
  assert.doesNotMatch(src, /useEffect/, "battery must run on click only — never auto-run on mount/tab focus");
  assert.match(src, /Run health battery/, "needs the run button label");
  assert.ok(!src.includes(ADMIN_FRAGMENT), "admin-string must not appear in the panel");
});

test("health panel: renders all four statuses and never imports lib/qa", () => {
  const src = read("components/admin/health-panel.tsx");
  assert.match(src, /PASS/);
  assert.match(src, /WARN/);
  assert.match(src, /FAIL/);
  assert.match(src, /SKIP/);
  assert.doesNotMatch(src, /from "@\/lib\/qa/,
    "client panel must not import the server battery module (node:fs + prisma → breaks the client bundle)");
});

test("admin panel: health tab registered, rendered, imported", () => {
  const src = read("app/admin=topsecret6199/(protected)/admin-panel.tsx");
  assert.match(src, /"routes" \| "health"/, "Tab type must include health");
  assert.match(src, /\{ id: "health", label: "Health" \}/, "TABS must list the Health entry");
  assert.match(src, /tab === "health" && <HealthPanel \/>/, "health tab must render the panel");
  assert.match(src, /import \{ HealthPanel \} from "@\/components\/admin\/health-panel"/, "panel must be imported");
});
