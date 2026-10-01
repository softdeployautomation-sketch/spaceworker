/**
 * TASK_135 §2 — the host-side cache for PINNED browser builds.
 *
 * WHY THIS EXISTS. The destination browser used to be whatever
 * `ghcr.io/m1k1o/neko/chromium:latest` happened to ship. That is fine for the
 * cookie half of a clone (cookies travel as DATA over CDP, so the build serving
 * them does not matter) and WRONG for the state half — history, tabs, bookmarks,
 * extensions — because Chromium refuses or mangles a profile written by a
 * different version, and extensions are version-sensitive. A mismatched profile
 * is not a replica, it is a corrupt one.
 *
 * So the destination build must equal the source build, which means downloading
 * it. Three properties make that safe to do inside a launch:
 *
 *   1. ONCE PER VERSION, NOT ONCE PER SESSION. A cache on the host
 *      (`/var/lib/spaceworker/browsers/<full version>/`), mounted read-only into
 *      the container. The second clone of the same Chrome build is a directory
 *      read, not a ~150 MB download, and it works with the network down.
 *   2. ATOMIC. Work happens in a temp dir that is `rename`d into place only when
 *      a complete, executable browser is in it. A half-downloaded or
 *      half-extracted build can never be observed at the final path, so a failed
 *      launch can never poison the cache for the next one.
 *   3. FAIL-CLOSED, BY NAME. Every failure returns a named code
 *      (`pinned_build_download_failed`, `pinned_build_binary_missing`, ...) so a
 *      caller refuses with something an operator can act on.
 *
 * NOTHING here runs on the work PC. This is the hosted side only: the device's
 * own filesystem is read by the engine and never touched from here, and no part
 * of this path raises anything a user of the work PC could see.
 */

import { execFile } from "child_process";
import { open, mkdir, rename, rm, stat, chmod } from "fs/promises";
import { join, resolve } from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/** Where pinned builds live on the host. Mounted read-only into containers. */
export const PINNED_BROWSER_CACHE_DEFAULT = "/var/lib/spaceworker/browsers";
/**
 * Where the cache is mounted inside the container. Mirrors the swfwd binary's
 * arrangement (a host artifact bind-mounted read-only), so the container needs
 * no network access of its own and the build it runs is pinned by the host.
 */
export const CONTAINER_PINNED_ROOT = "/opt/pinned-browser";
/** Chrome for Testing's linux64 archive expands to exactly this directory. */
export const PINNED_UNPACK_DIR = "chrome-linux64";
export const PINNED_BINARY_NAME = "chrome";
/**
 * A hard ceiling on one archive. Chrome for Testing's linux64 zip is far below
 * this; the cap exists so a redirect to something enormous cannot fill the disk
 * of a host that is running other people's sessions.
 */
export const MAX_PINNED_ARCHIVE_BYTES = 512 * 1024 * 1024;
/** Download budget. Generous: this is a one-off per version, not per session. */
export const PINNED_DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

export function pinnedCacheDir(): string {
  return process.env.BROWSER_PIN_CACHE_DIR ?? PINNED_BROWSER_CACHE_DEFAULT;
}

/**
 * Pure. The directory name for a version, or null when the string is not a
 * version at all.
 *
 * Strict on purpose: this value becomes a PATH SEGMENT on the host and inside
 * the container, so `../..` or an absolute path must be impossible rather than
 * merely unlikely. Only digits and dots, at least two components, no leading or
 * trailing separator — the exact shape `resolveHostedBrowser` produces.
 */
export function versionDirName(fullVersion: string): string | null {
  const raw = (fullVersion ?? "").trim();
  if (!/^\d{1,4}(?:\.\d{1,5}){1,3}$/.test(raw)) return null;
  return raw;
}

/** The host cache path for one version. Caller must have validated the name. */
export function hostPinnedRoot(cacheDir: string, dirName: string): string {
  return resolve(cacheDir, dirName);
}

