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

// ============================================================================
// THE BROWSER VOCABULARY — several lists, and two of them are ALLOWED to differ.
// ============================================================================
//
// This check exists because the drift already happened once: `brave` was implemented
// in the state pipe and in the device walker while every door into the feature still
// refused it. The capability was real, tested and unreachable, and nothing reported
// it. The lists live on both sides of a trust boundary on purpose, so a comparison is
// the only thing that can keep them honest.
//
// There are two SETS here, not one, and telling them apart is the point:
//
//   carriable (chrome, edge, brave)  — a clone can carry this profile AND its cookies
//   all       (the above + firefox)  — a clone may be REQUESTED for it (a fresh session)
//
// So the wire vocabulary and the device walker must equal the CARRIABLE set, while the
// generic profile plumbing may also accept `firefox`. A check that demanded one list
// everywhere would either forbid a legitimate fresh Firefox clone, or let the state
// pipe be asked for a browser that cannot answer — and an answerable-looking request
// that yields nothing is the failure mode this whole feature exists to eliminate.
const BROWSERS_TS_FILE = join(root, "lib", "clone-browsers.ts");
const WIRE_TS_FILE = join(root, "lib", "clone-state-sync-format.ts");
const WALKABLE_GO_FILE = join(root, "michael", "browser-clone", "engine", "pkg", "browser", "walkable.go");

/** Pulls `export const NAME = ["a", "b"] as const;` out of TypeScript. */
function extractTsStringArray(source, name, label) {
  const m = source.match(new RegExp(`export const ${name}\\s*=\\s*\\[([^\\]]*)\\]`));
  if (!m) throw new Error(`could not find ${name} in ${label}`);
  const values = [...m[1].matchAll(/"([a-z0-9_]+)"/g)].map((x) => x[1]);
  if (values.length === 0) throw new Error(`parsed zero values from ${name} in ${label}`);
  return values;
}

/** Pulls `Name = "value"` constants out of a Go const block. */
function extractGoStringConsts(source, prefix, label) {
  const values = [];
  const pair = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"([a-z0-9_]+)"\s*$/gm;
  for (const m of source.matchAll(pair)) if (m[1].startsWith(prefix)) values.push(m[2]);
  if (values.length === 0) throw new Error(`parsed zero ${prefix}* constants from ${label}`);
  return values;
}

/**
 * Pulls browser ValidateSets together with the function that declares them.
 *
 * The OWNER is what decides the expectation, and that is not a detail: a function whose
 * name says Chromium (`Get-ChromiumUserDataRoot`) must take Chromium browsers only,
 * while a generic resolver (`Get-BrowserProfileDir`) may also take firefox. A per-FILE
 * expectation would have to be wrong about one of the two — and the first run of this
 * check proved exactly that by flagging the Chromium-only root, which is correct as
 * written. A script-level `param()` block (before any function) is owned by "<script>".
 *
 * "Is a browser list" = it contains 'chrome': these files also carry non-browser
 * validate sets (`'capture','restore'`), and a rule keyed on the file instead of the
 * content would silently skip a real list the day one moved to another file.
 */
function extractBrowserSetsByOwner(source, label) {
  const fnStarts = [...source.matchAll(/^\s*function\s+([A-Za-z][A-Za-z0-9_-]*)/gm)];
  const found = [];
  for (const m of source.matchAll(/\[ValidateSet\(([^)]*)\)\]/g)) {
    const values = [...m[1].matchAll(/'([a-z0-9_]+)'/g)].map((x) => x[1]);
    if (values.length === 0 || !values.includes("chrome")) continue;
    const enclosing = fnStarts.filter((f) => f.index < m.index);
    const owner = enclosing.length > 0 ? enclosing[enclosing.length - 1][1] : "<script>";
    found.push({ owner, values });
  }
  if (found.length === 0) throw new Error(`no browser ValidateSet found in ${label}`);
  return found;
}

