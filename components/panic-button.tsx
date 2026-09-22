"use client";

import { useState } from "react";

import { Button } from "@/components/ui";

// Task 92 — THE panic switch (plan CROSS-TRACK RULE 6: one operation stops
// pending device actions, jobs, and proposals together). Confirm-first; the
// endpoint is idempotent and every sweep is audited.

export function PanicButton() {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function fire() {
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/devices/panic", { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        expiredProposals?: number;
        cancelledJobs?: number;
        cancelledActions?: number;
      };
      if (!res.ok) {
        setResult(data.error ?? "Panic stop failed — try again.");
      } else {
        setResult(
          `Stopped: ${data.expiredProposals ?? 0} proposal(s), ${data.cancelledJobs ?? 0} job(s), ${data.cancelledActions ?? 0} action(s).`,
        );
      }
    } catch {
      setResult("Network error — try again.");
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex gap-2">
        {confirming ? (
          <>
            <Button type="button" variant="danger" disabled={busy} onClick={() => void fire()}>
              {busy ? "Stopping…" : "Confirm: stop everything"}
            </Button>
            <Button type="button" variant="secondary" disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <Button type="button" variant="danger" onClick={() => setConfirming(true)}>
            Panic stop
          </Button>
        )}
      </div>
      {result ? <p className="text-xs text-fg-muted">{result}</p> : null}
    </div>
  );
}