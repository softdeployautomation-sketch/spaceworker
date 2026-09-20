"use client";

import { useEffect, useState } from "react";

import { Badge, Card, Spinner } from "@/components/ui";
import { LicenseActivationForm } from "@/components/license-activation-form";

// The shared licensing/activation gate — ONE component compiled identically into
// all four desktop EXE builds (Extractor / Mailer / Combined / Automation-
// enabled), per Task 27 Part A §"Licensing gate UI". Only the dashboard rendered
// behind it differs per build; the gate itself has zero build-specific code.
//
// Behaviour (Part A):
//   - First launch / during the silent 24h trial -> NO gate. The app opens
//     straight into the dashboard and the local trial timer starts behind it.
//   - Trial exhausted (this machine, reported by POST /api/exe-license/status)
//     -> the gate blocks the dashboard with License key + Email + Activate, plus
//     a "Get a license" link out to the real website's pricing page. `buyHref`
//     is resolved by the (server) caller via accountHref() — lib/exe-runtime.ts
//     is `server-only`, so this client component can't call it itself — so a
//     locked-out buyer can go buy/manage a license there instead of dead-ending
//     inside the app (2026-09-19).
//
// Backed by the local runtime (no server round-trip for validation): status and
// activate hit the app's own /api/exe-license/* routes, which validate offline
// with the embedded signing secret and persist locally.

type Status =
  | { mode: "loading" }
  | { mode: "ok" }
  | { mode: "expired"; message?: string };

export interface LicenseGateProps {
  /** Tier slug passed by the EXE shell: extractor | mailer | combined | automation. */
  build: string;
  /** Link out to get/manage a license — pass accountHref("/pricing") from a server caller. */
  buyHref: string;
  /** The dashboard UI to render while licensed or in trial. */
  children: React.ReactNode;
}

export function LicenseGate({ build, buyHref, children }: LicenseGateProps) {
  const [status, setStatus] = useState<Status>({ mode: "loading" });

  // Check the local license status on mount (first launch starts the 24h trial
  // silently; licensed/in-trial both let the dashboard through with no gate).
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/exe-license/status", { method: "POST" });
        const data = await res.json().catch(() => ({}));
        if (data.licensed || data.inTrial) {
          setStatus({ mode: "ok" });
        } else {
          setStatus({ mode: "expired", message: typeof data.message === "string" ? data.message : undefined });
        }
      } catch {
        setStatus({ mode: "expired", message: "Could not confirm your license status." });
      }
    })();
  }, []);

  if (status.mode === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner className="text-brand-600" />
      </div>
    );
  }

  // First launch / trial / active license: no gate — render the dashboard.
  if (status.mode === "ok") return <>{children}</>;

  // Trial exhausted: show the shared activation gate.
  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-6">
      <Card className="w-full max-w-md p-6">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-bold text-fg">SpaceWorker OS</h1>
          <Badge tone="warning">Trial expired</Badge>
        </div>
        <p className="mt-2 text-sm text-fg-muted">
          {status.message ??
            `Your 24-hour trial of the ${build} edition is over. Activate with the license key emailed when you purchased it, or grab a license in the store.`}
        </p>

        <div className="mt-5">
          <LicenseActivationForm
            onActivated={() => setStatus({ mode: "ok" })}
            autoFocus
            showBuyTab
            actionSlot={
              <a
                href={buyHref}
                target="_blank"
                rel="noreferrer"
                className="text-sm font-medium text-brand-600 hover:text-brand-700 hover:underline"
              >
                Get a license on the website →
              </a>
            }
          />
        </div>
      </Card>

      <p className="mt-4 max-w-md text-center text-xs text-fg-muted">
        Activation happens on this computer and works offline — no account or internet connection required.
      </p>
    </div>
  );
}