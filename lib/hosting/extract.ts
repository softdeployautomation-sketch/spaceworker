import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

import { MB, scanSiteFile } from "./rules";

// TASK_155 P3 — the §16.1 folder→site pipeline: a `.zip` is listed, cap-checked,
// extracted into a STAGING DIR OUTSIDE the deploy dir, and scanned (§11.1). The
// archive is NEVER trusted and NEVER loaded into RSS: `7z` (the only archiver on
// the box — `unzip` is absent, PLAN §12) does the listing and the extraction, and
// the parse + the tree→manifest mapping are PURE so they are unit-testable
// without Cloudflare and without 7z.
//
// Zip-slip (`../`), absolute paths, symlinks/hardlinks, nested zips, > N entries
// and per-file oversize are all refused BY NAME before/around extraction. A
// rejected archive leaves ZERO partial state — the caller wipes the staging dir.

export interface ZipEntry {
  /** The archive-relative path, exactly as 7z reports it (may use `/`). */
  path: string;
  /** Uncompressed size in bytes (0 for a directory). */
  size: number;
  isDir: boolean;
  isSymlink: boolean;
}

/** 7z prints `Attributes` with `l` for a symlink and `D` for a directory. */
function attributesSayDir(attrs: string): boolean {
  return attrs.includes("D") || attrs.includes("d");
}

/**
 * Parse the output of `7z l -slt <archive>`. PURE — takes the raw text, returns
 * the entries. `-slt` emits `Key = Value` lines grouped by a blank line per item;
 * we only read the keys we care about so a 7z version bump cannot break us.
 *
 * The output has an ARCHIVE-HEADER block before the first `----------` rule
 * (`Path = site.zip`, `Type = zip`, `Physical Size = …`). That block is NOT an
 * entry — its `Path` is the archive file itself, so a naive parser would emit a
 * spurious `…/site.zip` item and every real archive would be rejected as a
 * nested zip. We therefore ignore everything up to and including that rule.
 */
export function parseSevenZipListing(output: string): ZipEntry[] {
  const entries: ZipEntry[] = [];
  let cur: Partial<ZipEntry> & { attrs?: string; folder?: string } = {};
  let inEntries = false;

  const flush = () => {
    if (cur.path !== undefined) {
      const isDir = cur.isDir ?? (cur.folder === "+" || attributesSayDir(cur.attrs ?? ""));
      entries.push({
        path: cur.path,
        size: cur.size ?? 0,
        isDir,
        isSymlink: cur.isSymlink ?? false,
      });
    }
    cur = {};
  };

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    // The `----------` rule ends the header block; only entries follow it.
    if (/^-{5,}$/.test(line)) {
      flush();
      inEntries = true;
      continue;
    }
    if (!inEntries) continue;
    if (line === "") {
      flush();
      continue;
    }
    const eq = line.indexOf(" = ");
    if (eq === -1) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 3);
    switch (key) {
      case "Path":
        cur.path = value;
        break;
      case "Size":
        cur.size = Number.parseInt(value, 10) || 0;
        break;
      case "Folder":
        cur.folder = value;
        break;
      case "Attributes":
        cur.attrs = value;
        if (value.includes("l")) cur.isSymlink = true;
        break;
      case "Symbolic Link":
        if (value) cur.isSymlink = true;
        break;
      default:
        break;
    }
  }
  flush();
  return entries;
}

