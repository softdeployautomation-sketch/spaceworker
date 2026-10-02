import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

// TASK_155 P3 — the Pages/folder engine (PLAN §16.1–§16.6).
//
// WHY THIS FILE EXISTS: the P3 acceptance list is otherwise only provable by
// uploading a real .zip to the live VPS. The cases below drive the REAL modules:
//
//   * lib/hosting/extract.ts — the §16.1 pipeline. `parseSevenZipListing`,
//     `isZipSlip`, `isJunkEntry`, `analyseArchive` and `manifestFromTree` are PURE
//     (no DB, no network) so they carry the "the zip is never trusted" rules; the
//     §16.1 "reject by name BEFORE extraction" contract is a unit assertion, not a
//     hope. A real `7z` round-trip (7z is present on this box) proves the listing
//     parser against genuine 7z output, not a fixture.
//   * lib/hosting/rules.ts `scanSiteFile` — a SITE may ship html/js/css/svg (a
//     download may not), but never server-side script.
//   * lib/hosting/sites.ts `resolveSiteServe` — the SERVE-time path guard. This is
//     the second zip-slip guard, independent of extract time; a traversal, a
//     cloudflare site and an expired preview must all 404.
//
// What this file canNOT prove (said plainly, per the task contract): that the
// migration applies to the live DB, that the Cloudflare Direct-Upload deploy works
// (needs the throwaway account), and that /pv|/hs are reachable over real HTTP on
// the VPS. Those are owner-run live checks (PLAN §9).

(process.env as Record<string, string>).NODE_ENV = "test";
process.env.APP_BASE_URL = "https://spaceworker.test";
// sites.ts -> credentials.ts -> mailbox-crypto.ts reads MAILBOX_ENCRYPTION_KEY at
// import time; a real 32-byte hex key keeps that real AES path loadable.
process.env.MAILBOX_ENCRYPTION_KEY = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
const STORAGE_DIR = path.join(os.tmpdir(), `sw-t155-pages-${process.pid}-${randomUUID()}`);
process.env.HOSTING_STORAGE_DIR = STORAGE_DIR;

after(async () => {
  await fs.rm(STORAGE_DIR, { recursive: true, force: true });
});

/* eslint-disable @typescript-eslint/no-require-imports */
const extract = require("../lib/hosting/extract") as typeof import("../lib/hosting/extract");
const rules = require("../lib/hosting/rules") as typeof import("../lib/hosting/rules");
const cloudflare = require("../lib/hosting/cloudflare") as typeof import("../lib/hosting/cloudflare");
const serve = require("../lib/hosting/serve") as typeof import("../lib/hosting/serve");
/* eslint-enable @typescript-eslint/no-require-imports */

const { parseSevenZipListing, isZipSlip, isJunkEntry, analyseArchive, manifestFromTree, listArchive, extractArchive, scanExtractedTree } = extract;
const { scanSiteFile, MB } = rules;
const { pagesAssetKey } = cloudflare;
const { mimeForPath } = serve;


// ---------------------------------------------------------------------------
// Pure zip rules — no DB, no fs, no 7z.
// ---------------------------------------------------------------------------

test("isZipSlip: refuses absolute paths, upward traversal and Windows drive paths", () => {
  for (const bad of ["../etc/passwd", "a/../../b", "/etc/hosts", "C:/Windows/system32", "..\\..\\win"]) {
    assert.ok(isZipSlip(bad), `${bad} must be refused`);
  }
  for (const ok of ["index.html", "assets/app.js", "a/b/c.png", "folder.with.dots/x.css"]) {
    assert.ok(!isZipSlip(ok), `${ok} is a safe path`);
  }
});

test("isJunkEntry: macOS junk is skipped, not counted as a file", () => {
  assert.ok(isJunkEntry("__MACOSX/._index.html"));
  assert.ok(isJunkEntry(".DS_Store"));
  assert.ok(isJunkEntry("assets/.DS_Store"));
  assert.ok(!isJunkEntry("index.html"));
});

test("parseSevenZipListing: reads the Path/Size/Folder/Attributes keys 7z -slt emits", () => {
  const output = [
    "Listing archive: site.zip",
    "",
    "--",
    "Path = site.zip",
    "Type = zip",
    "Physical Size = 432",
    "",
    "----------",
    "Path = index.html",
    "Size = 42",
    "Folder = -",
    "Attributes = A",
    "",
    "Path = assets",
    "Folder = +",
    "Attributes = D",
    "",
    "Path = link.js",
    "Size = 0",
    "Folder = -",
    "Attributes = l",
    "Symbolic Link = /etc/passwd",
    "",
  ].join("\n");
  const entries = parseSevenZipListing(output);
  // The archive header (`Path = site.zip`) must NOT become an entry — otherwise
  // every real archive would be rejected as a nested zip.
  assert.equal(entries.length, 3);
  assert.deepEqual(entries[0], { path: "index.html", size: 42, isDir: false, isSymlink: false });
  assert.equal(entries[1].isDir, true);
  assert.equal(entries[2].isSymlink, true);
});

