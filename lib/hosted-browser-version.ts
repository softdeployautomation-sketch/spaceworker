/**
 * Deliver a hosted browser build that MATCHES the source browser's version.
 *
 * Why this exists (TASK_135 §4): the destination used to be whatever
 * `ghcr.io/m1k1o/neko/chromium:latest` happened to ship (measured at 151), against
 * a Windows source that could be any version. That is fine for the cookie carry —
 * cookies are handed over as *data* via CDP, so the browser version is irrelevant
 * to them — but it is wrong for the STATE half (history, tabs, bookmarks,
 * extensions), because Chromium refuses or mangles a profile written by a
 * different/newer version, and extensions are version-sensitive. A clone that
 * loads a mismatched profile is not a replica.
 *
 * The design is: ONE image serves any source version by downloading the matching
 * **Chrome for Testing** build at container start, instead of us building and
 * storing an image per version. Chrome for Testing publishes version-pinned
 * linux64 builds for every current stable major, which is exactly the shape this
 * needs.
 *
 * Three rules shape this module, and they are the same three rules as everywhere
 * else in the clone feature:
 *
 *  1. **Fail closed, by name.** A version we cannot match is refused with
 *     `browser_version_unsupported: <major>` — never a silent downgrade to
 *     `latest` that half-loads a profile. "Close enough" is not close enough when
 *     the artefact is somebody's browsing session.
 *  2. **Unknown is not "newest".** `major == null` means *undetermined*, and that
 *     refuses (`browser_version_unknown`). Assuming latest is how you get a
 *     silently-mismatched profile.
 *  3. **The refusal is actionable.** Every refusal carries a `fallback` hint, so
 *     the console can offer the user `fresh` (a session that logs in for itself)
 *     instead of a dead-end error.
 *
 * This module is deliberately PURE: the Chrome for Testing index is passed IN, so
 * resolution is testable without a network and the launch path decides what to
 * fetch. `fetchChromeForTestingIndex` at the bottom is the one impure convenience.
 */

/** A source browser as the capture reports it. */
export type SourceBrowserName = "chrome" | "edge" | "chromium" | "firefox";

/** The only destination we currently build. A Firefox destination is future work. */
export type DestinationBrowserName = "chromium";

/** Chrome for Testing's own platform ids. The harness runs on linux64. */
export type CftPlatform = "linux64" | "win64" | "win32" | "mac-x64" | "mac-arm64";

/**
 * The platform we deliver. The DESTINATION is always linux64 (the container);
 * `sourcePlatform` (below) is a separate thing — it only shapes the user agent so
 * sites see the device the user is actually on.
 */
export const DESTINATION_PLATFORM: CftPlatform = "linux64";

/**
 * Oldest source major we will try to match. **Measured, not guessed**: Chrome for
 * Testing's `known-good-versions-with-downloads.json` was fetched while writing
 * this and held 2539 versions across **44 majors, from 113 to 156**. So exact
 * matching is realistic for a real fleet rather than a nice-to-have, and anything
 * below 113 is refused rather than guessed at.
 *
 * Above the top of that range is refused too, and that direction matters more:
 * serving a browser OLDER than the source means handing Chromium a profile
 * written by a newer version, which is the direction that fails or corrupts. A
 * not-yet-published brand-new Chrome release therefore refuses by name and offers
 * `fresh`, rather than quietly opening the user's data in an older browser.
 */
export const MIN_SUPPORTED_MAJOR = 113;

/** The source browsers that resolve to a Chromium destination. */
const CHROMIUM_FAMILY: ReadonlySet<string> = new Set(["chrome", "edge", "chromium", "brave", "vivaldi", "opera"]);

const REFUSAL_HINTS: Readonly<Record<RefusalReason, string>> = {
  browser_not_supported: "Only Chromium-family source browsers are carried today. Start a fresh session instead.",
  browser_version_unknown: "The work PC did not report its browser version. Start a fresh session, or re-run the capture.",
  browser_version_index_unavailable: "The browser build list could not be read. Start a fresh session, or try again shortly.",
  browser_version_unsupported: "No exact build is available for that browser version. Start a fresh session instead.",
};

/** Why a resolution was refused. Every one is reportable and actionable. */
export type RefusalReason =
  | "browser_not_supported"
  | "browser_version_unknown"
  | "browser_version_unsupported"
  | "browser_version_index_unavailable";

