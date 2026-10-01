import "server-only";

import { db } from "./db";
import { browserRuntime } from "./browser-runtime";
import {
  createProfileDir,
  deleteCloneStateDir,
  deleteProfileDir,
  profileDirPath,
} from "./browser-profiles";
import { stateCacheDirForTarget } from "./clone-state-ingest";
import { connectUrlFor } from "./browser-session-serialize";
import { checkIpThroughProxy } from "./browser-proxy";
import { injectLiveCapture } from "./clone-live-capture";
import { resolveCloneBrowserPin } from "./clone-browser-pin";
import { materializeCloneState } from "./clone-state-restore";

// TASK_118 B8-2 — hosted launch: a clone whose destination is OUR OWN browser
// (Device.deviceKind = "hosted", provisioned by clone-destination.ts), driven
// through browser-server directly. This is a SIBLING to clone-transport.ts's
// agent-RPC launch path (runCloneLaunch), not a replacement of it — a
// workstation destination still goes through the agent. lib/clone.ts's
// stepLaunch/teardownTransport branch on the destination's deviceKind to pick
// one or the other.
//
// WHY THIS NEEDS ITS OWN MODULE, NOT JUST A BRANCH INSIDE runCloneLaunch: the
// hosted path talks to a completely different subsystem (browser-server, over
// localhost HTTP) with a completely different session model (a Neko container
// + a relay-ingress device listener) — there is no agent, no DeviceJob/
// DeviceAction RPC round-trip, and no bundle to capture/transfer/inject
// (route 3, TASK_117: the hosted browser logs in for itself).

export interface HostedLaunchResult {
  ok: boolean;
  egressMode: "relay" | "direct";
  exitCode: number | null;
  error?: string;
  viewUrl?: string;
  egressIp?: string;
  /**
   * TASK_135 — the outcome of the version pin and the state carry, returned so
   * the caller can surface it without re-reading the job. All optional: a
   * caller written against the pre-TASK_135 shape still compiles and behaves
   * exactly as before.
   */
  destinationBrowserVersion?: string | null;
  /** True only when state really landed AND really included tabs. */
  tabsRestored?: boolean;
  /** A named reason the source build or the state could not be carried. */
  browserPinError?: string | null;
  stateRestoreNote?: string | null;
}

/**
 * THE ONE PLACE that decides, before a container exists, which browser the clone
 * runs and whether the user's files may be written into its profile.
 *
 * WHY IT IS ONE FUNCTION AND NOT TWO STEPS. The version pin and the state
 * restore depend on each other in a way that makes the obvious order wrong:
 *
 *   1. install the pinned build  → a refusal means NO pin;
 *   2. materialise the state     → ONLY if step 1 succeeded;
 *   3. launch.
 *
 * Materialising before the build is known would leave the user's history, tabs
 * and bookmarks staged for a browser the launch might then fail to deliver — and
 * the documented fallback (a cookie-only session) would open them with the wrong
 * build, which is the profile corruption the whole pin exists to prevent. So a
 * failed pin means the state is NOT written, and the record says so.
 *
 * The tab flag is derived, never assumed: it is true only when the state really
 * did land AND really did include a session (tab) file, so
 * `--restore-last-session` can never be a claim the files do not support.
 */
