// Tests for the server-side STATE pipe (TASK_135 §6).
//
// Real directories, real files, real `/bin/sh`-free filesystem work: the failures
// this module can have are about paths and bytes (a file staged under the wrong
// name, a removal that escapes the cache, a fingerprint that makes a delta unsafe),
// so nothing here is mocked.

import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, existsSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  applyStateRemovals,
  decideStateSync,
  fingerprintCache,
  ingestStateFile,
  profileNameOfManifest,
  stateCacheDirForTarget,
  stateCacheDirPath,
  stateTargetKey,
  validateManifestFiles,
} from "./clone-state-ingest";
import { SYNC_MODE_DELTA, SYNC_REASONS, isDeltaEmpty } from "./clone-sync-plan";
import type { StateManifest } from "./clone-sync-plan";

const FP = (path: string, size = 10, mtime = 1000) => ({ path, size, mtime });

function manifest(over: Partial<StateManifest> = {}): StateManifest {
  return {
    deviceId: "dev-1",
    browser: "chrome",
    profile: "Default",
    // NOW, by default: a delta needs a baseline that is not stale, and a fixture
    // frozen in the past would silently exercise the staleness path in every test.
    capturedAt: new Date().toISOString(),
    files: [FP("History"), FP("Bookmarks")],
    ...over,
  };
}

// ---------------------------------------------------------------- the cache key

test("a target key is stable, readable and distinct per tuple", () => {
  const a = stateTargetKey({ deviceId: "dev-1", browser: "chrome", profileName: "Default" });
  assert.equal(a, stateTargetKey({ deviceId: "dev-1", browser: "chrome", profileName: "Default" }));
  // Different tuple, different key — two users must never share a cache directory.
  const variants = [
    { deviceId: "dev-2", browser: "chrome", profileName: "Default" },
    { deviceId: "dev-1", browser: "edge", profileName: "Default" },
    { deviceId: "dev-1", browser: "chrome", profileName: "Profile 1" },
    { deviceId: "dev-1", browser: "chrome", profileName: "Default " },
  ];
  for (const v of variants) {
    assert.notEqual(stateTargetKey(v), a, `${JSON.stringify(v)} collided with the base tuple`);
  }
  // A profile name with a space must not produce a path separator or a traversal.
  const spaced = stateTargetKey({ deviceId: "dev-1", browser: "chrome", profileName: "Profile 1" });
  assert.ok(!spaced.includes("/") && !spaced.includes("\\") && !spaced.includes(".."), spaced);
});

test("the cache directory is refused when it would escape the base", () => {
  const base = mkdtempSync(join(tmpdir(), "sw-cache-"));
  assert.equal(stateCacheDirPath(base, "ok-key").startsWith(base), true);
  for (const bad of ["../escape", "a/../../b", "/etc/passwd"]) {
    assert.throws(() => stateCacheDirPath(base, bad), /state_target_key_unsafe/, `must refuse ${bad}`);
  }
});

test("one helper resolves the cache for both the route and the launch", () => {
  const base = mkdtempSync(join(tmpdir(), "sw-cache-"));
  const prev = process.env.BROWSER_PROFILE_BASE_DIR;
  process.env.BROWSER_PROFILE_BASE_DIR = base;
  try {
    // An ABSENT profile name and an explicit "Default" must resolve to ONE
    // directory: the route and the launch derive the name differently, and two
    // directories would mean the state that arrived is never materialised.
    const fromAbsent = stateCacheDirForTarget({ deviceId: "d", browser: "Chrome", profileName: null });
    const fromDefault = stateCacheDirForTarget({ deviceId: "d", browser: "chrome", profileName: "Default" });
    assert.equal(fromAbsent, fromDefault);
    // A name that is not a profile name is refused rather than guessed at.
    assert.throws(() => stateCacheDirForTarget({ deviceId: "d", browser: "chrome", profileName: "../x" }), /state_profile_unknown/);
    // A missing base is a refusal, never a guess at a default directory.
    delete process.env.BROWSER_PROFILE_BASE_DIR;
    assert.throws(() => stateCacheDirForTarget({ deviceId: "d", browser: "chrome", profileName: "Default" }), /BROWSER_PROFILE_BASE_DIR/);
  } finally {
    if (prev === undefined) delete process.env.BROWSER_PROFILE_BASE_DIR;
    else process.env.BROWSER_PROFILE_BASE_DIR = prev;
  }
});

