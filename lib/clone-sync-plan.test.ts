import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  MANIFEST_MAX_AGE_MS,
  SYNC_MODE_DELTA,
  SYNC_MODE_FULL,
  SYNC_REASONS,
  cloneStateExclusion,
  cloneStatePathProblem,
  deltaBytes,
  diffManifests,
  filterCloneStateFiles,
  isDeltaEmpty,
  planSync,
  validateSyncDecision,
} from "./clone-sync-plan";
import type { FileFingerprint, StateManifest, SyncDecision } from "./clone-sync-plan";

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2026-09-20T12:00:00Z");

function fp(path: string, size = 1024, mtime = T0, sha256?: string): FileFingerprint {
  return sha256 ? { path, size, mtime, sha256 } : { path, size, mtime };
}

/** A realistic profile: the files a clone really does carry. */
function manifest(atMs: number, files: FileFingerprint[]): StateManifest {
  return {
    deviceId: "dev-1",
    browser: "chrome",
    version: "141.0.7390.55",
    profile: "Default",
    capturedAt: new Date(atMs).toISOString(),
    files,
  };
}

const BASIC_FILES = [
  fp("History", 4096),
  fp("Bookmarks", 2048),
  fp("Preferences", 8192),
  fp("Sessions/Session_1", 512),
  fp("Sessions/Tabs_1", 256),
  fp("Network/Network Persistent State", 1024),
  fp("Local Storage/leveldb/000003.log", 65536),
];

const assertValid = (d: SyncDecision) => {
  const problem = validateSyncDecision(d);
  assert.equal(problem, null, `decision invalid: ${problem}`);
};

// ---------------------------------------------------------------------------
// First-time clone
// ---------------------------------------------------------------------------

test("a first-time clone is a full sync with a named reason", () => {
  const d = planSync(null, manifest(T0 + DAY, BASIC_FILES), { now: new Date(T0 + DAY) });
  assert.equal(d.mode, SYNC_MODE_FULL);
  assert.equal(d.reason, SYNC_REASONS.firstClone);
  assert.equal(d.delta, undefined);
  assert.equal(d.cookiesAlwaysFull, true);
  // A full sync has nothing to enumerate: the device sends everything readable.
  assert.deepEqual(d.requestedPaths, []);
  assertValid(d);
});

test("an empty stored manifest is not a usable baseline", () => {
  // Treating it as one would produce an empty delta and transfer NOTHING, which
  // is precisely how a replica ends up permanently empty.
  const d = planSync(manifest(T0, []), manifest(T0 + DAY, BASIC_FILES), { now: new Date(T0 + DAY) });
  assert.equal(d.mode, SYNC_MODE_FULL);
  assert.equal(d.reason, SYNC_REASONS.firstClone);
});

test("an unparseable capturedAt is treated as no baseline", () => {
  const stored = { ...manifest(T0, BASIC_FILES), capturedAt: "not a date" };
  const d = planSync(stored, manifest(T0 + DAY, BASIC_FILES), { now: new Date(T0 + DAY) });
  assert.equal(d.mode, SYNC_MODE_FULL);
  assertValid(d);
});

// ---------------------------------------------------------------------------
// Sync on reconnect
// ---------------------------------------------------------------------------

test("a reconnect sends only what changed", () => {
  const before = BASIC_FILES;
  const after = [
    fp("History", 8192), // changed: grew
    fp("Bookmarks", 2048), // unchanged
    fp("Preferences", 8192), // unchanged
    fp("Sessions/Session_1", 512), // unchanged
    fp("Sessions/Tabs_1", 900, T0 + DAY), // changed: same size, rewritten
    fp("Sessions/Tabs_2", 128, T0 + DAY), // added
    fp("Network/Network Persistent State", 1024), // unchanged
    // "Local Storage/leveldb/000003.log" is gone -> removed
  ];
  const d = planSync(manifest(T0, before), manifest(T0 + DAY, after), { now: new Date(T0 + DAY) });

  assert.equal(d.mode, SYNC_MODE_DELTA);
  assert.equal(d.reason, SYNC_REASONS.syncOnReconnect);
  assert.ok(d.delta);
  assert.equal(d.delta!.unchanged, 4);
  assert.deepEqual(
    d.delta!.added.map((f) => f.path),
    ["Sessions/Tabs_2"],
  );
  assert.deepEqual(d.delta!.changed.map((f) => f.path).sort(), ["History", "Sessions/Tabs_1"]);
  assert.deepEqual(d.delta!.removed, ["Local Storage/leveldb/000003.log"]);
  // The device is asked for exactly the files the server needs, and nothing else.
  assert.deepEqual(d.requestedPaths.sort(), ["History", "Sessions/Tabs_1", "Sessions/Tabs_2"]);
  assert.equal(d.cookiesAlwaysFull, true);
  assertValid(d);
});