test("analyseArchive: > maxEntries is refused by name, before extraction", () => {
  const entries = Array.from({ length: 5 }, (_, i) => ({ path: `f${i}.html`, size: 1, isDir: false, isSymlink: false }));
  const verdict = analyseArchive(entries, { maxEntries: 3, maxAssetMb: 25 });
  assert.ok(!verdict.ok && verdict.code === "too_many_entries");
});

test("analyseArchive: zip-slip, symlink, nested zip and oversize are each refused with their own code", () => {
  const slip = analyseArchive([{ path: "../evil", size: 1, isDir: false, isSymlink: false }], { maxEntries: 100, maxAssetMb: 25 });
  assert.ok(!slip.ok && slip.code === "zip_slip");

  const link = analyseArchive([{ path: "x", size: 1, isDir: false, isSymlink: true }], { maxEntries: 100, maxAssetMb: 25 });
  assert.ok(!link.ok && link.code === "symlink");

  const nested = analyseArchive([{ path: "inner.zip", size: 1, isDir: false, isSymlink: false }], { maxEntries: 100, maxAssetMb: 25 });
  assert.ok(!nested.ok && nested.code === "nested_zip");

  const big = analyseArchive([{ path: "big.bin", size: 26 * MB, isDir: false, isSymlink: false }], { maxEntries: 100, maxAssetMb: 25 });
  assert.ok(!big.ok && big.code === "file_over_limit");
});

test("analyseArchive: an archive of only dirs/junk is refused as empty; a normal one reports counts + skipped", () => {
  const onlyJunk = analyseArchive(
    [
      { path: "folder", size: 0, isDir: true, isSymlink: false },
      { path: "__MACOSX/._x", size: 1, isDir: false, isSymlink: false },
    ],
    { maxEntries: 100, maxAssetMb: 25 }
  );
  assert.ok(!onlyJunk.ok && onlyJunk.code === "empty");

  const ok = analyseArchive(
    [
      { path: "index.html", size: 10, isDir: false, isSymlink: false },
      { path: "assets", size: 0, isDir: true, isSymlink: false },
      { path: "assets/app.js", size: 20, isDir: false, isSymlink: false },
    ],
    { maxEntries: 100, maxAssetMb: 25 }
  );
  assert.ok(ok.ok);
  if (ok.ok) {
    assert.equal(ok.fileCount, 2);
    assert.equal(ok.totalBytes, 30);
    assert.equal(ok.skipped, 1);
  }
});

test("manifestFromTree: normalises to a leading slash and maps path -> hash (the Pages deploy shape)", () => {
  const manifest = manifestFromTree([
    { path: "/index.html", sha256: "aa" },
    { path: "./assets/app.js", sha256: "bb" },
  ]);
  assert.deepEqual(manifest, { "/index.html": "aa", "/assets/app.js": "bb" });
});

test("scanSiteFile: a site MAY ship html/js/css/svg, but never server-side script", () => {
  for (const name of ["index.html", "app.js", "style.css", "logo.svg", "data.json"]) {
    assert.ok(scanSiteFile(name).ok, `${name} is allowed in a site`);
  }
  for (const name of ["shell.php", "run.sh", "app.py", "x.cgi", "page.jsp", "x.jar"]) {
    const v = scanSiteFile(name);
    assert.ok(!v.ok && v.code === "blocked_extension", `${name} must be refused in a site`);
  }
});

test("pagesAssetKey: deterministic, and distinct for content or extension changes", () => {
  const a = pagesAssetKey("index.html", Buffer.from("hello"));
  const b = pagesAssetKey("index.html", Buffer.from("hello"));
  const c = pagesAssetKey("index.html", Buffer.from("hello!"));
  const d = pagesAssetKey("index.css", Buffer.from("hello"));
  assert.equal(a, b);
  assert.equal(a.length, 32);
  assert.notEqual(a, c, "content change must change the key");
  assert.notEqual(a, d, "extension is part of the key (T0 rule)");
});

test("mimeForPath: serves the right Content-Type for the file kinds a site ships", () => {
  assert.match(mimeForPath("/x/index.html"), /text\/html/);
  assert.match(mimeForPath("app.js"), /javascript/);
  assert.match(mimeForPath("style.css"), /text\/css/);
  assert.match(mimeForPath("logo.svg"), /image\/svg\+xml/);
  assert.equal(mimeForPath("noext"), "application/octet-stream");
});

