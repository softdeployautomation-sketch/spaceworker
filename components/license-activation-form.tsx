"use client";

import { useEffect, useState } from "react";

import { Button, Input, Label } from "@/components/ui";
import { EXE_DURATION_OPTIONS, DEFAULT_EXE_DURATION_DAYS } from "@/lib/products";

// Shared EXE license activation form — POSTs to the app's own
// /api/exe-license/activate (license key), or the /api/exe/billing/* proxies
// (buy now), all local/offline-gated (or network-gated only for the parts that
// genuinely need it — a fresh purchase), no session.
//
// Used in two places:
//   1. <LicenseGate> — the full-screen gate shown once the 24h silent trial has
//      expired and the user can't reach the dashboard until they activate.
//   2. The Settings page's License panel — so a user on trial (or already
//      licensed) can activate/replace a key immediately without waiting the
//      trial clock out. Activation always replaces the current state outright.
//
// The "Email + password" sign-in tab was removed (Task 201 S14): it was an old
// alternate path to the SAME end state as pasting a license key, it needed a
// live network round-trip to verify the password (the key path validates fully
// offline once activated), and it confused the gate. The license-key path —
// with the device ID + email transfer hint below it — is now the single,
// unambiguous way in. /api/exe-license/password-activate is left in place,
// unreferenced, in case it's ever wanted again.
//
// Owner-requested 2026-09-20 (buy now): "as soon as the 24 hr elapses, lets
// put the signup and payment flow, so users dont need to come to the web...
// they just get their license and can then click a reload license binding
// page button." The Buy tab submits a real payment via the EXISTING
// unauthenticated-for-EXE-products /api/billing/submit (proxied through
// /api/exe/billing/submit — no changes needed to the hosted route, it already
// creates the account by email), then "Reload license binding" polls
// /api/exe/billing/payment-status until the resulting license is minted and
// binds it to this device automatically — no email/copy-paste needed unless
// the user closes the app before checking (the email with the key + claim
// link still arrives regardless, as a fallback).
//
// The remaining modes share the same already-bound-elsewhere confirmation UX
// (see needsTransferConfirm) since the routes return the identical
// `code: "already_bound"` shape.
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
  /** Show the "Buy now" tab. Off by default — only the trial-expired gate wants it. */
  showBuyTab?: boolean;
}

type Mode = "key" | "buy";
type PayKind = "btc" | "usdt_trc20" | "usdt_erc20";
const PAY_KINDS: { value: PayKind; label: string }[] = [
  { value: "btc", label: "Bitcoin" },
  { value: "usdt_trc20", label: "USDT (TRC20)" },
  { value: "usdt_erc20", label: "USDT (ERC20)" },
];