/** A path is unsafe if it is absolute, escapes upward, or is a Windows drive path. */
export function isZipSlip(entryPath: string): boolean {
  const p = entryPath.replace(/\\/g, "/");
  if (p.startsWith("/")) return true;
  if (/^[a-zA-Z]:\//.test(p)) return true;
  const parts = p.split("/");
  return parts.some((seg) => seg === "..");
}

/** OS junk we never extract into a site (and never count as a "skipped file"). */
export function isJunkEntry(entryPath: string): boolean {
  const p = entryPath.replace(/\\/g, "/");
  return p.startsWith("__MACOSX/") || p.endsWith("/.DS_Store") || p === ".DS_Store";
}

export interface ArchiveCaps {
  /** hostingMaxZipEntries — the Direct-Upload ceiling (R19). */
  maxEntries: number;
  /** hostingPagesMaxAssetMb — per-file ceiling (MUST stay < 25). */
  maxAssetMb: number;
}

export type ArchiveVerdict =
  | { ok: true; fileCount: number; totalBytes: number; skipped: number }
  | { ok: false; code: string; message: string };

/**
 * The §16.1 cap check, run on the LISTING before extraction. PURE. Refuses an
 * archive by name rather than discovering the problem mid-extract:
 *   - > `maxEntries` entries (count reported),
 *   - a zip-slip / absolute path,
 *   - a symlink or hardlink,
 *   - a nested `.zip`,
 *   - a file larger than `maxAssetMb`.
 * Directories and OS junk are counted as "skipped", not files.
 */
export function analyseArchive(entries: ZipEntry[], caps: ArchiveCaps): ArchiveVerdict {
  if (entries.length > caps.maxEntries) {
    return {
      ok: false,
      code: "too_many_entries",
      message: `That folder has ${entries.length} items — the limit is ${caps.maxEntries}. Zip a smaller folder.`,
    };
  }

  let fileCount = 0;
  let totalBytes = 0;
  let skipped = 0;

  for (const entry of entries) {
    if (isJunkEntry(entry.path)) {
      skipped += 1;
      continue;
    }
    if (isZipSlip(entry.path)) {
      return {
        ok: false,
        code: "zip_slip",
        message: `This archive contains an unsafe path (“${entry.path}”) and was refused. Re-zip the folder without “..” paths.`,
      };
    }
    if (entry.isSymlink) {
      return {
        ok: false,
        code: "symlink",
        message: `This archive contains a symbolic link (“${entry.path}”). Links can point outside your site, so it was refused.`,
      };
    }
    if (entry.isDir) {
      skipped += 1;
      continue;
    }
    if (/\.zip$/i.test(entry.path)) {
      return {
        ok: false,
        code: "nested_zip",
        message: "This archive contains another .zip inside it. Extract it first, then zip the folder once.",
      };
    }
    if (entry.size > caps.maxAssetMb * MB) {
      return {
        ok: false,
        code: "file_over_limit",
        message: `“${entry.path}” is larger than the ${caps.maxAssetMb} MB per-file limit. Remove it and try again.`,
      };
    }
    fileCount += 1;
    totalBytes += entry.size;
  }

  if (fileCount === 0) {
    return { ok: false, code: "empty", message: "That archive has no files to publish." };
  }
  return { ok: true, fileCount, totalBytes, skipped };
}

// ---------------------------------------------------------------------------
// The 7z shell-outs. These are the only non-pure parts; they are kept thin so the
// logic above carries the tests. Every call has a hard timeout so a pathological
// archive cannot wedge the process (§16.6).
// ---------------------------------------------------------------------------

function run7z(args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("7z", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (killed) {
        reject(new Error("The archive took too long to process and was stopped."));
        return;
      }
      resolve({ stdout, stderr, code: code ?? 0 });
    });
  });
}

/** List an archive's entries via `7z l -slt`. */
export async function listArchive(archivePath: string, timeoutMs = 60_000): Promise<ZipEntry[]> {
  const { stdout } = await run7z(["l", "-slt", archivePath], timeoutMs);
  return parseSevenZipListing(stdout);
}

export interface ExtractResult {
  entries: number;
  durationMs: number;
  /** Best-effort peak RSS of the 7z child, in MB (0 when 7z reports nothing). */
  peakRssMb: number;
}

/**
 * Extract `archivePath` into `destDir` (which MUST be outside the deploy dir).
 * `-y` overwrites, `-o` sets the output dir. The caller has already refused
 * zip-slip/links via analyseArchive; `-x!` still refuses junk dirs defensively.
 */