async function prepareCloneBrowser(opts: {
  cloneJobId: string;
  job: {
    browser: string;
    /** The work PC the state came from — part of the cache key, so required. */
    sourceDeviceId: string;
    sourceBrowserMajor: number | null;
    sourceBrowserVersion: string | null;
    sourceBrowserLang: string | null;
    /** The last accepted manifest — where the source profile name is recorded. */
    stateManifest: unknown;
    /** The engine profile name (DESIGN's `browserProfileRef`). */
    profileName: string | null;
  };
  osName: string | null;
  profileDir: string;
}): Promise<{
  pinnedBrowser: { fullVersion: string; downloadUrl: string } | null;
  restoreLastSession: boolean;
  userAgent: string | null;
  lang: string | null;
  /** A named refusal, when a pin or the state could not be delivered. */
  pinError: string | null;
  stateNote: string | null;
}> {
  const resolved = await resolveCloneBrowserPin({
    browser: opts.job.browser,
    sourceBrowserMajor: opts.job.sourceBrowserMajor,
    sourceBrowserVersion: opts.job.sourceBrowserVersion,
    sourceBrowserLang: opts.job.sourceBrowserLang,
    osName: opts.osName,
  });

  if (!resolved.ok) {
    // A named refusal plus the way out, exactly as clone-browser-pin documents.
    // The clone still happens — the session half (cookies) does not care which
    // build serves it — but the state half does, so it is skipped entirely.
    return {
      pinnedBrowser: null,
      restoreLastSession: false,
      userAgent: null,
      lang: null,
      pinError: resolved.error,
      stateNote: "state_skipped_no_matching_build",
    };
  }

  const pin = resolved.pin;
  const install = await browserRuntime.ensurePinned({
    fullVersion: pin.fullVersion,
    downloadUrl: pin.downloadUrl,
  });
  if (!install.ok) {
    return {
      pinnedBrowser: null,
      restoreLastSession: false,
      userAgent: null,
      lang: null,
      pinError: install.error,
      stateNote: "state_skipped_no_matching_build",
    };
  }

  // The build is IN HAND, so the profile may now be written. Ownership, modes and
  // the tab nudge are all handled by materializeCloneState; what matters here is
  // that it is called only on this path.
  //
  // THE STATE COMES FROM THE TARGET'S PERSISTENT CACHE, not from a per-job staging
  // directory. The cache is what survives between clones, which is what makes a
  // delta possible at all: a reconnect sends only the files that changed, and the
  // profile is still materialised WHOLE from the cache. A per-job directory would
  // materialise a profile containing only the delta — history and bookmarks gone,
  // which is precisely the failure this feature exists to remove. The ingest route
  // writes to the same directory through the same helper, so writer and reader
  // cannot drift apart.
  const materialized = await materializeCloneState({
    stagingDir: stateCacheDirForTarget({
      deviceId: opts.job.sourceDeviceId,
      browser: opts.job.browser,
      profileName: manifestProfileName(opts.job.stateManifest) ?? opts.job.profileName,
    }),
    profileDir: opts.profileDir,
    // The profile directory name comes from the MANIFEST the device produced —
    // it is the record of which profile the files actually came from — with the
    // job's own `profileName` as the fallback. It is not guessed here:
    // materializeCloneState resolves an absent name to `Default` (correct for a
    // Chromium source) and refuses a name that is not a profile name at all.
    profileName: manifestProfileName(opts.job.stateManifest) ?? opts.job.profileName,
  });

  return {
    pinnedBrowser: { fullVersion: pin.fullVersion, downloadUrl: pin.downloadUrl },
    restoreLastSession: materialized.ok && materialized.tabsStaged,
    userAgent: pin.userAgent,
    lang: pin.lang,
    pinError: null,
    stateNote: materialized.ok ? null : (materialized.error ?? "state_restore_failed"),
  };
}

/**
 * The `profile` field out of a stored state manifest, or null when there isn't
 * one. The manifest is JSON of unknown shape by the time it comes back from the
 * database, so this reads defensively rather than casting and hoping.
 */
function manifestProfileName(manifest: unknown): string | null {
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) return null;
  const profile = (manifest as { profile?: unknown }).profile;
  return typeof profile === "string" ? profile : null;
}


