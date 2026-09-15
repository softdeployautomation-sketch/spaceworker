"use client";

import { useEffect, useState } from "react";

type Kind = "btc" | "usdt_trc20" | "usdt_erc20";

type PaymentInfo = {
  status: string;
  kind: string;
  amountUsd: number;
  txHash: string;
  createdAt: string;
  updatedAt: string;
  autoApproved: boolean;
};

type CheckoutInfo = {
  kind: string;
  toAddress: string;
  amountUsd: number;
  note: string;
};

const KIND_OPTIONS: Array<{ id: Kind; label: string }> = [
  { id: "btc", label: "Bitcoin" },
  { id: "usdt_trc20", label: "USDT (TRC-20)" },
  { id: "usdt_erc20", label: "USDT (ERC-20)" },
];

function kindLabel(kind: string): string {
  return KIND_OPTIONS.find((o) => o.id === kind)?.label ?? kind;
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard unavailable — ignore
    }
  }
  return (
    <button
      onClick={copy}
      className="rounded-lg border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
    >
      {copied ? "Copied!" : "Copy"}
    </button>
  );
}

export default function BillingPage() {
  const [payment, setPayment] = useState<PaymentInfo | null | undefined>(undefined);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const res = await fetch("/api/billing/status");
      const data = await res.json().catch(() => ({}));
      if (res.ok) setPayment(data.status === null ? null : data);
      else setPayment(null);
    })();
  }, []);

  function handleResult(p: PaymentInfo | null, resultNote?: string) {
    setPayment(p);
    setNote(resultNote ?? null);
  }

  if (payment === undefined) {
    return (
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Billing</h1>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>
      </div>
    );
  }

  if (!payment) {
    return (
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Billing</h1>
        <UpgradeFlow onResult={handleResult} />
      </div>
    );
  }

  return <StatusCardView payment={payment} note={note} onResult={handleResult} />;
}

function UpgradeFlow({
  onResult,
}: {
  onResult: (p: PaymentInfo | null, note?: string) => void;
}) {
  const [kind, setKind] = useState<Kind>("btc");
  const [checkout, setCheckout] = useState<CheckoutInfo | null>(null);
  const [loadingInfo, setLoadingInfo] = useState(false);
  const [txHash, setTxHash] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setCheckout(null);
    setError("");
    setLoadingInfo(true);
    (async () => {
      const res = await fetch(`/api/billing/checkout?kind=${kind}`);
      const data = await res.json().catch(() => ({}));
      if (!cancelled) {
        setLoadingInfo(false);
        if (res.ok) setCheckout(data);
        else setError(typeof data.error === "string" ? data.error : "Failed to load payment info");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [kind]);

  async function submit() {
    const hash = txHash.trim();
    if (!hash) {
      setError("Enter your transaction hash");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch("/api/billing/submit", {
        method: "POST",
        body: JSON.stringify({ kind, txHash: hash }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : "Submission failed");
        return;
      }
      const statusRes = await fetch("/api/billing/status");
      const statusData = await statusRes.json().catch(() => ({}));
      if (statusRes.ok) {
        onResult(statusData.status === null ? null : statusData, data.note);
      }
    } catch {
      setError("Network error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mt-6">
      <div className="max-w-2xl rounded-xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="text-xl font-semibold tracking-tight">Upgrade to Pro</h2>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Pro plan gives your jobs higher queue priority.
          {checkout ? ` $${checkout.amountUsd.toFixed(2)} / month.` : ""}
        </p>

        <div className="mt-5 flex gap-2">
          {KIND_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              onClick={() => setKind(opt.id)}
              className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                kind === opt.id
                  ? "bg-zinc-900 text-white dark:bg-zinc-50 dark:text-zinc-900"
                  : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {loadingInfo && (
          <p className="mt-5 text-sm text-zinc-500 dark:text-zinc-400">Loading payment details…</p>
        )}

        {checkout && (
          <div className="mt-5 space-y-4">
            <div>
              <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                Send {kindLabel(kind)} to this address
              </p>
              <div className="mt-2 flex items-center gap-2">
                <code className="flex-1 break-all rounded-lg bg-zinc-100 px-3 py-2 font-mono text-xs text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                  {checkout.toAddress}
                </code>
                <CopyButton value={checkout.toAddress} />
              </div>
              <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
                Send exactly ${checkout.amountUsd.toFixed(2)} worth of{" "}
                {kind === "btc" ? "BTC" : "USDT"} — within ±5% is accepted.
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
                Transaction hash
              </label>
              <input
                type="text"
                value={txHash}
                onChange={(e) => setTxHash(e.target.value)}
                placeholder="Enter the transaction hash after sending"
                className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 font-mono text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950"
              />
              <button
                onClick={submit}
                disabled={submitting}
                className="mt-3 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-300"
              >
                {submitting ? "Submitting…" : "Submit Payment"}
              </button>
            </div>
          </div>
        )}

        {error && <p className="mt-4 text-sm text-red-600 dark:text-red-400">{error}</p>}
      </div>
    </div>
  );
}

function StatusCardView({
  payment,
  note,
  onResult,
}: {
  payment: PaymentInfo;
  note: string | null;
  onResult: (p: PaymentInfo | null, n?: string) => void;
}) {
  const labels: Record<string, { badge: string; text: string }> = {
    approved: {
      badge: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400",
      text: "Pro — Active",
    },
    pending: {
      badge: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400",
      text: "Payment Pending — checking blockchain…",
    },
    flagged: {
      badge: "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-400",
      text: "Under Review — our team will verify this manually",
    },
    rejected: {
      badge: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400",
      text: "Payment Rejected",
    },
  };
  const label = labels[payment.status] ?? labels.pending;

  return (
    <div className="mt-6">
      <div className="max-w-2xl rounded-xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="text-xl font-semibold tracking-tight">Pro plan</h2>
        <div className="mt-3">
          <span className={`rounded-full px-3 py-1 text-sm font-medium ${label.badge}`}>
            {label.text}
          </span>
        </div>

        <dl className="mt-5 space-y-2 text-sm">
          <div className="flex items-center justify-between gap-4">
            <dt className="text-zinc-500 dark:text-zinc-400">Amount</dt>
            <dd className="font-medium">${payment.amountUsd.toFixed(2)}</dd>
          </div>
          <div className="flex items-center justify-between gap-4">
            <dt className="text-zinc-500 dark:text-zinc-400">Method</dt>
            <dd>{kindLabel(payment.kind)}</dd>
          </div>
          <div className="flex items-center justify-between gap-4">
            <dt className="text-zinc-500 dark:text-zinc-400">
              {payment.status === "approved" ? "Approved" : "Submitted"}
            </dt>
            <dd>
              {new Date(
                payment.status === "approved" ? payment.updatedAt : payment.createdAt
              ).toLocaleString()}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-4">
            <dt className="text-zinc-500 dark:text-zinc-400">Tx hash</dt>
            <dd className="max-w-[55%] truncate font-mono text-xs">{payment.txHash}</dd>
          </div>
        </dl>

        {note && (
          <p className="mt-4 rounded-lg bg-zinc-100 px-3 py-2 text-sm text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
            {note}
          </p>
        )}
      </div>

      {payment.status === "rejected" && (
        <div className="mt-8 border-t border-zinc-200 pt-6 dark:border-zinc-800">
          <h3 className="text-lg font-semibold tracking-tight">Submit a new payment hash</h3>
          <UpgradeFlow onResult={onResult} />
        </div>
      )}
    </div>
  );
}