"use client";

import { useCallback, useEffect, useState } from "react";

import { CyberLabAup } from "@/components/cyberlab-aup";
import { ModuleToolLockCard } from "@/components/module-tool-lock";

// TASK_156 C1 — the Cyber Lab tab, now carrying the REAL gate (§12.9), the C0
// AUP onboarding (§7 C0), and the C2a console (§7 C2 item 5).
//
// Honest and deliberately small: the gate state, the entitlement, the AUP and
// the load envelope are all real reads. Behind `gate.open` the C2a console
// offers the ONE dry-run scenario against attested targets — synthetic
// telemetry, signed evidence episode, no live host until C2b (owner infra).
// It is the ONE door (§12.9): there is no staff badge and no staff gate.
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
    // eslint-disable-next-line react-hooks/set-state-in-effect -- every setState in load sits behind the fetch await, never synchronous (same accepted pattern as components/overview-stats-row.tsx)
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
      {/* TASK_184 A3 — the same lock card every other module shows. The AUP
          above stays gated on `entitled` (a user who can't use the lab is never
          asked to sign for it), and POST /api/cyberlab/consent refuses server-side
          regardless — this is the honest UI half of that one gate. */}
      {!status.entitled && (
        <ModuleToolLockCard moduleKey="cyberlab" entitled={status.entitled} />
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
        <p className="font-medium text-zinc-900 dark:text-zinc-100">Dry-run first — live ranges come with the lab hosts</p>
        <p className="mt-1">
          What runs today is a documented <strong>dry-run</strong>: attested-target pre-flight, an isolated range lifecycle with a
          hard TTL, and a signed, append-only evidence episode — produced from <strong>synthetic</strong> telemetry that is labelled
          as such in every artefact. No packet leaves the platform and no real host is touched. Live execution on the lab
          hosts is the next phase and reuses this exact gate → pre-flight → range → evidence chain.
        </p>
        <p className="mt-2">
          Attesting a target is your declaration that you own or are authorised for it — the platform can only verify
          ownership inside its own lab ranges.
        </p>
      </section>

      {/* TASK_156B UI-1 — the dashboard keeps a LAUNCHER card (PLAN §3: the
          interactive console moved to its own top-level /cyberlab section).
          The launcher appears ONLY when the server-side gate is fully open
          (enabled && entitled && consented) — a user who hasn't accepted the
          AUP never gets a door. The gate itself is still re-checked on every
          /api/cyberlab/* call, so this is UX, never the security boundary. */}
      {status.gate.open && (
        <a
          href="/cyberlab"
          className="block rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-900 transition-colors hover:bg-emerald-100 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200 dark:hover:bg-emerald-900"
        >
          <span className="font-medium">Open the Operation Console →</span>
          <span className="mt-0.5 block text-xs opacity-80">
            Scenarios, attested targets, the radial-rings console and signed evidence episodes — in its own section.
          </span>
        </a>
      )}

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
