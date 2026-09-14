import { NextResponse } from "next/server";

import { exeLicenseSecret } from "@/lib/exe-license";
import { validateLicenseKey } from "@/lib/exe-license-validator";
import { getMachineId, validateMachineId } from "@/lib/machine-id";
import {
  readLocalState,
  startTrialIfNeeded,
  trialActive,
  trialHoursLeft,
  TRIAL_HOURS,
} from "@/lib/license-state";

// POST /api/exe-license/status — the LOCAL licensing gate status, read from this
// machine's filesystem (no database, no auth). This is the same code that runs
// inside the desktop EXE's bundled local runtime; it is only mounted by the EXE
// shell, never by the hosted web dashboard.
//
// Returns the gate decision the shared <LicenseGate> component renders on:
//   - licensed       -> user has an active, machine-valid key -> show dashboard
//   - inTrial        -> unlicensed but first launch was < 24h ago -> show dashboard
//   - otherwise      -> trial exhausted -> show the activation gate
export async function POST() {
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