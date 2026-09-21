"use client";

import { useEffect, useState } from "react";

import { Badge, Button, Card, Input, Label, Spinner } from "@/components/ui";
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
//
// Task 58 (2026-09-21) — the owner's direction replaces the anonymous silent
// trial with an email-first flow: a brand-new machine has NO trial on the server
// yet, so /api/exe-license/status answers `requiresEmail` and THIS gate blocks
// the dashboard with a one-time email prompt before rendering anything. Only
// after the user submits a valid email (POST /api/exe-license/trial-start, which
// is the required/awaited call that creates the server ExeTrialSession and
// persists the authoritative startedAt locally) does the app proceed to `ok`.
// A returning machine whose local file was deleted (or an already-started/active
// trial) is reflected its TRUE server start by status and skips this prompt
// entirely — it is a one-time first-run step, not a nag on every launch.

type Status =
  | { mode: "loading" }
  | { mode: "ok" }
  | { mode: "requiresEmail" }
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
  // Task 58 — email-first first-run prompt. `requiresEmail` blocks the dashboard
  // until the user submits a valid email through the local trial-start route.
  const [email, setEmail] = useState("");
  const [emailError, setEmailError] = useState("");
  const [starting, setStarting] = useState(false);

  // Check the local license status on mount (licensed / already-started trial let
  // the dashboard through with no gate; a brand-new machine answers requiresEmail).
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/exe-license/status", { method: "POST" });
        const data = await res.json().catch(() => ({}));
        if (data.licensed || data.inTrial) {
          setStatus({ mode: "ok" });
        } else if (data.requiresEmail) {
          setStatus({ mode: "requiresEmail" });
        } else {
          setStatus({ mode: "expired", message: typeof data.message === "string" ? data.message : undefined });
        }
      } catch {
        // Offline and no local trial on file — the only way forward is the email
        // prompt, which itself will surface the connection error when submitted.
        setStatus({ mode: "requiresEmail" });
      }
    })();
  }, []);

  async function startTrial() {
    const value = email.trim();
    if (!value.includes("@")) {
      setEmailError("Enter a valid email to start your free trial.");
      return;
    }
    setStarting(true);
    setEmailError("");
    try {
      const res = await fetch("/api/exe-license/trial-start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: value }),
      });
      await res.json().catch(() => ({}));
      if (!res.ok) {
        setEmailError("Couldn't start your trial yet. Check your connection and try again.");
        setStarting(false);
        return;
      }
      // Trial started — re-read status so the just-landed trial reads as inTrial
      // (the authoritative startedAt was persisted locally by trial-start).
      const sres = await fetch("/api/exe-license/status", { method: "POST" });
      const sdata = await sres.json().catch(() => ({}));
      if (sdata.licensed || sdata.inTrial) setStatus({ mode: "ok" });
      else setStatus({ mode: "expired" });
    } catch {
      setEmailError("Network error. Check your internet connection and try again.");
    } finally {
      setStarting(false);
    }
  }

  if (status.mode === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner className="text-brand-600" />
      </div>
    );
  }

  // Brand-new machine with no server record yet: block the dashboard behind the
  // one-time, required email prompt (Task 58 — no more anonymous first launch).
  if (status.mode === "requiresEmail") {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center px-6">
        <Card className="w-full max-w-md p-6">
          <div className="flex items-center justify-between">
            <h1 className="text-xl font-bold text-fg">SpaceWorker OS</h1>
            <Badge tone="warning">Free trial</Badge>
          </div>
          <p className="mt-2 text-sm text-fg-muted">
            Start your free 24-hour trial of the {build} edition. Enter your email
            to begin — your trial stays tied to this device.
          </p>

          <div className="mt-5 space-y-3">
            <div>
              <Label htmlFor="trial-email">Email address</Label>
              <Input
                id="trial-email"
                type="email"
                autoComplete="email"
                placeholder="you@example.com"
                value={email}
                autoFocus
                disabled={starting}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setEmailError("");
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !starting) void startTrial();
                }}
              />
            </div>
            {emailError && <p className="text-sm text-red-600 dark:text-red-400">{emailError}</p>}
            <Button type="button" className="w-full" disabled={starting} onClick={() => void startTrial()}>
              {starting ? "Starting trial…" : "Start free trial"}
            </Button>
          </div>
        </Card>

        <p className="mt-4 max-w-md text-center text-xs text-fg-muted">
          We'll use this email to deliver your license key when you upgrade — never
          for anything else. An internet connection is needed once, to start the trial.
        </p>
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