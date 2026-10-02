import { promises as fs, createWriteStream } from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { prisma } from "../prisma";
import { getAdminSettings } from "../admin-settings";
import { hostingStorageRoot, hostingPublicBase } from "./providers";
import { resolveCapsForUser, type HostingResult } from "./files";
import {
  analyseArchive,
  extractArchive,
  listArchive,
  scanExtractedTree,
} from "./extract";
import { newHostingToken, sha256Hex } from "./rules";
import { deployTree, ensureProject, verifyCredential, type CfCredential, type DeployFile } from "./cloudflare";
import {
  getDefaultHostingCredential,
  getHostingCredentialById,
  markHostingCredentialVerified,
} from "./credentials";

// TASK_155 P3 — the SITES engine (stateful half). This is the §16.1 flow:
//
//   upload (.zip) → extract + analyse → PREVIEW → PUBLISH
//
// Every heavy step runs behind the §16.6 single-slot lock (one heavy job per
// user) and records its load metrics on a HostingJob row, so the LATER
// resource-governor task has real numbers to shape. The PURE zip rules live in
// ./extract.ts; the Cloudflare REST client lives in ./cloudflare.ts; this file is
// the part that needs Postgres + the disk and is live-verified.
//
// The engine is PER-SITE (§16.2): a site is "local" (our metal, free) or
// "cloudflare" (premium Pages), and the account a site was built on is immutable.

export interface HostingSiteView {
  id: string;
  name: string;
  engine: string;
  credentialId: string | null;
  status: string;
  previewToken: string;
  liveToken: string | null;
  liveUrl: string | null;
  previewUrl: string | null;
  createdAt: string;
}

type SiteRow = {
  id: string;
  name: string;
  engine: string;
  credentialId: string | null;
  status: string;
  previewToken: string;
  liveToken: string | null;
  liveUrl: string | null;
  previewUrl: string | null;
  createdAt: Date;
};

export function toSiteView(row: SiteRow): HostingSiteView {
  return {
    id: row.id,
    name: row.name,
    engine: row.engine,
    credentialId: row.credentialId,
    status: row.status,
    previewToken: row.previewToken,
    liveToken: row.liveToken,
    liveUrl: row.liveUrl,
    previewUrl: row.previewUrl,
    createdAt: row.createdAt.toISOString(),
  };
}

/** A Cloudflare project name must be a lowercase slug — derive it from the label. */
export function slugifyProject(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
  return base || "site";
}

function siteDir(userId: string, siteId: string): string {
  return path.join(hostingStorageRoot(), "sites", userId, siteId);
}
function revisionDir(userId: string, siteId: string, revisionId: string): string {
  return path.join(siteDir(userId, siteId), revisionId);
}
export function incomingDir(): string {
  return path.join(hostingStorageRoot(), "sites", "_incoming");
}

/** A single path segment safe to place under the storage root. */
function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "x";
}

/**
 * Stream an uploaded archive to a PRIVATE incoming file (never into the deploy
 * dir). The declared size is refused up front, and the streamed size is metered
 * and refused mid-flight, so an oversize or lying upload cannot fill the disk.
 * Returns the on-disk path + the bytes actually written; the caller passes the
 * path to createRevisionFromArchive, which always removes it.
 */
export async function writeIncomingArchive(
  userId: string,
  body: ReadableStream<Uint8Array>,
  opts: { maxBytes: number; declaredBytes: number }
): Promise<HostingResult<{ archivePath: string; bytes: number }>> {
  if (opts.declaredBytes > opts.maxBytes) {
    return {
      ok: false,
      status: 400,
      code: "archive_too_large",
      message: `That archive is larger than the ${Math.round(opts.maxBytes / (1024 * 1024))} MB limit.`,
    };
  }

  const dir = path.join(incomingDir(), safeSegment(userId));
  await fs.mkdir(dir, { recursive: true });
  const archivePath = path.join(dir, `${newHostingToken()}.zip`);
  const partPath = `${archivePath}.part`;

  let bytes = 0;
  let overflow = false;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytes += chunk.length;
      if (bytes > opts.maxBytes) {
        overflow = true;
        cb(new Error("archive_too_large"));
        return;
      }
      cb(null, chunk);
    },
  });

  try {
    await pipeline(
      Readable.fromWeb(body as unknown as Parameters<typeof Readable.fromWeb>[0]),
      meter,
      createWriteStream(partPath)
    );
    await fs.rename(partPath, archivePath);
  } catch {
    await fs.rm(partPath, { force: true }).catch(() => {});
    if (overflow) {
      return {
        ok: false,
        status: 400,
        code: "archive_too_large",
        message: `That archive is larger than the ${Math.round(opts.maxBytes / (1024 * 1024))} MB limit.`,
      };
    }
    return { ok: false, status: 400, code: "upload_failed", message: "The upload could not be saved. Try again." };
  }

  return { ok: true, value: { archivePath, bytes } };
}

