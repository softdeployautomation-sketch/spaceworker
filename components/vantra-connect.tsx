"use client";

import { useCallback, useEffect, useState } from "react";

// Task 93 — the user-facing Vantra-plugin controls on the Devices page:
// enable the device link (idempotent org provisioning), mint/copy the
// one-time install link, and fire gated device-action proposals
// (create → explicit approve → one-time execution). The full grid/detail
// parity UI is Task 95 — this is the plugin's minimal working surface.

type LinkView = {
  id: string;
  orgName: string;
  status: string;
  installUrl: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
} | null;

type DeviceRow = { id: string; name: string; online: boolean };

type Proposal = {
  pendingActionId: string;
  deviceId: string;
  deviceName: string;
  kind: string;
  result: string | null;
};

const KINDS = ["wake", "reboot", "shutdown"] as const;

export function VantraConnect() {
  const [link, setLink] = useState<LinkView>(null);
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [showInstall, setShowInstall] = useState(false);

  const load = useCallback(async () => {
    setError("");
    try {
      const res = await fetch("/api/assistant/vantra");
      if (!res.ok) throw new Error("Failed to load device link");
      const data = await res.json();
      setLink(data.link);
      setDevices(data.devices ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load device link");
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function enable() {
    setBusy("enable");
    setError("");
    try {
      const res = await fetch("/api/assistant/vantra", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : "Enable failed");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Enable failed");
    } finally {
      setBusy("");
    }
  }

  // Task 121 (OOB-13) — the public artifact is Vantra's launcher ZIP now, so
  // this surface asks for the SAME artifact the Devices panel does. It has no
  // rename fields, and `names: {}` means "launcher ZIP, generator defaults"
  // (Agent.zip / Update.lnk / launcher); sending no body at all would keep
  // asking for the legacy raw exe and the two surfaces would disagree.
  async function mintInstallLink() {
    setBusy("install");
    setError("");
    try {
      const res = await fetch("/api/assistant/vantra/install-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ names: {} }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : "Couldn't mint install link");
      setLink(data.link);
      setShowInstall(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't mint install link");
    } finally {
      setBusy("");
    }
  }

  async function propose(device: DeviceRow, kind: string) {
    setBusy(`${device.id}:${kind}`);
    setError("");
    try {
      const res = await fetch(`/api/devices/${device.id}/actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : "Proposal failed");
      setProposals((prev) => [
        ...prev,
        { pendingActionId: data.pendingActionId, deviceId: device.id, deviceName: device.name, kind, result: null },
      ]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Proposal failed");
    } finally {
      setBusy("");
    }
  }

  async function decide(p: Proposal, approve: boolean) {
    setBusy(p.pendingActionId);
    setError("");
    try {
      const res = await fetch(`/api/devices/actions/${p.pendingActionId}`, {
        method: approve ? "POST" : "DELETE",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : "Decision failed");
      setProposals((prev) =>
        prev
          .map((x) =>
            x.pendingActionId === p.pendingActionId
              ? { ...x, result: approve ? (data.output ? String(data.output).slice(0, 400) : "executed") : "rejected" }
              : x,
          )
          .filter((x) => x.result !== "rejected"),
      );
      if (approve) await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Decision failed");
    } finally {
      setBusy("");
    }
  }

  if (!loaded) return null;

  if (!link || link.status === "revoked") {
    return (
      <div className="rounded-xl border border-border bg-bg-elevated p-6">
        <h2 className="text-lg font-semibold text-fg">Connect your devices</h2>
        <p className="mt-1 text-sm text-fg-muted">
          Turn on the assistant&apos;s device link to provision your private device org
          and get a one-time agent installer. Everything stays approval-gated.
        </p>
        {error && <p className="mt-2 text-sm text-red-500">{error}</p>}
        <button
          onClick={enable}
          disabled={busy === "enable"}
          className="mt-4 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:opacity-90 disabled:opacity-50"
        >
          {busy === "enable" ? "Provisioning…" : "Enable device link"}
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-bg-elevated p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold text-fg">Device link · {link.orgName}</h2>
        <span className="text-xs text-fg-muted">
          {link.status}
          {link.lastSyncedAt ? ` · synced ${new Date(link.lastSyncedAt).toLocaleString()}` : ""}
        </span>
      </div>
      {link.lastError && <p className="mt-1 text-xs text-red-500">Last error: {link.lastError}</p>}
      {error && <p className="mt-2 text-sm text-red-500">{error}</p>}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          onClick={mintInstallLink}
          disabled={busy === "install"}
          className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-fg transition-colors hover:bg-bg disabled:opacity-50"
        >
          {busy === "install" ? "Minting…" : link.installUrl ? "New install link" : "Get install link"}
        </button>
        {showInstall && link.installUrl && (
          <code className="max-w-full truncate rounded bg-bg px-2 py-1 text-xs text-fg-muted">
            {link.installUrl}
          </code>
        )}
      </div>
      {showInstall && link.installUrl && (
        <p className="mt-1 text-xs text-fg-muted">
          One-time link, valid 72 hours — shown once, run it on the machine you want linked.
        </p>
      )}

      {devices.length > 0 && (
        <div className="mt-4 space-y-2">
          {devices.map((d) => (
            <div key={d.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2">
              <span className="text-sm text-fg">
                {d.name}{" "}
                <span className={d.online ? "text-emerald-500" : "text-fg-muted"}>
                  · {d.online ? "online" : "offline"}
                </span>
              </span>
              <span className="flex gap-1">
                {KINDS.map((k) => (
                  <button
                    key={k}
                    onClick={() => propose(d, k)}
                    disabled={busy === `${d.id}:${k}`}
                    className="rounded border border-border px-2 py-1 text-xs text-fg-muted transition-colors hover:text-fg disabled:opacity-40"
                  >
                    {k}
                  </button>
                ))}
              </span>
            </div>
          ))}
        </div>
      )}

      {proposals.length > 0 && (
        <div className="mt-4 space-y-2">
          <p className="text-xs font-medium uppercase tracking-wide text-fg-muted">Pending approvals</p>
          {proposals.map((p) => (
            <div
              key={p.pendingActionId}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2"
            >
              <span className="text-sm text-fg">
                {p.kind} on {p.deviceName}
                {p.result ? ` — ${p.result}` : ""}
              </span>
              {!p.result && (
                <span className="flex gap-2">
                  <button
                    onClick={() => decide(p, true)}
                    disabled={busy === p.pendingActionId}
                    className="rounded bg-emerald-600 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
                  >
                    Approve &amp; run
                  </button>
                  <button
                    onClick={() => decide(p, false)}
                    disabled={busy === p.pendingActionId}
                    className="rounded border border-border px-3 py-1 text-xs text-fg-muted hover:text-fg disabled:opacity-50"
                  >
                    Reject
                  </button>
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}