// TASK_216 D2 — source-pin test for the session-gate bake class bug.
//
// Incident (2026-10-16): during `next build`, app/cyberlab/page.tsx executed
// with an empty cookie store → getSession() returned null → its redirect()
// fired AT BUILD TIME and Next baked a static 307 → / into the prerender
// artifact (cyberlab.{html,rsc,meta}, `x-nextjs-prerender: 1`). Every runtime
// request — including authed users — got the baked bounce (owner: "entering
// the cyberlab console takes me back to home").
//
// The fix is `export const dynamic = "force-dynamic"` on every session-gated
// server page so the gate can only ever evaluate per request. This test reads
// the audited pages from disk and asserts the pin, so a NEW gated page (or a
// reverted one) fails the suite instead of shipping a baked gate.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const ROOT = join(__dirname, "..");

// The full audit list from TASK_216 D1 (grep getSession|getCurrentUser in
// app/**/page.tsx at 1c0f077). 8 of these are gate+redirect; 3 are
// gate+no-redirect (a baked gate would blank them the same way it bounced
// /cyberlab, so they were hardened too — verdicts in the STEPS handoff).
const AUDIT: readonly string[] = [
  "app/cyberlab/page.tsx", // the reported case
  "app/home/page.tsx",
  "app/login/page.tsx",
  "app/signup/page.tsx",
  "app/browser-popout/[sessionId]/page.tsx",
  "app/clone/[cloneId]/page.tsx",
  "app/console/[deviceId]/page.tsx",
  "app/dashboard/browser/page.tsx",
  "app/dashboard/devices/[deviceId]/page.tsx",
  "app/dashboard/licenses/page.tsx",
  "app/dashboard/settings/page.tsx",
];

function src(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

describe("TASK_216 — session-gated pages must never statically prerender", () => {
  for (const rel of AUDIT) {
    it(`${rel} carries force-dynamic`, () => {
      const source = src(rel);
      assert.match(
        source,
        /export const dynamic = "force-dynamic";/,
        `${rel} must export force-dynamic — a session gate evaluated at build time bakes its redirect/null into the artifact (the /cyberlab 307 incident)`,
      );
    });
  }

  it("audit list is still honest: every file gates on a session", () => {
    // If a file stops gating, it drops out of the class (fine) — but the
    // listed file must not silently become something this test no longer
    // understands.
    for (const rel of AUDIT) {
      assert.match(
        src(rel),
        /getSession|getCurrentUser/,
        `${rel} no longer calls getSession/getCurrentUser — update the TASK_216 audit list`,
      );
    }
  });

  it("the QA battery probes anon GET /cyberlab (307, never a rendered 200)", () => {
    const battery = src("lib/qa/battery.ts");
    assert.match(battery, /anon-cyberlab/, "lib/qa/battery.ts must carry the anon-cyberlab probe (TASK_216 D1.3)");
    assert.match(battery, /\/cyberlab/, "the probe must target /cyberlab");
  });
});
