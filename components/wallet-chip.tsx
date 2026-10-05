"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Wallet } from "lucide-react";

import { cn } from "@/lib/cn";

// PLAN_TASK_165 P1 (owner, 2026-10-05) — the Wallet chip in the OS top bar,
// beside the date, in place of the Billing dock tile.
//
// READ-ONLY BY CONSTRUCTION, same rule as components/wallet-balance.tsx: this
// file fetches, formats and links. There is no amount input, no POST and no
// handler that can move money, so it cannot become a top-up flow by accident.
// Money enters a wallet through exactly two server-side paths: the admin grant
// (PLAN_TASK_158 W3, shipped in 076800d) and the top-up flow this chip links to
// (PLAN_TASK_167 W4) — both decide server-side, never from this component.
//
// WHY formatCents IS NOT IMPORTED HERE. `formatCents` lives in lib/wallet.ts,
// and that module starts with `import "server-only"` — importing it from a
// client component fails the build. The client's only legitimate route to money
// is GET /api/wallet (W2, shipped in 231ae31), which is what this uses.
// Cents stay INTEGER end to end; this formats for display only and nothing
// derived from the string ever goes back to the server. `centsToDisplay` below
// is deliberately byte-for-byte the same shape as formatCents so the two cannot
// drift into disagreeing about what a balance looks like.
//
// AN EMPTY WALLET STILL RENDERS AN EXPLICIT LABEL, but as of PLAN_TASK_167 W4
// it is an invitation rather than an explanation: the chip links to
// /dashboard/billing, where the top-up form now lives, so "no funds yet" is the
// first step of a working flow instead of a dead end. A bare $0.00 would still
// read as a bug; this reads as "start here".

interface WalletView {
  balanceCents: number;
  postpaidLimitCents: number;
  spendableCents: number;
  prepaidOnly: boolean;
}

/** Same output as lib/wallet.ts `formatCents`; see the note above. */
function centsToDisplay(cents: number): string {
  return `$${(Math.abs(cents) / 100).toFixed(2)}`;
}

export function WalletChip() {
  const [wallet, setWallet] = useState<WalletView | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "hidden">("loading");

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch("/api/wallet", { cache: "no-store" });

        // A `license_only` session (proxy.ts LICENSE_ONLY_ALLOWED_API_PREFIXES)
        // is allowlisted away from /api/wallet, which answers 403 — and
        // /dashboard/billing is likewise outside its page allowlist, so it would
        // redirect that user to /dashboard/licenses. Rendering a chip for them
        // would advertise a balance they cannot read and a page they cannot
        // open, so a 403 renders NOTHING rather than a broken control. This was
        // verified against proxy.ts:48-56,158-168, not assumed.
        if (cancelled) return;
        if (res.status === 403 || res.status === 401) {
          setState("hidden");
          return;
        }
        if (!res.ok) throw new Error(String(res.status));

        const data = (await res.json()) as { wallet: WalletView };
        if (cancelled) return;
        setWallet(data.wallet);
        setState("ready");
      } catch {
        // Same rule as wallet-balance.tsx: a failed read must never render as a
        // number. Stay on the skeleton rather than showing a balance we don't have.
        if (!cancelled) setState("hidden");
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  if (state === "hidden") return null;

  const empty = state === "ready" && wallet?.balanceCents === 0;

  return (
    <Link
      href="/dashboard/billing"
      aria-label="Wallet"
      title={
        state === "loading"
          ? "Loading your balance"
          : empty
            ? "No funds yet — top up your wallet on the Billing page"
            : `Wallet balance ${centsToDisplay(wallet?.balanceCents ?? 0)}`
      }
      className={cn(
        "flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs transition-colors",
        "text-fg-muted hover:bg-black/5 hover:text-fg dark:hover:bg-white/5",
      )}
    >
      <Wallet className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      {state === "loading" ? (
        <span className="tabular-nums">…</span>
      ) : empty ? (
        // Deliberately not a bare "$0.00" — an empty wallet is an invitation to
        // the top-up form on /dashboard/billing now that W4 has shipped.
        <span>Wallet · add funds</span>
      ) : (
        <span className="font-semibold tabular-nums text-fg">
          {centsToDisplay(wallet?.balanceCents ?? 0)}
        </span>
      )}
    </Link>
  );
}