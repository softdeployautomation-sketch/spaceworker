import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import {
  CONTAINER_PINNED_ROOT,
  containerPinnedBinaryPath,
  containerPinnedVersionRoot,
  ensurePinnedBrowser,
  resetPinnedBrowserInFlight,
  versionDirName,
} from "./pinned-chromium";

/**
 * These tests use the REAL extractor chain (unzip) and a REAL zip, built here
 * with the `zip` CLI. A stubbed extractor would prove nothing about the step
 * that actually fails in production (an archive whose layout is not what CfT
 * promises), and the whole point of this module is that a silent half-built
 * cache entry cannot happen.
 */
function hasTool(tool: string): boolean {
  try {
    execFileSync("which", [tool], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const HAS_ZIP = hasTool("zip");

/** Builds a real archive with one directory layout. Returns its bytes. */
function makeArchive(entries: Record<string, string>): Buffer {
  const dir = mkdtempSync(join(tmpdir(), "pin-src-"));
  const zipPath = join(dir, "out.zip");
  try {
    for (const [rel, content] of Object.entries(entries)) {
      const target = join(dir, rel);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    execFileSync("zip", ["-q", "-r", zipPath, "."], { cwd: dir });
    return execFileSync("cat", [zipPath]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The layout Chrome for Testing's linux64 archive really has. */
const REAL_LAYOUT = { "chrome-linux64/chrome": "#!/bin/sh\necho fake\n" };

function freshCacheDir(): string {
  return mkdtempSync(join(tmpdir(), "pin-cache-"));
}

function stubFetch(bytes: Buffer, onCall?: () => void): (url: string) => Promise<Response> {
  return async () => {
    onCall?.();
    return new Response(new Uint8Array(bytes), { status: 200 });
  };
}

test("versionDirName accepts a real version and rejects anything path-like", () => {
  assert.equal(versionDirName("141.0.7390.55"), "141.0.7390.55");
  assert.equal(versionDirName("141.0"), "141.0");
  // Every one of these would become a path segment on the host and inside the
  // container, so none of them may ever be accepted.
  for (const bad of ["", "  ", "../evil", "141.0.7390.55/../..", "/abs/141.0", "v141.0.1", "141..0"]) {
    assert.equal(versionDirName(bad), null, `must reject ${JSON.stringify(bad)}`);
  }
});

test("the container binary path is built from the pinned root and unpack dir", () => {
  assert.equal(
    containerPinnedBinaryPath("141.0.7390.55"),
    `${CONTAINER_PINNED_ROOT}/141.0.7390.55/chrome-linux64/chrome`,
  );
  // The version root is what gets MOUNTED, and the binary must sit under it.
  assert.equal(containerPinnedVersionRoot("141.0.7390.55"), `${CONTAINER_PINNED_ROOT}/141.0.7390.55`);
  assert.ok(containerPinnedBinaryPath("141.0.7390.55").startsWith(`${containerPinnedVersionRoot("141.0.7390.55")}/`));
});

test("an invalid version is refused before any network or disk work", async () => {
  let fetched = false;
  const result = await ensurePinnedBrowser(
    { fullVersion: "../escape", downloadUrl: "https://example.test/x.zip" },
    {
      cacheDir: freshCacheDir(),
      fetchImpl: stubFetch(Buffer.from("x"), () => {
        fetched = true;
      }),
    },
  );
  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, /^pinned_build_version_invalid/);
  assert.equal(fetched, false, "a refusal must not depend on the network");
});

test("a downloaded build is installed, executable, and served from cache next time", async () => {
  if (!HAS_ZIP) assert.fail("the `zip` CLI is required to build this test's fixture");
  const cacheDir = freshCacheDir();
  const archive = makeArchive(REAL_LAYOUT);
  let calls = 0;

  const first = await ensurePinnedBrowser(
    { fullVersion: "141.0.7390.55", downloadUrl: "https://example.test/141.zip" },
    {
      cacheDir,
      fetchImpl: stubFetch(archive, () => {
        calls++;
      }),
      now: () => 1,
    },
  );
  assert.equal(first.ok, true, JSON.stringify(first));
  const installed = first as Extract<typeof first, { ok: true }>;
  assert.equal(installed.downloaded, true);
  assert.equal(
    installed.containerBinaryPath,
    `${CONTAINER_PINNED_ROOT}/141.0.7390.55/chrome-linux64/chrome`,
  );
  // The mount destination must carry the version, so that the binary path above
  // sits ON the mount (the 2026-09-28 composition bug). Asserted here as well as
  // in chromium-session-config.test.ts, because this is the module that produces
  // both values.
  assert.equal(installed.containerRoot, `${CONTAINER_PINNED_ROOT}/141.0.7390.55`);
  assert.ok(installed.containerBinaryPath.startsWith(`${installed.containerRoot}/`));
  assert.ok(existsSync(installed.hostBinaryPath), "the binary must exist at the host path");
  // The archive must NOT be left behind: the cache holds browsers, not zips.
  assert.equal(existsSync(join(installed.hostRoot, "browser.zip")), false);

  // Second call for the same version: a cache hit, and no second download.
  const second = await ensurePinnedBrowser(
    { fullVersion: "141.0.7390.55", downloadUrl: "https://example.test/141.zip" },
    {
      cacheDir,
      fetchImpl: stubFetch(archive, () => {
        calls++;
      }),
      now: () => 2,
    },
  );
  assert.equal(second.ok, true);
  assert.equal((second as Extract<typeof second, { ok: true }>).downloaded, false);
  assert.equal(calls, 1, "the second session must not download again");
});

test("two concurrent launches for one version download exactly once", async () => {
  if (!HAS_ZIP) assert.fail("the `zip` CLI is required to build this test's fixture");
  const cacheDir = freshCacheDir();
  const archive = makeArchive(REAL_LAYOUT);
  let calls = 0;
  resetPinnedBrowserInFlight();

  const slowFetch = async (): Promise<Response> => {
    calls++;
    await new Promise((r) => setTimeout(r, 50));
    return new Response(new Uint8Array(archive), { status: 200 });
  };

  const [a, b] = await Promise.all([
    ensurePinnedBrowser(
      { fullVersion: "140.0.1.2", downloadUrl: "https://example.test/a.zip" },
      { cacheDir, fetchImpl: slowFetch },
    ),
    ensurePinnedBrowser(
      { fullVersion: "140.0.1.2", downloadUrl: "https://example.test/a.zip" },
      { cacheDir, fetchImpl: slowFetch },
    ),
  ]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(calls, 1, "single-flight must collapse the two into one download");
});

test("a failed download leaves no cache entry behind", async () => {
  const cacheDir = freshCacheDir();
  const result = await ensurePinnedBrowser(
    { fullVersion: "130.0.1.2", downloadUrl: "https://example.test/gone.zip" },
    { cacheDir, fetchImpl: async () => new Response("nope", { status: 404 }), now: () => 3 },
  );
  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, /^pinned_build_download_failed/);
  // Nothing partial at the final path — the next launch must be able to retry.
  assert.equal(existsSync(join(cacheDir, "130.0.1.2")), false);
  // And no temp dirs left lying around either.
  const leftovers = readdirSync(cacheDir);
  assert.deepEqual(leftovers, [], `cache dir must be clean, found: ${leftovers.join(",")}`);
});

test("an archive that is not a zip fails by name, not silently", async () => {
  const cacheDir = freshCacheDir();
  const result = await ensurePinnedBrowser(
    { fullVersion: "131.0.1.2", downloadUrl: "https://example.test/corrupt.zip" },
    { cacheDir, fetchImpl: stubFetch(Buffer.from("this is not a zip file at all")), now: () => 4 },
  );
  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, /^pinned_build_extract_(failed|tool_missing)/);
  assert.equal(existsSync(join(cacheDir, "131.0.1.2")), false);
});

test("a zip without chrome-linux64/chrome is refused as a missing binary", async () => {
  if (!HAS_ZIP) assert.fail("the `zip` CLI is required to build this test's fixture");
  const cacheDir = freshCacheDir();
  const archive = makeArchive({ "chrome-linux64/NOT-chrome": "x", "readme.txt": "y" });
  const result = await ensurePinnedBrowser(
    { fullVersion: "132.0.1.2", downloadUrl: "https://example.test/odd.zip" },
    { cacheDir, fetchImpl: stubFetch(archive), now: () => 5 },
  );
  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, /^pinned_build_binary_missing/);
});

test("an unwritable cache directory is a named refusal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pin-notdir-"));
  const asFile = join(dir, "cache");
  writeFileSync(asFile, "i am a file");
  const result = await ensurePinnedBrowser(
    { fullVersion: "133.0.1.2", downloadUrl: "https://example.test/x.zip" },
    { cacheDir: asFile, fetchImpl: stubFetch(Buffer.from("x")), now: () => 6 },
  );
  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, /^pinned_build_cache_unwritable/);
  rmSync(dir, { recursive: true, force: true });
});

test("a non-http download url is refused without fetching", async () => {
  let fetched = false;
  const result = await ensurePinnedBrowser(
    { fullVersion: "134.0.1.2", downloadUrl: "file:///etc/passwd" },
    {
      cacheDir: freshCacheDir(),
      fetchImpl: stubFetch(Buffer.from("x"), () => {
        fetched = true;
      }),
    },
  );
  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, /^pinned_build_download_failed/);
  assert.equal(fetched, false, "a non-http url must never reach the fetcher");
});


