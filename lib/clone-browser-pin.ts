// TASK_135 — the ONE place that decides which destination browser build a clone
// gets, and refuses by name when it cannot decide.
//
// Why this is not simply a call to `resolveHostedBrowser`
// (lib/hosted-browser-version.ts): resolution is pure and takes an index, but a
// launch path needs three more things that only exist at launch time —
//
//   1. the index, fetched once and CACHED (a container start must not depend on a
//      network round-trip to Google on every session, and must not silently
//      degrade when that fetch fails);
//   2. the JOB's declared source version, which is where "unknown" comes from;
//   3. the parity inputs (user agent, language) that make the clone look like the
//      user's own machine rather than a Linux container.
//
// The refusals are the point. Every failure path here returns a NAMED error plus
// the `fresh` fallback, so the console can offer a session that logs in for itself
// instead of a dead end — and never a clone that quietly half-loaded a profile.

import {
  DESTINATION_PLATFORM,
  fetchChromeForTestingIndex,
  parityFlags,
  resolveHostedBrowser,
  sourceUserAgent,
  type ChromeForTestingIndex,
} from "./hosted-browser-version";

export interface CloneBrowserPin {
  major: number;
  fullVersion: string;
  platform: string;
  downloadUrl: string;
  userAgent: string;
  lang: string | null;
  /** The extra Chromium flags that give the clone the source's identity. */
  flags: string[];
}

export type CloneBrowserPinResult =
  | { ok: true; pin: CloneBrowserPin }
  | { ok: false; error: string; fallback: "fresh" };

/**
 * Pure. Splits a version string into its major, or null when there isn't one.
 * Accepts the forms the engine can actually report — "141.0.7390.54" (Chrome and
 * Edge, from the profile's `Last Version` file) and "141.0" (Firefox, from
 * `compatibility.ini`) — and nothing else. Junk is null (undetermined), never 0,
 * because "unknown" and "version zero" lead to different refusals.
 */
export function majorOfVersion(version: string | null | undefined): number | null {
  const raw = (version ?? "").trim();
  const match = /^(\d{1,4})(?:\.\d+){0,3}$/.exec(raw);
  if (!match) return null;
  const major = Number(match[1]);
  return Number.isInteger(major) && major > 0 ? major : null;
}

/**
 * Pure. The whole decision, given an already-fetched index (or null when the
 * index could not be had). Split from the fetch so every branch — every refusal —
 * is testable without a network.
 *
 * `sourceBrowser` is passed through rather than assumed to be Chromium: a Firefox
 * source is a real case the fleet will hit, and it must refuse with the named
 * `browser_not_supported` (offering `fresh`) instead of silently resolving to a
 * Chromium build that could never load a Firefox profile.
 */
export function planCloneBrowserPin(input: {
  /** The engine's browser name: chrome | edge | firefox | chromium | ... */
  sourceBrowser?: string | null;
  /** What the source device reported. Null/empty = undetermined. */
  sourceVersion?: string | null;
  /** The major, when the capture reported it separately from the version. */
  sourceMajor?: number | null;
  /** Device.osName, used only to shape the user agent. */
  os?: string | null;
  /** Source UI language, if the capture reported one. */
  lang?: string | null;
  index: ChromeForTestingIndex | null;
}): CloneBrowserPinResult {
  const major = input.sourceMajor ?? majorOfVersion(input.sourceVersion);
  const resolved = resolveHostedBrowser({
    // An absent name is treated as Chromium-family: the version check below is
    // what actually refuses, and inventing a browser name here would turn a
    // good clone into `browser_not_supported`.
    browser: (input.sourceBrowser ?? "chromium").trim().toLowerCase() || "chromium",
    major,
    index: input.index,
  });
  if (!resolved.ok) {
    // A named refusal, passed through VERBATIM (`browser_version_unsupported:
    // 141` carries its own major) so the code a human reads is the code that
    // happened — plus the one thing a launch path adds: the way out.
    return { ok: false, error: resolved.code, fallback: "fresh" };
  }
  const userAgent = sourceUserAgent({ major: resolved.major, os: input.os ?? null });
  const lang = (input.lang ?? "").trim() || null;
  return {
    ok: true,
    pin: {
      major: resolved.major,
      fullVersion: resolved.fullVersion,
      platform: DESTINATION_PLATFORM,
      downloadUrl: resolved.downloadUrl,
      userAgent,
      lang,
      flags: parityFlags({ userAgent, lang }),
    },
  };
}

