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
// Repo root, for the source-level regression assertions at the foot of this file.
const ROOT = path.resolve(__dirname, "..");
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

const { parseSevenZipListing, isZipSlip, isJunkEntry, analyseArchive, manifestFromTree, listArchive, extractArchive, scanExtractedTree, singleRootPrefix, flattenSingleRootDir } = extract;
const { scanSiteFile, MB } = rules;
const { pagesAssetKey, deployTree, waitForDeployment } = cloudflare;
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
// ---------------------------------------------------------------------------
// deployTree — the FIVE-call Direct-Upload wire contract (PLAN §9 T0, §16.1).
//
// WHY THIS EXISTS: the live "Cloudflare returned 405." bug was an endpoint
// contract slip. An earlier draft called account-token, PROJECT-SCOPED asset
// paths (`…/pages/projects/{p}/check-missing|upload|upsert-hashes`) that do not
// exist (they answer 405), and posted a JSON body to `…/deployments`, which only
// accepts multipart STRING fields. A unit test that only checks `pagesAssetKey`
// is blind to both, so this pins the exact five calls, their auth, and the
// deploy body shape — re-verified live 2026-10-02 against the real account:
//
//   1. GET  …/pages/projects/{p}/upload-token   (ACCOUNT token) -> jwt
//   2. POST /pages/assets/check-missing         (jwt)
//   3. POST /pages/assets/upload                (jwt, one ARRAY body per file)
//   4. POST /pages/assets/upsert-hashes         (jwt)
//   5. POST …/pages/projects/{p}/deployments    (ACCOUNT token, multipart)
// ---------------------------------------------------------------------------

