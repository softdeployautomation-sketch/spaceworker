#!/usr/bin/env node
// Clone state contract check: the Go device list and the TypeScript server list
// must agree, entry for entry, reason for reason.
//
// Why this exists: the two lists are deliberately duplicated (the device and the
// server sit on opposite ends of a trust boundary, so a shared library would mean
// one mistake disabling the check on both sides at once). The cost of that
// decision is drift — and drift here is silent by nature: the server would carry
// a file the device refused to send, or the device would send one the server
// never asked for, and nothing would report it. This script turns that silence
// into a failing check.
//
// It compares the SOURCE of both lists, so the two counts and the two names must
// match. Run by `npm run check:clone-contract`.

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const GO_FILE = join(root, "michael", "browser-clone", "engine", "pkg", "wake", "sensitives.go");
// The sync MODE and REASON vocabulary lives in the planner, not the exclusion map.
const GO_SYNC_FILE = join(root, "michael", "browser-clone", "engine", "pkg", "wake", "sync.go");
const TS_FILE = join(root, "lib", "clone-sync-plan.ts");

/** Extracts `"basename": "reason"` pairs from a named block of source. */
function extractEntries(source, startMarker, endMarker, label) {
  const start = source.indexOf(startMarker);
  if (start === -1) {
    throw new Error(`could not find ${startMarker} in ${label}`);
  }
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (end === -1) {
    throw new Error(`could not find the end of the ${startMarker} block in ${label}`);
  }
  const block = source.slice(start, end);

  const entries = new Map();
  // Matches:  "login data": "some_reason",      and   "login data": "some_reason"
  // and the unquoted TS shorthand:  cookies: "some_reason",
  const pair = /^\s*"?([A-Za-z_][A-Za-z0-9_ -]*)"?\s*:\s*"([a-z0-9_]+)"\s*,/gm;
  for (const m of block.matchAll(pair)) {
    entries.set(m[1].trim().toLowerCase(), m[2]);
  }
  if (entries.size === 0) {
    throw new Error(`parsed zero entries from the ${startMarker} block in ${label}`);
  }
  return entries;
}

const goSource = readFileSync(GO_FILE, "utf8");
const goSyncSource = readFileSync(GO_SYNC_FILE, "utf8");
const tsSource = readFileSync(TS_FILE, "utf8");

/**
 * Pulls `NAME = "value"` constants out of a named Go const block.
 *
 * Separate from `extractEntries` because Go declares constants with `=` where the
 * maps use `:`, and a regex that accepted both would silently match the wrong
 * block if the file ever gained one.
 */
function extractGoConstants(source, startMarker, endMarker, label) {
  const start = source.indexOf(startMarker);
  if (start === -1) throw new Error(`could not find ${startMarker} in ${label}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (end === -1) throw new Error(`could not find the end of the ${startMarker} block in ${label}`);
  const values = new Map();
  const pair = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"([a-z0-9_]+)"\s*$/gm;
  for (const m of source.slice(start, end).matchAll(pair)) values.set(m[1], m[2]);
  if (values.size === 0) throw new Error(`parsed zero constants from the ${startMarker} block in ${label}`);
  return values;
}

/** Pulls `NAME = "value";` declarations out of TypeScript source. */
function extractTsConstants(source, prefix, label) {
  const values = new Map();
  const pair = new RegExp(`^\\s*(?:export\\s+)?const\\s+(${prefix}[A-Z0-9_]+)\\s*=\\s*"([a-z0-9_]+)"\\s*;`, "gm");
  for (const m of source.matchAll(pair)) values.set(m[1], m[2]);
  if (values.size === 0) throw new Error(`parsed zero ${prefix}* constants from ${label}`);
  return values;
}

const goEntries = extractEntries(goSource, "cloneStateExclusions = map[string]string{", "\n}", GO_FILE);
const tsEntries = extractEntries(tsSource, "const CLONE_STATE_EXCLUSIONS: Record<string, string> = {", "\n};", TS_FILE);

const problems = [];

for (const [name, reason] of goEntries) {
  if (!tsEntries.has(name)) {
    problems.push(`device excludes "${name}" but the server does not`);
  } else if (tsEntries.get(name) !== reason) {
    problems.push(`"${name}": device reason "${reason}" != server reason "${tsEntries.get(name)}"`);
  }
}
for (const [name] of tsEntries) {
  if (!goEntries.has(name)) {
    problems.push(`server excludes "${name}" but the device does not`);
  }
}

console.log(`[clone-contract] device: ${goEntries.size} entries, server: ${tsEntries.size} entries`);

// ============================================================================
// THE MODE VOCABULARY — the check that matters most.
// ============================================================================
//
// The device decides what to SEND from the mode alone: `SelectStateFiles` treats a
// delta as "only the paths you were asked for" and EVERYTHING ELSE as "send the
// whole profile" (engine/pkg/wake/state.go — `plan.Mode != SyncModeDelta`). So a
// server that invented a third spelling would not fail loudly; it would make every
// reconnect re-send an entire profile, forever, with no error anywhere.
const goModes = extractGoConstants(goSyncSource, "// Sync modes.", "\n)", GO_SYNC_FILE);
const goSyncModes = new Map([...goModes].filter(([name]) => name.startsWith("SyncMode")));
const tsModes = extractTsConstants(tsSource, "SYNC_MODE_", "clone-sync-plan.ts");

const goModeValues = new Set(goSyncModes.values());
const tsModeValues = new Set(tsModes.values());
for (const value of goModeValues) {
  if (!tsModeValues.has(value)) problems.push(`device sync mode "${value}" is not a server mode`);
}
for (const value of tsModeValues) {
  if (!goModeValues.has(value)) problems.push(`server sync mode "${value}" is not a device mode`);
}
if (goModeValues.size < 2) problems.push(`only ${goModeValues.size} sync modes parsed; expected full and delta`);
console.log(`[clone-contract] sync modes — device: ${[...goModeValues].sort().join(",")}, server: ${[...tsModeValues].sort().join(",")}`);

// ============================================================================
// THE REASON VOCABULARY — one direction only, on purpose.
// ============================================================================
//
// Every reason the DEVICE knows must exist on the server, because a device reason
// is what the platform records and renders; a device-only reason would be stored
// as an unexplained string. The reverse is allowed: the server may invent reasons
// the device merely echoes back (`cache_baseline` is one — the device neither
// computes nor needs it, it only carries the decision it was given).
const goReasons = extractGoConstants(goSyncSource, "// Reasons a sync decision was made.", "\n)", GO_SYNC_FILE);
const tsReasons = extractEntries(tsSource, "export const SYNC_REASONS = {", "\n} as const;", "clone-sync-plan.ts");
const tsReasonValues = new Set(tsReasons.values());
for (const [name, value] of goReasons) {
  if (!tsReasonValues.has(value)) problems.push(`device reason ${name} = "${value}" is not a server reason`);
}
console.log(`[clone-contract] sync reasons — device: ${goReasons.size}, server: ${tsReasons.size}`);

// A shared count is not enough on its own, but the two lists being non-trivial is
// worth asserting: a parse that silently returned an empty list would otherwise
// look like agreement.
const MINIMUM_EXPECTED = 10;
if (goEntries.size < MINIMUM_EXPECTED) {
  problems.push(`only ${goEntries.size} device entries parsed; expected at least ${MINIMUM_EXPECTED}`);
}

if (problems.length > 0) {
  console.log("[clone-contract] FAILED");
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}
console.log("[clone-contract] PASSED — the device and server exclusion lists agree, and the sync vocabulary matches");