test("a reconnect transfers a small fraction of a first clone", () => {
  const big = BASIC_FILES.map((f) => fp(f.path, 1 << 20)); // 7 MB profile
  const after = big.map((f) => ({ ...f }));
  after[0] = fp(after[0].path, (1 << 20) + 7); // one file grew
  const d = planSync(manifest(T0, big), manifest(T0 + DAY, after), { now: new Date(T0 + DAY) });

  assert.equal(d.mode, SYNC_MODE_DELTA);
  assert.ok(d.delta);
  const full = big.reduce((n, f) => n + f.size, 0);
  assert.ok(
    deltaBytes(d.delta!) < full / 4,
    `reconnect moved ${deltaBytes(d.delta!)} of ${full}; a delta must be a small fraction`,
  );
});

test("nothing changed is an empty delta and says so", () => {
  const d = planSync(manifest(T0, BASIC_FILES), manifest(T0 + DAY, BASIC_FILES), {
    now: new Date(T0 + DAY),
  });
  assert.equal(d.mode, SYNC_MODE_DELTA);
  assert.ok(d.delta);
  assert.equal(isDeltaEmpty(d.delta!), true);
  // An empty delta must still be a VALID delta, so the caller can skip the
  // transfer and go straight to the cookies instead of erroring.
  assertValid(d);
  assert.deepEqual(d.requestedPaths, []);
});

test("a removal alone is still work: the replica has to delete it", () => {
  const after = BASIC_FILES.filter((f) => f.path !== "Bookmarks");
  const d = planSync(manifest(T0, BASIC_FILES), manifest(T0 + DAY, after), {
    now: new Date(T0 + DAY),
  });
  assert.ok(d.delta);
  assert.equal(isDeltaEmpty(d.delta!), false);
  assert.deepEqual(d.delta!.removed, ["Bookmarks"]);
});

test("Windows path spellings are one file, not two", () => {
  // Re-sending every file on every sync is the failure this prevents.
  const d = diffManifests(
    [fp("Network\\LevelDB\\000005.ldb", 10, T0)],
    [fp("network/leveldb/000005.ldb", 10, T0)],
  );
  assert.equal(isDeltaEmpty(d), true);
});

test("a hash beats size and mtime in both directions", () => {
  // Same size and mtime, different content: the fast comparison is blind to it.
  const changed = diffManifests([fp("History", 100, T0, "aaaa")], [fp("History", 100, T0, "bbbb")]);
  assert.equal(changed.changed.length, 1);

  // Same content, mtime moved because Chrome touched the file at launch: NOT a
  // change. Without this every file would come back on every reconnect.
  const unchanged = diffManifests(
    [fp("History", 100, T0, "aaaa")],
    [fp("History", 100, T0 + DAY, "aaaa")],
  );
  assert.equal(isDeltaEmpty(unchanged), true);

  // With a hash on only one side, size+mtime is all there is.
  const oneSided = diffManifests([fp("History", 100, T0)], [fp("History", 100, T0, "zzzz")]);
  assert.equal(isDeltaEmpty(oneSided), true);
});

test("a duplicate path does not become two files", () => {
  const d = diffManifests(
    [fp("History", 100, T0), fp("HISTORY", 100, T0)],
    [fp("history", 100, T0)],
  );
  assert.equal(isDeltaEmpty(d), true);
});

