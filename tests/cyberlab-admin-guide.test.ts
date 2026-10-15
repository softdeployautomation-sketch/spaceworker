import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

// TASK_156B Slice 6 — static pins for the admin CyberLab guide. The guide is
// the owner's runbook; if the engine/flow facts drift (egress dials, money
// flow, honesty statements) these pins force the doc to be updated in the
// same commit — a stale guide is how the owner wastes an evening debugging a
// "bug" that is really a doc.
const ROOT = resolve(import.meta.dirname, "..");
const guide = readFileSync(resolve(ROOT, "components/admin/cyberlab-guide.tsx"), "utf8");
const panel = readFileSync(
  resolve(ROOT, "app/admin=topsecret6199/(protected)/admin-panel.tsx"),
  "utf8",
);
const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

test("guide documents the real attack journey: scan first, then break-in sim", () => {
  assert.match(guide, /Scan for weaknesses/);
  assert.match(guide, /real TCP probes from our servers/);
  assert.match(guide, /open \/ closed \/ filtered/);
  assert.match(guide, /SIMULATION/);
  assert.match(guide, /attested device|attest a device/i);
});

test("guide documents the money flow and the off-Premium-Plus posture", () => {
  assert.match(guide, /Request for Cyber Lab/);
  assert.match(guide, /not part of Premium Plus/i);
  assert.match(guide, /Support tab queue/);
  assert.match(guide, /granted automatically for the/);
  assert.match(guide, /Users tab/);
});

test("guide pins the egress dial field names exactly as the schema names them", () => {
  assert.match(guide, /cyberlabLiveEgressEnabled/);
  assert.match(guide, /cyberlabEgressRequireOwnershipProof/);
  assert.match(guide, /cyberlabEgressScopeGuard/);
  assert.match(guide, /cyberlabEgressAllowList/);
  assert.match(guide, /Broadcast scopes are always refused/);
});

test("guide documents replay + server-computed signature", () => {
  assert.match(guide, /Replay ▶/);
  assert.match(guide, /VERIFIED/);
  assert.match(guide, /\/cyberlab\/replay\/\[id\]/);
});

test("admin Cyber Lab tab renders the guide FIRST, above the caps dials", () => {
  assert.ok(panel.includes('from "@/components/admin/cyberlab-guide"'));
  const tab = panel.slice(
    panel.indexOf("function CyberLabAdminTab"),
    panel.indexOf("function SessionsTab"),
  );
  assert.ok(tab.length > 0, "CyberLabAdminTab must exist");
  assert.ok(tab.includes("<CyberLabGuide"), "guide must be mounted in the tab");
  assert.ok(
    tab.indexOf("<CyberLabGuide") < tab.indexOf("<CyberLabCapsPanel"),
    "guide renders above the caps panel",
  );
});

test("guide pins are registered in test:lab", () => {
  assert.ok(pkg.scripts["test:lab"].includes("cyberlab-admin-guide"));
});