/** Where the cache directory is mounted inside a container. */
export function containerPinnedRoot(): string {
  return CONTAINER_PINNED_ROOT;
}

/**
 * Where ONE VERSION's directory is mounted inside a container.
 *
 * THE BUG THIS EXISTS FOR (found 2026-09-28 by running the real container): the
 * mount used to put the host's `<cache>/<version>` at `/opt/pinned-browser`,
 * while the binary path said `/opt/pinned-browser/<version>/chrome-linux64/chrome`
 * — so the conf exec'd a path that did not exist and supervisord reported
 * `chromium FATAL Exited too quickly`. Every unit test passed, because each of
 * the two functions was tested on its own and nothing tested that they COMPOSE.
 * Now both are derived from this one function, so they cannot disagree, and
 * pinnedMountComposesToBinary() pins that with a test.
 */
export function containerPinnedVersionRoot(dirName: string): string {
  return `${CONTAINER_PINNED_ROOT}/${dirName}`;
}

/**
 * The container-side path to the pinned binary, for the launch conf. Built from
 * the validated version name only, so it is safe to interpolate into the
 * supervisord conf's shell command (see assertPinnedBrowserPath in
 * chromium-session-config.ts, which re-checks the exact shape).
 */
export function containerPinnedBinaryPath(dirName: string): string {
  return `${containerPinnedVersionRoot(dirName)}/${PINNED_UNPACK_DIR}/${PINNED_BINARY_NAME}`;
}

/** Is a usable browser already at this path? (exists, and is a file) */
async function binaryRunnableAt(path: string): Promise<boolean> {
  const info = await stat(path).catch(() => null);
  return info !== null && info.isFile();
}

/**
 * An extractor is a CLI that can expand a zip. Three are tried in order because
 * none of them is guaranteed on a fresh VPS image, and the failure of this step
 * must be a NAMED, operator-actionable error rather than a launch that hangs.
 */
type Extractor = { tool: string; run: (zip: string, dest: string) => Promise<void> };

const DEFAULT_EXTRACTORS: Extractor[] = [
  { tool: "unzip", run: (zip, dest) => runTool("unzip", ["-q", "-o", zip, "-d", dest]) },
  { tool: "7z", run: (zip, dest) => runTool("7z", ["x", "-y", `-o${dest}`, zip]) },
  { tool: "python3", run: (zip, dest) => runTool("python3", ["-m", "zipfile", "-e", zip, dest]) },
];

async function runTool(tool: string, args: string[]): Promise<void> {
  await execFileAsync(tool, args, { timeout: 5 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 });
}

export interface PinnedEnsureRequest {
  /** Exact version to install, e.g. `141.0.7390.55`. */
  fullVersion: string;
  /** Chrome for Testing's linux64 archive for that exact version. */
  downloadUrl: string;
}

export type PinnedEnsureResult =
  | {
      ok: true;
      /** Host path to the binary — what the container mounts and can see. */
      hostBinaryPath: string;
      hostRoot: string;
      containerRoot: string;
      containerBinaryPath: string;
      /** False when this was a cache hit — the launch path logs it as evidence. */
      downloaded: boolean;
    }
  | { ok: false; error: string };

export interface PinnedEnsureDeps {
  cacheDir?: string;
  /** Test seam: replaces the network fetch. */
  fetchImpl?: (url: string) => Promise<Response>;
  /** Test seam: replaces the extractor chain. */
  extractors?: Extractor[];
  /** Test seam: makes the temp-dir suffix deterministic. */
  now?: () => number;
}

/**
 * Installs (or finds) the exact build for one version and returns where it is.
 *
 * SINGLE-FLIGHT. Two sessions for the same version starting at the same moment
 * would otherwise both download ~150 MB and both extract into the same path.
 * Concurrent callers for one version share one in-flight promise and get the
 * same answer; the map entry is dropped when it settles, so a failure can be
 * retried later rather than being cached as a permanent failure.
 */
const inFlight = new Map<string, Promise<PinnedEnsureResult>>();

