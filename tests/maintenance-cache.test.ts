/**
 * TASK_185 — maintenance responses must never be cacheable, and the wrapper's
 * polling surfaces must bypass the HTTP cache so a client that already replayed
 * maintenance HTML self-heals on the next tick.
 *
 * Root cause being locked (2026-10-08): nginx served maintenance.html during
 * the deploy-flag window with NO Cache-Control → the browser heuristic-cached
 * the HTML *for the request URL* (~1.4 days from file age) → /api/devices
 * answered "Unexpected token '<'" long after the deploy ended. Incognito (no
 * cache) worked — the classic fingerprint.
 *
 * Static locks, per HOW_WE_MOVE_FAST: the nginx side is box-only and verified
 * live (see TASK_185 §S7 evidence); these cover the repo-side half so the
 * no-store contract can't silently regress.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

test("proxy.ts: exeApi maintenance JSON carries no-store", () => {
  const src = read("../proxy.ts");
  const i = src.indexOf("flags.exeApi");
  assert.ok(i > 0, "exeApi branch missing");
  const block = src.slice(i, src.indexOf("NextResponse.json", i) + 400);
  assert.ok(
    /Cache-Control": "no-store/.test(block),
    "exeApi 503 must set Cache-Control: no-store — middleware responses are not guaranteed next.config headers()",
  );
});

test("proxy.ts: web-maintenance HTML branch still sets no-store", () => {
  const src = read("../proxy.ts");
  const i = src.indexOf("MAINTENANCE_PAGE_HTML, {");
  assert.ok(i > 0, "MAINTENANCE_PAGE_HTML response branch missing");
  const block = src.slice(i, i + 300);
  assert.ok(
    /Cache-Control": "no-store/.test(block),
    "maintenance HTML branch lost its no-store header",
  );
});

test("device-list: the /api/devices poll and vantra-link GET bypass cache", () => {
  const src = read("../components/device-list.tsx");
  assert.ok(
    src.includes('fetch("/api/devices", { cache: "no-store" })'),
    "/api/devices poll must pass cache:no-store (self-heal loop for poisoned tabs)",
  );
  assert.ok(
    src.includes('fetch("/api/assistant/vantra", { cache: "no-store" })'),
    "vantra-link GET must pass cache:no-store",
  );
});

test("device-console: tool-data batch GETs bypass cache", () => {
  const src = read("../components/device-console.tsx");
  for (const url of [
    "`/api/devices/${deviceId}/queued-commands`",
    "`/api/devices/${deviceId}/activity`",
    "`/api/entitlements`",
  ]) {
    assert.ok(
      src.includes(`fetch(${url}, { cache: "no-store" })`),
      `console GET ${url} must pass cache:no-store`,
    );
  }
});

test("billing: status/topup GETs bypass cache", () => {
  const src = read("../app/dashboard/billing/page.tsx");
  assert.ok(
    src.includes('fetch("/api/billing/status", { cache: "no-store" })'),
    "billing status GET must pass cache:no-store",
  );
  assert.ok(
    src.includes('fetch("/api/billing/topup", { cache: "no-store" })'),
    "billing topup limits GET must pass cache:no-store",
  );
});

test("maintenance page keeps its self-reload poller", () => {
  // If the maintenance document somehow renders, it must keep polling so the
  // user lands on the real app once the window closes — never a dead page.
  const src = read("../proxy.ts");
  assert.ok(
    src.includes("MAINTENANCE_PAGE_HTML"),
    "maintenance HTML constant missing from proxy",
  );
  const html = read("../lib/maintenance.ts");
  assert.ok(
    /setInterval|setTimeout|reload|fetch\(/.test(html),
    "lib/maintenance.ts MAINTENANCE_PAGE_HTML lost its reload poller",
  );
});
