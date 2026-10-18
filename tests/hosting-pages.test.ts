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
const { pagesAssetKey, deployTree, waitForDeployment, ensureProject, warmUpUrl, createZone, normalizePagesSubdomain, pagesProjectUrl } = cloudflare;
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

// ---------------------------------------------------------------------------
// TASK_158 W1 — the wrapper that macOS refused to collapse.
//
// `flattenSingleRootDir` required `items.length === 1`, but Finder puts a
// top-level `.DS_Store` (and often a `__MACOSX/` folder) BESIDE the wrapper, so
// staging had two children and NOTHING was unwrapped. The deployed root then had
// no `/index.html` and the site 404'd at `/` while the page sat at `/mysite/`.
// ---------------------------------------------------------------------------

test("flatten: OS junk beside the wrapper must not block the unwrap", async () => {
  const dir = path.join(STORAGE_DIR, `junk-${randomUUID()}`);
  await fs.mkdir(path.join(dir, "mysite", "assets"), { recursive: true });
  await fs.writeFile(path.join(dir, "mysite", "index.html"), "<h1>root</h1>");
  await fs.writeFile(path.join(dir, "mysite", "assets", "app.js"), "console.log(1)");
  // The two children that used to defeat the flatten.
  await fs.writeFile(path.join(dir, ".DS_Store"), "junk");
  await fs.mkdir(path.join(dir, "__MACOSX"), { recursive: true });
  await fs.writeFile(path.join(dir, "__MACOSX", "._index.html"), "junk");

  const moved = await flattenSingleRootDir(dir);
  assert.equal(moved, "mysite/", "the wrapper must still be recognised");

  const scanned = await scanExtractedTree(dir, { maxAssetMb: 25 });
  assert.ok(scanned.ok);
  const paths = scanned.files.map((f) => f.path).sort();
  assert.deepEqual(paths, ["/assets/app.js", "/index.html"], "only the real site survives, at the ROOT");
  // The junk must be GONE from disk too, not merely hidden from the scan.
  await assert.rejects(fs.stat(path.join(dir, ".DS_Store")));
  await assert.rejects(fs.stat(path.join(dir, "__MACOSX")));
});

test("flatten: two REAL roots still refuse to unwrap — that ambiguity is the user's", async () => {
  const dir = path.join(STORAGE_DIR, `multi-${randomUUID()}`);
  await fs.mkdir(path.join(dir, "site"), { recursive: true });
  await fs.mkdir(path.join(dir, "assets"), { recursive: true });
  await fs.writeFile(path.join(dir, "site", "index.html"), "<h1>a</h1>");
  await fs.writeFile(path.join(dir, "assets", "a.css"), "a{}");

  assert.equal(await flattenSingleRootDir(dir), "", "no single wrapper here");
  const scanned = await scanExtractedTree(dir, { maxAssetMb: 25 });
  assert.ok(scanned.ok);
  const paths = scanned.files.map((f) => f.path).sort();
  assert.deepEqual(paths, ["/assets/a.css", "/site/index.html"], "the user's layout is left alone");
});

test("flatten: a site already at the ROOT is untouched (index.html beside a folder)", async () => {
  const dir = path.join(STORAGE_DIR, `flat-${randomUUID()}`);
  await fs.mkdir(path.join(dir, "assets"), { recursive: true });
  await fs.writeFile(path.join(dir, "index.html"), "<h1>hi</h1>");
  await fs.writeFile(path.join(dir, "assets", "a.css"), "a{}");

  assert.equal(await flattenSingleRootDir(dir), "", "a root index.html is not a wrapper");
  const scanned = await scanExtractedTree(dir, { maxAssetMb: 25 });
  assert.ok(scanned.ok);
  assert.deepEqual(scanned.files.map((f) => f.path).sort(), ["/assets/a.css", "/index.html"]);
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
  // View fields — the TASK_225 publish tests drive the REAL toRevisionView over
  // these fake rows, so a row must carry everything the view reads (createdAt
  // included: toRevisionView calls .toISOString() on it).
  fileCount: number;
  bytes: number;
  cfUrl: string | null;
  rejection: string | null;
  expiresAt: Date | null;
  publishedAt: Date | null;
  createdAt: Date;
};

let sites: SiteRow[] = [];
let revisions: RevisionRow[] = [];
let adminRow: { hostingEnabled: boolean };
// TASK_225 — the fakes below are also RECORDERS: every hostingSite mutation and
// every Cloudflare-facing call is captured so the tests can assert what the
// code actually DID (persist-before-deploy, reuse-vs-remint), not merely that
// it returned ok. A fake that lets a test pass for the wrong reason is worse
// than no fake (house rule, task doc §4).
let siteUpdates: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
let cfSeen: Array<{ name: string; sitePersistedAtCall: boolean }> = [];
let deploySeen: Array<{ name: string; branch: string }> = [];

function matchRow(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, v]) => row[k] === v);
}