/** What the console may offer instead of a dead end. */
export interface RefusalFallback {
  /** Start a `fresh` session (logs in for itself) instead of a carried clone. */
  readonly fresh: boolean;
  /** Human-facing next step, written for the console, not for a log. */
  readonly hint: string;
}

export interface ResolutionRefusal {
  readonly ok: false;
  readonly reason: RefusalReason;
  /** The source major, when it was known. Used to build `browser_version_unsupported: 141`. */
  readonly major: number | null;
  /** `reason` plus the major, e.g. `browser_version_unsupported: 141`. */
  readonly code: string;
  readonly fallback: RefusalFallback;
}

export interface ResolvedBuild {
  readonly ok: true;
  readonly destination: DestinationBrowserName;
  /** The source major this build satisfies — the same number, by construction. */
  readonly major: number;
  /** The exact version to download, e.g. `141.0.7390.55`. */
  readonly fullVersion: string;
  readonly platform: CftPlatform;
  readonly downloadUrl: string;
  /** Which channel the match came from, for the audit trail. */
  readonly channel: string;
}

export type Resolution = ResolvedBuild | ResolutionRefusal;

/**
 * One entry of Chrome for Testing's `known-good-versions-with-downloads.json`.
 * Only the fields this module needs are typed; the payload carries plenty more.
 */
export interface CftVersionEntry {
  readonly version: string;
  readonly downloads?: Readonly<Record<string, ReadonlyArray<{ readonly url: string }>>>;
}

export interface ChromeForTestingIndex {
  /** `stable` | `beta` | `dev` | `canary`, each pointing at a full version. */
  readonly channels?: Readonly<Record<string, { readonly version: string }>>;
  readonly versions: ReadonlyArray<CftVersionEntry>;
}

/**
 * Parse the Chrome for Testing index into the shape this module resolves against.
 *
 * Tolerant on purpose: a malformed or partial payload yields `null` (which the
 * caller turns into `browser_version_index_unavailable`) rather than throwing
 * somewhere deep in a launch. A launch path is a bad place to discover that a
 * remote JSON shape changed.
 */
export function parseChromeForTestingIndex(payload: unknown): ChromeForTestingIndex | null {
  if (payload === null || typeof payload !== "object") return null;
  const raw = payload as { versions?: unknown; channels?: unknown };
  if (!Array.isArray(raw.versions)) return null;

  const versions: CftVersionEntry[] = [];
  for (const item of raw.versions) {
    if (item === null || typeof item !== "object") continue;
    const entry = item as { version?: unknown; downloads?: unknown };
    if (typeof entry.version !== "string" || entry.version === "") continue;
    const downloads: Record<string, Array<{ url: string }>> = {};
    if (entry.downloads !== null && typeof entry.downloads === "object") {
      for (const [product, list] of Object.entries(entry.downloads as Record<string, unknown>)) {
        if (!Array.isArray(list)) continue;
        const urls: Array<{ url: string }> = [];
        for (const d of list) {
          if (d !== null && typeof d === "object" && typeof (d as { url?: unknown }).url === "string") {
            urls.push({ url: (d as { url: string }).url });
          }
        }
        if (urls.length > 0) downloads[product] = urls;
      }
    }
    versions.push({ version: entry.version, downloads });
  }
  if (versions.length === 0) return null;

  const channels: Record<string, { version: string }> = {};
  if (raw.channels !== null && typeof raw.channels === "object") {
    for (const [name, value] of Object.entries(raw.channels as Record<string, unknown>)) {
      if (value !== null && typeof value === "object" && typeof (value as { version?: unknown }).version === "string") {
        channels[name] = { version: (value as { version: string }).version };
      }
    }
  }
  return { versions, channels };
}