// ---------------------------------------------------------------------------
// A REAL 7z round-trip: build a zip, list it, cap-check it, extract it, scan it.
// This is the §16.1 pipeline against the actual archiver, not a fixture.
// ---------------------------------------------------------------------------

function run(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err || `${cmd} exited ${code}`))));
  });
}

test("real 7z: a folder zips, lists, cap-checks, extracts and scans — the whole §16.1 path", async () => {
  const work = path.join(STORAGE_DIR, "roundtrip");
  const src = path.join(work, "site");
  await fs.mkdir(path.join(src, "assets"), { recursive: true });
  await fs.writeFile(path.join(src, "index.html"), "<!doctype html><h1>hi</h1>");
  await fs.writeFile(path.join(src, "assets", "app.js"), "console.log(1)");
  await fs.writeFile(path.join(src, "assets", "style.css"), "body{}");
  const zipPath = path.join(work, "site.zip");
  // 7z is the archiver the VPS has (unzip is absent there); use it to build too.
  await run("7z", ["a", "-tzip", zipPath, "."], src);

  const entries = await listArchive(zipPath);
  const verdict = analyseArchive(entries, { maxEntries: 20000, maxAssetMb: 25 });
  assert.ok(verdict.ok, JSON.stringify(verdict));
  if (verdict.ok) assert.equal(verdict.fileCount, 3);

  const dest = path.join(work, "out");
  await extractArchive(zipPath, dest);
  const tree = await scanExtractedTree(dest, { maxAssetMb: 25 });
  assert.ok(tree.ok, JSON.stringify(tree));
  if (tree.ok) {
    const names = tree.files.map((f) => f.path).sort();
    assert.deepEqual(names, ["/assets/app.js", "/assets/style.css", "/index.html"]);
    assert.ok(tree.totalBytes > 0);
  }
});

test("real 7z: an archive carrying a server-side script is refused by scanExtractedTree", async () => {
  const work = path.join(STORAGE_DIR, "blocked");
  const src = path.join(work, "site");
  await fs.mkdir(src, { recursive: true });
  await fs.writeFile(path.join(src, "index.html"), "<h1>ok</h1>");
  await fs.writeFile(path.join(src, "shell.php"), "<?php system($_GET['c']); ?>");
  const zipPath = path.join(work, "site.zip");
  await run("7z", ["a", "-tzip", zipPath, "."], src);

  const dest = path.join(work, "out");
  await extractArchive(zipPath, dest);
  const tree = await scanExtractedTree(dest, { maxAssetMb: 25 });
  assert.ok(!tree.ok && tree.code === "blocked_extension");
});


// ---------------------------------------------------------------------------
// resolveSiteServe — the SERVE-time path guard (second zip-slip defence).
// ---------------------------------------------------------------------------

type SiteRow = {
  id: string;
  userId: string;
  name: string;
  engine: string;
  credentialId: string | null;
  cfProject: string | null;
  previewToken: string;
  liveToken: string | null;
  status: string;
  previewUrl: string | null;
  liveUrl: string | null;
  createdAt: Date;
};
type RevisionRow = {
  id: string;
  siteId: string;
  userId: string;
  state: string;
  storagePath: string;
  previewToken: string;
  expiresAt: Date | null;
  publishedAt: Date | null;
};

let sites: SiteRow[] = [];
let revisions: RevisionRow[] = [];
let adminRow: { hostingEnabled: boolean };

const fakePrisma = {
  hostingSite: {
    findFirst: async ({ where }: { where: Record<string, unknown> }) =>
      sites.find((s) =>
        Object.entries(where).every(([k, v]) => (s as unknown as Record<string, unknown>)[k] === v)
      ) ?? null,
  },
  hostingRevision: {
    findFirst: async ({ where, orderBy }: { where: Record<string, unknown>; orderBy?: Record<string, string> }) => {
      let hits = revisions.filter((r) =>
        Object.entries(where).every(([k, v]) => (r as unknown as Record<string, unknown>)[k] === v)
      );
      if (orderBy?.publishedAt === "desc") {
        hits = hits.sort((a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0));
      }
      return hits[0] ?? null;
    },
  },
};

function installRequireHook(): void {
  const loader = Module as unknown as { _load: (r: string, p: NodeModule | undefined, m: boolean) => unknown };
  const original = loader._load;
  loader._load = function patched(request, parent, isMain) {
    if (request === "server-only") return {};
    const from = parent?.filename ?? "";
    if (from.includes("/lib/hosting/")) {
      if (request === "../prisma") return { prisma: fakePrisma };
      if (request === "../admin-settings") return { getAdminSettings: async () => ({ ...adminRow }) };
      if (request === "../premium") {
        return {
          isPremiumWithReversion: (u: { tier: number; premiumExpiresAt: Date | null }) =>
            u.tier >= 5 && (u.premiumExpiresAt === null || u.premiumExpiresAt.getTime() > Date.now()),
        };
      }
    }
    return original.call(this, request, parent, isMain);
  };
}