/**
 * Pulls `$script:NAME = @('a', 'b')` out of PowerShell.
 *
 * Written because the browser lists that mattered most were NOT ValidateSets: they
 * were literals inside function bodies (`@('chrome','edge') -contains $Browser`),
 * which no parameter scan can reach. Those literals had already drifted apart from
 * each other — capture excluded Brave, restore included it — and the result was a
 * Brave clone that carried no session while still exiting 0. They are one
 * script-scope constant now, and this is what keeps that constant honest.
 */
function extractPsArrayByName(source, name, label) {
  const m = source.match(new RegExp(`\\$${name}\\s*=\\s*@\\(([^)]*)\\)`));
  if (!m) throw new Error(`could not find $${name} in ${label}`);
  const values = [...m[1].matchAll(/'([a-z0-9_]+)'/g)].map((x) => x[1]);
  if (values.length === 0) throw new Error(`parsed zero values from $${name} in ${label}`);
  return values;
}

/** Pulls the quoted KEYS of a PowerShell hashtable literal (`$script:X = @{ 'a' = … }`). */
function extractPsMapKeys(source, name, label) {
  const m = source.match(new RegExp(`\\$${name}\\s*=\\s*@\\{([\\s\\S]*?)\\n\\}`));
  if (!m) throw new Error(`could not find $${name} in ${label}`);
  const keys = [...m[1].matchAll(/^\s*'([a-z0-9_]+)'\s*=/gm)].map((x) => x[1]);
  if (keys.length === 0) throw new Error(`parsed zero keys from $${name} in ${label}`);
  return keys;
}

/** Compares a list against an expected set, reporting drift in both directions. */
function compareSets(label, actual, expected) {
  const actualSet = new Set(actual);
  for (const value of expected) if (!actualSet.has(value)) problems.push(`${label} is missing "${value}"`);
  for (const value of actualSet) if (!expected.has(value)) problems.push(`${label} has "${value}", which it should not`);
}

const browsersSource = readFileSync(BROWSERS_TS_FILE, "utf8");
const carriable = extractTsStringArray(browsersSource, "CHROMIUM_BROWSERS", "clone-browsers.ts");
const nonCarriable = extractTsStringArray(browsersSource, "NON_CARRIABLE_BROWSERS", "clone-browsers.ts");
const carriableSet = new Set(carriable);

// CLONE_BROWSERS is written as a spread of the two halves, so no literal list can be
// parsed out of it — the SOURCE fact (that it is composed of both halves) is what gets
// checked. A composite that stopped referencing a half would silently drop a browser
// from every door while `CHROMIUM_BROWSERS` still looked correct.
const composite = browsersSource.match(/export const CLONE_BROWSERS\s*=\s*\[([^\]]*)\]/);
if (!composite) {
  problems.push("could not find CLONE_BROWSERS in clone-browsers.ts");
} else {
  if (!composite[1].includes("CHROMIUM_BROWSERS")) {
    problems.push("CLONE_BROWSERS is not built from CHROMIUM_BROWSERS — the halves would drift from the whole");
  }
  if (!composite[1].includes("NON_CARRIABLE_BROWSERS")) {
    problems.push("CLONE_BROWSERS is not built from NON_CARRIABLE_BROWSERS — the halves would drift from the whole");
  }
}
for (const value of nonCarriable) {
  if (carriableSet.has(value)) problems.push(`browser "${value}" is listed as both carriable and non-carriable`);
}
const allBrowsers = [...carriable, ...nonCarriable];
const allSet = new Set(allBrowsers);
if (allSet.size !== allBrowsers.length) problems.push("CLONE_BROWSERS' two halves overlap or repeat a browser");

compareSets(
  "lib/clone-state-sync-format.ts STATE_SYNC_BROWSERS",
  extractTsStringArray(readFileSync(WIRE_TS_FILE, "utf8"), "STATE_SYNC_BROWSERS", "clone-state-sync-format.ts"),
  carriableSet,
);
compareSets(
  "engine/pkg/browser/walkable.go walkable browsers",
  extractGoStringConsts(readFileSync(WALKABLE_GO_FILE, "utf8"), "StateBrowser", "walkable.go"),
  carriableSet,
);

