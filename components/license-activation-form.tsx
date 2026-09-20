"use client";

import { useState } from "react";

import { Button, Input, Label } from "@/components/ui";

// Shared EXE license activation form — POSTs to the app's own
// /api/exe-license/activate (license key) or /api/exe-license/password-activate
// (email + password) route, both local/offline-gated, no session.
//
// Used in two places:
//   1. <LicenseGate> — the full-screen gate shown once the 24h silent trial has
//      expired and the user can't reach the dashboard until they activate.
//   2. The Settings page's License panel — so a user on trial (or already
//      licensed) can activate/replace a key immediately without waiting the
//      trial clock out. Activation always replaces the current state outright.
//
// Owner-requested 2026-09-20: "make exe sign in optional to use either the
// password or license". Password sign-in doesn't mint a new license out of
// nowhere — it looks up an EXISTING one already issued to that account (via
// checkout or an admin issue) and binds it here, same end state as the
// license-key path once you already have the key. Both modes share the same
// already-bound-elsewhere confirmation UX (see needsTransferConfirm) since
// both backend routes return the identical `code: "already_bound"` shape.
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
  /** Focus the first field on mount. */
  autoFocus?: boolean;
}

type Mode = "key" | "password";

export function LicenseActivationForm({
  onActivated,
  actionSlot,
  submitLabel = "Activate",
  autoFocus = false,
}: LicenseActivationFormProps) {
  const [mode, setMode] = useState<Mode>("key");
  const [licenseKey, setLicenseKey] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [activating, setActivating] = useState(false);
  // Set only when the server rejected the sign-in with code "already_bound" —
  // the credentials/key are genuinely valid, it's just active on a different
  // device. Never auto-transferred (see auto-bind & password-login routes):
  // the person has to see this and click through it themselves.
  const [needsTransferConfirm, setNeedsTransferConfirm] = useState(false);

  function switchMode(next: Mode) {
    setMode(next);
    setError("");
    setNeedsTransferConfirm(false);
  }

  async function submit(confirmTransfer = false) {
    setError("");
    setActivating(true);
    try {
      const url = mode === "key" ? "/api/exe-license/activate" : "/api/exe-license/password-activate";
      const body =
        mode === "key" ? { licenseKey, email, confirmTransfer } : { email, password, confirmTransfer };
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.licensed) {
        setNeedsTransferConfirm(false);
        onActivated?.();
      } else if (data.code === "already_bound" && !confirmTransfer) {
        setNeedsTransferConfirm(true);
        setError(
          typeof data.error === "string"
            ? data.error
            : "This license is already active on another device.",
        );
      } else {
        setNeedsTransferConfirm(false);
        setError(
          typeof data.error === "string"
            ? data.error
            : mode === "key"
              ? "Activation failed. Check the key and email and try again."
              : "Sign-in failed. Check your email and password and try again.",
        );
      }
    } catch {
      setNeedsTransferConfirm(false);
      setError("Network error — could not reach the local licensing service.");
    } finally {
      setActivating(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => switchMode("key")}
          className={`flex-1 rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${
            mode === "key"
              ? "border-brand-500 bg-brand-50 text-brand-700 dark:bg-brand-900/40 dark:text-brand-300"
              : "border-border bg-transparent text-fg-muted hover:bg-black/5 dark:hover:bg-white/5"
          }`}
        >
          License key
        </button>
        <button
          type="button"
          onClick={() => switchMode("password")}
          className={`flex-1 rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${
            mode === "password"
              ? "border-brand-500 bg-brand-50 text-brand-700 dark:bg-brand-900/40 dark:text-brand-300"
              : "border-border bg-transparent text-fg-muted hover:bg-black/5 dark:hover:bg-white/5"
          }`}
        >
          Email + password
        </button>
      </div>

      {mode === "key" ? (
        <>
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
        </>
      ) : (
        <>
          <div>
            <Label htmlFor="exe-password-email">Email</Label>
            <Input
              id="exe-password-email"
              type="email"
              autoComplete="email"
              autoFocus={autoFocus}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
            />
          </div>
          <div>
            <Label htmlFor="exe-password-password">Password</Label>
            <Input
              id="exe-password-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Your account password"
            />
          </div>
        </>
      )}

      {error && (
        <p className="text-sm text-red-600 dark:text-red-400" role="alert">
          {error}
        </p>
      )}

      {needsTransferConfirm ? (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/40">
          <p className="text-sm text-amber-800 dark:text-amber-200">
            Moving it here will sign the other device out of this license — only do this if that device is no
            longer in use.
          </p>
          <div className="mt-3 flex items-center justify-end gap-3">
            <Button
              variant="secondary"
              type="button"
              onClick={() => setNeedsTransferConfirm(false)}
              disabled={activating}
            >
              Cancel
            </Button>
            <Button variant="primary" type="button" onClick={() => submit(true)} disabled={activating}>
              {activating ? "Moving…" : "Move license to this device"}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-3">
          {actionSlot}
          <div className="flex-1" />
          <Button variant="primary" type="button" onClick={() => submit(false)} disabled={activating}>
            {activating ? (mode === "key" ? "Activating…" : "Signing in…") : mode === "key" ? submitLabel : "Sign in"}
          </Button>
        </div>
      )}
    </div>
  );
}