const fakePrisma = {
  // resolveCapsForUser (files.ts:92) calls prisma.user.findUnique with
  // select { tier, premiumExpiresAt } — the fake returns exactly those.
  user: {
    findUnique: async () => ({ tier: 9, premiumExpiresAt: null }),
  },
  hostingSite: {
    findFirst: async ({ where }: { where: Record<string, unknown> }) =>
      sites.find((s) => matchRow(s as unknown as Record<string, unknown>, where)) ?? null,
    count: async ({ where }: { where: Record<string, unknown> }) =>
      sites.filter((s) => matchRow(s as unknown as Record<string, unknown>, where)).length,
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const row = {
        id: "site_" + randomUUID(),
        credentialId: null,
        cfProject: null,
        liveToken: null,
        status: "draft",
        previewUrl: null,
        liveUrl: null,
        createdAt: new Date(),
        ...data,
      } as unknown as SiteRow;
      sites.push(row);
      return row;
    },
    update: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      siteUpdates.push({ where, data });
      const row = sites.find((s) => matchRow(s as unknown as Record<string, unknown>, where));
      if (!row) throw new Error(`fake hostingSite.update: no row for ${JSON.stringify(where)}`);
      Object.assign(row as unknown as Record<string, unknown>, data);
      return row;
    },
  },
  hostingRevision: {
    findFirst: async ({ where, orderBy }: { where: Record<string, unknown>; orderBy?: Record<string, string> }) => {
      let hits = revisions.filter((r) => matchRow(r as unknown as Record<string, unknown>, where));
      if (orderBy?.publishedAt === "desc") {
        hits = hits.sort((a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0));
      }
      return hits[0] ?? null;
    },
    // prunePublishedRevisions (end of every publish) reads findMany.
    findMany: async ({ where, orderBy }: { where: Record<string, unknown>; orderBy?: Record<string, string> }) => {
      let hits = revisions.filter((r) => matchRow(r as unknown as Record<string, unknown>, where));
      if (orderBy?.publishedAt === "desc") {
        hits = hits.sort((a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0));
      }
      return hits;
    },
    update: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const row = revisions.find((r) => matchRow(r as unknown as Record<string, unknown>, where));
      if (!row) throw new Error(`fake hostingRevision.update: no row for ${JSON.stringify(where)}`);
      Object.assign(row as unknown as Record<string, unknown>, data);
      return row;
    },
  },
  // acquireHeavyJob: the running-lock count → 0 (unlocked), create → a job id.
  // deploysInLastDay: count → 0 (under the per-day quota).
  // finishHeavyJob: update is .catch((){})-guarded in prod; the fake resolves.
  hostingJob: {
    count: async () => 0,
    create: async ({ data }: { data: Record<string, unknown> }) => ({ id: "job_" + randomUUID(), ...data }),
    update: async () => ({}),
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
      // TASK_225 — the publish path (publishRevision → deployRevision) needs the
      // platform roster and the Cloudflare client. These intercept only requires
      // FROM /lib/hosting/ files (sites.ts): the test file's own direct
      // `require("../lib/hosting/cloudflare")` above bypasses the hook, so the
      // pre-existing tests still drive the REAL CF client.
      if (request === "./platform-accounts") {
        return {
          healthyPlatformAccountCount: async () => 1,
          resolvePlatformCredential: async () => ({
            ok: true,
            value: { accountId: "acct_test", token: "tok_test", platformAccountId: "plat_test" },
          }),
        };
      }
      if (request === "./cloudflare") {
        return {
          ensureProject: async (_cred: unknown, name: string) => {
            // ORDER PROOF for the lazy heal: had the minted name already been
            // PERSISTED to the row at the moment Cloudflare first saw it?
            cfSeen.push({ name, sitePersistedAtCall: siteUpdates.some((u) => "cfProject" in u.data) });
            return { ok: true, value: { subdomain: `${name}-c3t` } };
          },
          deployTree: async (_cred: unknown, name: string, _files: unknown, branch: string) => {
            deploySeen.push({ name, branch });
            return { ok: true, value: { url: `https://hash.${name}.pages.dev`, deploymentId: "dep_test" } };
          },
          pagesProjectUrl: (subdomain: string) => `https://${subdomain}.pages.dev`,
          verifyCredential: async () => ({ ok: true }),
          warmUpUrl: async () => {},
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
const { resolveSiteServe, slugifyProject, uniqueCfProject, createSite, publishRevision } = sitesMod;

beforeEach(() => {
  sites = [];
  revisions = [];
  adminRow = { hostingEnabled: true };
  siteUpdates = [];
  cfSeen = [];
  deploySeen = [];
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
    // View fields (TASK_225): the publish path maps the fake-updated row through
    // the real toRevisionView, which reads these.
    fileCount: 1,
    bytes: 42,
    cfUrl: null,
    rejection: null,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    publishedAt: null,
    createdAt: new Date(),
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
// TASK_225 — Cloudflare project-name uniqueness.
//
// The bug: `cfProject` was the bare label slug, and Cloudflare Pages project
// names are GLOBALLY unique. Two sites labelled the same minted the SAME
// project name: the second site's create 400s, or — once a deploy ran — one
// user's site was written into ANOTHER user's project (the owner's report:
// user B overwrites user A). The fix: every cloudflare site now MINTS
// `<head>-<7 hex>` at create (uniqueCfProject), and a legacy NULL-cfProject
// row heals to a minted name at deploy time — persisted to the row BEFORE any
// Cloudflare call sees it.
//
// These drive the REAL createSite/publishRevision through the fake prisma and
// the intercepted CF client (the house pattern above). The fakes RECORD their
// calls, so the assertions pin behaviour (what was persisted, what Cloudflare
// was asked for), not just return values.
// ---------------------------------------------------------------------------

const CF_NAME_SHAPE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

test("TASK_225: the same label mints two DISTINCT project names (user B must never overwrite user A)", () => {
  const a = uniqueCfProject("Portfolio");
  const b = uniqueCfProject("Portfolio");
  assert.notEqual(
    a,
    b,
    `two sites labelled "Portfolio" collided — both minted ${a}; user B's deploy would write into user A's project`
  );
  for (const n of [a, b]) assert.ok(n.startsWith("portfolio-"), `${n} must still derive from the label`);
});

test("TASK_225: every mint is a valid Cloudflare Pages name — charset, length, no double or trailing hyphen", () => {
  for (const label of ["Portfolio", "My Cool Site!", "a".repeat(200), "   ", "!!!", "Ünïcode Çafé 2026", "MiXeD CASE 42"]) {
    const n = uniqueCfProject(label);
    assert.match(n, CF_NAME_SHAPE, `${JSON.stringify(label)} minted ${n}`);
    assert.ok(n.length <= 48, `${n} is ${n.length} chars — must stay under the CF limit (48: under both the documented 58 and our proven 50)`);
    assert.ok(!n.includes("--"), `${n} must not contain a double hyphen`);
    assert.ok(!n.endsWith("-"), `${n} must not end in a hyphen`);
  }
});

test("TASK_225: edge labels still mint valid unique names; a 200-char label is clamped, never over the limit", () => {
  // slugifyProject collapses blank/junk labels to "site" — the mint must still
  // be unique and shape-valid (not "site-…" collisions, not an empty head).
  const blank = uniqueCfProject("   ");
  const junk = uniqueCfProject("!!!");
  assert.match(blank, CF_NAME_SHAPE);
  assert.match(junk, CF_NAME_SHAPE);
  assert.notEqual(blank, junk);
  const long = uniqueCfProject("A".repeat(200));
  assert.ok(long.length <= 48, `${long.length}-char mint must be clamped`);
  // The head-slice can land ON a hyphen — 39 a's + "-b" slugs to a 41-char
  // base whose 40-char slice ends exactly on the hyphen, which would mint
  // `<head>--<suffix>`. The mint trims it.
  const trap = uniqueCfProject("a".repeat(39) + "-b");
  assert.ok(!trap.includes("--"), `${trap} must not mint a double hyphen`);
  assert.match(trap, CF_NAME_SHAPE);
});

test("TASK_225: two users creating the SAME label get two different project names (platform-roster isolation)", async () => {
  const one = await createSite({ userId: "user_a", name: "Portfolio", engine: "cloudflare", credentialId: null });
  const two = await createSite({ userId: "user_b", name: "Portfolio", engine: "cloudflare", credentialId: null });
  assert.ok(one.ok && two.ok, JSON.stringify([one, two]));
  assert.equal(sites.length, 2);
  // The minted names live on the ROWS (HostingSiteView doesn't expose cfProject).
  const [rowA, rowB] = sites;
  assert.ok(rowA.cfProject && rowB.cfProject, "both rows must carry a cfProject");
  assert.notEqual(
    rowA.cfProject,
    rowB.cfProject,
    `user A (${rowA.cfProject}) and user B (${rowB.cfProject}) minted the same project name`
  );
});

test("TASK_225: a local-engine site still stores cfProject: null (the free engine is untouched)", async () => {
  const res = await createSite({ userId: "user_1", name: "My Cool Site", engine: "local", credentialId: null });
  assert.ok(res.ok, JSON.stringify(res));
  assert.equal(sites[0].engine, "local");
  assert.equal(sites[0].cfProject, null, "the local engine has no Cloudflare project");
  // The local SERVE paths are pinned by the five resolveSiteServe tests above — unchanged.
});

test("TASK_225: a deploy REUSES the stored cfProject exactly — never re-mints, never re-slugifies", async () => {
  const { siteId, revisionId, storagePath } = seedLocalSite(
    { engine: "cloudflare", cfProject: "keep-me-123", credentialId: null },
    { state: "previewed" }
  );
  await fs.mkdir(storagePath, { recursive: true });
  await fs.writeFile(path.join(storagePath, "index.html"), "<h1>hi</h1>");
  const res = await publishRevision({ userId: "user_1", siteId, revisionId });
  assert.ok(res.ok, JSON.stringify(res));
  assert.equal(cfSeen.length, 1, "exactly one ensureProject call");
  assert.equal(cfSeen[0].name, "keep-me-123", "deploy must use the STORED project name verbatim");
  assert.equal(sites[0].cfProject, "keep-me-123", "the stored name must not be rewritten");
  assert.ok(
    !siteUpdates.some((u) => "cfProject" in u.data),
    "no cfProject update may be persisted for a row that already has one"
  );
  assert.equal(deploySeen[0].branch, "main", "a publish deploys branch main");
});

test("TASK_225: a legacy row with cfProject: null heals to a UNIQUE name PERSISTED before Cloudflare sees it", async () => {
  const { siteId, revisionId, storagePath } = seedLocalSite(
    { engine: "cloudflare", cfProject: null, credentialId: null },
    { state: "previewed" }
  );
  await fs.mkdir(storagePath, { recursive: true });
  await fs.writeFile(path.join(storagePath, "index.html"), "<h1>hi</h1>");
  const res = await publishRevision({ userId: "user_1", siteId, revisionId });
  assert.ok(res.ok, JSON.stringify(res));
  assert.equal(cfSeen.length, 1);
  const minted = cfSeen[0].name;
  assert.match(minted, CF_NAME_SHAPE, `heal minted an invalid name: ${minted}`);
  assert.notEqual(minted, "demo", "the heal must NOT re-derive the bare label slug (the pre-TASK_225 collision bug)");
  assert.equal(sites[0].cfProject, minted, "the minted name must be persisted to the row");
  assert.ok(cfSeen[0].sitePersistedAtCall, "the name must be PERSISTED before any Cloudflare call sees it (persist-before-deploy)");
  // The live url still follows the subdomain Cloudflare GRANTED (TASK_158 W1) —
  // with unique names, each site's url is naturally its own.
  assert.equal(res.ok && res.value.previewUrl, `https://${minted}-c3t.pages.dev`);
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

test("regression: a Cloudflare live url is the stable PROJECT url, never the deploy hash", async () => {
  const src = await fs.readFile(path.join(ROOT, "lib", "hosting", "sites.ts"), "utf8");
  // The publish bookkeeping lives in deployRevision (publishRevision only calls it).
  const fn = src.slice(src.indexOf("async function deployRevision"));
  assert.ok(
    !/data:\s*\{\s*status:\s*"published",\s*liveUrl:\s*dv\.url\s*\}/.test(src),
    "liveUrl must not be the per-deployment hash url"
  );
  // TASK_158 W1 — and it must not be hand-built from the REQUESTED project name
  // either. `<name>.pages.dev` is only a wish: when the name is taken Cloudflare
  // serves the project from `<name>-<suffix>.pages.dev`, so the old template handed
  // out `https://new-test.pages.dev` (live 522) for a site that actually lived at
  // `new-test-c3t.pages.dev`. The url now comes from the subdomain Cloudflare granted.
  assert.ok(
    !/const liveUrl = `https:\/\/\$\{project\}\.pages\.dev`/.test(fn),
    "liveUrl must not be derived from the requested project name"
  );
  assert.match(fn, /pagesProjectUrl\(/, "liveUrl must be built from the granted subdomain");
});

// ---------------------------------------------------------------------------
// TASK_158 W1 — the granted-subdomain fix.
//
// Symptom (live, 2026-10-04): a real ZIP uploaded and deployed fine, the preview
// `<hash>.new-test-c3t.pages.dev` returned 200, and the project itself served at
// `new-test-c3t.pages.dev` — but the stored `liveUrl` was the hand-built
// `https://new-test.pages.dev`, which answered **522**. Cloudflare had appended a
// suffix because `new-test.pages.dev` was already taken, and nothing noticed.
//
// The fix has two halves and BOTH are asserted below: read the granted subdomain,
// and never hand-build a hostname from the requested name.
// ---------------------------------------------------------------------------

test("normalizePagesSubdomain: takes whatever Cloudflare sent, always yields a bare label", () => {
  assert.equal(normalizePagesSubdomain("new-test-c3t", "new-test"), "new-test-c3t");
  assert.equal(normalizePagesSubdomain("demo.pages.dev", "fallback"), "demo");
  assert.equal(normalizePagesSubdomain("https://demo.pages.dev/", "fallback"), "demo");
  assert.equal(normalizePagesSubdomain("  demo  ", "fallback"), "demo");
  // The OTHER real shape: `subdomains` is an array of full hostnames on older
  // responses. Reading only the singular field is what lets the 522 come back on the
  // accounts where this one is returned instead.
  assert.equal(normalizePagesSubdomain(["demo.pages.dev"], "fallback"), "demo");
  assert.equal(normalizePagesSubdomain(["demo.pages.dev", "b.demo.pages.dev"], "fallback"), "demo");
  assert.equal(normalizePagesSubdomain([], "fallback"), "fallback");
  // Absent/blank falls back to the requested name — the old behaviour exactly, so
  // an API that omits the field cannot regress to an empty hostname.
  assert.equal(normalizePagesSubdomain(undefined, "fallback"), "fallback");
  assert.equal(normalizePagesSubdomain(null, "fallback"), "fallback");
  assert.equal(normalizePagesSubdomain("", "fallback"), "fallback");
  assert.equal(normalizePagesSubdomain("   ", "fallback"), "fallback");
});

test("pagesProjectUrl: builds the https project url", () => {
  assert.equal(pagesProjectUrl("new-test-c3t"), "https://new-test-c3t.pages.dev");
});

/**
 * Drive the REAL `ensureProject` against a stubbed fetch. This is the call whose
 * response shape caused the 522, so it is asserted on the wire, not via a helper.
 */
async function runEnsureProject(
  handler: (url: string, init: RequestInit) => Response | null
): Promise<{ res: Awaited<ReturnType<typeof ensureProject>>; calls: string[] }> {
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    calls.push(`${init.method ?? "GET"} ${url}`);
    return handler(url, init) ?? jsonRes({ success: false, errors: [{ message: `unexpected ${url}` }] }, 500);
  }) as typeof globalThis.fetch;
  try {
    return { res: await ensureProject({ accountId: "acct_1", token: "tok_1" }, "new-test"), calls };
  } finally {
    globalThis.fetch = realFetch;
  }
}

test("ensureProject: an EXISTING project reports the subdomain Cloudflare granted, not the name we asked for", async () => {
  const { res, calls } = await runEnsureProject((url) =>
    url.endsWith("/pages/projects/new-test")
      ? jsonRes({ success: true, result: { name: "new-test", subdomain: "new-test-c3t" } })
      : null
  );
  assert.ok(res.ok, JSON.stringify(res));
  assert.equal(res.value?.subdomain, "new-test-c3t");
  assert.equal(res.value?.name, "new-test");
  assert.equal(calls.length, 1, "an existing project must never be re-POSTed");
});

test("ensureProject: a BRAND-NEW project reports its granted subdomain too", async () => {
  const { res, calls } = await runEnsureProject((url, init) => {
    if (init.method === "GET") return jsonRes({ success: false, errors: [{ message: "not found" }] }, 404);
    if (url.endsWith("/pages/projects")) {
      return jsonRes({ success: true, result: { name: "new-test", subdomain: "new-test-c3t" } }, 201);
    }
    return null;
  });
  assert.ok(res.ok, JSON.stringify(res));
  assert.equal(res.value?.subdomain, "new-test-c3t");
  assert.equal(calls.length, 2, "404 then create");
});

test("ensureProject: a response with no subdomain falls back to the requested name", async () => {
  const { res } = await runEnsureProject((url) =>
    url.endsWith("/pages/projects/new-test") ? jsonRes({ success: true, result: { name: "new-test" } }) : null
  );
  assert.ok(res.ok, JSON.stringify(res));
  assert.equal(res.value?.subdomain, "new-test");
});

test("ensureProject: the older `subdomains[]` shape is read too, not silently ignored", async () => {
  const { res } = await runEnsureProject((url) =>
    url.endsWith("/pages/projects/new-test")
      ? jsonRes({ success: true, result: { name: "new-test", subdomains: ["new-test-c3t.pages.dev"] } })
      : null
  );
  assert.ok(res.ok, JSON.stringify(res));
  assert.equal(res.value?.subdomain, "new-test-c3t", "the array form must not fall back to the requested name");
});

test("ensureProject: a singular `subdomain` wins over `subdomains` when both are present", async () => {
  const { res } = await runEnsureProject((url) =>
    url.endsWith("/pages/projects/new-test")
      ? jsonRes({
          success: true,
          result: { name: "new-test", subdomain: "granted-c3t", subdomains: ["stale-old.pages.dev"] },
        })
      : null
  );
  assert.ok(res.ok, JSON.stringify(res));
  assert.equal(res.value?.subdomain, "granted-c3t");
});

test("ensureProject: a non-404 failure is reported, never retried as a create", async () => {
  const { res, calls } = await runEnsureProject(() =>
    jsonRes({ success: false, errors: [{ message: "Authentication error" }] }, 403)
  );
  assert.equal(res.ok, false);
  assert.equal(calls.length, 1, "a 403 must not be followed by a create");
});

// ---------------------------------------------------------------------------
// TASK_158 W1 — the certificate race.
//
// A brand-new Pages project has its `*.pages.dev` certificate issued ON DEMAND,
// so the very first request to the fresh host fails the TLS handshake. A browser
// reports that as ERR_SSL_VERSION_OR_CIPHER_MISMATCH, not as a 404 — which makes a
// perfectly good deploy look completely broken. These pin the two properties that
// matter: an already-warm url costs nothing, and a cold one is waited for.
// ---------------------------------------------------------------------------

test("warmUpUrl: returns true on the first probe, with no sleeping at all", async () => {
  const realFetch = globalThis.fetch;
  let probes = 0;
  let slept = 0;
  globalThis.fetch = (async () => {
    probes += 1;
    return new Response("ok", { status: 200 });
  }) as typeof globalThis.fetch;
  try {
    const warm = await warmUpUrl("https://demo.pages.dev", { sleep: async () => void (slept += 1) });
    assert.equal(warm, true);
    assert.equal(probes, 1);
    assert.equal(slept, 0, "an already-warm url must not delay the publish");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("warmUpUrl: a TLS failure is retried, and ANY http status counts as live", async () => {
  const realFetch = globalThis.fetch;
  let probes = 0;
  globalThis.fetch = (async () => {
    probes += 1;
    if (probes < 3) throw new Error("unable to verify the first certificate");
    // A 404 still proves the hostname is live at the edge, which is all a browser
    // needs to stop showing an SSL error.
    return new Response("nope", { status: 404 });
  }) as typeof globalThis.fetch;
  try {
    const warm = await warmUpUrl("https://fresh.pages.dev", { sleep: async () => {} });
    assert.equal(warm, true);
    assert.equal(probes, 3);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("warmUpUrl: gives up at the deadline instead of hanging a deploy", async () => {
  const realFetch = globalThis.fetch;
  let probes = 0;
  globalThis.fetch = (async () => {
    probes += 1;
    throw new Error("still not provisioned");
  }) as typeof globalThis.fetch;
  try {
    // A zero timeout means the FIRST failure is already past the deadline.
    const warm = await warmUpUrl("https://never.pages.dev", { timeoutMs: 0, sleep: async () => {} });
    assert.equal(warm, false);
    assert.equal(probes, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---------------------------------------------------------------------------
// TASK_158 W1 — ZONE CREATION, the single call the dedicated Zones token exists
// for. Creating a zone is an ACCOUNT grant that neither the Pages token nor the
// Workers token carries (both answer 403 for it), so these assertions are about
// the exact request body and about telling "already exists" apart from a real
// refusal — the difference between re-reading the user's own zone and reporting a
// spurious error.
// ---------------------------------------------------------------------------

async function runCreateZone(
  name: string,
  handler: (url: string, init: RequestInit) => Response
): Promise<{ res: Awaited<ReturnType<typeof createZone>>; calls: { url: string; method: string; body: string; authorization: string | null }[] }> {
  const calls: { url: string; method: string; body: string; authorization: string | null }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({
      url,
      method: init.method ?? "GET",
      body: typeof init.body === "string" ? init.body : "",
      authorization: new Headers(init.headers ?? {}).get("authorization"),
    });
    return handler(url, init);
  }) as typeof globalThis.fetch;
  try {
    return { res: await createZone({ accountId: "acct_1", token: "zone_tok" }, name), calls };
  } finally {
    globalThis.fetch = realFetch;
  }
}

test("createZone: POSTs the account-scoped zone body and reports the assigned nameservers", async () => {
  const { res, calls } = await runCreateZone("example.com", () =>
    jsonRes({
      success: true,
      result: { id: "zone_9", name: "example.com", status: "pending", name_servers: ["ns1.cf.com", "ns2.cf.com"] },
    })
  );
  assert.ok(res.ok, JSON.stringify(res));
  assert.equal(res.value?.zoneId, "zone_9");
  assert.equal(res.value?.status, "pending");
  // The nameservers are the whole user-facing payoff: without them the UI can only
  // say "go and create this yourself".
  assert.deepEqual(res.value?.nameservers, ["ns1.cf.com", "ns2.cf.com"]);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.cloudflare.com/client/v4/zones");
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].authorization, "Bearer zone_tok");
  const body = JSON.parse(calls[0].body) as Record<string, unknown>;
  assert.equal(body.name, "example.com");
  assert.deepEqual(body.account, { id: "acct_1" });
  // jump_start imports what the registrar already serves, so a domain that is
  // already live does not go dark while the nameservers propagate.
  assert.equal(body.jump_start, true);
  // "full" is the nameserver setup; "partial" would serve nothing.
  assert.equal(body.type, "full");
});

test("createZone: 'already exists' is a DISTINCT code, so the caller re-reads instead of erroring", async () => {
  const { res } = await runCreateZone("example.com", () =>
    jsonRes({ success: false, errors: [{ code: 1061, message: "Zone already exists." }] }, 400)
  );
  assert.equal(res.ok, false);
  assert.equal(res.code, "zone_exists");
});

test("createZone: a 409 is also 'already exists'", async () => {
  const { res } = await runCreateZone("example.com", () =>
    jsonRes({ success: false, errors: [{ message: "Duplicate zone" }] }, 409)
  );
  assert.equal(res.ok, false);
  assert.equal(res.code, "zone_exists");
});

test("createZone: a genuine refusal is a plain failure, never mistaken for 'already exists'", async () => {
  // A 403 is exactly what a token WITHOUT the zone-create grant returns — the
  // expected answer if the operator pasted a Pages token into the Zones slot.
  const { res } = await runCreateZone("example.com", () =>
    jsonRes({ success: false, errors: [{ message: "Authentication error" }] }, 403)
  );
  assert.equal(res.ok, false);
  assert.equal(res.code, "zone_create_failed");
});

test("createZone: a 200 with no zone id is a failure, not an empty success", async () => {
  const { res } = await runCreateZone("example.com", () => jsonRes({ success: true, result: {} }));
  assert.equal(res.ok, false);
  assert.equal(res.code, "zone_create_failed");
});

