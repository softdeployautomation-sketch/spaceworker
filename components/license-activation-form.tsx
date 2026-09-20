"use client";

import { useEffect, useState } from "react";

import { Button, Input, Label } from "@/components/ui";

// Shared EXE license activation form — POSTs to the app's own
// /api/exe-license/activate (license key), /api/exe-license/password-activate
// (email + password), or the /api/exe/billing/* proxies (buy now), all
// local/offline-gated (or network-gated only for the parts that genuinely
// need it — a fresh purchase, a password check), no session.
//
// Used in two places:
//   1. <LicenseGate> — the full-screen gate shown once the 24h silent trial has
//      expired and the user can't reach the dashboard until they activate.
//   2. The Settings page's License panel — so a user on trial (or already
//      licensed) can activate/replace a key immediately without waiting the
//      trial clock out. Activation always replaces the current state outright.
//
// Owner-requested 2026-09-20 (password sign-in): "make exe sign in optional to
// use either the password or license". Password sign-in doesn't mint a new
// license out of nowhere — it looks up an EXISTING one already issued to that
// account (via checkout or an admin issue) and binds it here, same end state
// as the license-key path once you already have the key.
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
// All THREE modes share the same already-bound-elsewhere confirmation UX (see
// needsTransferConfirm) since all three backend routes return the identical
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

type Mode = "key" | "password" | "buy";
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
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [activating, setActivating] = useState(false);
  // Set only when the server rejected the sign-in with code "already_bound" —
  // the credentials/key are genuinely valid, it's just active on a different
  // device. Never auto-transferred: the person has to see this and click
  // through it themselves.
  const [needsTransferConfirm, setNeedsTransferConfirm] = useState(false);

  // ---- Buy tab state ----
  const [payKind, setPayKind] = useState<PayKind>("btc");
  const [checkout, setCheckout] = useState<{ toAddress: string; amountUsd: number; note: string } | null>(null);
  const [checkoutError, setCheckoutError] = useState("");
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [txHash, setTxHash] = useState("");
  const [paymentId, setPaymentId] = useState<string | null>(null);
  const [paymentStatus, setPaymentStatus] = useState<string | null>(null);
  const [copyLabel, setCopyLabel] = useState("Copy");

  useEffect(() => {
    if (mode !== "buy" || paymentId) return;
    setCheckoutLoading(true);
    setCheckoutError("");
    fetch(`/api/exe/billing/checkout?kind=${payKind}`)
      .then((r) => r.json())
      .then((data) => {
        if (typeof data.toAddress === "string" && typeof data.amountUsd === "number") {
          setCheckout({ toAddress: data.toAddress, amountUsd: data.amountUsd, note: data.note ?? "" });
        } else {
          setCheckoutError(typeof data.error === "string" ? data.error : "Couldn't load payment instructions.");
        }
      })
      .catch(() => setCheckoutError("Network error — couldn't reach the store."))
      .finally(() => setCheckoutLoading(false));
  }, [mode, payKind, paymentId]);

  function switchMode(next: Mode) {
    setMode(next);
    setError("");
    setNeedsTransferConfirm(false);
  }

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
        body: JSON.stringify({ kind: payKind, txHash: txHash.trim() || undefined, email }),
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

  const tabs: { value: Mode; label: string }[] = [
    { value: "key", label: "License key" },
    { value: "password", label: "Email + password" },
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
        </>
      )}

      {mode === "password" && (
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
              {activating ? (mode === "key" ? "Activating…" : "Signing in…") : mode === "key" ? submitLabel : "Sign in"}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
