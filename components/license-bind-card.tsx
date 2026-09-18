"use client";

import { useState } from "react";
import { CopyButton } from "@/components/copy-button";

// Task 47 — the buyer self-service "claim this license to my machine" card. It
// runs against /api/exe-license/bind (ownership-scoped server route) and, on
// success, reveals the RE-SIGNED machine-bound activation key the buyer actually
// enters into the EXE. Once a license is bound it's intentionally single-use —
// moving to another machine is a deliberate admin/support action, not a
// self-service "claim again" button.

type ClaimResult = {
  licenseKey: string;
  boundMachineId: string;
  boundMachineLabel: string | null;
  productName: string;
  expiresAt: string;
};

export function LicenseBindCard({
  exeLicenseId,
  productName,
  expiresAtLabel,
}: {
  exeLicenseId: string;
  productName: string;
  expiresAtLabel: string;
}) {
  const [machineId, setMachineId] = useState("");
  const [machineLabel, setMachineLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<ClaimResult | null>(null);

  async function claim() {
    if (!machineId.trim() || busy) return;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const res = await fetch("/api/exe-license/bind", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          exeLicenseId,
          machineId: machineId.trim(),
          machineLabel: machineLabel.trim() ? machineLabel.trim() : undefined,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as Partial<ClaimResult> & {
        error?: string;
      };
      if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : "Claim failed.");
        return;
      }
      if (!data.licenseKey) {
        setError("The license was claimed but no key was returned. Contact support.");
        return;
      }
      setResult({
        licenseKey: data.licenseKey,
        boundMachineId: data.boundMachineId ?? "",
        boundMachineLabel: data.boundMachineLabel ?? null,
        productName: data.productName ?? productName,
        expiresAt: data.expiresAt ?? "",
      });
    } catch {
      setError("Network error — please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-brand-200 bg-brand-50/60 p-4 dark:border-brand-900 dark:bg-brand-950/40">
      <h3 className="text-sm font-semibold text-fg">Activate this license to a device</h3>
      <p className="mt-1 text-xs text-fg-muted">
        Once downloaded, run the app and copy the <strong>Device ID</strong> it shows on the
        license screen. Enter it here to lock this license to that device. This is a one-time
        step — you can&rsquo;t silently move the license to another machine yourself.
      </p>
      <div className="mt-3 space-y-2">
        <input
          value={machineId}
          onChange={(e) => setMachineId(e.target.value)}
          placeholder="Device ID (e.g. 4d1c9f2a8b3e6d7c)"
          className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-brand-600"
        />
        <input
          value={machineLabel}
          onChange={(e) => setMachineLabel(e.target.value)}
          placeholder="Device label (optional, e.g. “Office PC”)"
          className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-brand-600"
        />
        <button
          onClick={claim}
          disabled={busy}
          className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-700 disabled:opacity-50"
        >
          {busy ? "Claiming…" : "Claim to this device"}
        </button>
      </div>

      {error && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}

      {result && (
        <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3 dark:border-emerald-900 dark:bg-emerald-950">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-emerald-800 dark:text-emerald-300">
              Activation key ready
            </p>
            <CopyButton value={result.licenseKey} label="Copy key" />
          </div>
          <p className="mt-2 break-all rounded-md bg-white p-2 font-mono text-xs text-zinc-800 shadow-sm dark:bg-zinc-900 dark:text-zinc-200">
            {result.licenseKey}
          </p>
          <p className="mt-2 text-xs text-emerald-700 dark:text-emerald-400">
            Bound to device <code>{result.boundMachineId}</code>
            {result.boundMachineLabel ? ` (${result.boundMachineLabel})` : ""}. Enter this key in
            the app to activate. Valid until{" "}
            {result.expiresAt ? new Date(result.expiresAt).toLocaleDateString() : expiresAtLabel}.
          </p>
        </div>
      )}
    </div>
  );
}