export async function listSites(userId: string): Promise<HostingSiteView[]> {
  const rows = await prisma.hostingSite.findMany({ where: { userId }, orderBy: { createdAt: "desc" } });
  return rows.map(toSiteView);
}

export async function getSite(userId: string, id: string): Promise<HostingSiteView | null> {
  const row = await prisma.hostingSite.findFirst({ where: { id, userId } });
  return row ? toSiteView(row) : null;
}

export interface CreateSiteInput {
  userId: string;
  name: string;
  /** "local" | "cloudflare"; anything else is coerced to "local". */
  engine?: string;
  credentialId?: string | null;
}

/**
 * Create a site. The engine is chosen HERE (per-item, §16.2) and bound for the
 * site's life. A premium site resolves a credential now (the named one, else the
 * user's default, else the platform account) and refuses if the token is dead —
 * fail CLOSED, never a silent fallback (§16.4).
 */
export async function createSite(input: CreateSiteInput): Promise<HostingResult<HostingSiteView>> {
  const { caps } = await resolveCapsForUser(input.userId);
  if (!caps.enabled) {
    return { ok: false, status: 403, code: "disabled", message: "Hosting is not enabled on this account yet." };
  }

  const name = input.name.trim();
  if (!name) return { ok: false, status: 400, code: "invalid_name", message: "Give your site a name." };

  const engine = input.engine === "cloudflare" ? "cloudflare" : "local";

  const count = await prisma.hostingSite.count({ where: { userId: input.userId } });
  if (count >= caps.premiumMaxProjects) {
    return {
      ok: false,
      status: 403,
      code: "quota_projects",
      message: `You’ve reached your limit of ${caps.premiumMaxProjects} sites. Delete one to create another.`,
    };
  }

  const previewToken = newHostingToken();
  const cfProject = engine === "cloudflare" ? slugifyProject(name) : null;

  const row = await prisma.hostingSite.create({
    data: {
      userId: input.userId,
      name,
      engine,
      credentialId: input.credentialId ?? null,
      previewToken,
      cfProject,
      status: "draft",
      previewUrl: `${hostingPublicBase()}/pv/${previewToken}/`,
    },
  });
  return { ok: true, value: toSiteView(row) };
}

/** Delete a site and wipe its extracted trees. Only the owner's own site. */
export async function deleteSite(userId: string, id: string): Promise<HostingResult<{ id: string }>> {
  const row = await prisma.hostingSite.findFirst({ where: { id, userId } });
  if (!row) return { ok: false, status: 404, code: "not_found", message: "Site not found." };

  await prisma.$transaction([
    prisma.hostingRevision.deleteMany({ where: { siteId: row.id } }),
    prisma.hostingJob.deleteMany({ where: { siteId: row.id } }),
    prisma.hostingSite.delete({ where: { id: row.id } }),
  ]);
  await fs.rm(siteDir(userId, row.id), { recursive: true, force: true }).catch(() => {});
  return { ok: true, value: { id: row.id } };
}

// ---------------------------------------------------------------------------
// The §16.6 single-slot heavy-job lock. At most `maxHeavyJobsPerUser` (default 1)
// "running" rows per user, so a zip extract and a deploy never run at once for
// one tenant. Every job records its load metrics for the later governor task.
// ---------------------------------------------------------------------------

interface HeavyJobHandle {
  jobId: string;
}

