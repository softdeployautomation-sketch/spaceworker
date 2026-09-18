"use client";

import { useState } from "react";

import { Button, Input, Label } from "@/components/ui";

// Shared EXE license activation form — License key + Email + Activate, POSTing to
// the app's own /api/exe-license/activate route (local, offline, no session).
//
// Used in two places:
//   1. <LicenseGate> — the full-screen gate shown once the 24h silent trial has
//      expired and the user can't reach the dashboard until they activate.
//   2. The Settings page's License panel — so a user on trial (or already
//      licensed) can activate/replace a key immediately without waiting the
//      trial clock out. Activation always replaces the current state outright.
//
// `onActivated` fires only after a real success (res.ok && data.licensed); the
// caller is responsible for re-reading status / unhiding the app.
export interface LicenseActivationFormProps {
  /** Fired after a successful activation (res.ok && data.licensed). */
  onActivated?: () => void;
  /** Optional leading slot in the actions row (e.g. a "Buy a license →" link). */
  actionSlot?: React.ReactNode;
  /** Button label. Defaults to "Activate". */
  submitLabel?: string;
  /** Focus the license key field on mount. */
  autoFocus?: boolean;
}

export function LicenseActivationForm({
  onActivated,
  actionSlot,
  submitLabel = "Activate",
  autoFocus = false,
}: LicenseActivationFormProps) {
  const [licenseKey, setLicenseKey] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [activating, setActivating] = useState(false);

  async function activate() {
    setError("");
    setActivating(true);
    try {
      const res = await fetch("/api/exe-license/activate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ licenseKey, email }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.licensed) {
        onActivated?.();
      } else {
        setError(
          typeof data.error === "string"
            ? data.error
            : "Activation failed. Check the key and email and try again.",
        );
      }
    } catch {
      setError("Network error — could not reach the local licensing service.");
    } finally {
      setActivating(false);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <Label htmlFor="exe-license-key">License key</Label>
        <Input
          id="exe-license-key"
          type="text"
          autoComplete="off"
          spellCheck={false}
          autoFocus={autoFocus}
          value={licenseKey}
          onChange={(e) => setLicenseKey(e.target.value)}
          placeholder="Paste your license key"
        />
      </div>
      <div>
        <Label htmlFor="exe-license-email">Email</Label>
        <Input
          id="exe-license-email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
        />
      </div>

      {error && (
        <p className="text-sm text-red-600 dark:text-red-400" role="alert">
          {error}
        </p>
      )}

      <div className="flex items-center justify-between gap-3">
        {actionSlot}
        <div className="flex-1" />
        <Button variant="primary" type="button" onClick={activate} disabled={activating}>
          {activating ? "Activating…" : submitLabel}
        </Button>
      </div>
    </div>
  );
}