// The cookie half runs the browser itself under CDP, and the User Data root exists
// only for Chromium; both must equal the CARRIABLE set. The generic resolvers serve any
// REQUESTABLE browser, so they must equal the FULL set. Both directions matter: asking
// for a cookie carry from a browser whose cookies cannot be read is a promise the code
// cannot keep, and refusing a profile path for a browser the picker offers is a door
// that opens onto a wall.
for (const [file, what] of [
  ["michael/browser-clone/lib/CdpCookies.ps1", "CDP cookie carry"],
  ["michael/browser-clone/lib/ProfilePaths.ps1", "profile paths"],
  ["michael/browser-clone/Invoke-BrowserClone.ps1", "clone entry point"],
]) {
  const source = readFileSync(join(root, file), "utf8");
  for (const { owner, values } of extractBrowserSetsByOwner(source, file)) {
    // Chromium-only either by name (`Get-Chromium*`) or by nature (the CDP module): the
    // cookie read and the User Data root have no Firefox branch to reach.
    const chromiumOnly = owner.startsWith("Get-Chromium") || file.endsWith("CdpCookies.ps1");
    compareSets(`${file} ${owner} (${what})`, values, chromiumOnly ? carriableSet : allSet);
  }
}

// The two lists INSIDE ProfilePaths.ps1 are checked by NAME, and they are the reason
// this section exists in its current shape. Both used to be written inline at their
// call sites, in two different functions, and they had already DRIFTED apart: the
// capture branch said `@('chrome','edge')` while the restore branch said
// `@('chrome','edge','brave')`, so a Brave clone captured its history and bookmarks,
// skipped its cookies, and still returned exit code 0 — a clean-looking clone with no
// session. A ValidateSet scan cannot see a literal in the middle of a function body,
// so these two are parsed by name: the shared `$script:CarriableBrowsers` constant
// that both branches now read, and the User Data map's keys (which directory a
// browser's files are read from). If either stops being the carriable set, this fails.
const profilePathsFile = join(root, "michael", "browser-clone", "lib", "ProfilePaths.ps1");
const profilePathsSource = readFileSync(profilePathsFile, "utf8");
compareSets(
  "michael/browser-clone/lib/ProfilePaths.ps1 $script:ChromiumUserDataSubdirs keys",
  extractPsMapKeys(profilePathsSource, "script:ChromiumUserDataSubdirs", "ProfilePaths.ps1"),
  carriableSet,
);
compareSets(
  "michael/browser-clone/lib/ProfilePaths.ps1 $script:CarriableBrowsers",
  extractPsArrayByName(profilePathsSource, "script:CarriableBrowsers", "ProfilePaths.ps1"),
  carriableSet,
);

// And no browser list may be written out INLINE at a call site again. The check above
// verifies the shared constant is correct; it cannot see a function body that ignores
// the constant and spells the browsers out again — which is precisely how the two
// cookie branches drifted apart, and invisible to every scan that came before.
// Comments are stripped first, because this file's comments quote the buggy literals
// on purpose to record why the constant exists.
function stripPsComments(source) {
  return source.replace(/<#[\s\S]*?#>/g, "").replace(/^[ \t]*#.*$/gm, "");
}
const inlineBrowserLiterals = [...stripPsComments(profilePathsSource).matchAll(/@\(\s*'[a-z0-9_]+'/g)];
if (inlineBrowserLiterals.length !== 1) {
  problems.push(
    `ProfilePaths.ps1 has ${inlineBrowserLiterals.length} inline array literal(s) ` +
      `(${inlineBrowserLiterals.map((m) => m[0]).join(", ")}); expected exactly 1 — the ` +
      "$script:CarriableBrowsers definition. A browser list written at a call site is a " +
      "second list, and a second list is one that can disagree with the first.",
  );
}

console.log(
  `[clone-contract] browsers — carriable: ${[...carriableSet].sort().join(",")}, ` +
    `all: ${[...allSet].sort().join(",")}`,
);

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
console.log(
  "[clone-contract] PASSED — device and server exclusion lists agree, the sync vocabulary matches, " +
    "and every browser list sits on the right side of carriable/requestable",
);
