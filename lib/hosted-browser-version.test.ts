import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MIN_SUPPORTED_MAJOR,
  chromeForTestingDownloadUrl,
  fetchChromeForTestingIndex,
  majorOf,
  parityFlags,
  parseChromeForTestingIndex,
  resolveHostedBrowser,
  sourceUserAgent,
  type ChromeForTestingIndex,
} from "./hosted-browser-version";

// TASK_135 §4 — deliver a destination build matching the source version.
//
// These tests are written to attack the resolver, not to confirm it. The failure
// mode being defended against is specific and nasty: a clone that OPENS but is
// running the wrong browser version, which half-loads the user's profile and looks
// like a working feature until someone notices their tabs are gone.

/** A small index in the real payload's shape (measured against the live doc). */
function index(...versions: string[]): ChromeForTestingIndex {
  return { versions: versions.map((version) => ({ version })) };
}

test("resolves the highest patch of the requested major", () => {
  const r = resolveHostedBrowser({
    browser: "chrome",
    major: 141,
    // Deliberately out of order, and with a neighbouring major mixed in, so a
    // first-match or last-match implementation fails here.
    index: index("141.0.7390.50", "140.0.7339.1", "141.0.7390.55", "142.0.7444.2"),
  });
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.fullVersion, "141.0.7390.55");
  assert.equal(r.ok && r.major, 141);
});

test("patch comparison is numeric, not lexicographic", () => {
  // "141.0.7390.9" > "141.0.7390.10" as strings. A lexicographic compare picks
  // the older build and the test above would still pass, so this pins it.
  const r = resolveHostedBrowser({
    browser: "chrome",
    major: 141,
    index: index("141.0.7390.9", "141.0.7390.10"),
  });
  assert.equal(r.ok && r.fullVersion, "141.0.7390.10");
});

test("the download URL matches CfT's real layout", () => {
  const r = resolveHostedBrowser({ browser: "chrome", major: 141, index: index("141.0.7390.55") });
  assert.equal(r.ok, true);
  assert.equal(
    r.ok && r.downloadUrl,
    "https://storage.googleapis.com/chrome-for-testing-public/141.0.7390.55/linux64/chrome-linux64.zip",
  );
  assert.equal(
    chromeForTestingDownloadUrl("141.0.7390.55", "linux64"),
    "https://storage.googleapis.com/chrome-for-testing-public/141.0.7390.55/linux64/chrome-linux64.zip",
  );
});

test("edge and chromium sources resolve like chrome", () => {
  for (const browser of ["chrome", "edge", "chromium", "EDGE", " Chrome "]) {
    const r = resolveHostedBrowser({ browser, major: 141, index: index("141.0.7390.55") });
    assert.equal(r.ok, true, `${browser} must resolve`);
    assert.equal(r.ok && r.fullVersion, "141.0.7390.55");
  }
});

test("firefox refuses by name and offers a fresh session", () => {
  const r = resolveHostedBrowser({ browser: "firefox", major: 141, index: index("141.0.7390.55") });
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.reason, "browser_not_supported");
  assert.equal(r.ok === false && r.fallback.fresh, true);
  assert.equal(r.ok === false && r.code, "browser_not_supported: 141");
});

test("an unknown version is NEVER treated as newest", () => {
  // The single most dangerous shortcut in this module: `null` meaning "just use
  // latest" would open a mismatched profile while looking successful.
  const r = resolveHostedBrowser({ browser: "chrome", major: null, index: index("156.0.100.1") });
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.reason, "browser_version_unknown");
  assert.equal(r.ok === false && r.code, "browser_version_unknown");
});

test("a version with no matching build refuses rather than substituting", () => {
  const r = resolveHostedBrowser({ browser: "chrome", major: 157, index: index("156.0.100.1") });
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.code, "browser_version_unsupported: 157");
  // Specifically: it must NOT have quietly returned 156.
  assert.equal(r.ok, false);
});

test("a source newer than every known build refuses (never a downgrade)", () => {
  // Serving an OLDER browser than the source is the direction that corrupts a
  // profile written by the newer one, so it must not be offered as a match.
  const r = resolveHostedBrowser({ browser: "chrome", major: 156, index: index("155.0.1.1", "154.0.1.1") });
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.reason, "browser_version_unsupported");
});

test("an unreadable index is its own refusal, distinct from an unsupported version", () => {
  const r = resolveHostedBrowser({ browser: "chrome", major: 141, index: null });
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.reason, "browser_version_index_unavailable");
});

