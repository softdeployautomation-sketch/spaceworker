import { test } from "node:test";
import assert from "node:assert/strict";
import {
  INDEX_FAILURE_TTL_MS,
  INDEX_TTL_MS,
  loadChromeForTestingIndex,
  majorOfVersion,
  planCloneBrowserPin,
  resetChromeForTestingIndexCache,
  resolveCloneBrowserPin,
} from "./clone-browser-pin";
import {
  MIN_SUPPORTED_MAJOR,
  resolveHostedBrowser,
  type ChromeForTestingIndex,
} from "./hosted-browser-version";

// TASK_135 §4 — the launch-path half of version matching.
//
// The defence being tested is concrete: a launch must never serve "latest" when
// the source version is unknown or unmatchable. It must refuse with a code a
// human can read, and it must offer the way out (`fresh`). A resolver that
// quietly falls back is indistinguishable from a working one until somebody's
// tabs are gone, so every refusal is pinned by name here.

function index(...versions: string[]): ChromeForTestingIndex {
  return { versions: versions.map((version) => ({ version })) };
}

/** A fetcher that fails the test if it is called at all. */
function forbiddenFetch(): () => Promise<ChromeForTestingIndex | null> {
  return async () => {
    throw new Error("the index must not be fetched for this input");
  };
}

test("majorOfVersion reads the forms the engine actually reports", () => {
  // Chrome/Edge: the profile's `Last Version` file.
  assert.equal(majorOfVersion("141.0.7390.54"), 141);
  // Firefox: `compatibility.ini`.
  assert.equal(majorOfVersion("141.0"), 141);
  // A bare major, which a device may report when the patch is unreadable.
  assert.equal(majorOfVersion("141"), 141);
  assert.equal(majorOfVersion(" 141.0.7390.54 "), 141);
});

test("junk is UNDETERMINED, never version zero", () => {
  // The distinction matters: unknown refuses `browser_version_unknown`, and a
  // bogus 0 would refuse `browser_version_unsupported: 0` instead — a different,
  // misleading code for the same real problem.
  for (const bad of ["", "   ", "abc", "v141", "141.x", "-141", "0", "1.2.3.4.5", "141.", "14 1"]) {
    assert.equal(majorOfVersion(bad), null, `${JSON.stringify(bad)} must be null`);
  }
  assert.equal(majorOfVersion(null), null);
  assert.equal(majorOfVersion(undefined), null);
});

