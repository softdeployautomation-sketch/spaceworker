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
const tsSource = readFileSync(TS_FILE, "utf8");

// The TS marker names its own closing brace; the Go marker is a var block.
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
console.log("[clone-contract] PASSED — the device and server exclusion lists agree");
