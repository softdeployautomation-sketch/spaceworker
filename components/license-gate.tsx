"use client";

import { useEffect, useState } from "react";

import { Badge, Button, Card, Input, Label, Spinner } from "@/components/ui";

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
//     a "Buy a license" link that deep-links back to the landing page's store.
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
  /** Deep link to the landing page's store section. Defaults to the homepage store. */
  buyHref?: string;
  /** The dashboard UI to render while licensed or in trial. */
  children: React.ReactNode;
}

export function LicenseGate({ build, buyHref = "/#store", children }: LicenseGateProps) {
  const [status, setStatus] = useState<Status>({ mode: "loading" });
  const [licenseKey, setLicenseKey] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [activating, setActivating] = useState(false);

  async function activate() {
    setError("");
    setActivating(true);
    try {
      const res = await fetch("/api/exe-license/activate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ licenseKey, email }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.licensed) {
        setStatus({ mode: "ok" });
      } else {
        setError(typeof data.error === "string" ? data.error : "Activation failed. Check the key and email and try again.");
      }
    } catch {
      setError("Network error — could not reach the local licensing service.");
    } finally {
      setActivating(false);
    }
  }

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

        <div className="mt-5 space-y-4">
          <div>
            <Label htmlFor="exe-license-key">License key</Label>
            <Input
              id="exe-license-key"
              type="text"
              autoComplete="off"
              spellCheck={false}
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

          {error && (
            <p className="text-sm text-red-600 dark:text-red-400" role="alert">
              {error}
            </p>
          )}

          <div className="flex items-center justify-between gap-3">
            <a
              href={buyHref}
              className="text-sm font-medium text-brand-600 hover:text-brand-700 hover:underline"
            >
              Buy a license →
            </a>
            <Button variant="primary" type="button" onClick={activate} disabled={activating}>
              {activating ? "Activating…" : "Activate"}
            </Button>
          </div>
        </div>
      </Card>

      <p className="mt-4 max-w-md text-center text-xs text-fg-muted">
        Activation happens on this computer and works offline — no account or internet connection required.
      </p>
    </div>
  );
}