// ---------------------------------------------------------------------------
// When a delta must be refused
// ---------------------------------------------------------------------------
//
// A delta against the wrong baseline is how a replica silently loses data, so
// every one of these is a full transfer with its own named reason.

test("a delta is refused for a different browser, profile or device", () => {
  const stored = manifest(T0, BASIC_FILES);

  const otherBrowser = planSync(
    stored,
    { ...manifest(T0 + DAY, BASIC_FILES), browser: "edge" },
    { now: new Date(T0 + DAY) },
  );
  assert.equal(otherBrowser.mode, SYNC_MODE_FULL);
  assert.equal(otherBrowser.reason, SYNC_REASONS.browserChanged);

  const otherProfile = planSync(
    stored,
    { ...manifest(T0 + DAY, BASIC_FILES), profile: "Profile 2" },
    { now: new Date(T0 + DAY) },
  );
  assert.equal(otherProfile.mode, SYNC_MODE_FULL);
  assert.equal(otherProfile.reason, SYNC_REASONS.profileChanged);

  const otherDevice = planSync(
    stored,
    { ...manifest(T0 + DAY, BASIC_FILES), deviceId: "dev-2" },
    { now: new Date(T0 + DAY) },
  );
  assert.equal(otherDevice.mode, SYNC_MODE_FULL);
  assert.equal(otherDevice.reason, SYNC_REASONS.deviceChanged);

  assertValid(otherBrowser);
  assertValid(otherProfile);
  assertValid(otherDevice);
});

test("a major browser upgrade forces a full sync", () => {
  const d = planSync(
    manifest(T0, BASIC_FILES),
    { ...manifest(T0 + DAY, BASIC_FILES), version: "142.0.7444.1" },
    { now: new Date(T0 + DAY) },
  );
  assert.equal(d.mode, SYNC_MODE_FULL);
  assert.equal(d.reason, SYNC_REASONS.versionChanged);
  assertValid(d);
});

test("a minor version change is still a delta", () => {
  const d = planSync(
    manifest(T0, BASIC_FILES),
    { ...manifest(T0 + DAY, BASIC_FILES), version: "141.0.7499.99" },
    { now: new Date(T0 + DAY) },
  );
  assert.equal(d.mode, SYNC_MODE_DELTA);
});

test("a stale manifest forces a full sync, and the boundary is exact", () => {
  // A week of drift can rewrite the history database in place, and a delta
  // against a stale list would silently omit that change.
  const stale = planSync(manifest(T0, BASIC_FILES), manifest(T0 + 8 * DAY, BASIC_FILES), {
    now: new Date(T0 + 8 * DAY),
  });
  assert.equal(stale.mode, SYNC_MODE_FULL);
  assert.equal(stale.reason, SYNC_REASONS.manifestStale);

  // Exactly at the edge is still inside the window.
  const edge = planSync(manifest(T0, BASIC_FILES), manifest(T0 + MANIFEST_MAX_AGE_MS, BASIC_FILES), {
    now: new Date(T0 + MANIFEST_MAX_AGE_MS),
  });
  assert.equal(edge.mode, SYNC_MODE_DELTA);
});

test("an explicit window can be shorter or longer than the default", () => {
  const stored = manifest(T0, BASIC_FILES);
  const next = manifest(T0 + DAY, BASIC_FILES);

  const tight = planSync(stored, next, { now: new Date(T0 + DAY), maxAgeMs: 60 * 60 * 1000 });
  assert.equal(tight.mode, SYNC_MODE_FULL);
  assert.equal(tight.reason, SYNC_REASONS.manifestStale);

  const loose = planSync(stored, next, { now: new Date(T0 + DAY), maxAgeMs: 30 * DAY });
  assert.equal(loose.mode, SYNC_MODE_DELTA);

  // A zero window means the default, not "everything is stale".
  assert.equal(planSync(stored, next, { now: new Date(T0 + DAY), maxAgeMs: 0 }).mode, SYNC_MODE_DELTA);
});

// ---------------------------------------------------------------------------
// The receiving end refuses secrets and escapes
// ---------------------------------------------------------------------------