export function LicenseActivationForm({
  onActivated,
  actionSlot,
  submitLabel = "Activate",
  autoFocus = false,
  showBuyTab = false,
}: LicenseActivationFormProps) {
  const [mode, setMode] = useState<Mode>("key");
  const [licenseKey, setLicenseKey] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [activating, setActivating] = useState(false);
  // This device's hardware machine ID (the license's device UUID). Shown under
  // the email field so a user transferring a license can send us (device ID +
  // email). Server-only value — fetched from the local status route on mount.
  const [deviceId, setDeviceId] = useState("");
  // Set only when the server rejected the sign-in with code "already_bound" —
  // the credentials/key are genuinely valid, it's just active on a different
  // device. Never auto-transferred: the person has to see this and click
  // through it themselves.
  const [needsTransferConfirm, setNeedsTransferConfirm] = useState(false);
  // "key" mode only — a real confirmation code emailed to the account on
  // file (Task 49 fix: a client-supplied boolean was never real consent).
  const [transferCodeInput, setTransferCodeInput] = useState("");

  // ---- Buy tab state ----
  const [payKind, setPayKind] = useState<PayKind>("btc");
  const [durationDays, setDurationDays] = useState(DEFAULT_EXE_DURATION_DAYS);
  const [checkout, setCheckout] = useState<{ toAddress: string; amountUsd: number; note: string } | null>(null);
  const [checkoutError, setCheckoutError] = useState("");
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [txHash, setTxHash] = useState("");
  const [paymentId, setPaymentId] = useState<string | null>(null);
  const [paymentStatus, setPaymentStatus] = useState<string | null>(null);
  const [copyLabel, setCopyLabel] = useState("Copy");

  useEffect(() => {
    if (mode !== "buy" || paymentId) return;
    // Cancellation guard — crypto sends are irreversible, so a stale response
    // from a currency the user already switched away from must never land
    // (a rapid BTC -> USDT-TRC20 -> USDT-ERC20 click sequence can resolve
    // out of order). Mirrors components/store.tsx's CheckoutModal effect.
    let cancelled = false;
    setCheckout(null);
    setCheckoutLoading(true);
    setCheckoutError("");
    fetch(`/api/exe/billing/checkout?kind=${payKind}&durationDays=${durationDays}`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        if (typeof data.toAddress === "string" && typeof data.amountUsd === "number") {
          setCheckout({ toAddress: data.toAddress, amountUsd: data.amountUsd, note: data.note ?? "" });
        } else {
          setCheckoutError(typeof data.error === "string" ? data.error : "Couldn't load payment instructions.");
        }
      })
      .catch(() => {
        if (!cancelled) setCheckoutError("Network error — couldn't reach the store.");
      })
      .finally(() => {
        if (!cancelled) setCheckoutLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [mode, payKind, paymentId, durationDays]);

  function switchMode(next: Mode) {
    setMode(next);
    setError("");
    setNeedsTransferConfirm(false);
    setTransferCodeInput("");
  }

  // Fetch this device's machine ID once on mount so the transfer hint under the
  // email field can show it. The status route returns `machineId` on every
  // response (see app/api/exe-license/status/route.ts). Best-effort — a failure
  // just leaves the field blank; it never blocks activation.
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/exe-license/status", { method: "POST" });
        const data = await res.json().catch(() => ({}));
        if (typeof data.machineId === "string" && data.machineId) setDeviceId(data.machineId);
      } catch {
        // offline / not an EXE runtime — leave deviceId empty
      }
    })();
  }, []);

  async function submitPayment() {
    setError("");
    if (!email || !email.includes("@")) {
      setError("Enter the email to deliver your license to.");
      return;
    }
    setActivating(true);
    try {
      const res = await fetch("/api/exe/billing/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: payKind, txHash: txHash.trim() || undefined, email, durationDays }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && typeof data.paymentId === "string") {
        setPaymentId(data.paymentId);
        setPaymentStatus(typeof data.status === "string" ? data.status : "pending");
      } else {
        setError(typeof data.error === "string" ? data.error : "Couldn't submit the payment. Try again.");
      }
    } catch {
      setError("Network error — could not reach the store.");
    } finally {
      setActivating(false);
    }
  }

  async function checkPayment(confirmTransfer = false) {
    if (!paymentId) return;
    setError("");
    setActivating(true);
    try {
      const res = await fetch("/api/exe/billing/payment-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paymentId, email, confirmTransfer }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.done && data.licensed) {
        setNeedsTransferConfirm(false);
        onActivated?.();
      } else if (data.code === "already_bound" && !confirmTransfer) {
        setNeedsTransferConfirm(true);
        setError(typeof data.error === "string" ? data.error : "This license is already active on another device.");
      } else if (res.ok) {
        setPaymentStatus(typeof data.status === "string" ? data.status : paymentStatus);
        setError(
          data.status === "flagged"
            ? "This payment needs manual review — we'll email you once it's approved."
            : "Still waiting on your payment to confirm. This can take a few minutes for on-chain payments — check again shortly.",
        );
      } else {
        setError(typeof data.error === "string" ? data.error : "Couldn't check payment status.");
      }
    } catch {
      setError("Network error — could not reach the license server.");
    } finally {
      setActivating(false);
    }
  }

  async function submit(confirmTransfer = false) {
    if (mode === "buy") return checkPayment(confirmTransfer);
    setError("");
    setActivating(true);
    try {
      const res = await fetch("/api/exe-license/activate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          licenseKey,
          email,
          transferCode: transferCodeInput.trim() || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.licensed) {
        setNeedsTransferConfirm(false);
        setTransferCodeInput("");
        onActivated?.();
      } else if (data.code === "already_bound" && !transferCodeInput.trim()) {
        setNeedsTransferConfirm(true);
        setError(
          typeof data.error === "string"
            ? data.error
            : "This license is already active on another device.",
        );
      } else if (data.code === "invalid_transfer_code") {
        // Keep the code-entry UI open so they can retry without starting over.
        setNeedsTransferConfirm(true);
        setError(typeof data.error === "string" ? data.error : "That code is incorrect.");
      } else {
        setNeedsTransferConfirm(false);
        setError(
          typeof data.error === "string"
            ? data.error
            : "Activation failed. Check the key and email and try again.",
        );
      }
    } catch {
      setNeedsTransferConfirm(false);
      setError("Network error — could not reach the local licensing service.");
    } finally {
      setActivating(false);
    }
  }

  const tabs: { value: Mode; label: string }[] = [
    { value: "key", label: "License key" },
    ...(showBuyTab ? [{ value: "buy" as Mode, label: "Buy now" }] : []),
  ];

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        {tabs.map((t) => (
          <button
            key={t.value}
            type="button"
            onClick={() => switchMode(t.value)}
            className={`flex-1 rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${
              mode === t.value
                ? "border-brand-500 bg-brand-50 text-brand-700 dark:bg-brand-900/40 dark:text-brand-300"
                : "border-border bg-transparent text-fg-muted hover:bg-black/5 dark:hover:bg-white/5"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {mode === "key" && (
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
          {/* This device's license-bound ID. Shown so a user moving their license
              to another PC can send us exactly what identifies this install —
              this device ID + the email on the license — and we can transfer it.
              Copyable so they don't have to retype the hex. */}
          <div className="rounded-lg border border-border bg-input px-3 py-2 text-xs text-fg-muted">
            <div className="flex items-center justify-between gap-2">
              <span>
                Device ID:{" "}
                <code className="font-mono text-fg" data-testid="exe-device-id">
                  {deviceId || "…"}
                </code>
              </span>
              {deviceId && (
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard.writeText(deviceId);
                    setCopyLabel("Copied!");
                    setTimeout(() => setCopyLabel("Copy"), 1500);
                  }}
                  className="shrink-0 rounded border border-border px-2 py-0.5 hover:bg-black/5 dark:hover:bg-white/5"
                >
                  {copyLabel}
                </button>
              )}
            </div>
            <p className="mt-1">
              Moving your license to a new PC? Send this Device ID and the email on your license to
              support and we&apos;ll transfer it.
            </p>
          </div>
        </>
      )}

      {mode === "buy" && (
        <div className="space-y-3">
          {!paymentId ? (
            <>
              <div className="flex gap-2">
                {PAY_KINDS.map((k) => (
                  <button
                    key={k.value}
                    type="button"
                    onClick={() => {
                      setPayKind(k.value);
                      setCheckout(null);
                    }}
                    className={`flex-1 rounded-lg border px-2 py-1.5 text-xs font-medium transition-colors ${
                      payKind === k.value
                        ? "border-brand-500 bg-brand-50 text-brand-700 dark:bg-brand-900/40 dark:text-brand-300"
                        : "border-border bg-transparent text-fg-muted hover:bg-black/5 dark:hover:bg-white/5"
                    }`}
                  >
                    {k.label}
                  </button>
                ))}
              </div>
              <div className="flex gap-2">
                {EXE_DURATION_OPTIONS.map((opt) => (
                  <button
                    key={opt.days}
                    type="button"
                    onClick={() => setDurationDays(opt.days)}
                    className={`flex-1 rounded-lg border px-2 py-1.5 text-xs font-medium transition-colors ${
                      durationDays === opt.days
                        ? "border-brand-500 bg-brand-50 text-brand-700 dark:bg-brand-900/40 dark:text-brand-300"
                        : "border-border bg-transparent text-fg-muted hover:bg-black/5 dark:hover:bg-white/5"
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              <div>
                <Label htmlFor="exe-buy-email">Email (your license is delivered here)</Label>
                <Input
                  id="exe-buy-email"
                  type="email"
                  autoComplete="email"
                  autoFocus={autoFocus}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                />
              </div>
              {checkoutLoading && <p className="text-sm text-fg-muted">Loading payment instructions…</p>}
              {checkoutError && <p className="text-sm text-red-600 dark:text-red-400">{checkoutError}</p>}
              {checkout && (
                <div className="rounded-lg border border-border bg-input p-3 text-sm">
                  <p className="text-fg-muted">Send exactly</p>
                  <p className="text-lg font-semibold text-fg">${checkout.amountUsd.toFixed(2)}</p>
                  <p className="mt-2 text-fg-muted">to</p>
                  <div className="mt-1 flex items-center gap-2">
                    <code className="flex-1 break-all rounded bg-black/5 px-2 py-1 text-xs dark:bg-white/5">
                      {checkout.toAddress}
                    </code>
                    <button
                      type="button"
                      onClick={() => {
                        void navigator.clipboard.writeText(checkout.toAddress);
                        setCopyLabel("Copied!");
                        setTimeout(() => setCopyLabel("Copy"), 1500);
                      }}
                      className="shrink-0 rounded border border-border px-2 py-1 text-xs hover:bg-black/5 dark:hover:bg-white/5"
                    >
                      {copyLabel}
                    </button>
                  </div>
                  <p className="mt-2 text-xs text-fg-muted">{checkout.note}</p>
                </div>
              )}
              <div>
                <Label htmlFor="exe-buy-txhash">Transaction hash (optional — speeds up confirmation)</Label>
                <Input
                  id="exe-buy-txhash"
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  value={txHash}
                  onChange={(e) => setTxHash(e.target.value)}
                  placeholder="Paste your transaction hash after sending"
                />
              </div>
            </>
          ) : (
            <div className="rounded-lg border border-border bg-input p-3 text-sm">
              <p className="text-fg">Payment submitted{paymentStatus ? ` — status: ${paymentStatus}` : ""}.</p>
              <p className="mt-1 text-xs text-fg-muted">
                On-chain payments usually confirm within a few minutes. Once approved, your license is emailed to{" "}
                {email} — or just click below and it&rsquo;ll activate here directly.
              </p>
            </div>
          )}
        </div>
      )}

      {error && (
        <p className="text-sm text-red-600 dark:text-red-400" role="alert">
          {error}
        </p>
      )}

      {needsTransferConfirm && mode === "key" ? (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/40">
          <p className="text-sm text-amber-800 dark:text-amber-200">
            We emailed a confirmation code to the account on file — enter it below to move this license here.
            The other device will be signed out.
          </p>
          <div className="mt-3">
            <Input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              value={transferCodeInput}
              onChange={(e) => setTransferCodeInput(e.target.value)}
              placeholder="6-digit code"
            />
          </div>
          <div className="mt-3 flex items-center justify-end gap-3">
            <Button
              variant="secondary"
              type="button"
              onClick={() => {
                setNeedsTransferConfirm(false);
                setTransferCodeInput("");
              }}
              disabled={activating}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              type="button"
              onClick={() => submit()}
              disabled={activating || !transferCodeInput.trim()}
            >
              {activating ? "Confirming…" : "Confirm move"}
            </Button>
          </div>
        </div>
      ) : needsTransferConfirm ? (
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
          {mode === "buy" ? (
            paymentId ? (
              <Button variant="primary" type="button" onClick={() => checkPayment(false)} disabled={activating}>
                {activating ? "Checking…" : "Reload license binding"}
              </Button>
            ) : (
              <Button variant="primary" type="button" onClick={() => void submitPayment()} disabled={activating}>
                {activating ? "Submitting…" : "I've sent the payment"}
              </Button>
            )
          ) : (
            <Button variant="primary" type="button" onClick={() => submit(false)} disabled={activating}>
              {activating ? "Activating…" : submitLabel}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
