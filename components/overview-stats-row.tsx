"use client";

import { useCallback, useEffect, useState } from "react";

import { Bot, Cpu, Mail, Megaphone, Users, Wallet } from "lucide-react";

import { cn } from "@/lib/cn";

// PLAN_TASK_165 P3 (owner, 2026-10-05) — the status row directly under the
// welcome panel: wallet balance, AI spend today, and the other dashboard
// counters, in ONE line.
//
// ONE FETCH, ONE ROW. The first cut of this was five tiles each with its own
// useEffect. That is five round trips landing in an unpredictable order, so the
// row visibly shuffled as each resolved, and five separate places to get the
// wallet wrong. This reads GET /api/overview-stats once and renders a stable
// row, which is also why the numbers cannot disagree with each other.
//
// READ-ONLY, LIKE EVERY OTHER MONEY SURFACE IN THE APP. This file fetches and
// formats; there is no amount input, no POST and no handler that can move money
// or spend AI. The one route allowed to credit a wallet is a server-side admin
// grant (PLAN_TASK_158 W3), which still does not exist. See
// components/wallet-balance.tsx for the long version of that argument.
//
// UNITS. Wallet figures arrive as integer CENTS; AI figures as integer HUNDREDTHS
// OF A CENT (the unit AiUsageLog and User.aiDailyCapHundredthsCent are stored in).
// Both are formatted here, in the browser, for display only — nothing derived
// from these strings is ever sent back. `formatCents` itself is NOT imported:
// lib/wallet.ts starts with `import "server-only"`, so a client component cannot
// use it. The local formatters below are deliberately the same shape as the
// server's, for the same reason as in wallet-chip.tsx.
//
// A FAILED READ RENDERS NOTHING, NOT ZEROES. Every figure here can be a real zero
// ("no devices"), so a dropped fetch that fell back to 0 would be a lie the user
// cannot detect. The row disappears instead and the welcome panel above is
// unaffected. A 401/403 does the same thing: a `license_only` session is
// allowlisted away from this API by proxy.ts, and advertising a balance that
// session cannot read is worse than showing nothing.
//
// NO ANIMATED NUMBERS. A count-up would mean a per-frame timer on the largest
// element of the dashboard, for decoration. Plain `tabular-nums` text keeps the
// row readable and stops the digits reflowing the layout as they change width.

interface WalletView {
  balanceCents: number;
  postpaidLimitCents: number;
  spendableCents: number;
  prepaidOnly: boolean;
}

interface OverviewStats {
  wallet: WalletView;
  ai: { usedTodayHundredthsCent: number; dailyCapHundredthsCent: number };
  counts: {
    devicesTotal: number;
    devicesOnline: number;
    leads: number;
    campaigns: number;
    mailboxes: number;
  };
}

/** Same output as lib/wallet.ts `formatCents`; see the unit note above. */
function centsToDisplay(cents: number): string {
  return `$${(Math.abs(cents) / 100).toFixed(2)}`;
}

/**
 * HUNDREDTHS OF A CENT → dollars. Divided by 10_000 in one step, not 100 twice,
 * so usage and cap are on the same scale (the default cap 20000 is $200.00).
 */
function hundredthsToDisplay(hundredths: number): string {
  return `$${(Math.abs(hundredths) / 10_000).toFixed(2)}`;
}