type DeployCall = {
  url: string;
  method: string;
  authorization: string | null;
  contentType: string | null;
  isFormData: boolean;
  body: string;
};

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Drive the REAL deployTree against a stubbed fetch that records every call. */
async function runDeployTree(opts: {
  missing: (keys: string[]) => string[];
  /** The deployment-status stages returned by the readiness poll, in order. */
  stages?: Array<{ name: string; status: string }>;
  /** Skip the readiness gate entirely (wire-contract-only runs). */
  awaitReady?: boolean;
}) {
  const cred = { accountId: "acct-123", token: "ACCOUNT_TOKEN" } as Parameters<typeof deployTree>[0];
  const project = "demo";
  const html = Buffer.from("<h1>hi</h1>");
  const css = Buffer.from("h1{color:red}");
  const files: Parameters<typeof deployTree>[2] = [
    { path: "/index.html", filename: "index.html", read: async () => html },
    { path: "/style.css", filename: "style.css", read: async () => css },
  ];
  const htmlKey = pagesAssetKey("index.html", html);
  const cssKey = pagesAssetKey("style.css", css);

  const calls: DeployCall[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    const headers = new Headers(init.headers ?? {});
    const isFormData = init.body instanceof FormData;
    let body = "";
    if (typeof init.body === "string") body = init.body;
    else if (isFormData) {
      for (const [k, v] of (init.body as FormData).entries()) body += `${k}=${String(v)};`;
    }
    calls.push({
      url,
      method: init.method ?? "GET",
      authorization: headers.get("authorization"),
      contentType: headers.get("content-type"),
      isFormData,
      body,
    });

    if (url.endsWith(`/pages/projects/${project}/upload-token`)) {
      return jsonRes({ success: true, result: { jwt: "JWT123" } });
    }
    if (url.endsWith("/pages/assets/check-missing")) {
      return jsonRes({ success: true, result: opts.missing([htmlKey, cssKey]) });
    }
    if (url.endsWith("/pages/assets/upload")) return jsonRes({ success: true, result: {} });
    if (url.endsWith("/pages/assets/upsert-hashes")) return jsonRes({ success: true, result: {} });
    if (url.endsWith(`/pages/projects/${project}/deployments`)) {
      return jsonRes({ success: true, result: { id: "dep-1", url: "https://demo.pages.dev" } });
    }
    if (url.endsWith(`/pages/projects/${project}/deployments/dep-1`)) {
      const queue = opts.stages ?? [{ name: "deploy", status: "success" }];
      const stage = queue.shift() ?? queue[queue.length - 1] ?? { name: "deploy", status: "success" };
      return jsonRes({
        success: true,
        result: { id: "dep-1", url: "https://demo.pages.dev", environment: "production", latest_stage: stage },
      });
    }
    return jsonRes({ success: false, errors: [{ message: `unexpected ${url}` }] }, 500);
  }) as typeof globalThis.fetch;

  try {
    const res = await deployTree(cred, project, files, "main", { awaitReady: opts.awaitReady !== false });
    return { res, calls, htmlKey, cssKey, project };
  } finally {
    globalThis.fetch = realFetch;
  }
}
test("deployTree: account token only for token+deploy, the JWT for /pages/assets/*, multipart manifest", async () => {
  const { res, calls, htmlKey, cssKey, project } = await runDeployTree({ missing: (keys) => keys });
  assert.ok(res.ok, JSON.stringify(res));
  assert.equal(res.value?.url, "https://demo.pages.dev");

  const find = (suffix: string) => calls.filter((c) => c.url.endsWith(suffix));
  const token = find(`/pages/projects/${project}/upload-token`);
  const missing = find("/pages/assets/check-missing");
  const upload = find("/pages/assets/upload");
  const upsert = find("/pages/assets/upsert-hashes");
  const deploy = find(`/pages/projects/${project}/deployments`);

  assert.equal(token.length, 1, "exactly one upload-token mint");
  assert.equal(missing.length, 1);
  assert.equal(upload.length, 2, "one POST per missing asset");
  assert.equal(upsert.length, 1);
  assert.equal(deploy.length, 1);

  // 1 — the token is minted WITH the account token.
  assert.equal(token[0].method, "GET");
  assert.equal(token[0].authorization, "Bearer ACCOUNT_TOKEN");

  // 2–4 — the /pages/assets/* family takes ONLY the short-lived JWT.
  for (const c of [...missing, ...upload, ...upsert]) {
    assert.equal(c.authorization, "Bearer JWT123", `${c.url} must use the upload JWT`);
  }

  // 3 — each upload body is a JSON ARRAY of {key, value(base64), metadata, base64:true}.
  const bodyOf = (c: DeployCall) => JSON.parse(c.body) as Array<Record<string, unknown>>;
  assert.deepEqual(upload.map((c) => bodyOf(c)[0].key).sort(), [htmlKey, cssKey].sort());
  for (const c of upload) {
    const entry = bodyOf(c)[0];
    assert.equal(entry.base64, true);
    assert.equal(typeof entry.value, "string");
    const meta = entry.metadata as { contentType?: string };
    assert.ok(meta.contentType && meta.contentType.length > 0, "contentType must never be empty (the original bug)");
  }

  // 5 — deployments is MULTIPART with `branch` + `manifest` as STRING fields,
  //     authenticated with the account token.
  assert.equal(deploy[0].method, "POST");
  assert.equal(deploy[0].authorization, "Bearer ACCOUNT_TOKEN");
  assert.ok(deploy[0].isFormData, "the deployments body must be multipart FormData");
  assert.equal(
    deploy[0].contentType,
    null,
    "no explicit Content-Type — fetch must set the multipart boundary itself (setting one breaks the deploy)"
  );
  assert.match(deploy[0].body, /branch=main;/);
  const manifestField = /manifest=(\{.*?\});/.exec(deploy[0].body);
  assert.ok(manifestField, "the manifest must be a multipart STRING field");
  const manifest = JSON.parse(manifestField![1]) as Record<string, string>;
  assert.equal(manifest["/index.html"], htmlKey);
  assert.equal(manifest["/style.css"], cssKey);

  // ZERO calls to the dead, project-scoped asset paths (the 405 bug).
  for (const dead of [
    `/pages/projects/${project}/check-missing`,
    `/pages/projects/${project}/upload`,
    `/pages/projects/${project}/upsert-hashes`,
  ]) {
    assert.equal(find(dead).length, 0, `${dead} does not exist on the account-token surface`);
  }
});