test("profileNameOfManifest reads a real manifest and never guesses", () => {
  assert.equal(profileNameOfManifest({ profile: "Profile 2" }), "Profile 2");
  assert.equal(profileNameOfManifest({ profile: "" }), "Default");
  assert.equal(profileNameOfManifest({}), "Default");
  assert.equal(profileNameOfManifest(null), "Default");
  assert.equal(profileNameOfManifest("nonsense"), "Default");
  assert.equal(profileNameOfManifest([1, 2]), "Default");
});

// -------------------------------------------------------------- the manifest

test("secret-bearing and unsafe paths are refused with a reason", () => {
  const res = validateManifestFiles([
    FP("History"),
    FP("Network/Cookies"),
    FP("Login Data"),
    FP("Local State"),
    FP("../../escape"),
    FP("C:History"),
    FP(""),
  ]);
  assert.deepEqual(res.kept.map((f) => f.path), ["History"]);
  const reasons = new Map(res.excluded.map((e) => [e.path, e.reason]));
  // Every refusal is NAMED. A file silently absent from a manifest is how a
  // replica quietly loses data.
  assert.ok(reasons.get("Network/Cookies"));
  assert.ok(reasons.get("Login Data"));
  assert.ok(reasons.get("Local State"));
  assert.ok(reasons.get("../../escape"));
  assert.ok(reasons.get("C:History"));
  for (const why of reasons.values()) assert.ok(why.length > 0);
});

test("two spellings of one file are one entry, not two", () => {
  const res = validateManifestFiles([FP("Sessions/Session_1"), FP("sessions\\session_1")]);
  assert.equal(res.kept.length, 1);
  assert.equal(res.excluded.length, 1);
  assert.equal(res.excluded[0].reason, "state_path_duplicate");
});

test("a file that cannot be fingerprinted is refused, not assumed unchanged", () => {
  const res = validateManifestFiles([
    { path: "History" },
    { path: "Bookmarks", size: 5 },
    { path: "Web Data", size: 5, mtime: Number.NaN },
    { path: "Top Sites", size: -1, mtime: 5 },
    FP("Preferences", 1, 2),
  ]);
  assert.deepEqual(res.kept.map((f) => f.path), ["Preferences"]);
  assert.equal(res.excluded.length, 4);
  for (const e of res.excluded) assert.equal(e.reason, "state_fingerprint_incomplete");
});

test("a manifest that is not an array is empty, not a crash", () => {
  for (const junk of [undefined, null, "x", 42, {}]) {
    const res = validateManifestFiles(junk);
    assert.deepEqual(res.kept, []);
    assert.equal(res.bytes, 0);
  }
});

test("bytes are summed from the fingerprints that were kept", () => {
  const res = validateManifestFiles([FP("History", 100), FP("Network/Cookies", 999), FP("Bookmarks", 50)]);
  assert.equal(res.bytes, 150, "a refused file's size must not be counted");
});

// ------------------------------------------------------------- the decision

test("no baseline is a first clone, with a named reason", () => {
  const d = decideStateSync({ previous: null, next: manifest() });
  assert.equal(d.mode, "full");
  assert.equal(d.reason, "first_clone");
  // A full transfer asks for nothing in particular: the device sends everything.
  assert.deepEqual(d.requestedPaths, []);
  assert.equal(d.cookiesAlwaysFull, true);
});

test("a usable baseline is a delta that asks only for what changed", () => {
  const prev = manifest({ files: [FP("History", 10, 1000), FP("Bookmarks", 10, 1000)] });
  const next = manifest({ files: [FP("History", 10, 1000), FP("Bookmarks", 99, 2000), FP("Web Data", 5, 3000)] });
  const d = decideStateSync({ previous: prev, next });
  assert.equal(d.mode, "delta");
  assert.equal(d.reason, "sync_on_reconnect");
  assert.deepEqual([...d.requestedPaths].sort(), ["Bookmarks", "Web Data"]);
  assert.deepEqual(d.delta?.removed, []);
});