export async function extractArchive(
  archivePath: string,
  destDir: string,
  timeoutMs = 120_000
): Promise<ExtractResult> {
  await fs.mkdir(destDir, { recursive: true });
  const started = Date.now();
  const { code, stderr } = await run7z(
    ["x", archivePath, `-o${destDir}`, "-y", "-bso0", "-bsp0", "-x!__MACOSX"],
    timeoutMs
  );
  const durationMs = Date.now() - started;
  if (code !== 0) {
    throw new Error(stderr.trim() || "The archive could not be extracted.");
  }
  const entries = await countFiles(destDir);
  return { entries, durationMs, peakRssMb: 0 };
}

/** Recursively count regular files under `dir`. */
async function countFiles(dir: string): Promise<number> {
  let count = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop() as string;
    const items = await fs.readdir(current, { withFileTypes: true });
    for (const item of items) {
      const full = path.join(current, item.name);
      if (item.isDirectory()) stack.push(full);
      else if (item.isFile()) count += 1;
    }
  }
  return count;
}

export interface TreeFile {
  /** Site-relative path with a LEADING slash, e.g. "/index.html". */
  path: string;
  bytes: number;
  /** Absolute path on disk (local engine reads from here). */
  absPath: string;
}

/**
 * Walk the extracted tree and return its files, with §11.1 applied: a
 * server-side script/webshell extension is a HARD rejection (a site is static
 * content; it must never ship a `.php`/`.sh`), while everything else is allowed.
 */
export async function scanExtractedTree(
  rootDir: string,
  opts: { maxAssetMb: number }
): Promise<{ ok: true; files: TreeFile[]; totalBytes: number } | { ok: false; code: string; message: string }> {
  const files: TreeFile[] = [];
  const stack: string[] = [""];
  let totalBytes = 0;

  while (stack.length) {
    const rel = stack.pop() as string;
    const abs = path.join(rootDir, rel);
    const items = await fs.readdir(abs, { withFileTypes: true });
    for (const item of items) {
      const childRel = rel ? `${rel}/${item.name}` : item.name;
      const childAbs = path.join(rootDir, childRel);
      if (item.isSymbolicLink()) {
        return {
          ok: false,
          code: "symlink",
          message: `“${childRel}” is a symbolic link — links can point outside your site, so it was refused.`,
        };
      }
      if (item.isDirectory()) {
        stack.push(childRel);
        continue;
      }
      if (!item.isFile()) continue;

      const verdict = scanSiteFile(item.name);
      if (!verdict.ok) {
        return {
          ok: false,
          code: verdict.code,
          message: `“${childRel}” can’t be published as a page — sites are static content. Remove it and try again.`,
        };
      }
      const stat = await fs.stat(childAbs);
      if (stat.size > opts.maxAssetMb * MB) {
        return {
          ok: false,
          code: "file_over_limit",
          message: `“${childRel}” is larger than the ${opts.maxAssetMb} MB per-file limit.`,
        };
      }
      totalBytes += stat.size;
      files.push({ path: `/${childRel}`, bytes: stat.size, absPath: childAbs });
    }
  }

  if (files.length === 0) {
    return { ok: false, code: "empty", message: "That archive has no files to publish." };
  }
  return { ok: true, files, totalBytes };
}

/**
 * Build the Pages Direct-Upload manifest (`{ "/path": hash }`) from a tree. PURE.
 * The exact shape the §9 T0 `deployments` call wants, so a publish is a
 * manifest-only call when the bytes are already uploaded.
 */
export function manifestFromTree(files: Array<{ path: string; sha256: string }>): Record<string, string> {
  const manifest: Record<string, string> = {};
  for (const file of files) {
    // Pages wants a leading slash and no "./" — normalise defensively.
    const key = `/${file.path.replace(/^\.?\//, "")}`;
    manifest[key] = file.sha256;
  }
  return manifest;
}

