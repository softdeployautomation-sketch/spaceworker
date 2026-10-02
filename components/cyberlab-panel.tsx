"use client";

import { useCallback, useEffect, useState } from "react";

import { CyberLabAup } from "@/components/cyberlab-aup";

// TASK_156 C1 — the Cyber Lab tab, now carrying the REAL gate (§12.9) and the C0
// AUP onboarding (§7 C0).
//
// Honest and deliberately small: the lab engine is not built (§7 C2+), so this
// renders the true state — the platform switch, the user's premium `cyberlab`
// entitlement, whether they have accepted the current AUP, and the load envelope
// the owner can already tune in admin. It is the ONE door (§12.9): there is no
// staff badge and no staff gate. The panel exists so the menu and dashboard card
// point somewhere real, the AUP can be accepted before anything runs, and the load
// numbers the governor will eventually queue against are visible from day one.
//
// A newly-accepted AUP is reflected by re-reading the status endpoint (the gate
// state is server-authoritative — the client never assumes acceptance succeeded).

interface CyberLabStatus {
  enabled: boolean;
  entitled: boolean;
  entitlementReason: string;
  gate: {
    open: boolean;
    termsVersion: string;
    consented: boolean;
    consentedAt: string | null;
  };
  caps: {
    freeMaxConcurrentRanges: number;
    freeMaxRangeMinutes: number;
    rangeRamMb: number;
    hostRamBudgetMb: number;
    maxTargetsPerScenario: number;
    maxEpisodesPerMonth: number;
    maxTargetsPerUser: number;
    maxRunsPerDay: number;
    toolStaleAfterDays: number;
    researchRefreshDays: number;
  };
}

const CAP_ROWS: Array<{ label: string; pick: (c: CyberLabStatus["caps"]) => string; hint: string }> = [
  {
    label: "Concurrent ranges",
    pick: (c) => String(c.freeMaxConcurrentRanges),
    hint: "How many isolated lab ranges one user may hold active at once.",
  },
  {
    label: "Max range duration",
    pick: (c) => `${c.freeMaxRangeMinutes} min`,
    hint: "Hard TTL before a range is torn down.",
  },
  {
    label: "RAM per range",
    pick: (c) => `${c.rangeRamMb} MB`,
    hint: "Reserved for each range host — the scarce resource.",
  },
  {
    label: "Host RAM budget",
    pick: (c) => `${c.hostRamBudgetMb} MB`,
    hint: "Total the lab may use; the governor queues against this.",
  },
  {
    label: "Attested targets (per scenario)",
    pick: (c) => String(c.maxTargetsPerScenario),
    hint: "Cap on targets per scenario — the legal spine.",
  },
  {
    label: "Attested targets (per user)",
    pick: (c) => String(c.maxTargetsPerUser),
    hint: "Total attested inventory one user may hold (§5.2.1).",
  },
  {
    label: "Runs per day",
    pick: (c) => String(c.maxRunsPerDay),
    hint: "Lab runs one user may start per calendar day.",
  },
  {
    label: "Episodes / month",
    pick: (c) => String(c.maxEpisodesPerMonth),
    hint: "Evidence bundles a user may produce per month.",
  },
  {
    label: "Tool currency window",
    pick: (c) => `${c.toolStaleAfterDays} days`,
    hint: "A catalog row older than this is hidden until re-reviewed (§12.1).",
  },
  {
    label: "Research refresh",
    pick: (c) => `${c.researchRefreshDays} days`,
    hint: "How often the ATT&CK/rule feeds are re-pulled (§12.1).",
  },
];

export function CyberLabPanel() {
  const [status, setStatus] = useState<CyberLabStatus | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/cyberlab/status");
      if (!res.ok) throw new Error("Couldn’t load the Cyber Lab status.");
      const data = (await res.json()) as CyberLabStatus;
      setStatus(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn’t load the Cyber Lab status.");
    }
  }, []);

  // House pattern (cf. components/hosting-panel.tsx): fire-and-forget on mount.
  useEffect(() => {
    void load();
  }, [load]);

  if (error) {
    return <div className="p-6 text-sm text-red-600 dark:text-red-400">{error}</div>;
  }
  if (!status) {
    return <div className="p-6 text-sm text-zinc-500">Loading Cyber Lab…</div>;
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">Cyber Lab</h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Real-world offensive and defensive tooling on isolated ranges — every run attested and evidence-trailed.
        </p>
      </header>

      {!status.enabled && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          The Cyber Lab isn’t switched on yet. Existing tools keep working exactly as before.
        </div>
      )}
      {!status.entitled && (
        <div className="rounded-md border border-zinc-300 bg-zinc-50 px-3 py-2 text-sm text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
          Cyber Lab access isn’t included on your account yet.
        </div>
      )}

      {/* §7 C0 — the AUP gate. Only shown to a user who can actually use the lab
          (entitled): a user who cannot use it is not asked to sign. */}
      {status.entitled && !status.gate.consented && <CyberLabAup onAccepted={load} />}

      {status.entitled && status.gate.consented && (
        <div className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
          Acceptable-use policy v{status.gate.termsVersion} accepted
          {status.gate.consentedAt ? ` on ${new Date(status.gate.consentedAt).toLocaleDateString()}` : ""}.
        </div>
      )}

      <section className="rounded-lg border border-dashed border-zinc-300 p-4 text-sm text-zinc-600 dark:border-zinc-700 dark:text-zinc-300">
        <p className="font-medium text-zinc-900 dark:text-zinc-100">Not available yet</p>
        <p className="mt-1">
          The lab engine (isolated ranges, the abuse sentinel, the evidence chain) is being built. The settings below
          are the live load envelope your admin controls — they are shown so nothing about the lab’s capacity is hidden.
        </p>
      </section>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {CAP_ROWS.map((row) => (
          <div key={row.label} className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
            <div className="text-xs uppercase tracking-wide text-zinc-500">{row.label}</div>
            <div className="mt-1 text-lg font-medium text-zinc-900 dark:text-zinc-100">{row.pick(status.caps)}</div>
            <div className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">{row.hint}</div>
          </div>
        ))}
      </section>
    </div>
  );
}
