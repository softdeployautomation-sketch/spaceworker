import { NextResponse } from "next/server";
import { hostname } from "os";

import { exeLicenseSecret } from "@/lib/exe-license";
import { validateLicenseKey } from "@/lib/exe-license-validator";
import { isLocalExeRuntime, HOSTED_APP_URL } from "@/lib/exe-runtime";
import { exeBuildTarget } from "@/lib/exe-build-target";
import { getMachineId, validateMachineId } from "@/lib/machine-id";
import {
  readLocalState,
  writeTrialStart,
  trialActive,
  trialHoursLeft,
  TRIAL_HOURS,
} from "@/lib/license-state";

// Owner-requested 2026-09-20: "a subtab showing every free users device
// active for that 24hrs". Kept fire-and-forget for the already-started case —
// never awaited by the caller, never allowed to affect the trial gate this
// route exists to answer. (A brand-new machine never reaches this helper: it
// has no local trialStartedAt yet and is sent to the required trial-start flow
// instead, which itself awaits the server BEFORE persisting anything.) Best-
// effort hostname for the admin subtab's display only, never a security
// boundary (matches every other machineLabel in this codebase).
function pingTrialStatus(machineId: string, trialStartedAt: string): void {
  void fetch(`${HOSTED_APP_URL}/api/exe-license/trial-ping`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      machineId,
      product: `${exeBuildTarget()}_exe`,
      trialStartedAt,
      machineLabel: (() => {
        try {
          return hostname();
        } catch {
          return undefined;
        }
      })(),
    }),
    signal: AbortSignal.timeout(8_000),
  }).catch(() => {
    // Best-effort only — a failed ping must never surface to the trial gate.
  });
}

/**
 * Task 58 — asks the hosted app whether this (machineId, product) already has a
 * trial on record, WITHOUT needing an email. Returns the authoritative
 * `startedAt` (ISO) if it does, else null.
 *   - Returning machine (local state file deleted) -> server returns its ORIGINAL
 *     start, so we can restore it and never re-prompt / never grant a fresh 24h.
 *   - Genuinely new machine -> server answers 400 "email required" (a new trial
 *     can't be created without one) -> treat as no record -> caller sends the
 *     machine through the required email-first trial-start flow instead.
 *   - Offline / timeout -> null (can't prove prior existence; the caller degrades
 *     gracefully and the one-time email prompt + local start still works offline).
 */
async function reconcileServerStart(machineId: string): Promise<string | null> {
  try {
    const res = await fetch(`${HOSTED_APP_URL}/api/exe-license/trial-ping`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        machineId,
        product: `${exeBuildTarget()}_exe`,
      }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => ({}));
    return typeof data.startedAt === "string" ? data.startedAt : null;
  } catch {
    return null;
  }
}

// POST /api/exe-license/status — the LOCAL licensing gate status, read from this
// machine's filesystem (no database, no session auth — see lib/exe-runtime.ts
// for why that's safe: SPACEWORKER_LOCAL_EXE gates this to the Tauri-bundled
// local runtime only, fail-closed, never set on the deployed web server). This
// is the same code that runs inside the desktop EXE's bundled local runtime; it
// is only mounted by the EXE shell, never by the hosted web dashboard.
//
// Returns the gate decision the shared <LicenseGate> component renders on:
//   - licensed        -> user has an active, machine-valid key -> show dashboard
//   - inTrial         -> unlicensed but first launch was < 24h ago -> show dashboard
//   - requiresEmail   -> brand-new machine with NO started trial yet -> the gate
//                        shows the one-time email prompt; until the user submits
//                        a valid email to /api/exe-license/trial-start, the app
//                        is NOT usable (Task 58 — no more anonymous first launch)
//   - otherwise       -> trial exhausted -> show the activation gate
export async function POST() {
  if (!isLocalExeRuntime()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const state = await readLocalState();

  // 1. A stored activation wins if the key is still valid on THIS machine.
  if (state.activation) {
    try {
      const secret = exeLicenseSecret();
      const currentMachineId = (await getMachineId()).toLowerCase();
      const validation = await validateLicenseKey(state.activation.licenseKey, secret, {
        currentMachineId,
      });

      if (validation.valid && validateMachineId(state.activation.machineId, currentMachineId)) {
        return NextResponse.json({
          licensed: true,
          licensee: validation.licensee,
          plan: validation.plan,
          expiresAt: validation.expiresAt,
          expiresAtDate: validation.expiresAtDate?.toISOString(),
          licensedAt: state.activation.activatedAt,
        });
      }

      // Stored key failed — distinguish a copied binding from a genuinely dead key.
      const copied = state.activation.machineId.toLowerCase() !== currentMachineId;
      const message = copied
        ? "This license is bound to another computer. Enter a license for this machine, or activate with the key you purchased."
        : validation.error;
      return NextResponse.json({ licensed: false, inTrial: false, message });
    } catch {
      // Signing secret not configured on this machine — cannot validate the key.
      return NextResponse.json(
        { licensed: false, inTrial: false, message: "Licensing is not configured on this device." },
        { status: 500 },
      );
    }
  }

  // 2. No activation yet.
  const now = new Date();
  const currentMachineId = (await getMachineId()).toLowerCase();

  // A machine with NO local trialStartedAt is brand-new (or its local state file
  // was deleted). Task 58: a trial can NO LONGER start silently here, and the
  // clock can no longer be reset by deleting the local file — so before we ever
  // ask the user for an email we first ask the server whether this (machineId,
  // product) ALREADY has a trial on record. If it does (a returning machine whose
  // local file was deleted), we restore its TRUE original startedAt via
  // writeTrialStart and skip the email prompt entirely (the verification for this
  // task requires exactly that). Only a genuinely new machine with no server
  // record falls through to `requiresEmail` — the one-time email-first prompt.
  const serverStart = await reconcileServerStart(currentMachineId);

  if (!state.trialStartedAt && !serverStart) {
    return NextResponse.json({
      licensed: false,
      inTrial: false,
      requiresEmail: true,
    });
  }

  // Prefer the earlier start so the local file alone can never push the trial
  // forward — the earlier of local/server wins (Task 58 Part B spec point 4).
  const effectiveStartedAt =
    !serverStart || (state.trialStartedAt && new Date(state.trialStartedAt) < new Date(serverStart))
      ? state.trialStartedAt
      : serverStart;
  if (!effectiveStartedAt) {
    return NextResponse.json({ licensed: false, inTrial: false, requiresEmail: true });
  }

  // If the authoritative start came from the server (a returning machine whose
  // local file was deleted), persist it so subsequent offline launches also see
  // the TRUE start and never re-prompt (Task 58 verification: "delete local file,
  // relaunch -> prompt does NOT reappear"). No-op when the local start was already
  // the earlier/binding one.
  if (effectiveStartedAt !== state.trialStartedAt) {
    await writeTrialStart({ trialStartedAt: effectiveStartedAt });
  }

  const effectiveState = { ...state, trialStartedAt: effectiveStartedAt };

  if (trialActive(effectiveState, now)) {
    const hoursLeft = trialHoursLeft(effectiveState, now);
    pingTrialStatus(currentMachineId, effectiveStartedAt);
    return NextResponse.json({
      licensed: false,
      inTrial: true,
      trialHoursLeft: hoursLeft,
      trialStartedAt: effectiveStartedAt,
      trialEndsAt: new Date(
        new Date(effectiveStartedAt).getTime() + TRIAL_HOURS * 60 * 60 * 1000,
      ).toISOString(),
    });
  }

  return NextResponse.json({
    licensed: false,
    inTrial: false,
    trialStartedAt: effectiveStartedAt,
  });
}