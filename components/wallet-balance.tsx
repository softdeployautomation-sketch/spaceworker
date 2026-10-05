"use client";

import { useCallback, useEffect, useState } from "react";

// TASK_158 W2 — the dashboard's read-only balance card.
//
// DELIBERATELY READ-ONLY. There is no "add funds" button, no amount field and no
// submit handler anywhere in this file, and that is the whole point: a wallet top-up
// is money entering the system, and the only route that may do that is the one
// that proves a real payment arrived (W3/W4, server-side). A number typed into a
// text box and POSTed by the browser is an amount the user chose, which is exactly
// the thing that must not be possible. So this component can misreport a balance
// but cannot change one — and if it ever did render an editable control, that
// would be a new vulnerability, not a missing feature.
//
// It renders CENTS as received and formats them here, in the browser, for display
// only. Nothing derived from the formatted string is ever sent back to the server
// (see the comment in app/api/wallet/route.ts on why money stays integral).

interface WalletView {
  balanceCents: number;
  postpaidLimitCents: number;
  spendableCents: number;
  prepaidOnly: boolean;
}

/** Cents as a display string. Abs sign carried by the caller, not hidden here. */
function money(cents: number): string {
  const abs = Math.abs(cents);
  return `${cents < 0 ? "-" : ""}$${(abs / 100).toFixed(2)}`;
}

export function WalletBalance() {
  const [wallet, setWallet] = useState<WalletView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/wallet", { cache: "no-store" });
      if (!res.ok) throw new Error(`Failed to load balance (${res.status})`);
      const data = (await res.json()) as { wallet: WalletView };
      setWallet(data.wallet);
    } catch {
      // Say what went wrong, not "your balance is $0.00". A failed read and a
      // genuinely empty wallet look identical if an error renders as a number.
      setError("Could not load your balance. Try again shortly.");
      setWallet(null);
    } finally {
      setLoading(false);
    }
  }, []);

  // House pattern (cf. components/hosting-panel.tsx): fire-and-forget on mount so
  // the effect body returns void, not a setState promise.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- every setState in load is behind the fetch await, not synchronous
    void load();
  }, [load]);

  if (loading) {
    return (
      <section
        aria-busy="true"
        className="mb-6 rounded-xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
      >
        <h2 className="text-sm font-medium text-zinc-500 dark:text-zinc-400">Balance</h2>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>
      </section>
    );
  }

  if (error || !wallet) {
    return (
      <section className="mb-6 rounded-xl border border-amber-300 bg-amber-50 p-5 dark:border-amber-800 dark:bg-amber-950/30">
        <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-200">Balance</h2>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{error}</p>
        <button
          onClick={() => void load()}
          className="mt-3 rounded-lg border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          Retry
        </button>
      </section>
    );
  }

  return (
    <section
      aria-label="Wallet balance"
      className="mb-6 rounded-xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
    >
      <h2 className="text-sm font-medium text-zinc-500 dark:text-zinc-400">Balance</h2>

      <p className="mt-1 text-3xl font-semibold tabular-nums tracking-tight text-zinc-900 dark:text-zinc-100">
        {money(wallet.balanceCents)}
      </p>

      <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
        {wallet.prepaidOnly ? (
          "Prepaid. Purchases are charged at checkout."
        ) : (
          <>
            {money(wallet.spendableCents)} available — a {money(wallet.postpaidLimitCents)} credit
            line is on this account.
          </>
        )}
      </p>

      {/*
        Refreshing is a re-read, never a mutation. It re-fetches GET /api/wallet
        and cannot touch a balance, so it is safe to expose on a card that shows
        money.
      */}
      <button
        onClick={() => void load()}
        className="mt-3 rounded-lg border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
      >
        Refresh
      </button>
    </section>
  );
}