installRequireHook();

/* eslint-disable @typescript-eslint/no-require-imports */
const sitesMod = require("../lib/hosting/sites") as typeof import("../lib/hosting/sites");
/* eslint-enable @typescript-eslint/no-require-imports */
const { resolveSiteServe, slugifyProject } = sitesMod;

beforeEach(() => {
  sites = [];
  revisions = [];
  adminRow = { hostingEnabled: true };
});

function seedLocalSite(overrides: Partial<SiteRow> = {}, revision: Partial<RevisionRow> = {}) {
  const siteId = "site_" + randomUUID();
  const revisionId = "rev_" + randomUUID();
  const storagePath = path.join(STORAGE_DIR, "serve", siteId, revisionId);
  sites.push({
    id: siteId,
    userId: "user_1",
    name: "Demo",
    engine: "local",
    credentialId: null,
    cfProject: null,
    previewToken: "pv_" + siteId,
    liveToken: "hs_" + siteId,
    status: "previewed",
    previewUrl: null,
    liveUrl: null,
    createdAt: new Date(),
    ...overrides,
  });
  revisions.push({
    id: revisionId,
    siteId,
    userId: "user_1",
    state: "previewed",
    storagePath,
    previewToken: "pv_" + siteId,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    publishedAt: null,
    ...revision,
  });
  return { siteId, revisionId, storagePath };
}


test("resolveSiteServe: a clean preview path resolves inside the revision's staging dir", async () => {
  const { siteId, storagePath } = seedLocalSite();
  await fs.mkdir(storagePath, { recursive: true });
  await fs.writeFile(path.join(storagePath, "index.html"), "<h1>hi</h1>");
  const res = await resolveSiteServe("pv", "pv_" + siteId, "index.html");
  assert.ok(res.ok, JSON.stringify(res));
  if (res.ok) assert.equal(res.value.absPath, path.join(storagePath, "index.html"));
});

test("resolveSiteServe: a traversal path 404s — the serve-time zip-slip guard", async () => {
  const { siteId, storagePath } = seedLocalSite();
  await fs.mkdir(storagePath, { recursive: true });
  const res = await resolveSiteServe("pv", "pv_" + siteId, "../../../../etc/passwd");
  assert.ok(!res.ok && res.status === 404);
});

test("resolveSiteServe: a cloudflare-engine site is never served by our metal", async () => {
  const { siteId, storagePath } = seedLocalSite({ engine: "cloudflare" });
  await fs.mkdir(storagePath, { recursive: true });
  const res = await resolveSiteServe("pv", "pv_" + siteId, "index.html");
  assert.ok(!res.ok && res.status === 404);
});

test("resolveSiteServe: an unpublished preview past its TTL 404s; a published revision lives on", async () => {
  const { siteId, storagePath } = seedLocalSite({}, { expiresAt: new Date(Date.now() - 1000) });
  await fs.mkdir(storagePath, { recursive: true });
  const expired = await resolveSiteServe("pv", "pv_" + siteId, "index.html");
  assert.ok(!expired.ok && expired.status === 404);

  const { siteId: liveId, storagePath: livePath } = seedLocalSite(
    {},
    { state: "published", publishedAt: new Date(), expiresAt: new Date(Date.now() - 1000) }
  );
  await fs.mkdir(livePath, { recursive: true });
  const live = await resolveSiteServe("pv", "pv_" + liveId, "index.html");
  assert.ok(live.ok, "a published revision is not swept by the preview TTL");
});

test("resolveSiteServe: hosting disabled platform-wide 404s everything", async () => {
  const { siteId } = seedLocalSite();
  adminRow.hostingEnabled = false;
  const res = await resolveSiteServe("pv", "pv_" + siteId, "index.html");
  assert.ok(!res.ok && res.status === 404);
});

test("resolveSiteServe: the live tree resolves via the site's liveToken to the latest published revision", async () => {
  const { storagePath } = seedLocalSite({ liveToken: "hs_live" }, { state: "published", publishedAt: new Date() });
  await fs.mkdir(storagePath, { recursive: true });
  await fs.writeFile(path.join(storagePath, "index.html"), "<h1>live</h1>");
  const res = await resolveSiteServe("hs", "hs_live", "");
  assert.ok(res.ok, JSON.stringify(res));
  if (res.ok) assert.equal(res.value.absPath, path.join(storagePath, "index.html"));
});

test("slugifyProject: a Cloudflare project name is a lowercase slug, never empty", () => {
  assert.equal(slugifyProject("My Cool Site!"), "my-cool-site");
  assert.equal(slugifyProject("   "), "site");
});