test("a removal is named so the replica can delete it", () => {
  const prev = manifest({ files: [FP("History", 10, 1000), FP("Old Thing", 1, 1)] });
  const next = manifest({ files: [FP("History", 10, 1000)] });
  const d = decideStateSync({ previous: prev, next });
  assert.equal(d.mode, "delta");
  assert.deepEqual(d.delta?.removed, ["Old Thing"]);
});

test("a different browser or profile is a full transfer, not a delta", () => {
  const prev = manifest();
  assert.equal(decideStateSync({ previous: prev, next: manifest({ browser: "edge" }) }).mode, "full");
  assert.equal(decideStateSync({ previous: prev, next: manifest({ profile: "Profile 1" }) }).mode, "full");
  // A profile name is compared case-insensitively, so `default` is the same
  // profile as `Default` and must NOT look like a new one.
  assert.equal(decideStateSync({ previous: prev, next: manifest({ profile: "default" }) }).mode, "delta");
});

test("a major upgrade forces a full transfer", () => {
  const prev = manifest({ version: "141.0.7390.55" });
  const d = decideStateSync({ previous: prev, next: manifest({ version: "142.0.7444.60" }) });
  assert.equal(d.mode, "full");
  assert.equal(d.reason, "browser_version_changed");
});

test("a stale baseline forces a full transfer", () => {
  const old = manifest({ capturedAt: new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString() });
  const d = decideStateSync({ previous: old, next: manifest() });
  assert.equal(d.mode, "full");
  assert.equal(d.reason, "manifest_stale");
});

test("an empty stored baseline is not a usable one", () => {
  const d = decideStateSync({ previous: manifest({ files: [] }), next: manifest() });
  assert.equal(d.mode, "full");
  assert.equal(d.reason, "first_clone");
});

test("every decision this module returns is coherent", () => {
  // The validator is the contract: a delta must carry a delta, must not ask for a
  // path it excluded, and must always state the cookies rule. Anything that failed
  // it would be handed to a device, so the module checks before returning and
  // falls back to a full transfer rather than shipping an incoherent plan.
  const cases: Array<Parameters<typeof decideStateSync>[0]> = [
    { previous: null, next: manifest() },
    { previous: manifest(), next: manifest() },
    { previous: manifest(), next: manifest({ files: [FP("History")] }) },
    { previous: manifest({ files: [] }), next: manifest() },
  ];
  for (const c of cases) {
    const d = decideStateSync(c);
    assert.equal(d.cookiesAlwaysFull, true);
    assert.ok(["full", "delta"].includes(d.mode));
    assert.ok(d.reason.length > 0);
    if (d.mode === "delta") assert.ok(d.delta, "a delta must carry its delta");
    if (d.mode === "full") assert.equal(d.delta, undefined, "a full transfer must not carry one");
  }
});

// ----------------------------------------------------------- the cache on disk

test("a staged file lands where the materialiser will look for it", async () => {
  const cache = mkdtempSync(join(tmpdir(), "sw-stage-"));
  const res = await ingestStateFile({
    cacheDir: cache,
    relPath: "Sessions/Session_123",
    content: Buffer.from("tabs"),
  });
  assert.equal(res.ok, true);
  assert.equal(res.bytes, 4);
  // Forward-slash relative paths become real directories, which is what
  // materializeCloneState walks.
  assert.equal(readFileSync(join(cache, "Sessions", "Session_123"), "utf8"), "tabs");
});

test("a secret or an empty body is refused and nothing is written", async () => {
  const cache = mkdtempSync(join(tmpdir(), "sw-stage-"));
  for (const [path, why] of [
    ["Network/Cookies", /cookies/],
    ["../../escape", /escapes|absolute/],
    ["Login Data", /password/],
  ] as const) {
    const res = await ingestStateFile({ cacheDir: cache, relPath: path, content: Buffer.from("x") });
    assert.equal(res.ok, false, `${path} must be refused`);
    assert.match(String(res.error), why);
  }
  // An empty file is not a state file: staging it would create a zero-byte
  // History that Chromium would then refuse to open.
  const empty = await ingestStateFile({ cacheDir: cache, relPath: "History", content: Buffer.alloc(0) });
  assert.equal(empty.ok, false);
  assert.equal(empty.error, "state_file_empty");
  assert.equal(existsSync(join(cache, "History")), false);
});