test("secret-bearing profile files are never carried", () => {
  const reasons: Record<string, string> = {
    Cookies: "cookies_abe_bound_use_cdp",
    "Network/Cookies": "cookies_abe_bound_use_cdp",
    "Network\\Cookies": "cookies_abe_bound_use_cdp",
    "Login Data": "passwords_abe_bound_unusable_in_clone",
    "Network/Login Data": "passwords_abe_bound_unusable_in_clone",
    "Login Data For Account": "passwords_abe_bound_unusable_in_clone",
    "Cookies-journal": "cookies_abe_bound_use_cdp",
    "Local State": "abe_key_store_never_transferred",
  };
  for (const [path, want] of Object.entries(reasons)) {
    assert.equal(cloneStateExclusion(path), want, `${path} must be excluded`);
  }
  // Case is not a way around it.
  assert.equal(cloneStateExclusion("COOKIES"), "cookies_abe_bound_use_cdp");
  assert.equal(cloneStateExclusion("local state"), "abe_key_store_never_transferred");
});

test("ordinary state files are carried", () => {
  const carried = [
    "History",
    "Bookmarks",
    "Preferences",
    "Secure Preferences",
    "Web Data",
    "Sessions/Session_1",
    "Sessions/Tabs_1",
    "Current Session",
    "Network/Network Persistent State",
    "Local Storage/leveldb/000003.log",
    "Extensions/abc/manifest.json",
  ];
  for (const path of carried) {
    assert.equal(cloneStateExclusion(path), null, `${path} must be carried`);
  }
});

/**
 * The exclusion list is duplicated on purpose (device + server sit on opposite
 * ends of a trust boundary, so a shared library would let one mistake disable the
 * check on both sides). This pins the SERVER's full list so a change here has to
 * be deliberate — and `npm run check:clone-contract` fails if it ever drifts from
 * the device's `engine/pkg/wake/sensitives.go`.
 */
test("the server's exclusion list is exactly the agreed contract", () => {
  const expected: Record<string, string> = {
    cookies: "cookies_abe_bound_use_cdp",
    "cookies-journal": "cookies_abe_bound_use_cdp",
    "login data": "passwords_abe_bound_unusable_in_clone",
    "login data for account": "passwords_abe_bound_unusable_in_clone",
    "login data-journal": "passwords_abe_bound_unusable_in_clone",
    "login data for account-journal": "passwords_abe_bound_unusable_in_clone",
    "local state": "abe_key_store_never_transferred",
    app_bound_encrypted_key: "abe_key_store_never_transferred",
    "affiliation database": "unused_by_clone",
    "preferences-journal": "journal_transient",
    "secure preferences-journal": "journal_transient",
  };
  for (const [name, reason] of Object.entries(expected)) {
    assert.equal(cloneStateExclusion(name), reason, `${name} must be excluded as ${reason}`);
  }
  // Nothing extra may creep in unnoticed: a file silently excluded is as much a
  // defect as one silently carried.
  const extra = Object.keys(expected).filter((name) => cloneStateExclusion(name) === null);
  assert.deepEqual(extra, []);
});

test("a path that escapes the profile root is refused", () => {
  const bad: Record<string, string> = {
    "../secrets.txt": "state_path_escapes_profile",
    "..\\secrets.txt": "state_path_escapes_profile",
    "a/../../b": "state_path_escapes_profile",
    "..": "state_path_escapes_profile",
    "/etc/passwd": "state_path_absolute",
    "\\\\Windows\\System32\\config\\SAM": "state_path_unc",
    "C:/Windows/System32/config/SAM": "state_path_drive_relative",
    "C:History": "state_path_drive_relative",
    "": "state_path_empty",
    "   ": "state_path_empty",
  };
  for (const [path, want] of Object.entries(bad)) {
    assert.equal(cloneStatePathProblem(path), want, `${path} must be refused`);
  }
});