test("deployTree: an already-uploaded tree is a manifest-only deploy — the bytes do not move twice", async () => {
  const { res, calls } = await runDeployTree({ missing: () => [] });
  assert.ok(res.ok, JSON.stringify(res));
  assert.equal(res.value?.uploaded, 0);
  assert.equal(res.value?.reused, 2);
  assert.equal(calls.filter((c) => c.url.endsWith("/pages/assets/upload")).length, 0, "nothing uploads when nothing is missing");
  assert.equal(calls.filter((c) => c.url.endsWith("/pages/projects/demo/deployments")).length, 1);
});

// ---------------------------------------------------------------------------
// The readiness gate. A 200 from POST …/deployments only means CREATED; the URL
// was handed out before the deploy finished and the preview 404'd. The poll must
// wait for a terminal stage and must NEVER return a URL it has not seen succeed.
// ---------------------------------------------------------------------------

test("deployTree: polls the deployment until its stage is terminal before returning the URL", async () => {
  const { res, calls } = await runDeployTree({
    missing: (keys) => keys,
    stages: [
      { name: "queued", status: "active" },
      { name: "build", status: "active" },
      { name: "deploy", status: "success" },
    ],
  });
  assert.ok(res.ok, JSON.stringify(res));
  assert.equal(res.value?.url, "https://demo.pages.dev");
  const polls = calls.filter((c) => c.url.endsWith("/pages/projects/demo/deployments/dep-1"));
  assert.equal(polls.length, 3, "must poll until the stage is terminal, not return on creation");
  assert.equal(polls[0].method, "GET");
  assert.equal(polls[0].authorization, "Bearer ACCOUNT_TOKEN");
});

test("deployTree: a FAILED deployment stage is an error, never a URL", async () => {
  const { res } = await runDeployTree({
    missing: (keys) => keys,
    stages: [{ name: "deploy", status: "failure" }],
  });
  assert.equal(res.ok, false);
  assert.equal(res.status, 502);
  assert.match(res.error ?? "", /could not finish the deploy/i);
});