test("fingerprinting the cache reports exactly what is there", async () => {
  const cache = mkdtempSync(join(tmpdir(), "sw-fp-"));
  await ingestStateFile({ cacheDir: cache, relPath: "History", content: Buffer.from("abc") });
  await ingestStateFile({ cacheDir: cache, relPath: "Extensions/abc/manifest.json", content: Buffer.from("{}") });
  const files = await fingerprintCache(cache);
  assert.deepEqual(files.map((f) => f.path), ["Extensions/abc/manifest.json", "History"]);
  assert.deepEqual(files.map((f) => f.size), [2, 3]);
  for (const f of files) assert.ok(f.mtime > 0, "a fingerprint without an mtime makes a delta unsafe");
});

test("a non-regular entry is not fingerprinted as a file", async () => {
  const cache = mkdtempSync(join(tmpdir(), "sw-fp2-"));
  mkdirSync(join(cache, "Sessions"), { recursive: true });
  writeFileSync(join(cache, "History"), "abc");
  // A symlink in a cache we did not write is not state, and following it could
  // read anything on the host.
  try {
    symlinkSync("/etc/passwd", join(cache, "evil-link"));
  } catch {
    // Symlinks may be unavailable; the assertion below still covers the rest.
  }
  const files = await fingerprintCache(cache);
  for (const f of files) assert.notEqual(f.path, "evil-link");
  assert.ok(files.some((f) => f.path === "History"));
});

// ---------------------------------------------------- the seam: cache -> decision
//
// WHY THIS TEST EXISTS, AND WHY IT IS THE IMPORTANT ONE HERE.
//
// Both halves of this feature were tested on their own — the device decided what to
// send, the server decided what to ask for — and BOTH suites were green while the
// pair was broken: a real second sync re-uploaded the WHOLE profile. Neither half
// could see it, because neither half is where the mistake was. The join was. So
// this runs the real sequence over the bytes a clone actually carries: stage the
// profile into a cache, fingerprint that cache exactly as the route does, and
// compute the decision from the manifest a device would post.

/** A realistic profile, including the space-bearing and nested names that only a
 *  real cache walk produces. */
const REAL_PROFILE: Array<[string, string]> = [
  ["History", "history-bytes"],
  ["Bookmarks", "bookmark-bytes"],
  ["Preferences", "prefs-bytes"],
  ["Web Data", "web-data-bytes"],
  ["Top Sites", "top-sites-bytes"],
  ["Network/Network Persistent State", "nps-bytes"],
  ["Sessions/Session_0001", "session-bytes"],
  ["Sessions/Tabs_0001", "tab-bytes"],
  ["Local Storage/leveldb/000003.log", "leveldb-bytes"],
  ["Extensions/abcdefghijklmnopabcdefghijklmnop/manifest.json", '{"name":"ext"}'],
  ["Extensions/abcdefghijklmnopabcdefghijklmnop/1.0.0/background.js", "ext-bytes"],
];

/** The SOURCE file's mtime on the work PC, which is what a device really posts. It
 *  can never equal a staged copy's mtime — that is a value from the SERVER's clock —
 *  which is the whole reason the comparison has to be content-based. */
const SOURCE_MTIME = 1_600_000_000;