async function acquireHeavyJob(
  userId: string,
  siteId: string | null,
  kind: string,
  maxConcurrent: number
): Promise<HostingResult<HeavyJobHandle>> {
  const running = await prisma.hostingJob.count({ where: { userId, status: "running" } });
  if (running >= maxConcurrent) {
    return {
      ok: false,
      status: 429,
      code: "busy",
      message: "Another hosting job is already running on your account. Wait for it to finish and try again.",
    };
  }
  const job = await prisma.hostingJob.create({ data: { userId, siteId, kind, status: "running" } });
  return { ok: true, value: { jobId: job.id } };
}

async function finishHeavyJob(
  jobId: string,
  metrics: { status: "done" | "failed"; bytesProcessed?: number; entries?: number; durationMs?: number; peakRssMb?: number; error?: string }
): Promise<void> {
  await prisma.hostingJob
    .update({
      where: { id: jobId },
      data: {
        status: metrics.status,
        bytesProcessed: BigInt(metrics.bytesProcessed ?? 0),
        entries: metrics.entries ?? 0,
        durationMs: metrics.durationMs ?? 0,
        peakRssMb: metrics.peakRssMb ?? 0,
        error: metrics.error,
        finishedAt: new Date(),
      },
    })
    .catch(() => {});
}

// ---------------------------------------------------------------------------
// The revision pipeline: upload → extract + analyse → PREVIEW.
// ---------------------------------------------------------------------------

export interface RevisionView {
  id: string;
  state: string;
  fileCount: number;
  bytes: number;
  previewToken: string;
  previewUrl: string | null;
  cfUrl: string | null;
  rejection: string | null;
  createdAt: string;
}

type RevisionRow = {
  id: string;
  state: string;
  fileCount: number;
  bytes: bigint;
  previewToken: string;
  cfUrl: string | null;
  rejection: string | null;
  createdAt: Date;
};

