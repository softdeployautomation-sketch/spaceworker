"use client";

import { useCallback, useEffect, useState } from "react";

import { Badge, Card, Spinner } from "@/components/ui";
import { LicenseActivationForm } from "@/components/license-activation-form";

// EXE-only License panel for the Settings page (Task 27 Part B). Shown only when
// the app runs as a desktop build (isLocalExeRuntime — gated in the server page);
// the hosted web dashboard never renders it.
//
// It calls the same local POST /api/exe-license/status & /activate routes the
// <LicenseGate> uses, so a user on the silent 24h trial who already has a real
// key can activate immediately (replacing the trial state with a real license)
// instead of waiting the clock out — exactly the pre-launch / test-while-trial
// scenario this section exists for.
type LicenseStatus =
  | { mode: "loading" }
  | {
      mode: "licensed";
      licensee?: string;
      plan?: string;
      expiresAt?: string;
      expiresAtDate?: string;
    }
  | { mode: "inTrial"; trialHoursLeft?: number; trialEndsAt?: string }
  | { mode: "expired"; message?: string };

/** Formats an ISO timestamp for display; falls back to "never" when absent/invalid. */
function formatExpiry(iso?: string): string {
  if (!iso) return "never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "never";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Fetches the local license status without touching component state. */
async function fetchLicenseStatus(): Promise<LicenseStatus> {
  try {
    const res = await fetch("/api/exe-license/status", { method: "POST" });
    const data = await res.json().catch(() => ({}));
    if (data.licensed) {
      return {
        mode: "licensed",
        licensee: typeof data.licensee === "string" ? data.licensee : undefined,
        plan: typeof data.plan === "string" ? data.plan : undefined,
        expiresAt: typeof data.expiresAt === "string" ? data.expiresAt : undefined,
        expiresAtDate: typeof data.expiresAtDate === "string" ? data.expiresAtDate : undefined,
      };
    }
    if (data.inTrial) {
      return {
        mode: "inTrial",
        trialHoursLeft: typeof data.trialHoursLeft === "number" ? data.trialHoursLeft : undefined,
        trialEndsAt: typeof data.trialEndsAt === "string" ? data.trialEndsAt : undefined,
      };
    }
    return {
      mode: "expired",
      message: typeof data.message === "string" ? data.message : undefined,
    };
  } catch {
    return { mode: "expired", message: "Could not confirm your license status." };
  }
}

export function ExeLicensePanel({ buyHref }: { buyHref: string }) {
  const [status, setStatus] = useState<LicenseStatus>({ mode: "loading" });

  // Re-fetch after an activation/replacement (called from event handlers only).
  const refresh = useCallback(async () => {
    setStatus(await fetchLicenseStatus());
  }, []);

  useEffect(() => {
    void (async () => {
      setStatus(await fetchLicenseStatus());
    })();
  }, []);

  return (
    <Card className="max-w-2xl p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-fg">License</h2>
          <p className="mt-1 text-sm text-fg-muted">
            License key and trial status for this device.
          </p>
        </div>
        {status.mode === "licensed" && <Badge tone="success">Licensed</Badge>}
        {status.mode === "inTrial" && <Badge tone="warning">Trial</Badge>}
        {status.mode === "expired" && <Badge tone="danger">Trial expired</Badge>}
      </div>

      {status.mode === "loading" ? (
        <div className="mt-4 flex items-center gap-2 text-sm text-fg-muted">
          <Spinner /> Checking license status…
        </div>
      ) : status.mode === "licensed" ? (
        <div className="mt-4">
          <p className="text-sm text-fg">
            {status.plan ? `${status.plan} plan` : "Activated"} — expires{" "}
            <span className="tabular-nums">{formatExpiry(status.expiresAtDate)}</span>
          </p>
          {status.licensee && (
            <p className="mt-1 text-sm text-fg-muted">Licensed to {status.licensee}</p>
          )}

          <hr className="my-4 border-border" />
          <p className="text-sm text-fg-muted">
            Already activated on this device. Paste a different key below to replace it.
          </p>
          <div className="mt-3">
            <LicenseActivationForm
              onActivated={() => {
                setStatus({ mode: "loading" });
                void refresh();
              }}
              submitLabel="Replace license"
            />
          </div>
        </div>
      ) : status.mode === "inTrial" ? (
        <div className="mt-4">
          <p className="text-sm text-fg">
            Expires in{" "}
            <span className="tabular-nums">{Math.max(0, Math.ceil(status.trialHoursLeft ?? 0))}h</span>
            {" "}({formatExpiry(status.trialEndsAt)})
          </p>

          <hr className="my-4 border-border" />
          <p className="text-sm text-fg-muted">
            Already have a license key? Activate now to unlock the full version — no need to wait
            for the trial to run out.
          </p>
          <div className="mt-3">
            <LicenseActivationForm
              onActivated={() => {
                setStatus({ mode: "loading" });
                void refresh();
              }}
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
        </div>
      ) : (
        <div className="mt-4">
          <p className="text-sm text-fg-muted">
            {status.message ??
              "Your 24-hour trial has ended. Activate with the license key emailed when you purchased it."}
          </p>
          <div className="mt-3">
            <LicenseActivationForm
              onActivated={() => {
                setStatus({ mode: "loading" });
                void refresh();
              }}
              autoFocus
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
        </div>
      )}
    </Card>
  );
}