test("refusal precedence: browser before version before index", () => {
  // Firefox + unknown version + no index: the browser is the most fundamental
  // fact, so that is what must be reported.
  const r = resolveHostedBrowser({ browser: "firefox", major: null, index: null });
  assert.equal(r.ok === false && r.reason, "browser_not_supported");

  // A known browser with an unknown version beats a missing index, because the
  // version is what the user can actually act on.
  const r2 = resolveHostedBrowser({ browser: "chrome", major: null, index: null });
  assert.equal(r2.ok === false && r2.reason, "browser_version_unknown");

  const r3 = resolveHostedBrowser({ browser: "chrome", major: 141, index: null });
  assert.equal(r3.ok === false && r3.reason, "browser_version_index_unavailable");
});

test("versions below the measured floor refuse", () => {
  assert.ok(MIN_SUPPORTED_MAJOR >= 113, "the floor tracks CfT's real range");
  const r = resolveHostedBrowser({
    browser: "chrome",
    major: MIN_SUPPORTED_MAJOR - 1,
    index: index(`${MIN_SUPPORTED_MAJOR - 1}.0.1.1`),
  });
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.reason, "browser_version_unsupported");
});

// ---------------------------------------------------------------------------
// Index parsing — tolerant of a changing remote shape, but never silently empty
// (an empty parse that "resolves" nothing looks identical to a real no-match).
// ---------------------------------------------------------------------------

test("parses the real payload shape", () => {
  const parsed = parseChromeForTestingIndex({
    versions: [{ version: "141.0.7390.55", downloads: { chrome: [{ url: "https://x/chrome-linux64.zip" }] } }],
  });
  assert.ok(parsed);
  assert.equal(parsed?.versions.length, 1);
  assert.equal(parsed?.versions[0].version, "141.0.7390.55");
});

test("a malformed payload is null, not an empty index", () => {
  // Empty would resolve as "unsupported version"; null resolves as "index
  // unavailable" — a different, honest story for the operator.
  for (const bad of [null, undefined, 42, "nope", {}, { versions: [] }, { versions: "no" }]) {
    assert.equal(parseChromeForTestingIndex(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test("junk entries are skipped without losing the good ones", () => {
  const parsed = parseChromeForTestingIndex({
    versions: [null, { version: "" }, { version: 141 }, "x", { version: "141.0.7390.55" }],
  });
  assert.equal(parsed?.versions.length, 1);
  assert.equal(parsed?.versions[0].version, "141.0.7390.55");
});

test("majorOf parses real version strings and rejects rubbish", () => {
  assert.equal(majorOf("141.0.7390.55"), 141);
  assert.equal(majorOf(" 113.0.5672.0 "), 113);
  assert.equal(majorOf("141"), null, "no dot is not a full version");
  assert.equal(majorOf(""), null);
  assert.equal(majorOf(null), null);
  assert.equal(majorOf(undefined), null);
  assert.equal(majorOf("abc.1"), null);
});

// ---------------------------------------------------------------------------
// Identity parity
// ---------------------------------------------------------------------------

test("the user agent reflects the device, not the container", () => {
  const win = sourceUserAgent({ major: 141 });
  assert.ok(win.includes("Windows NT 10.0"), win);
  // Frozen form: Chrome reports <major>.0.0.0 under UA reduction.
  assert.ok(win.includes("Chrome/141.0.0.0"), win);
  // Must never leak the real platform, which is the whole point.
  assert.ok(!win.includes("Linux"), win);

  assert.ok(sourceUserAgent({ major: 141, os: "macOS" }).includes("Macintosh"));
  assert.ok(sourceUserAgent({ major: 141, os: "Linux" }).includes("X11; Linux x86_64"));
});

test("parity flags are emitted only when set, so the plain conf never changes", () => {
  assert.deepEqual(parityFlags({}), []);
  assert.deepEqual(parityFlags({ userAgent: "  ", lang: "" }), []);
  assert.deepEqual(parityFlags({ lang: "en-GB" }), ["--lang=en-GB"]);
  assert.deepEqual(parityFlags({ userAgent: "UA" }), ["--user-agent=UA"]);
  // Order is stable, so the generated conf is reproducible.
  assert.deepEqual(parityFlags({ userAgent: "UA", lang: "en-GB" }), ["--user-agent=UA", "--lang=en-GB"]);
});

test("the resolver never throws, whatever it is handed", () => {
  // A launch path calling this must get a refusal, not an exception.
  const junk = [undefined, null, "", "chrome", "CHROME"] as const;
  for (const browser of junk) {
    for (const major of [null, 0, -1, 1.5, Number.NaN, 141]) {
      const r = resolveHostedBrowser({ browser: browser as string, major: major as number | null, index: null });
      assert.equal(typeof (r.ok === false && r.code), "string");
    }
  }
});

test("the network helper fails soft when the index is unreachable", async () => {
  // Points at a closed port: must return null rather than reject, so a launch
  // turns it into a named refusal instead of an unhandled rejection.
  const parsed = await fetchChromeForTestingIndex("http://127.0.0.1:1/nope.json", 2000);
  assert.equal(parsed, null);
});