export async function ensurePinnedBrowser(
  input: PinnedEnsureRequest,
  deps: PinnedEnsureDeps = {},
): Promise<PinnedEnsureResult> {
  const dirName = versionDirName(input.fullVersion);
  if (!dirName) {
    return { ok: false, error: `pinned_build_version_invalid: ${String(input.fullVersion)}` };
  }
  const cacheDir = deps.cacheDir ?? pinnedCacheDir();
  const hostRoot = hostPinnedRoot(cacheDir, dirName);
  const hostBinaryPath = join(hostRoot, PINNED_UNPACK_DIR, PINNED_BINARY_NAME);

  // Cache hit: the only path that needs no network and no disk write. Checked
  // before the single-flight map so a warm cache never even allocates a promise.
  if (await binaryRunnableAt(hostBinaryPath)) {
    return {
      ok: true,
      hostBinaryPath,
      hostRoot,
      containerRoot: containerPinnedVersionRoot(dirName),
      containerBinaryPath: containerPinnedBinaryPath(dirName),
      downloaded: false,
    };
  }

  const existing = inFlight.get(dirName);
  if (existing) return existing;

  const work = install({ dirName, cacheDir, hostRoot, hostBinaryPath, input, deps }).finally(() => {
    inFlight.delete(dirName);
  });
  inFlight.set(dirName, work);
  return work;
}

/** Test seam: forget any in-flight installs (mirrors the index cache reset). */
export function resetPinnedBrowserInFlight(): void {
  inFlight.clear();
}

async function install(opts: {
  dirName: string;
  cacheDir: string;
  hostRoot: string;
  hostBinaryPath: string;
  input: PinnedEnsureRequest;
  deps: PinnedEnsureDeps;
}): Promise<PinnedEnsureResult> {
  const suffix = `${process.pid}-${(opts.deps.now ?? Date.now)()}-${Math.random().toString(36).slice(2, 8)}`;
  // The temp dir sits INSIDE the cache (not /tmp): `rename` is only atomic
  // within one filesystem, and a cross-device rename is a copy that can be
  // interrupted — the exact half-built cache entry this file exists to prevent.
  const tmpDir = join(opts.cacheDir, `.tmp-${opts.dirName}-${suffix}`);
  try {
    await mkdir(opts.cacheDir, { recursive: true });
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });
  } catch {
    return { ok: false, error: `pinned_build_cache_unwritable: ${opts.cacheDir}` };
  }

  let published = false;
  try {
    const zipPath = join(tmpDir, "browser.zip");
    const downloaded = await downloadArchive(opts.input.downloadUrl, zipPath, opts.deps);
    if (!downloaded.ok) return downloaded;

    const extracted = await extractArchive(zipPath, tmpDir, opts.deps);
    if (!extracted.ok) return extracted;

    const binary = join(tmpDir, PINNED_UNPACK_DIR, PINNED_BINARY_NAME);
    if (!(await binaryRunnableAt(binary))) {
      return { ok: false, error: `pinned_build_binary_missing: ${opts.input.fullVersion}` };
    }
    // The container's browser runs as an unprivileged in-container user, so the
    // binary must be executable for whoever the container runs as — the same
    // reasoning as the profile dir's own 0777 (browser-profiles.ts). It is
    // mounted read-only, so nothing can be written through it.
    await chmod(binary, 0o755).catch(() => {});

    // Drop the archive before publishing: the cache holds browsers, not zips.
    await rm(zipPath, { force: true }).catch(() => {});

    // Publish atomically. Anything already at the final path is a stale partial
    // from an older layout — remove it first so `rename` cannot fail on a
    // non-empty target directory.
    await rm(opts.hostRoot, { recursive: true, force: true }).catch(() => {});
    await rename(tmpDir, opts.hostRoot);
    published = true;
  } catch (e) {
    return { ok: false, error: `pinned_build_install_failed: ${errText(e)}` };
  } finally {
    // EVERY failure path ends up here, including the `return`s above — those
    // return out of the `try`, so a cleanup written only in the `catch` would
    // skip them and leave a `.tmp-*` directory behind (found by this file's own
    // test). That litter is not cosmetic: the cache would fill up over weeks,
    // and a stale temp dir next to a version is exactly the "half-built entry"
    // this module exists to prevent. The `published` guard keeps a successful
    // install untouched.
    if (!published) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }


  return {
    ok: true,
    hostBinaryPath: opts.hostBinaryPath,
    hostRoot: opts.hostRoot,
    containerRoot: containerPinnedVersionRoot(opts.dirName),
    containerBinaryPath: containerPinnedBinaryPath(opts.dirName),
    downloaded: true,
  };
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : "unknown";
}