/**
 * Starts a hosted clone session: a fresh per-job Chrome profile (owner's own
 * design — "it automatically creates a browser profile with that device
 * name... so we dont risk leakage"), a browser-server session pointed at
 * either the relay device-listener (relay egress) or nothing (direct — the
 * hosted browser's own IP, premium-gated upstream in requestClone), and a
 * LIVE egress-IP check through whichever path was actually used.
 *
 * Fail-closed, per TASK_118's own explicit requirement ("never silently fall
 * back to our own IP"): relay egress that cannot be proven live is a REFUSAL,
 * not a degraded launch. The pre-check (hasControl) catches an offline device
 * before a container is even started; the post-check (checkIpThroughProxy)
 * catches anything the pre-check couldn't (a control conn that's up but a
 * stream that isn't) and is the actual EVIDENCE recorded as `egressIp` — the
 * record never claims a mode it didn't verify.
 */
export async function runHostedLaunch(opts: {
  userId: string;
  cloneJobId: string;
  sourceDeviceId: string;
  egress: "relay" | "direct";
}): Promise<HostedLaunchResult> {
  const sessionId = opts.cloneJobId;
  const source = await db.device.findUnique({
    where: { id: opts.sourceDeviceId },
    // TASK_135 §4 — osName shapes the clone's user agent, so sites see the work
    // PC's real platform instead of a Linux container.
    select: { id: true, name: true, osName: true },
  });
  if (!source) {
    return { ok: false, egressMode: opts.egress, exitCode: null, error: "source_device_not_found" };
  }

  let proxyServerValue = "";
  if (opts.egress === "relay") {
    // Fail-closed BEFORE starting a container: naming the relay here is the
    // whole point (see the task's own verification bar — "the launch
    // refuses with a reason that names the relay").
    const controlCheck = await browserRuntime.relayControlStatus(source.id);
    const up = controlCheck.ok && (controlCheck.data as { up?: boolean } | undefined)?.up === true;
    if (!up) {
      return {
        ok: false,
        egressMode: "relay",
        exitCode: null,
        error: `relay_offline: ${source.name}'s relay is not currently connected.`,
      };
    }
    const listener = await browserRuntime.openRelayDeviceListener({ deviceKey: source.id, sessionId });
    if (!listener.ok) {
      return { ok: false, egressMode: "relay", exitCode: null, error: `relay_listener_failed: ${listener.error}` };
    }
    const listenerData = listener.data as { port?: number; host?: string } | undefined;
    if (typeof listenerData?.port !== "number" || !listenerData.host) {
      return {
        ok: false,
        egressMode: "relay",
        exitCode: null,
        error: "relay_listener_failed: no port/host returned",
      };
    }
    const { port, host: listenerHost } = listenerData;
    // FIXED 2026-09-25 (real click-through test, ERR_PROXY_CONNECTION_FAILED):
    // Chromium runs INSIDE the Neko container's own network namespace — a
    // value of "127.0.0.1" here (the original, untested version) resolves to
    // the CONTAINER's own loopback, not the host's, so it was silently
    // unreachable despite this module's own host-side egress check (below)
    // passing fine. `listenerHost` is browser-server's own answer for what a
    // container should actually dial (the docker bridge gateway) — never
    // guessed here.
    proxyServerValue = `http://${listenerHost}:${port}`;
    // No close-handle needed here: browser-server's own stopInternal() closes
    // this session's device listener automatically (keyed by sessionId) the
    // moment /sessions/stop is called — see stopHostedLaunch below.
  }
  // Direct egress: proxyServerValue stays "" — browser-runtime.start()'s own
  // contract documents empty as valid ("direct connection, no exit node").
  // The hosted container's own IP is the exit IP in that case, which is
  // exactly what premium/direct is supposed to mean — never mislabelled.

  // TASK_119A A4 — the job is read BEFORE the container starts: a `live` job
  // needs its CDP endpoint to exist from the first launch, so the mode must be
  // known at start time rather than after it. A missing row is a refusal HERE,
  // not a reported success later (V4's own finding).
  //
  // TASK_135 §3 reads the same row for the SOURCE BROWSER identity and for
  // whether any state was ingested, because both decisions have to be made
  // before the container exists.
  const job = await db.cloneJob.findUnique({
    where: { id: opts.cloneJobId },
    select: {
      sessionMode: true,
      browser: true,
      sourceDeviceId: true,
      sourceBrowserMajor: true,
      sourceBrowserVersion: true,
      sourceBrowserLang: true,
      stateSyncMode: true,
      stateManifest: true,
      profileName: true,
    },
  });
  if (!job) {
    return { ok: false, egressMode: opts.egress, exitCode: null, error: "clone_job_not_found" };
  }
  const wantsLive = job.sessionMode === "live";
  const profileDir = profileDirPath(sessionId);

  await createProfileDir(sessionId).catch(() => {
    // createProfileDir doesn't throw on "already exists" (mkdir recursive) —
    // this catch is only reached on a genuine fs error, which the start call
    // below will also hit and report properly. Never silently continue past
    // a real failure here; just don't double-report it.
  });

  // TASK_135 §3/§5 — the version pin and the state restore, resolved as ONE
  // decision before the container exists. See prepareCloneBrowser's own comment
  // for why they cannot be separated.
  const prep = await prepareCloneBrowser({
    cloneJobId: opts.cloneJobId,
    job,
    osName: source.osName ?? null,
    profileDir,
  });

  let started = await browserRuntime.start({
    sessionId,
    userId: opts.userId,
    profileDir,
    proxyServerValue,
    // Every hosted clone is a clone session: `--bwsi` must be off and the
    // container's own password store named (TASK_117's two blockers). Only a
    // `live` job additionally needs the CDP endpoint its injection uses.
    cloneMode: true,
    cdp: wantsLive,
    pinnedBrowser: prep.pinnedBrowser,
    restoreLastSession: prep.restoreLastSession,
    userAgent: prep.userAgent,
    lang: prep.lang,
  });
  let pinError = prep.pinError;
  if (!started.ok && prep.pinnedBrowser && started.error.startsWith("pinned_browser_unavailable")) {
    // The build was installed a moment ago, so this is a cache hit in every
    // normal case — but if the cache became unusable between the two calls, the
    // session must NOT come up with the user's files staged for a browser it is
    // not running. Delete the profile and relaunch WITHOUT the pin: a cookie-only
    // clone on the image's own Chromium is a useful session, while a profile
    // opened by a mismatched build is corruption. The refusal is RECORDED, never
    // swallowed — that is the difference between a documented fallback and the
    // silent one this feature has already been bitten by.
    pinError = started.error;
    await deleteProfileDir(profileDir).catch(() => {});
    await createProfileDir(sessionId).catch(() => {});
    started = await browserRuntime.start({
      sessionId,
      userId: opts.userId,
      profileDir,
      proxyServerValue,
      cloneMode: true,
      cdp: wantsLive,
      userAgent: prep.userAgent,
      lang: prep.lang,
    });
  }
  if (!started.ok) {
    await deleteProfileDir(profileDir).catch(() => {});
    return {
      ok: false,
      egressMode: opts.egress,
      exitCode: null,
      error: `browser_start_failed: ${started.error}`,
    };
  }
  const startedData = started.data as
    | { nekoPassword?: string | null; cdpPort?: number; pinnedBrowserVersion?: string | null; restoreLastSession?: boolean }
    | undefined;
  const nekoPassword = startedData?.nekoPassword ?? null;
  const cdpPort = startedData?.cdpPort;

  // EVIDENCE, not intent: what the runtime reports it actually launched. A job
  // whose source version could not be delivered keeps a NULL here rather than
  // the version we hoped for, so a later "why was my profile mangled?" question
  // has an answer on the record.
  const destinationBrowserVersion = startedData?.pinnedBrowserVersion ?? null;
  const restoreActive = startedData?.restoreLastSession === true;
  if (destinationBrowserVersion) {
    await db.cloneJob
      .update({
        where: { id: opts.cloneJobId },
        data: { destinationBrowserVersion },
      })
      .catch(() => {});
  }

  // Live proof, not an assumption: what IS the exit IP through the path we
  // just built? A relay clone whose egress check fails here is torn down
  // immediately rather than handed to the user half-working.
  let egressIp: string | undefined;
  if (opts.egress === "relay") {
    try {
      // "127.0.0.1" here is correct and deliberate, unlike proxyServerValue
      // above: THIS check runs in THIS Node process, on the HOST — where the
      // listener (bound 0.0.0.0) is reachable via loopback too. Only the
      // CONTAINER needs the bridge-gateway address; this process isn't one.
      const port = Number(proxyServerValue.split(":").pop());
      egressIp = await checkIpThroughProxy({ scheme: "http", host: "127.0.0.1", port });
    } catch (e) {
      await browserRuntime.stop(sessionId).catch(() => {});
      await deleteProfileDir(profileDirPath(sessionId)).catch(() => {});
      return {
        ok: false,
        egressMode: "relay",
        exitCode: null,
        error: `relay_egress_unverified: ${e instanceof Error ? e.message : "unknown"}`,
      };
    }
  }

  // TASK_119 A6: Inject live session if requested.
  // Fail-closed (V4): live mode MUST have CDP endpoint and injection must succeed.
  // The job row itself was read before the container started (a missing row
  // already refused there), which is what lets the CDP endpoint be requested at
  // launch time instead of hoped for afterwards.
  if (wantsLive) {
    // Live mode requires CDP endpoint to exist.
    if (!cdpPort) {
      await browserRuntime.stop(sessionId).catch(() => {});
      await deleteProfileDir(profileDirPath(sessionId)).catch(() => {});
      return {
        ok: false,
        egressMode: opts.egress,
        exitCode: null,
        error: "session_injection_failed: CDP endpoint not available",
      };
    }

    const injectionResult = await injectLiveCapture({
      cloneJobId: opts.cloneJobId,
      cdpPort,
    });
    if (!injectionResult.ok) {
      await browserRuntime.stop(sessionId).catch(() => {});
      await deleteProfileDir(profileDirPath(sessionId)).catch(() => {});
      return {
        ok: false,
        egressMode: opts.egress,
        exitCode: null,
        error: `session_injection_failed: ${injectionResult.error}`,
      };
    }
  }

  // The named refusal (if any) is recorded BEFORE the return, so a launch that
  // fails later still leaves the reason it was running the wrong browser.
  if (pinError || prep.stateNote) {
    await db.cloneJob
      .update({
        where: { id: opts.cloneJobId },
        data: {
          browserPinError: pinError,
          stateRestoreNote: prep.stateNote,
        },
      })
      .catch(() => {});
  }

  return {
    ok: true,
    egressMode: opts.egress,
    exitCode: 0,
    viewUrl: connectUrlFor(sessionId, nekoPassword),
    egressIp,
    destinationBrowserVersion,
    // From the runtime's own report, not from the pin we asked for: the flag is
    // only "true" when a session was really started with the restore flag on.
    tabsRestored: restoreActive,
    browserPinError: pinError,
    stateRestoreNote: prep.stateNote,
  };
}

/** Stops a hosted session and cleans its profile — the hosted-path teardown. */
export async function stopHostedLaunch(cloneJobId: string): Promise<string> {
  const sessionId = cloneJobId;
  try {
    const res = await browserRuntime.stop(sessionId);
    await deleteProfileDir(profileDirPath(sessionId)).catch(() => {});
    // TASK_135 §5 — the staged state goes with it. It is kept for the life of the
    // job (a retried launch must be able to re-materialise the same files) and
    // released here, so a job's inbound history/tabs never outlive the job.
    await deleteCloneStateDir(cloneJobId).catch(() => {});
    return res.ok ? "ok" : `error: ${res.error}`;
  } catch (e) {
    return `error: ${e instanceof Error ? e.message : "unknown"}`;
  }
}