test("an exact-major build is pinned, at the highest patch", () => {
  const r = planCloneBrowserPin({
    sourceBrowser: "chrome",
    sourceVersion: "141.0.7390.12",
    index: index("141.0.7390.50", "140.0.7339.1", "141.0.7390.55", "142.0.7444.2"),
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.pin.major, 141);
  assert.equal(r.pin.fullVersion, "141.0.7390.55");
  assert.match(r.pin.downloadUrl, /chrome-linux64\.zip$/);
});

test("every refusal keeps its major in the code, and offers fresh", () => {
  const unmatchable = planCloneBrowserPin({
    sourceBrowser: "chrome",
    sourceVersion: "157.0.1.1",
    index: index("141.0.7390.55"),
  });
  assert.deepEqual(unmatchable, {
    ok: false,
    error: `browser_version_unsupported: 157`,
    fallback: "fresh",
  });

  const noIndex = planCloneBrowserPin({
    sourceBrowser: "chrome",
    sourceVersion: "141.0.7390.12",
    index: null,
  });
  // A network problem is NOT reported as an unsupported version.
  assert.equal(noIndex.ok, false);
  assert.equal(noIndex.ok === false && noIndex.error, "browser_version_index_unavailable: 141");

  const unknown = planCloneBrowserPin({ sourceBrowser: "chrome", sourceVersion: "", index: null });
  assert.equal(unknown.ok === false && unknown.error, "browser_version_unknown");

  const firefox = planCloneBrowserPin({
    sourceBrowser: "firefox",
    sourceVersion: "141.0",
    index: index("141.0.7390.55"),
  });
  // The exact code the resolver owns, compared against the resolver itself.
  // Spelling it differently here (e.g. `browser_not_supported: firefox`) is what
  // previously made two entry points of this module disagree about one failure, so
  // the equality is asserted against the source of truth rather than a literal.
  const owned = resolveHostedBrowser({ browser: "firefox", major: 141, index: null });
  assert.equal(owned.ok, false);
  assert.equal(firefox.ok === false && firefox.error, owned.ok === false && owned.code);
});

test("the clone presents the SOURCE device's identity, not a container's", () => {
  const win = planCloneBrowserPin({
    sourceBrowser: "edge",
    sourceVersion: "141.0.7390.12",
    os: "Microsoft Windows 11 Pro",
    lang: "en-GB",
    index: index("141.0.7390.55"),
  });
  assert.equal(win.ok, true);
  if (!win.ok) return;
  assert.match(win.pin.userAgent, /Windows NT 10\.0; Win64; x64/);
  assert.match(win.pin.userAgent, /Chrome\/141\.0\.0\.0/);
  assert.deepEqual(win.pin.flags, [`--user-agent=${win.pin.userAgent}`, "--lang=en-GB"]);

  const mac = planCloneBrowserPin({
    sourceBrowser: "chrome",
    sourceVersion: "141",
    os: "macOS 15.1",
    index: index("141.0.7390.55"),
  });
  assert.equal(mac.ok && /Macintosh/.test(mac.pin.userAgent), true);

  // No language reported: no flag. A default here would rewrite the clone's UI
  // language to something the user never chose.
  const noLang = planCloneBrowserPin({
    sourceBrowser: "chrome",
    sourceVersion: "141",
    os: "Ubuntu 24.04",
    index: index("141.0.7390.55"),
  });
  assert.equal(noLang.ok && noLang.pin.lang, null);
  assert.deepEqual(noLang.ok && noLang.pin.flags, [`--user-agent=${noLang.ok ? noLang.pin.userAgent : ""}`]);
});

test("an index-independent refusal never reaches the network", async () => {
  // Not an optimisation: a launch that cannot possibly succeed should not depend
  // on an outbound call, so a broken network can never turn a clear "no version
  // reported" into a confusing "build list unavailable".
  const fetchIndex = forbiddenFetch();
  for (const job of [
    { browser: "firefox", sourceBrowserVersion: "141.0" },
    { browser: "edge", sourceBrowserVersion: "" },
    { browser: "chrome", sourceBrowserVersion: "abc" },
    { browser: "chrome", sourceBrowserVersion: "" },
    { browser: "chrome", sourceBrowserMajor: null, sourceBrowserVersion: null },
  ]) {
    const r = await resolveCloneBrowserPin(job, { loadIndex: fetchIndex });
    assert.equal(r.ok, false, `${JSON.stringify(job)} must refuse`);
    assert.equal(r.ok === false && r.fallback, "fresh");
  }
});

test("a below-floor major is refused even when builds for it exist", async () => {
  // The floor is enforced by the resolver, behind its index check, so this path
  // does fetch once (cached) rather than re-deriving the code here — the trade the
  // preflight comment records. The point of the test is that the floor WINS: a
  // profile written by a pre-113 browser is not carried into a modern build.
  let calls = 0;
  const r = await resolveCloneBrowserPin(
    { browser: "chrome", sourceBrowserMajor: MIN_SUPPORTED_MAJOR - 1, osName: "Windows 10" },
    {
      loadIndex: async () => {
        calls += 1;
        // A build for that very version is present, to prove the floor is checked
        // rather than the match merely failing.
        return index(`${MIN_SUPPORTED_MAJOR - 1}.0.1.1`, "141.0.7390.55");
      },
    },
  );
  assert.equal(calls, 1);
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.error, `browser_version_unsupported: ${MIN_SUPPORTED_MAJOR - 1}`);
  assert.equal(r.ok === false && r.fallback, "fresh");
});

test("a resolvable input fetches the index once and pins exactly", async () => {
  let calls = 0;
  const loadIndex = async () => {
    calls += 1;
    return index("141.0.7390.50", "141.0.7390.55");
  };
  const r = await resolveCloneBrowserPin(
    { browser: "chrome", sourceBrowserMajor: 141, sourceBrowserVersion: "141.0.7390.12", osName: "Windows 11" },
    { loadIndex },
  );
  assert.equal(calls, 1);
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.pin.fullVersion, "141.0.7390.55");
});