/**
 * The live index, cached in-process. A host running clones resolves one version
 * per session, and the index is a few MB of JSON that changes a few times a week
 * at most — refetching it per launch would put a public-internet round-trip (and
 * its failure mode) inside the container start path for no benefit.
 *
 * A FAILED fetch is cached too, briefly and separately. It is never cached as an
 * EMPTY index, which would turn a network blip into `browser_version_unsupported`
 * — the wrong code for a transient problem, and exactly the kind of misleading
 * refusal that costs an hour of debugging.
 */
export const INDEX_TTL_MS = 6 * 60 * 60 * 1000;
export const INDEX_FAILURE_TTL_MS = 60 * 1000;

let cachedIndex: { index: ChromeForTestingIndex | null; at: number } | null = null;

export async function loadChromeForTestingIndex(opts?: {
  now?: number;
  fetchIndex?: () => Promise<ChromeForTestingIndex | null>;
}): Promise<ChromeForTestingIndex | null> {
  const now = opts?.now ?? Date.now();
  const fetchIndex = opts?.fetchIndex ?? fetchChromeForTestingIndex;
  if (cachedIndex) {
    const ttl = cachedIndex.index ? INDEX_TTL_MS : INDEX_FAILURE_TTL_MS;
    if (now - cachedIndex.at < ttl) return cachedIndex.index;
  }
  const index = await fetchIndex();
  cachedIndex = { index, at: now };
  return index;
}

/** Test seam: drop the process cache. */
export function resetChromeForTestingIndexCache(): void {
  cachedIndex = null;
}

/**
 * The launch-path entry point: read the job's declared source browser identity,
 * get the index (cached), and produce either a pin or a named refusal with a
 * fallback. Never throws — a clone launch should surface a reason a human can
 * act on, not a stack trace.
 *
 * `deps` exists for tests: `index` short-circuits the fetch entirely, and
 * `loadIndex` injects a stub fetcher. Neither is used in production.
 */
export async function resolveCloneBrowserPin(
  job: {
    browser?: string | null;
    sourceBrowserMajor?: number | null;
    sourceBrowserVersion?: string | null;
    sourceBrowserLang?: string | null;
    osName?: string | null;
  },
  deps?: {
    index?: ChromeForTestingIndex | null;
    loadIndex?: () => Promise<ChromeForTestingIndex | null>;
  },
): Promise<CloneBrowserPinResult> {
  const major = job.sourceBrowserMajor ?? majorOfVersion(job.sourceBrowserVersion);
  const browser = (job.browser ?? "chromium").trim().toLowerCase() || "chromium";

  // Ask the resolver FIRST, with no index, purely to learn whether this input can
  // be refused without the build list: a non-Chromium source and an undetermined
  // version cannot be rescued by any index, so the launch path gives up on them
  // without an outbound call. A launch that cannot possibly succeed must not
  // depend on the network, or a blip would replace a clear refusal with a
  // confusing one.
  //
  // `index: null` is the mechanism, not a shortcut: it is what makes an
  // index-requiring input report `browser_version_index_unavailable`, which is the
  // signal to go and fetch. The refusal CODE is taken from the resolver verbatim,
  // so this module cannot drift into a second spelling of the same error — which
  // is exactly the bug this preflight replaced (it used to hand-roll
  // `browser_not_supported: firefox` while the resolver said
  // `browser_not_supported: 141`). The version floor sits behind the index check,
  // so a below-floor major costs one CACHED fetch here; that is cheaper than
  // re-deriving, and re-spelling, the resolver's codes in a second place.
  const preflight = resolveHostedBrowser({ browser, major, index: null });
  if (!preflight.ok && preflight.reason !== "browser_version_index_unavailable") {
    return { ok: false, error: preflight.code, fallback: "fresh" };
  }

  const index =
    deps && "index" in deps ? (deps.index ?? null) : await (deps?.loadIndex ?? loadChromeForTestingIndex)();
  return planCloneBrowserPin({
    sourceBrowser: browser,
    sourceMajor: major,
    sourceVersion: job.sourceBrowserVersion,
    os: job.osName,
    lang: job.sourceBrowserLang,
    index,
  });
}