test("a second sync of an unchanged profile asks for nothing", async () => {
  const cache = mkdtempSync(join(tmpdir(), "sw-seam-"));
  const source = new Map<string, Buffer>();
  for (const [rel, text] of REAL_PROFILE) {
    const content = Buffer.from(text);
    source.set(rel, content);
    const res = await ingestStateFile({ cacheDir: cache, relPath: rel, content });
    assert.equal(res.ok, true, `${rel} must stage: ${res.error}`);
  }

  /** The manifest a device posts: digest and size of ITS bytes, and ITS mtime. */
  const posted = (overrides: Record<string, string> = {}) => {
    const files = REAL_PROFILE.map(([rel]) => {
      const content = overrides[rel] === undefined ? source.get(rel)! : Buffer.from(overrides[rel]);
      return {
        path: rel,
        size: content.length,
        mtime: SOURCE_MTIME,
        sha256: createHash("sha256").update(content).digest("hex"),
      };
    });
    const checked = validateManifestFiles(files);
    assert.deepEqual(checked.excluded, [], "a realistic profile must not be refused as a whole");
    return manifest({ files: checked.kept });
  };

  // The baseline the route builds when no manifest is stored yet: the cache, read
  // back through the same fingerprinter (the ingest route's `loadBaseline`), and
  // without a deviceId — exactly the shape the route produces.
  const baseline: StateManifest = {
    browser: "chrome",
    profile: "Default",
    capturedAt: new Date().toISOString(),
    files: await fingerprintCache(cache),
  };

  // The premise of every delta: the cache's mtimes differ from the source's, so only
  // the DIGEST can recognise a file that has already landed. Asserted rather than
  // assumed — if the fixture ever shared an mtime, this test would pass for the
  // wrong reason.
  for (const f of baseline.files) {
    assert.equal(f.sha256?.length, 64, `${f.path}: the cache must declare a digest, or the comparison falls back to size+mtime`);
    assert.notEqual(f.mtime, SOURCE_MTIME, `${f.path}: the fixture must not share an mtime with the source`);
  }

  // SYNC 2, nothing changed — the steady state of a healthy reconnect. The server
  // must ask for NOTHING. Not the whole profile: reading the empty request list as
  // "send everything" is what made every reconnect re-upload every file.
  const nothing = decideStateSync({ previous: baseline, next: posted() });
  assert.equal(nothing.mode, SYNC_MODE_DELTA, "an unchanged profile is a delta, not a full transfer");
  assert.equal(nothing.reason, SYNC_REASONS.syncOnReconnect);
  assert.deepEqual(nothing.requestedPaths, [], "nothing changed, so nothing may be requested");
  assert.ok(nothing.delta && isDeltaEmpty(nothing.delta), "the delta must be empty");
  assert.deepEqual(nothing.excluded, [], "nothing in this profile is a secret to refuse");

  // And the delta is not VACUOUSLY empty: one changed file is asked for, by its own
  // name — spaces included, which is the spelling a naive URL encoding mangles.
  const oneChanged = decideStateSync({ previous: baseline, next: posted({ "Top Sites": "top-sites-v2" }) });
  assert.equal(oneChanged.mode, SYNC_MODE_DELTA);
  assert.deepEqual(oneChanged.requestedPaths, ["Top Sites"]);
});

test("a removal deletes from the cache, and refuses anything unsafe", async () => {
  const cache = mkdtempSync(join(tmpdir(), "sw-rm-"));
  await ingestStateFile({ cacheDir: cache, relPath: "Old Thing", content: Buffer.from("gone") });
  await ingestStateFile({ cacheDir: cache, relPath: "History", content: Buffer.from("keep") });

  const res = await applyStateRemovals({
    cacheDir: cache,
    paths: ["Old Thing", "History", "../../escape", "Never Was"],
  });
  assert.deepEqual(res.removed, ["Old Thing", "History"]);
  assert.equal(existsSync(join(cache, "Old Thing")), false);
  assert.equal(existsSync(join(cache, "History")), false);

  // The two refusals are NAMED and distinct: an escaping path is an attack or a
  // bug, an absent path is drift — and a replica that cannot tell them apart
  // cannot be diagnosed.
  const reasons = new Map(res.refused.map((r) => [r.path, r.reason]));
  assert.ok(reasons.get("../../escape"));
  assert.equal(reasons.get("Never Was"), "state_remove_not_found");
  // Nothing outside the cache was touched.
  assert.equal(existsSync(cache), true);
});

test("a removal path is refused before it can escape the cache", async () => {
  const cache = mkdtempSync(join(tmpdir(), "sw-rm2-"));
  const outside = join(cache, "..", "must-survive.txt");
  writeFileSync(outside, "keep me");
  const res = await applyStateRemovals({ cacheDir: cache, paths: ["../must-survive.txt"] });
  assert.deepEqual(res.removed, []);
  assert.equal(res.refused.length, 1);
  assert.equal(existsSync(outside), true, "a removal must never reach outside the cache");
});