/** Counts above 999 get a "k" so a five-digit number can't stretch the row. */
function countToDisplay(n: number): string {
  return n < 1000 ? String(n) : `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
}

const LABELS = ["Wallet", "AI today", "Devices", "Leads", "Campaigns", "Mailboxes"];

export function OverviewStatsRow({ className }: { className?: string }) {
  const [stats, setStats] = useState<OverviewStats | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "hidden">("loading");

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await fetch("/api/overview-stats", {
        cache: "no-store",
        ...(signal ? { signal } : {}),
      });
      if (res.status === 401 || res.status === 403) {
        setState("hidden");
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      setStats((await res.json()) as OverviewStats);
      setState("ready");
    } catch (err) {
      // An abort is us unmounting, not a failure — it must not blank a row
      // that has already rendered.
      if ((err as Error).name === "AbortError") return;
      setState("hidden");
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- both setState calls are behind the fetch await inside load(), never synchronous
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const shell = cn(
    "flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-border bg-bg-elevated/60 px-3 py-2.5 text-xs backdrop-blur",
    className,
  );

  if (state === "hidden") return null;

  // The skeleton keeps the row's HEIGHT reserved, so the page below it does not
  // jump upward when the real numbers arrive. It is `aria-busy` + a text label,
  // not a spinner over a blank gap.
  if (state === "loading") {
    return (
      <div aria-busy="true" aria-label="Account status" className={shell}>
        {LABELS.map((label) => (
          <span key={label} className="flex items-center gap-1.5 text-fg-muted">
            <span className="h-3 w-3 animate-pulse rounded bg-black/10 dark:bg-white/10" />
            {label}
            <span className="h-3 w-8 animate-pulse rounded bg-black/10 dark:bg-white/10" />
          </span>
        ))}
      </div>
    );
  }

  if (!stats) return null;

  const { wallet, ai, counts } = stats;
  const walletEmpty = wallet.balanceCents === 0;
  // A cap of 0 means "no AI allowance", not "0% used" — dividing by it would be
  // Infinity, so it is reported as an unset cap instead of as a percentage.
  const aiCapZero = ai.dailyCapHundredthsCent <= 0;

  return (
    <div aria-label="Account status" className={shell}>
      <Stat icon={<Wallet className="h-3.5 w-3.5" aria-hidden="true" />} label="Wallet">
        {/* Same honesty rule as the top-bar chip: a bare "$0.00" reads as a
            broken read, and no production route can fund a wallet yet (P4). */}
        {walletEmpty ? (
          <span className="text-fg-muted">no funds yet</span>
        ) : (
          <span className="font-semibold tabular-nums text-fg">
            {centsToDisplay(wallet.balanceCents)}
          </span>
        )}
        {!walletEmpty && !wallet.prepaidOnly && (
          <span className="text-fg-muted">
            {" "}
            ({centsToDisplay(wallet.spendableCents)} incl. credit)
          </span>
        )}
      </Stat>

      <Stat icon={<Bot className="h-3.5 w-3.5" aria-hidden="true" />} label="AI today">
        <span className="font-semibold tabular-nums text-fg">
          {hundredthsToDisplay(ai.usedTodayHundredthsCent)}
        </span>
        <span className="text-fg-muted">
          {aiCapZero
            ? " used · no cap set"
            : ` used of ${hundredthsToDisplay(ai.dailyCapHundredthsCent)}`}
        </span>
      </Stat>

      <Stat icon={<Cpu className="h-3.5 w-3.5" aria-hidden="true" />} label="Devices">
        <span className="font-semibold tabular-nums text-fg">{counts.devicesOnline}</span>
        <span className="text-fg-muted"> online of {counts.devicesTotal}</span>
      </Stat>

      <Stat icon={<Users className="h-3.5 w-3.5" aria-hidden="true" />} label="Leads">
        <span className="font-semibold tabular-nums text-fg">{countToDisplay(counts.leads)}</span>
      </Stat>

      <Stat icon={<Megaphone className="h-3.5 w-3.5" aria-hidden="true" />} label="Campaigns">
        <span className="font-semibold tabular-nums text-fg">
          {countToDisplay(counts.campaigns)}
        </span>
      </Stat>

      <Stat icon={<Mail className="h-3.5 w-3.5" aria-hidden="true" />} label="Mailboxes">
        <span className="font-semibold tabular-nums text-fg">
          {countToDisplay(counts.mailboxes)}
        </span>
      </Stat>
    </div>
  );
}

function Stat({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap text-fg-muted">
      <span className="text-fg-subtle">{icon}</span>
      {label}
      {children}
    </span>
  );
}