/** Streams the archive to disk, enforcing the size cap as it goes. */
async function downloadArchive(
  url: string,
  zipPath: string,
  deps: PinnedEnsureDeps,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!/^https?:\/\//.test((url ?? "").trim())) {
    return { ok: false, error: "pinned_build_download_failed: url not http(s)" };
  }
  let res: Response;
  try {
    const doFetch =
      deps.fetchImpl ??
      ((u: string) => fetch(u, { signal: AbortSignal.timeout(PINNED_DOWNLOAD_TIMEOUT_MS) }));
    res = await doFetch(url);
  } catch (e) {
    return { ok: false, error: `pinned_build_download_failed: ${errText(e)}` };
  }
  if (!res.ok || !res.body) {
    return { ok: false, error: `pinned_build_download_failed: HTTP ${res.status}` };
  }
  // Node's fetch body is an async iterable; the cast keeps this file free of a
  // DOM-lib dependency while staying on the standard stream shape.
  const body = res.body as unknown as AsyncIterable<Uint8Array>;
  let handle;
  try {
    handle = await open(zipPath, "w");
  } catch (e) {
    return { ok: false, error: `pinned_build_cache_unwritable: ${errText(e)}` };
  }
  let total = 0;
  let tooLarge = false;
  try {
    for await (const chunk of body) {
      total += chunk.byteLength;
      if (total > MAX_PINNED_ARCHIVE_BYTES) {
        tooLarge = true;
        break;
      }
      await handle.write(chunk);
    }
  } catch (e) {
    return { ok: false, error: `pinned_build_download_failed: ${errText(e)}` };
  } finally {
    await handle.close().catch(() => {});
  }
  if (tooLarge) {
    return { ok: false, error: `pinned_build_download_too_large: >${MAX_PINNED_ARCHIVE_BYTES}` };
  }
  if (total === 0) {
    return { ok: false, error: "pinned_build_download_failed: empty archive" };
  }
  return { ok: true };
}

/**
 * Tries each extractor in order. An unavailable tool is skipped (ENOENT); a tool
 * that ran and failed moves on to the next, because the tools differ in what
 * they accept. If every one was missing, that is its OWN code: the operator fix
 * (install unzip) is a different action from investigating a corrupt archive.
 */
async function extractArchive(
  zipPath: string,
  destDir: string,
  deps: PinnedEnsureDeps,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const extractors = deps.extractors ?? DEFAULT_EXTRACTORS;
  let sawMissing = false;
  let lastError = "";
  for (const extractor of extractors) {
    try {
      await extractor.run(zipPath, destDir);
      return { ok: true };
    } catch (e) {
      const text = errText(e);
      if (/ENOENT/.test(text) || /not found/i.test(text)) {
        sawMissing = true;
      } else {
        lastError = `${extractor.tool}: ${text}`;
      }
    }
  }
  if (lastError) return { ok: false, error: `pinned_build_extract_failed: ${lastError}` };
  if (sawMissing) {
    return {
      ok: false,
      error: `pinned_build_extract_tool_missing: ${extractors.map((e) => e.tool).join(",")}`,
    };
  }
  return { ok: false, error: "pinned_build_extract_failed: no extractor ran" };
}


