"use client";

import { useCallback, useEffect, useState } from "react";

import { cn } from "@/lib/cn";

type SessionPayload = {
  ok: boolean;
  cloneId: string;
  status: string;
  openUrl: string | null;
  session: {
    id: string;
    status: string;
    egressMode: string | null;
    startedAt: string;
    lastUsedAt: string | null;
    stoppedAt: string | null;
    expiresAt: string | null;
  };
  display: {
    browser: string;
    profileName: string | null;
    egressMode: string;
    source: { id: string; name: string; deviceStatus: string; online: boolean } | null;
    destination: { id: string; name: string; deviceStatus: string; online: boolean } | null;
    launchedAt: string | null;
    expiresAt: string | null;
    ttlRemainingMs: number | null;
    idleRemainingMs: number | null;
  };
};

const STEP_LABELS: Record<string, string> = {
  requested: "Requested",
  awaiting_source: "Waiting for your PC",
  capturing: "Reading your browser",
  captured: "Browser data captured",
  transferring: "Copying your browser",
  received: "Copy received",
  injecting: "Preparing your session",
  ready: "Almost ready",
  launching: "Starting your browser",
  active: "Ready",
  expired_idle: "Session expired",
  expired_hard: "Session expired",
  revoked: "Revoked",
  failed: "Could not start",
  deleted: "Deleted",
};

function stepLabel(status: string): string {
  return STEP_LABELS[status] ?? "Working on it";
}

function cleanSessionErr(value: unknown, fallback: string): string {
  if (typeof value !== "string" || !value) return fallback;
  const text = value
    .replace("vantra_503: ", "")
    .replace("vantra_404: ", "")
    .replace("vantra_500: ", "")
    .replace("clone_failed: ", "")
    .replace("session_failed: ", "")
    .trim();
  if (/<!DOCTYPE|<html/i.test(text)) return fallback;
  if (/^[a-z0-9_]+:/i.test(text)) {
    const human = text.replace(/^[a-z0-9_]+:\s*/i, "").trim();
    return human || fallback;
  }
  return text || fallback;
}

function countdown(ms: number | null): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  if (ms <= 0) return "expired";
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m} min left`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h} hr left` : `${Math.floor(h / 24)} d left`;
}

export function CloneSessionView({ cloneId }: { cloneId: string }) {
  const [data, setData] = useState<SessionPayload | null>(null);
  const [error, setError] = useState("");
  const [revoking, setRevoking] = useState(false);
  const [revoked, setRevoked] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/clones/${cloneId}/session`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(cleanSessionErr(body.reason ?? body.error, "The session is not ready yet — try again in a moment."));
        return;
      }
      const payload = body as SessionPayload;
      setData(payload);
      setError("");
      if (payload.status === "revoked") setRevoked(true);
    } catch {
      setError("The session is not ready yet — try again in a moment.");
    }
  }, [cloneId]);

  useEffect(() => {
    void load();
    const t = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      void load();
    }, 15000);
    return () => clearInterval(t);
  }, [load]);

  async function revoke() {
    setRevoking(true);
    setError("");
    try {
      const res = await fetch(`/api/clones/${cloneId}/revoke`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(cleanSessionErr(body.reason ?? body.error, "Could not revoke the clone"));
      }
      setRevoked(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not revoke the clone");
    } finally {
      setRevoking(false);
    }
  }

  const browser = data?.display.browser === "edge" ? "Edge" : data?.display.browser === "firefox" ? "Firefox" : "Chrome";
  const egressLine = data && data.display.egressMode === "direct"
    ? "SpaceWorker's IP — sites may ask you to sign in again"
    : "Same IP as your PC";
  const ready = data !== null && data.status === "active" && !!data.openUrl && !revoked;
  const headline = revoked ? "Revoked" : data ? stepLabel(data.status) : "Loading…";

  return (
    <div className="flex min-h-screen flex-col bg-bg text-fg">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2">
        <span className="flex min-w-0 items-center gap-2 text-sm">
          <span className={cn("inline-block h-2 w-2 shrink-0 rounded-full", ready ? "bg-emerald-500" : revoked ? "bg-zinc-400" : "bg-amber-400")} />
          <span className="truncate font-medium">{browser} clone · {headline}</span>
          {data && (
            <span className="hidden truncate text-xs text-fg-muted sm:inline">
              {egressLine} · TTL {countdown(data.display.ttlRemainingMs)}
            </span>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {!revoked && (
            <button
              onClick={revoke}
              disabled={revoking}
              className="rounded-lg border border-red-500/50 px-3 py-1.5 text-xs font-medium text-red-500 transition-colors hover:bg-red-500/10 disabled:opacity-50"
            >
              {revoking ? "Revoking…" : "Revoke"}
            </button>
          )}
          <button
            onClick={() => window.close()}
            className="rounded-lg border border-border px-3 py-1.5 text-xs text-fg-muted transition-colors hover:text-fg"
          >
            Close window
          </button>
        </span>
      </header>
      {error && <p className="border-b border-border px-4 py-2 text-sm text-red-500">{error}</p>}
      <main className="flex flex-1 flex-col">
        {revoked ? (
          <div className="flex flex-1 items-center justify-center p-8 text-center">
            <div>
              <p className="text-base font-medium">This clone is revoked.</p>
              <p className="mt-1 text-sm text-fg-muted">The hosted browser is closed. You can safely close this window.</p>
            </div>
          </div>
        ) : ready ? (
          <iframe
            src={data?.openUrl as string}
            title="Cloned browser session"
            className="h-[calc(100vh-49px)] w-full flex-1 border-0"
            allow="clipboard-read; clipboard-write"
          />
        ) : (
          <div className="flex flex-1 items-center justify-center p-8 text-center">
            <div>
              <p className="text-base font-medium">{headline}</p>
              <p className="mt-1 text-sm text-fg-muted">
                {data ? "The hosted browser is getting ready — this page updates itself." : "Loading the session…"}
              </p>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