export function toRevisionView(row: RevisionRow, previewUrl: string | null): RevisionView {
  return {
    id: row.id,
    state: row.state,
    fileCount: row.fileCount,
    bytes: Number(row.bytes),
    previewToken: row.previewToken,
    previewUrl,
    cfUrl: row.cfUrl,
    rejection: row.rejection,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Build the lazy-read DeployFile list from an extracted tree. */
function treeDeployFiles(files: Array<{ path: string; absPath: string }>): DeployFile[] {
  return files.map((f) => ({
    path: f.path,
    filename: f.path.split("/").pop() ?? "index.html",
    read: () => fs.readFile(f.absPath),
  }));
}

/** Count a user's deploys (preview + publish) in the last 24h. */
async function deploysInLastDay(userId: string): Promise<number> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return prisma.hostingJob.count({ where: { userId, kind: "deploy", startedAt: { gte: since } } });
}

export interface CreateRevisionInput {
  userId: string;
  siteId: string;
  /** Absolute path of the already-streamed .zip (in incomingDir()). */
  archivePath: string;
  archiveName: string;
  archiveBytes: number;
}

export async function createRevisionFromArchive(
  input: CreateRevisionInput
): Promise<HostingResult<RevisionView>> {
  const { caps } = await resolveCapsForUser(input.userId);
  if (!caps.enabled) {
    await fs.rm(input.archivePath, { force: true }).catch(() => {});
    return { ok: false, status: 403, code: "disabled", message: "Hosting is not enabled on this account yet." };
  }

  const site = await prisma.hostingSite.findFirst({ where: { id: input.siteId, userId: input.userId } });
  if (!site) {
    await fs.rm(input.archivePath, { force: true }).catch(() => {});
    return { ok: false, status: 404, code: "not_found", message: "Site not found." };
  }

  // Archive ceiling — refuse an oversize zip before touching it (§16.1).
  if (input.archiveBytes > caps.maxZipMb * 1024 * 1024) {
    await fs.rm(input.archivePath, { force: true }).catch(() => {});
    return {
      ok: false,
      status: 400,
      code: "archive_too_large",
      message: `That archive is larger than the ${caps.maxZipMb} MB limit.`,
    };
  }

  // The §16.6 single-slot lock — one heavy job per user.
  const lock = await acquireHeavyJob(input.userId, site.id, "extract", caps.maxHeavyJobsPerUser);
  if (!lock.ok) {
    await fs.rm(input.archivePath, { force: true }).catch(() => {});
    return lock;
  }
  const jobId = lock.value.jobId;
  const startedAt = Date.now();

  const revisionId = newHostingToken();
  const destDir = revisionDir(input.userId, site.id, revisionId);

  try {
    // 1. List, then analyse — refuse by name before extracting (zero partial state).
    const entries = await listArchive(input.archivePath);
    const verdict = analyseArchive(entries, { maxEntries: caps.maxZipEntries, maxAssetMb: caps.pagesMaxAssetMb });
    if (!verdict.ok) {
      await fs.rm(input.archivePath, { force: true }).catch(() => {});
      await finishHeavyJob(jobId, { status: "failed", entries: entries.length, durationMs: Date.now() - startedAt, error: verdict.message });
      return { ok: false, status: 400, code: verdict.code, message: verdict.message };
    }

    // 2. Extract into the staging dir (outside the deploy dir), then scan the tree.
    const extracted = await extractArchive(input.archivePath, destDir);
    const tree = await scanExtractedTree(destDir, { maxAssetMb: caps.pagesMaxAssetMb });
    if (!tree.ok) {
      await fs.rm(destDir, { recursive: true, force: true }).catch(() => {});
      await finishHeavyJob(jobId, { status: "failed", entries: extracted.entries, durationMs: Date.now() - startedAt, error: tree.message });
      return { ok: false, status: 400, code: tree.code, message: tree.message };
    }

    // 3. Quota: the extracted set counts against the storage quota (§16.1).
    const usage = await prisma.hostingRevision.aggregate({
      where: { userId: input.userId, state: { in: ["extracted", "previewed", "published"] } },
      _sum: { bytes: true },
    });
    const usedBytes = Number(usage._sum.bytes ?? 0);
    if (usedBytes + tree.totalBytes > caps.storageQuotaMb * 1024 * 1024) {
      await fs.rm(destDir, { recursive: true, force: true }).catch(() => {});
      await finishHeavyJob(jobId, { status: "failed", durationMs: Date.now() - startedAt, error: "over quota" });
      return {
        ok: false,
        status: 403,
        code: "quota_storage",
        message: `This site would exceed your ${caps.storageQuotaMb} MB storage limit. Delete an old site or upgrade.`,
      };
    }

    // 4. Hash the tree (one file at a time) for the manifest.
    const manifest: Record<string, string> = {};
    for (const file of tree.files) {
      const content = await fs.readFile(file.absPath);
      manifest[file.path] = sha256Hex(new Uint8Array(content));
    }

    const previewToken = newHostingToken();
    const expiresAt = new Date(Date.now() + caps.previewTtlHours * 60 * 60 * 1000);

    const revision = await prisma.hostingRevision.create({
      data: {
        id: revisionId,
        siteId: site.id,
        userId: input.userId,
        state: "extracted",
        archiveName: input.archiveName,
        archiveBytes: input.archiveBytes,
        fileCount: tree.files.length,
        bytes: BigInt(tree.totalBytes),
        manifest,
        storagePath: destDir,
        previewToken,
        expiresAt,
        entries: extracted.entries,
        durationMs: Date.now() - startedAt,
      },
    });

    // 5. PREVIEW deploy (§16.1 state 3).
    const preview = await deployRevision(site, revision, tree.files, "preview");
    await finishHeavyJob(jobId, {
      status: "done",
      bytesProcessed: input.archiveBytes,
      entries: extracted.entries,
      durationMs: Date.now() - startedAt,
    });
    await fs.rm(input.archivePath, { force: true }).catch(() => {});

    if (!preview.ok) return preview;
    return { ok: true, value: preview.value };
  } catch (err) {
    await fs.rm(destDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(input.archivePath, { force: true }).catch(() => {});
    const message = err instanceof Error ? err.message : "The archive could not be processed.";
    await finishHeavyJob(jobId, { status: "failed", durationMs: Date.now() - startedAt, error: message });
    return { ok: false, status: 400, code: "extract_failed", message };
  }
}

// ---------------------------------------------------------------------------
// The deploy step (preview + publish share it). For the LOCAL engine a "deploy"
// is purely our own bookkeeping — the extracted tree is already on our disk, so
// the preview/live URL is a stable /pv|/hs/<token>/ path and nothing leaves the
// box. For the CLOUDFLARE engine it is the four-call Direct-Upload deploy.
// ---------------------------------------------------------------------------

type SiteRecord = {
  id: string;
  userId: string;
  name: string;
  engine: string;
  credentialId: string | null;
  cfProject: string | null;
  previewToken: string;
  liveToken: string | null;
};

type RevisionRecord = {
  id: string;
  userId: string;
  siteId: string;
  storagePath: string | null;
  previewToken: string;
};

async function resolveDeployCredential(
  userId: string,
  credentialId: string | null
): Promise<HostingResult<CfCredential & { credentialId: string }>> {
  // A named credential is honoured; otherwise the user's default; otherwise the
  // platform account (env). A dead token fails CLOSED — never a silent fallback.
  const cred = credentialId
    ? await getHostingCredentialById(userId, credentialId)
    : await getDefaultHostingCredential(userId);
  if (!cred) {
    return {
      ok: false,
      status: 400,
      code: "no_credential",
      message: "Add a Cloudflare account in the Hosting tab before deploying to Cloudflare.",
    };
  }

  // §16.4 "re-verify on use": confirm the token still works before we hand it to a
  // deploy. A dead token marks the row red and fails CLOSED with plain language —
  // it never silently falls back to the platform account.
  const verdict = await verifyCredential({ accountId: cred.accountId, token: cred.token });
  if (!verdict.ok) {
    await markHostingCredentialVerified(userId, cred.id, verdict.error ?? "That API token could not be verified.");
    return {
      ok: false,
      status: 403,
      code: "credential_invalid",
      message: verdict.error ?? "That Cloudflare account could not be verified. Check the account in the Hosting tab.",
    };
  }
  await markHostingCredentialVerified(userId, cred.id, null);
  return { ok: true, value: { accountId: cred.accountId, token: cred.token, credentialId: cred.id } };
}

async function deployRevision(
  site: SiteRecord,
  revision: RevisionRecord,
  files: Array<{ path: string; absPath: string }>,
  mode: "preview" | "publish"
): Promise<HostingResult<RevisionView>> {
  const { caps } = await resolveCapsForUser(site.userId);

  // The deploy-per-day dial counts BOTH a preview and a publish (§16.3).
  if (mode === "publish") {
    const used = await deploysInLastDay(site.userId);
    if (used >= caps.premiumDeploymentsPerDay) {
      return {
        ok: false,
        status: 429,
        code: "quota_deploys",
        message: `You’ve reached ${caps.premiumDeploymentsPerDay} deploys today. Try again tomorrow.`,
      };
    }
  }

  const now = new Date();

  if (site.engine !== "cloudflare") {
    // LOCAL — no network. Preview is /pv/<token>/; publish mints a stable /hs/<token>/.
    if (mode === "preview") {
      const previewUrl = `${hostingPublicBase()}/pv/${revision.previewToken}/`;
      const updated = await prisma.hostingRevision.update({
        where: { id: revision.id },
        data: { state: "previewed" },
      });
      await prisma.hostingSite.update({ where: { id: site.id }, data: { status: "previewed", previewUrl } });
      return { ok: true, value: toRevisionView(updated, previewUrl) };
    }
    const liveToken = site.liveToken ?? newHostingToken();
    const liveUrl = `${hostingPublicBase()}/hs/${liveToken}/`;
    const updated = await prisma.hostingRevision.update({
      where: { id: revision.id },
      data: { state: "published", publishedAt: now },
    });
    await prisma.hostingSite.update({
      where: { id: site.id },
      data: { status: "published", liveToken, liveUrl },
    });
    await prunePublishedRevisions(site.id, caps.publishedRevisionsKept);
    return { ok: true, value: toRevisionView(updated, liveUrl) };
  }

  // CLOUDFLARE — the four-call Direct-Upload deploy.
  const credRes = await resolveDeployCredential(site.userId, site.credentialId);
  if (!credRes.ok) return credRes;
  const project = site.cfProject ?? slugifyProject(site.name);
  const ensured = await ensureProject(credRes.value, project);
  if (!ensured.ok) {
    return { ok: false, status: 502, code: "cf_project", message: ensured.error ?? "Cloudflare rejected the project." };
  }
  const branch = mode === "publish" ? "main" : `preview-${revision.id}`;
  const deployed = await deployTree(credRes.value, project, treeDeployFiles(files), branch);
  if (!deployed.ok || !deployed.value) {
    return { ok: false, status: 502, code: "cf_deploy", message: deployed.error ?? "Cloudflare rejected the deploy." };
  }
  const dv = deployed.value;

  if (mode === "preview") {
    const updated = await prisma.hostingRevision.update({
      where: { id: revision.id },
      data: { state: "previewed", cfUrl: dv.url, cfDeploymentId: dv.deploymentId },
    });
    await prisma.hostingSite.update({
      where: { id: site.id },
      data: { status: "previewed", previewUrl: dv.url },
    });
    return { ok: true, value: toRevisionView(updated, dv.url) };
  }

  const updated = await prisma.hostingRevision.update({
    where: { id: revision.id },
    data: {
      state: "published",
      publishedAt: now,
      cfUrl: dv.url,
      cfDeploymentId: dv.deploymentId,
    },
  });
  await prisma.hostingSite.update({
    where: { id: site.id },
    data: { status: "published", liveUrl: dv.url },
  });
  await prunePublishedRevisions(site.id, caps.publishedRevisionsKept);
  return { ok: true, value: toRevisionView(updated, dv.url) };
}

/**
 * Keep only the last `keep` PUBLISHED revisions (§16.1). The site's current live
 * revision is always the newest published one, so expiring older ones never breaks
 * a live link — it just frees their bytes and makes "undo my last publish" cheap.
 */
async function prunePublishedRevisions(siteId: string, keep: number): Promise<void> {
  const published = await prisma.hostingRevision.findMany({
    where: { siteId, state: "published" },
    orderBy: { publishedAt: "desc" },
  });
  const stale = published.slice(Math.max(1, keep));
  for (const rev of stale) {
    await prisma.hostingRevision.update({ where: { id: rev.id }, data: { state: "expired" } }).catch(() => {});
    if (rev.storagePath) await fs.rm(rev.storagePath, { recursive: true, force: true }).catch(() => {});
  }
}

export async function listRevisions(userId: string, siteId: string): Promise<RevisionView[]> {
  const site = await prisma.hostingSite.findFirst({ where: { id: siteId, userId } });
  if (!site) return [];
  const rows = await prisma.hostingRevision.findMany({
    where: { siteId, state: { in: ["previewed", "published"] } },
    orderBy: { createdAt: "desc" },
  });
  return rows.map((row) =>
    toRevisionView(
      row,
      row.cfUrl ?? (site.engine === "cloudflare" ? null : `${hostingPublicBase()}/pv/${row.previewToken}/`)
    )
  );
}

export interface PublishInput {
  userId: string;
  siteId: string;
  revisionId: string;
}

/** §16.1 state 4 — publish a previewed revision to the live URL. */
export async function publishRevision(input: PublishInput): Promise<HostingResult<RevisionView>> {
  const { caps } = await resolveCapsForUser(input.userId);
  if (!caps.enabled) {
    return { ok: false, status: 403, code: "disabled", message: "Hosting is not enabled on this account yet." };
  }
  const site = await prisma.hostingSite.findFirst({ where: { id: input.siteId, userId: input.userId } });
  if (!site) return { ok: false, status: 404, code: "not_found", message: "Site not found." };

  const revision = await prisma.hostingRevision.findFirst({
    where: { id: input.revisionId, siteId: site.id, userId: input.userId },
  });
  if (!revision) return { ok: false, status: 404, code: "not_found", message: "Revision not found." };
  if (revision.state !== "previewed") {
    return { ok: false, status: 409, code: "not_previewed", message: "That revision isn’t ready to publish." };
  }

  const lock = await acquireHeavyJob(input.userId, site.id, "deploy", caps.maxHeavyJobsPerUser);
  if (!lock.ok) return lock;
  const startedAt = Date.now();

  try {
    let files: Array<{ path: string; absPath: string }> = [];
    if (site.engine !== "cloudflare" && revision.storagePath) {
      const tree = await scanExtractedTree(revision.storagePath, { maxAssetMb: caps.pagesMaxAssetMb });
      if (tree.ok) files = tree.files;
    }
    const result = await deployRevision(site, revision, files, "publish");
    await finishHeavyJob(lock.value.jobId, {
      status: result.ok ? "done" : "failed",
      durationMs: Date.now() - startedAt,
      error: result.ok ? undefined : result.message,
    });
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Publish failed.";
    await finishHeavyJob(lock.value.jobId, { status: "failed", durationMs: Date.now() - startedAt, error: message });
    return { ok: false, status: 502, code: "publish_failed", message };
  }
}

// ---------------------------------------------------------------------------
// Serving the LOCAL engine's preview/live trees. The CLOUDFLARE engine's URLs are
// served by Cloudflare itself, so these resolvers only ever serve our own metal.
// ---------------------------------------------------------------------------

/**
 * Resolve a public /pv/<token>/<path> (preview) or /hs/<token>/<path> (live) to a
 * file on disk. Enforces the master switch, the site's engine (cloudflare sites
 * are never served here), the preview TTL, and — critically — that the requested
 * path cannot escape the revision's staging dir (a second zip-slip guard at SERVE
 * time, independent of the extract-time check).
 */
export async function resolveSiteServe(
  kind: "pv" | "hs",
  token: string,
  relPath: string
): Promise<HostingResult<{ absPath: string }>> {
  const settings = await getAdminSettings();
  if (!settings.hostingEnabled) {
    return { ok: false, status: 404, code: "not_found", message: "Not found." };
  }

  let storagePath: string | null = null;

  if (kind === "pv") {
    const revision = await prisma.hostingRevision.findFirst({ where: { previewToken: token } });
    if (!revision) return { ok: false, status: 404, code: "not_found", message: "Not found." };
    const site = await prisma.hostingSite.findFirst({ where: { id: revision.siteId } });
    if (!site || site.engine === "cloudflare") {
      return { ok: false, status: 404, code: "not_found", message: "Not found." };
    }
    if (revision.state !== "previewed" && revision.state !== "published") {
      return { ok: false, status: 404, code: "not_found", message: "Not found." };
    }
    // An unpublished preview past its TTL is gone (§16.1); a published revision lives on.
    if (revision.state === "previewed" && revision.expiresAt && revision.expiresAt.getTime() <= Date.now()) {
      return { ok: false, status: 404, code: "expired", message: "This preview has expired." };
    }
    storagePath = revision.storagePath;
  } else {
    const site = await prisma.hostingSite.findFirst({ where: { liveToken: token } });
    if (!site || site.engine === "cloudflare") {
      return { ok: false, status: 404, code: "not_found", message: "Not found." };
    }
    const revision = await prisma.hostingRevision.findFirst({
      where: { siteId: site.id, state: "published" },
      orderBy: { publishedAt: "desc" },
    });
    if (!revision) return { ok: false, status: 404, code: "not_found", message: "Not found." };
    storagePath = revision.storagePath;
  }

  if (!storagePath) return { ok: false, status: 404, code: "not_found", message: "Not found." };

  const root = path.resolve(storagePath);
  const clean = relPath.replace(/^\/+/, "");
  if (clean.split("/").some((seg) => seg === "..")) {
    return { ok: false, status: 404, code: "not_found", message: "Not found." };
  }
  let target = path.resolve(root, clean || "index.html");
  if (target !== root && !target.startsWith(root + path.sep)) {
    return { ok: false, status: 404, code: "not_found", message: "Not found." };
  }

  // A directory (or the root) serves its index.html, like a static host.
  try {
    const stat = await fs.stat(target);
    if (stat.isDirectory()) target = path.join(target, "index.html");
  } catch {
    // Fall through — the read below decides.
  }

  return { ok: true, value: { absPath: target } };
}