test("waitForDeployment: a deployment stuck mid-queue times out with plain language", async () => {
  const cred = { accountId: "acct-123", token: "ACCOUNT_TOKEN" };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    jsonRes({
      success: true,
      result: { id: "dep-1", url: "https://demo.pages.dev", latest_stage: { name: "build", status: "active" } },
    })) as typeof globalThis.fetch;
  try {
    const res = await waitForDeployment(cred, "demo", "dep-1", {
      timeoutMs: 0,
      sleep: async () => {},
    });
    assert.equal(res.ok, false);
    assert.equal(res.status, 504);
    assert.match(res.error ?? "", /still deploying/i);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---------------------------------------------------------------------------
// The wrapping-folder unwrap. A live preview 404'd at the site ROOT because the
// zipped folder's single top-level directory became the only child of the root, so
// there was no /index.html to serve and the real page sat at /<folder>/.
// ---------------------------------------------------------------------------

test("singleRootPrefix: strips a single wrapping folder, never a real multi-root site", () => {
  assert.equal(singleRootPrefix(["mysite/index.html", "mysite/style.css", "mysite/app.js"]), "mysite/");
  assert.equal(singleRootPrefix(["mysite/", "mysite/index.html"]), "mysite/");
  // Two top-level folders = a real layout. Leave the user's zip alone.
  assert.equal(singleRootPrefix(["a/index.html", "b/index.html"]), "");
  // A top-level FILE beside a folder = no single wrapper.
  assert.equal(singleRootPrefix(["README.md", "site/index.html"]), "");
  // Nothing to unwrap.
  assert.equal(singleRootPrefix(["index.html", "style.css"]), "");
  assert.equal(singleRootPrefix([]), "");
  // OS junk must not decide whether there is a wrapper.
  assert.equal(singleRootPrefix(["__MACOSX/._x", "mysite/.DS_Store", "mysite/index.html"]), "mysite/");
});

test("scanExtractedTree + flatten: a zipped folder becomes a root index.html (no .DS_Store in the tree)", async () => {
  const dir = path.join(STORAGE_DIR, `unwrap-${randomUUID()}`);
  await fs.mkdir(path.join(dir, "mysite", "sub"), { recursive: true });
  await fs.writeFile(path.join(dir, "mysite", "index.html"), "<h1>root</h1>");
  await fs.writeFile(path.join(dir, "mysite", ".DS_Store"), "junk");
  await fs.writeFile(path.join(dir, "mysite", "sub", "page.html"), "x");

  const before = await scanExtractedTree(dir, { maxAssetMb: 25 });
  assert.ok(before.ok);
  assert.ok(before.files.some((f) => f.path === "/mysite/index.html"), "pre-flatten the wrapper is present");

  await flattenSingleRootDir(dir);
  const after = await scanExtractedTree(dir, { maxAssetMb: 25 });
  assert.ok(after.ok);
  assert.ok(after.files.some((f) => f.path === "/index.html"), "the wrapper must be gone — this is the 404 fix");
  assert.equal(
    after.files.filter((f) => f.path.includes(".DS_Store")).length,
    0,
    "OS junk never reaches the manifest"
  );

  // A tree that is ALREADY at the root (index.html + a sibling folder) is untouched.
  const flatDir = path.join(STORAGE_DIR, `noUnwrap-${randomUUID()}`);
  await fs.mkdir(path.join(flatDir, "assets"), { recursive: true });
  await fs.writeFile(path.join(flatDir, "index.html"), "<h1>hi</h1>");
  await fs.writeFile(path.join(flatDir, "assets", "a.css"), "a{}");
  const prefix = singleRootPrefix(["index.html", "assets/a.css"]);
  assert.equal(prefix, "", "a real site root must never be unwrapped");
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

// ---------------------------------------------------------------------------
// REGRESSION — publish sent an EMPTY manifest for Cloudflare sites.
//
// Symptom (live, 2026-10-03): after "Publish to live" the site showed a DIFFERENT
// url, and opening it gave a Cloudflare 404 while the preview still served.
//
// Cause: publishRevision re-read the extracted tree behind
//   `if (site.engine !== "cloudflare" && revision.storagePath)`
// so for the cloudflare engine `files` stayed `[]` and deployTree POSTed an empty
// manifest to branch "main" -> a brand-new `<hash>.pages.dev` with no assets.
// Second half of the same defect: the live url was recorded as the deployment's
// one-off hash url, so it changed on every publish.
//
// These read the SOURCE, deliberately. The bug lived in an `if` that only ever
// mattered once real Cloudflare credentials were in play — exactly the kind of
// thing a mocked unit test cannot see. Asserting on the published text keeps the
// regression loud without a network or a DB.
// ---------------------------------------------------------------------------

test("regression: publish rebuilds the file tree for BOTH engines (no cloudflare-shaped 404)", async () => {
  const src = await fs.readFile(path.join(ROOT, "lib", "hosting", "sites.ts"), "utf8");
  const fn = src.slice(src.indexOf("export async function publishRevision"));
  assert.ok(fn.length > 0, "publishRevision must exist");

  // The old guard silently emptied the Cloudflare tree. It must not come back.
  assert.ok(
    !/engine\s*!==\s*"cloudflare"\s*&&\s*revision\.storagePath/.test(src),
    "the publish path must not gate the tree rebuild on the LOCAL engine"
  );
  // Publish must re-scan from storagePath and refuse an empty tree.
  assert.match(fn, /scanExtractedTree\(storagePath/, "publish must re-read the extracted tree");
  assert.match(fn, /files\.length === 0/, "publish must refuse to deploy an empty tree");
});

test("regression: a Cloudflare live url is the stable <project>.pages.dev, not the deploy hash", async () => {
  const src = await fs.readFile(path.join(ROOT, "lib", "hosting", "sites.ts"), "utf8");
  // The publish bookkeeping lives in deployRevision (publishRevision only calls it).
  const fn = src.slice(src.indexOf("async function deployRevision"));
  assert.match(fn, /const liveUrl = `https:\/\/\$\{project\}\.pages\.dev`/);
  assert.ok(
    !/data:\s*\{\s*status:\s*"published",\s*liveUrl:\s*dv\.url\s*\}/.test(src),
    "liveUrl must not be the per-deployment hash url"
  );
});