test("ordinary profile paths are safe", () => {
  const good = [
    "History",
    "Sessions/Tabs_1",
    "Local Storage/leveldb/000003.log",
    "IndexedDB/https_example.com_0.indexeddb.leveldb/000010.ldb",
    "a/../b",
    "Extensions/abc/x.js",
  ];
  for (const path of good) {
    assert.equal(cloneStatePathProblem(path), null, `${path} must be accepted`);
  }
});

test("a manifest naming the ABE key store is refused and accounted for", () => {
  const { kept, excluded } = filterCloneStateFiles([
    fp("History", 1),
    fp("Local State", 2),
    fp("../../evil", 3),
    fp("Bookmarks", 4),
  ]);
  assert.deepEqual(
    kept.map((f) => f.path),
    ["History", "Bookmarks"],
  );
  assert.equal(excluded.length, 2);
  for (const e of excluded) {
    assert.ok(e.reason.length > 0, `${e.path} was dropped with no reason`);
  }
  // Nothing vanishes without being reported: kept + excluded == input.
  assert.equal(kept.length + excluded.length, 4);
});

test("a decision never asks for a path it refused", () => {
  const stored = manifest(T0, BASIC_FILES);
  const next = manifest(T0 + DAY, [
    ...BASIC_FILES,
    fp("Local State", 9999, T0 + DAY), // sensitive -> refused
  ]);
  const d = planSync(stored, next, { now: new Date(T0 + DAY) });

  assert.equal(d.mode, SYNC_MODE_DELTA);
  assert.ok(d.requestedPaths.every((p) => p !== "Local State"), "an excluded path was requested");
  assert.ok(d.excluded.some((e) => e.path === "Local State"));
  // And the guard would have caught it if the two ever disagreed.
  assertValid(d);
});

test("a stored baseline containing a sensitive path cannot resurrect it", () => {
  // A manifest written before this rule existed, or by a tampered device.
  const poisoned = manifest(T0, [...BASIC_FILES, fp("Local State", 9999, T0)]);
  const next = manifest(T0 + DAY, [...BASIC_FILES, fp("Local State", 9999, T0)]);
  const d = planSync(poisoned, next, { now: new Date(T0 + DAY) });

  assert.ok(d.delta);
  const paths = [...d.delta!.added, ...d.delta!.changed].map((f) => f.path);
  assert.ok(!paths.includes("Local State"), "a sensitive file came back through the diff");
  assert.ok(!d.requestedPaths.includes("Local State"));
  assertValid(d);
});

// ---------------------------------------------------------------------------
// The validator itself
// ---------------------------------------------------------------------------

test("the validator rejects decisions that would under-send", () => {
  assert.equal(
    validateSyncDecision({
      mode: SYNC_MODE_DELTA,
      reason: SYNC_REASONS.syncOnReconnect,
      cookiesAlwaysFull: true,
      requestedPaths: [],
      excluded: [],
    }),
    "sync_delta_missing_delta",
  );
  assert.equal(
    validateSyncDecision({
      mode: SYNC_MODE_FULL,
      reason: SYNC_REASONS.firstClone,
      delta: { added: [], changed: [], removed: [], unchanged: 0 },
      cookiesAlwaysFull: true,
      requestedPaths: [],
      excluded: [],
    }),
    "sync_full_carries_a_delta",
  );
  assert.equal(
    validateSyncDecision({
      mode: "incremental" as never,
      reason: SYNC_REASONS.syncOnReconnect,
      cookiesAlwaysFull: true,
      requestedPaths: [],
      excluded: [],
    }),
    "sync_mode_unknown:incremental",
  );
});

test("the validator catches a request for a path the decision excluded", () => {
  // This is the pairing that keeps the two halves honest: the exclusion list and
  // the request list must never disagree.
  const problem = validateSyncDecision({
    mode: SYNC_MODE_DELTA,
    reason: SYNC_REASONS.syncOnReconnect,
    delta: { added: [], changed: [], removed: [], unchanged: 0 },
    cookiesAlwaysFull: true,
    requestedPaths: ["Network\\Cookies"],
    excluded: [{ path: "Network/Cookies", reason: "cookies_abe_bound_use_cdp" }],
  });
  assert.equal(problem, "sync_requests_excluded_path:Network\\Cookies");
});
