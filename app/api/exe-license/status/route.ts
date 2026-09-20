import { NextResponse } from "next/server";
import { hostname } from "os";

import { exeLicenseSecret } from "@/lib/exe-license";
import { validateLicenseKey } from "@/lib/exe-license-validator";
import { isLocalExeRuntime, HOSTED_APP_URL } from "@/lib/exe-runtime";
import { exeBuildTarget } from "@/lib/exe-build-target";
import { getMachineId, validateMachineId } from "@/lib/machine-id";
import {
  readLocalState,
  startTrialIfNeeded,
  trialActive,
  trialHoursLeft,
  TRIAL_HOURS,
} from "@/lib/license-state";

// Owner-requested 2026-09-20: "a subtab showing every free users device
// active for that 24hrs". Fire-and-forget — never awaited by the caller,
// never allowed to affect the trial gate this route exists to answer. Best-
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

// POST /api/exe-license/status — the LOCAL licensing gate status, read from this
// machine's filesystem (no database, no session auth — see lib/exe-runtime.ts
// for why that's safe: SPACEWORKER_LOCAL_EXE gates this to the Tauri-bundled
// local runtime only, fail-closed, never set on the deployed web server). This
// is the same code that runs inside the desktop EXE's bundled local runtime; it
// is only mounted by the EXE shell, never by the hosted web dashboard.
//
// Returns the gate decision the shared <LicenseGate> component renders on:
//   - licensed       -> user has an active, machine-valid key -> show dashboard
//   - inTrial        -> unlicensed but first launch was < 24h ago -> show dashboard
//   - otherwise      -> trial exhausted -> show the activation gate
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

  // 2. No activation yet — honour the silent 24h trial.
  const started = await startTrialIfNeeded();
  const now = new Date();

  if (trialActive(started, now)) {
    const hoursLeft = trialHoursLeft(started, now);
    if (started.trialStartedAt) {
      const currentMachineId = (await getMachineId()).toLowerCase();
      pingTrialStatus(currentMachineId, started.trialStartedAt);
    }
    return NextResponse.json({
      licensed: false,
      inTrial: true,
      trialHoursLeft: hoursLeft,
      trialStartedAt: started.trialStartedAt,
      trialEndsAt: new Date(
        new Date(started.trialStartedAt ?? now.toISOString()).getTime() +
          TRIAL_HOURS * 60 * 60 * 1000,
      ).toISOString(),
    });
  }

  return NextResponse.json({
    licensed: false,
    inTrial: false,
    trialStartedAt: started.trialStartedAt,
  });
}