/** The major (leading integer) of a full version, or `null` when unparseable. */
export function majorOf(version: string | null | undefined): number | null {
  if (typeof version !== "string") return null;
  const m = /^(\d+)\./.exec(version.trim());
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Where a pinned build is downloaded from. Pure string building, so it is testable. */
export function chromeForTestingDownloadUrl(fullVersion: string, platform: CftPlatform): string {
  return `https://storage.googleapis.com/chrome-for-testing-public/${fullVersion}/${platform}/chrome-${platform}.zip`;
}

function refusal(reason: RefusalReason, major: number | null): ResolutionRefusal {
  return {
    ok: false,
    reason,
    major,
    // The form the console and the audit trail show, e.g.
    // `browser_version_unsupported: 157`.
    code: major === null ? reason : `${reason}: ${major}`,
    fallback: { fresh: true, hint: REFUSAL_HINTS[reason] },
  };
}

/** Numeric compare of dotted version strings (never lexicographic). */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Resolve the destination build for a source browser version.
 *
 * Requires an EXACT major match. That is a deliberate choice, not an omission:
 * within a major, Chromium migrates profiles forward happily, and CfT publishes
 * every patch of every major it knows, so "highest patch of the same major" is
 * both the closest match available and the safest one. Anything else refuses.
 *
 * Refusal precedence, so the *most actionable* reason is the one reported:
 *   1. `browser_not_supported`          — the source browser itself is out of scope
 *   2. `browser_version_unknown`        — the device never told us (never "newest")
 *   3. `browser_version_index_unavailable` — we could not read the build list
 *   4. `browser_version_unsupported`    — no exact build exists
 */
export function resolveHostedBrowser(input: {
  browser: string;
  major: number | null;
  index: ChromeForTestingIndex | null;
}): Resolution {
  const browser = (input.browser ?? "").trim().toLowerCase();
  if (!CHROMIUM_FAMILY.has(browser)) {
    return refusal("browser_not_supported", input.major);
  }
  if (input.major === null || !Number.isInteger(input.major) || input.major <= 0) {
    return refusal("browser_version_unknown", null);
  }
  const major = input.major;
  if (input.index === null) {
    return refusal("browser_version_index_unavailable", major);
  }
  if (major < MIN_SUPPORTED_MAJOR) {
    return refusal("browser_version_unsupported", major);
  }

  let best: string | null = null;
  for (const entry of input.index.versions) {
    if (majorOf(entry.version) !== major) continue;
    if (best === null || compareVersions(entry.version, best) > 0) {
      best = entry.version;
    }
  }
  if (best === null) {
    return refusal("browser_version_unsupported", major);
  }

  return {
    ok: true,
    destination: "chromium",
    major,
    fullVersion: best,
    platform: DESTINATION_PLATFORM,
    downloadUrl: chromeForTestingDownloadUrl(best, DESTINATION_PLATFORM),
    channel: "cft-known-good",
  };
}

/**
 * The user agent the clone should present, so sites see the device the user is
 * actually on rather than a Linux container.
 *
 * Uses Chrome's frozen UA form, `Chrome/<major>.0.0.0`. That is not a shortcut
 * around not knowing the patch version — it is what modern Chrome reports anyway
 * under UA reduction, so it is the *more* accurate value.
 */
export function sourceUserAgent(input: { major: number; os?: string | null }): string {
  const os = (input.os ?? "windows").trim().toLowerCase();
  let platformToken = "(Windows NT 10.0; Win64; x64)";
  if (os.includes("mac") || os.includes("darwin") || os.includes("osx")) {
    platformToken = "(Macintosh; Intel Mac OS X 10_15_7)";
  } else if (os.includes("linux")) {
    platformToken = "(X11; Linux x86_64)";
  }
  return `Mozilla/5.0 ${platformToken} AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${input.major}.0.0.0 Safari/537.36`;
}

/**
 * Launch flags that make the clone's identity match the source.
 *
 * `--lang` and `--user-agent` only. **Timezone is NOT here on purpose**: TZ is an
 * environment variable for the container (Neko's own env), not a Chromium command
 * line flag — setting it as a flag would look like it worked and do nothing,
 * which is the class of silent no-op this feature has already been bitten by
 * twice (see the module header on `--remote-debugging-port`).
 *
 * Empty/absent inputs produce NO flag, so a session without them keeps the exact
 * conf the private browser has always run.
 */
export function parityFlags(input: {
  userAgent?: string | null;
  lang?: string | null;
}): string[] {
  const flags: string[] = [];
  const ua = (input.userAgent ?? "").trim();
  if (ua) flags.push(`--user-agent=${ua}`);
  const lang = (input.lang ?? "").trim();
  if (lang) flags.push(`--lang=${lang}`);
  return flags;
}

/**
 * Read the Chrome for Testing index. The ONE impure function here — kept thin and
 * separate so everything above stays testable without a network.
 *
 * Never throws: a launch path should not die on a fetch. It returns `null`, which
 * `resolveHostedBrowser` turns into a named refusal.
 */
export async function fetchChromeForTestingIndex(
  url = "https://googlechromelabs.github.io/chrome-for-testing/known-good-versions-with-downloads.json",
  timeoutMs = 15_000,
): Promise<ChromeForTestingIndex | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return parseChromeForTestingIndex(await res.json());
  } catch {
    return null;
  }
}