test("the index fetch itself fails soft, as its own named refusal", async () => {
  const r = await resolveCloneBrowserPin(
    { browser: "chrome", sourceBrowserMajor: 141 },
    { loadIndex: async () => null },
  );
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.error, "browser_version_index_unavailable: 141");
});

test("the index is cached, so a container start is not a Google round-trip", async () => {
  resetChromeForTestingIndexCache();
  let calls = 0;
  const fetchIndex = async () => {
    calls += 1;
    return index("141.0.7390.55");
  };
  const t0 = 1_000_000;
  const first = await loadChromeForTestingIndex({ now: t0, fetchIndex });
  const second = await loadChromeForTestingIndex({ now: t0 + INDEX_TTL_MS - 1, fetchIndex });
  assert.equal(calls, 1);
  assert.equal(first?.versions.length, 1);
  assert.equal(second?.versions.length, 1);
  // Past the TTL it refetches, so a new Chrome release is picked up without a
  // process restart.
  await loadChromeForTestingIndex({ now: t0 + INDEX_TTL_MS + 1, fetchIndex });
  assert.equal(calls, 2);
  resetChromeForTestingIndexCache();
});

test("a failed index fetch is never cached as an EMPTY index", async () => {
  // The dangerous shortcut: negative-cache as `{versions: []}`, which would make
  // the next launch of a perfectly ordinary browser report
  // `browser_version_unsupported` — blaming the user's version for our outage.
  resetChromeForTestingIndexCache();
  let calls = 0;
  const flaky = async () => {
    calls += 1;
    return calls === 1 ? null : index("141.0.7390.55");
  };
  const t0 = 5_000_000;
  const failed = await loadChromeForTestingIndex({ now: t0, fetchIndex: flaky });
  assert.equal(failed, null);

  // Within the short failure window we do not hammer a dead endpoint...
  const stillNull = await loadChromeForTestingIndex({ now: t0 + INDEX_FAILURE_TTL_MS - 1, fetchIndex: flaky });
  assert.equal(stillNull, null);
  assert.equal(calls, 1);

  // ...but unlike a real index it expires quickly, and recovery is not blocked:
  // the same caller, moments later, resolves the pin it was refused before.
  const recovered = await loadChromeForTestingIndex({ now: t0 + INDEX_FAILURE_TTL_MS + 1, fetchIndex: flaky });
  assert.equal(calls, 2);
  assert.equal(recovered?.versions.length, 1);

  const pinned = await resolveCloneBrowserPin(
    { browser: "chrome", sourceBrowserMajor: 141 },
    { index: recovered },
  );
  assert.equal(pinned.ok, true);
  assert.equal(pinned.ok && pinned.pin.fullVersion, "141.0.7390.55");
  resetChromeForTestingIndexCache();
});

test("the failure window is far shorter than the success window", () => {
  // If someone ever flips these, an outage would be cached for six hours and a
  // real index would be refetched every minute. Cheap to assert, expensive to
  // discover in production.
  assert.ok(INDEX_FAILURE_TTL_MS < INDEX_TTL_MS / 10);
});

/** The module must not explode on shapes a buggy caller can produce. */
test("planning never throws, whatever it is handed", () => {
  const inputs = [
    {}, 
    { sourceBrowser: null, sourceVersion: null, index: null },
    { sourceBrowser: "  ", sourceVersion: "141", index: index("141.0.7390.55") },
    { sourceBrowser: "CHROME", sourceVersion: "141", index: index("141.0.7390.55") },
  ];
  for (const input of inputs) {
    const r = planCloneBrowserPin({ index: null, ...input } as Parameters<typeof planCloneBrowserPin>[0]);
    assert.equal(typeof r.ok, "boolean");
  }
  // An ABSENT browser name must not be the reason a clone is refused — the
  // version check is what refuses, and a name we were never given is not evidence
  // of anything.
  const unnamed = planCloneBrowserPin({ sourceVersion: "141", index: index("141.0.7390.55") });
  assert.equal(unnamed.ok, true);
});
