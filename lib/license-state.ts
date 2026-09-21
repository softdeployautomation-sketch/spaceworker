import "server-only";

import { mkdir, readFile, writeFile } from "fs/promises";
import { homedir } from "os";
import path from "path";

import { getMachineId } from "./machine-id";

// Local, per-machine persistence for the EXE's licensing gate. Holds (a) when
// the 24-hour unlicensed trial started, and (b) once the user activates — which
// license key + email are bound to THIS machine. This is the "same tier of
// tamper-resistance as the rest of the scheme": a determined user can edit the
// file and reset the timer, an accepted, known limitation of client-side-only
// licensing (Part A), not something to over-engineer around.

export const TRIAL_HOURS = 24;

export interface ExeLicenseActivation {
  /** Email the buyer entered at activation (checked against `licensee`). */
  licensee: string;
  /** The signed license key. */
  licenseKey: string;
  /** Hardware ID this license was first activated on. */
  machineId: string;
  /** ISO (UTC) timestamp of activation. */
  activatedAt: string;
}

export interface ExeLicenseLocalState {
  version: 1;
  /** ISO (UTC) timestamp of first launch (trial start). Absent pre-first-run. */
  trialStartedAt?: string;
  /** The email the user entered at trial-start (Task 58 — required before a NEW
   *  trial can begin; no more anonymous first launch). Stored here so a returning
   *  user's later pings carry the same identity, and so the admin trial view can
   *  attribute a device to a real person. */
  email?: string;
  /** Present once the user has activated a valid key on this machine. */
  activation?: ExeLicenseActivation;
  /** Fixed 2026-09-21 — see getCachedMachineId() below for why this exists. */
  cachedMachineId?: string;
}

const DEFAULT_STATE: ExeLicenseLocalState = { version: 1 };

/**
 * Resolves where this machine's license state lives. Honours an explicit
 * SPACEWORKER_LOCAL_DATA_DIR override (the Tauri shell can point at its own
 * app-data dir), otherwise falls back to a per-OS app-data location.
 */
export function licenseStatePath(): string {
  const override = process.env.SPACEWORKER_LOCAL_DATA_DIR;
  if (override) return path.join(override, "exe-license-state.json");

  const sys = process.platform; // win32 | darwin | linux | ...
  try {
    if (sys === "win32") {
      return path.join(
        process.env.APPDATA ?? path.join(homedir(), "AppData", "Roaming"),
        "SpaceWorkerOS",
        "exe-license-state.json",
      );
    }
    if (sys === "darwin") {
      return path.join(
        homedir(),
        "Library",
        "Application Support",
        "SpaceWorkerOS",
        "exe-license-state.json",
      );
    }
    const dataHome = process.env.XDG_DATA_HOME ?? path.join(homedir(), ".local", "share");
    return path.join(dataHome, "spaceworker-os", "exe-license-state.json");
  } catch {
    return path.join(process.env.TMPDIR ?? "/tmp", "spaceworker-os", "exe-license-state.json");
  }
}

/** Reads the local state, returning defaults (never throwing) if absent/corrupt. */
export async function readLocalState(): Promise<ExeLicenseLocalState> {
  try {
    const raw = await readFile(licenseStatePath(), "utf8");
    const parsed = JSON.parse(raw) as ExeLicenseLocalState;
    if (parsed && typeof parsed === "object" && parsed.version === 1) return parsed;
  } catch {
    // missing file / bad JSON → defaults
  }
  return { ...DEFAULT_STATE };
}

async function writeLocalState(state: ExeLicenseLocalState): Promise<void> {
  const filePath = licenseStatePath();
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(state, null, 2), "utf8");
}

/**
 * Fixed 2026-09-21 (found live: the same physical device produced TWO
 * different machineId values ~2h apart — a bound license on one id, a fresh
 * trial-session ping on another, same hostname). getMachineId()
 * (lib/machine-id.ts) recomputes from live hardware queries (wmic/PowerShell
 * on Windows) on EVERY single call — status/route.ts alone calls it on
 * essentially every app launch/poll. If either underlying command
 * intermittently fails or times out (WMI queries are known to be less
 * reliable under a Remote Desktop session than an interactive console
 * session — the owner's own report was specifically about RDP users), the
 * resulting hash differs even though it's the same machine, silently
 * fragmenting one device's identity across license binding / trial tracking
 * / the admin views that key off it.
 *
 * Fix: compute once, cache in the SAME local state file every other
 * licensing fact already lives in, and reuse forever after — a transient
 * hardware-query hiccup on a LATER call can never change an already-settled
 * identity. Every getMachineId() call site should go through this instead of
 * calling it directly (machine-id.ts itself stays pure/hardware-only,
 * unaware of caching — this file already owns local file I/O).
 */
export async function getCachedMachineId(): Promise<string> {
  const state = await readLocalState();
  if (state.cachedMachineId) return state.cachedMachineId;
  const fresh = (await getMachineId()).toLowerCase();
  await writeLocalState({ ...state, cachedMachineId: fresh });
  return fresh;
}

/**
 * Starts the 24h trial on first launch. No-op (and idempotent) once started —
 * the first launch time is persisted, never reset by re-opening the app.
 */
export async function startTrialIfNeeded(now?: Date): Promise<ExeLicenseLocalState> {
  const state = await readLocalState();
  if (state.activation) return state; // never start a trial behind a valid license
  if (!state.trialStartedAt) {
    state.trialStartedAt = (now ?? new Date()).toISOString();
    await writeLocalState(state);
  }
  return state;
}

/** Persists the trial's authoritative start time and the bound email. Called
 *  with the server-returned `startedAt` so a returning machine (local file
 *  reinstated/deleted) keeps its TRUE original start, never a fresh 24h. */
export async function writeTrialStart(
  input: { trialStartedAt: string; email?: string },
): Promise<ExeLicenseLocalState> {
  const state = await readLocalState();
  if (input.trialStartedAt) state.trialStartedAt = input.trialStartedAt;
  if (input.email) state.email = input.email;
  await writeLocalState(state);
  return state;
}

/** True while the (started) trial still has time remaining. */
export function trialActive(state: ExeLicenseLocalState, now?: Date): boolean {
  if (!state.trialStartedAt) return false;
  const started = new Date(state.trialStartedAt);
  const current = now ?? new Date();
  return current.getTime() - started.getTime() < TRIAL_HOURS * 60 * 60 * 1000;
}

/** Hours of trial remaining (positive while active). */
export function trialHoursLeft(state: ExeLicenseLocalState, now?: Date): number {
  if (!state.trialStartedAt) return 0;
  const started = new Date(state.trialStartedAt);
  const current = now ?? new Date();
  return Math.max(0, TRIAL_HOURS * 60 * 60 * 1000 - (current.getTime() - started.getTime())) /
    (60 * 60 * 1000);
}

/** Binds an activated license to this machine and persists it. */
export async function saveActivation(
  input: { licensee: string; licenseKey: string; machineId: string },
  now?: Date,
): Promise<ExeLicenseLocalState> {
  const state = await readLocalState();
  state.activation = {
    licensee: input.licensee,
    licenseKey: input.licenseKey,
    machineId: input.machineId,
    activatedAt: (now ?? new Date()).toISOString(),
  };
  await writeLocalState(state);
  return state;
}

/** Removes any stored activation (e.g. a license that expired). */
export async function clearActivation(): Promise<ExeLicenseLocalState> {
  const state = await readLocalState();
  delete state.activation;
  await writeLocalState(state);
  return state;
}