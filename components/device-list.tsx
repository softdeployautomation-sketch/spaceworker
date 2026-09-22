"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Activity, Moon, Monitor, PlugZap, RefreshCw, Search } from "lucide-react";

import { PanicButton } from "@/components/panic-button";
import { cn } from "@/lib/cn";

// Task 95 — Devices v2 list, ScreenConnect-style session grid. ONE device =
// ONE row with ONE status (from /api/devices only, derived from OUR heartbeat
// age — the old page also rendered the Vantra-sync view, so a machine showed
// twice with two statuses). Row click → /dashboard/devices/[deviceId].

type DeviceRow = {
  id: string;
  name: string;
  deviceKind: string;
  status: string;
  osName: string | null;
  osVersion: string | null;
  lastSeenAt: string | null;
};

function relTime(iso: string | null): string {
  if (!iso) return "never";
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} hr ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

function osLabel(d: DeviceRow): string {
  const name = (d.osName ?? "").toLowerCase();
  if (name.includes("win")) return "Windows";
  if (name.includes("mac") || name.includes("darwin") || name.includes("os x")) return "macOS";
  if (name.includes("linux")) return "Linux";
  return d.osName || "Unknown";
}

type Filter = "all" | "online" | "offline";

export function DeviceList() {
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [link, setLink] = useState<{
    status: string;
    installUrl: string | null;
    lastError: string | null;
  } | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const loadLink = useCallback(async () => {
    try {
      const res = await fetch("/api/assistant/vantra");
      if (!res.ok) return;
      const data = await res.json();
      setLink(
        data.link
          ? { status: data.link.status, installUrl: data.link.installUrl, lastError: data.link.lastError }
          : null,
      );
    } catch {
      // non-fatal — the list still renders without the link panel
    }
  }, []);

  const load = useCallback(async () => {
    setError("");
    try {
      const res = await fetch("/api/devices");
      if (!res.ok) throw new Error("Failed to load devices");
      const data = await res.json();
      setDevices(
        (data.devices ?? []).map((d: { effectiveStatus?: string; status?: string } & DeviceRow) => ({
          ...d,
          status: d.effectiveStatus ?? d.status ?? "unknown",
        })),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load devices");
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    load();
    loadLink();
  }, [load, loadLink]);

  async function enable() {
    setBusy("enable");
    setError("");
    try {
      const res = await fetch("/api/assistant/vantra", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : "Enable failed");
      await loadLink();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Enable failed");
    } finally {
      setBusy("");
    }
  }

  async function mintInstallLink() {
    setBusy("install");
    setError("");
    try {
      const res = await fetch("/api/assistant/vantra/install-link", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok)
        throw new Error(typeof data.error === "string" ? data.error : "Couldn't mint install link");
      setLink((prev) =>
        prev ? { ...prev, installUrl: data.link.installUrl, status: data.link.status } : prev,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't mint install link");
    } finally {
      setBusy("");
    }
  }

  async function copyInstallLink() {
    if (!link?.installUrl) return;
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${link.installUrl}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard unavailable — the URL stays visible for manual copy
    }
  }

  const counts = useMemo(() => {
    const online = devices.filter((d) => d.status === "online" || d.status === "asleep").length;
    return { all: devices.length, online, offline: devices.length - online };
  }, [devices]);

  const visible = useMemo(() => {
    let rows = devices;
    if (filter === "online") rows = rows.filter((d) => d.status === "online" || d.status === "asleep");
    if (filter === "offline") rows = rows.filter((d) => d.status !== "online" && d.status !== "asleep");
    const q = query.trim().toLowerCase();
    if (q) rows = rows.filter((d) => `${d.name} ${d.osName ?? ""}`.toLowerCase().includes(q));
    return rows;
  }, [devices, filter, query]);

  const statusWord = (s: string) => (s === "asleep" ? "asleep" : s === "online" ? "online" : "offline");

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-fg">Devices</h1>
          <p className="mt-1 text-sm text-fg-muted">
            Your machines and their live status. Remote tools live in each machine&apos;s console.
          </p>
        </div>
        <PanicButton />
      </div>

      {error && <p className="text-sm text-red-500">{error}</p>}

      {/* ScreenConnect-style toolbar: tabs + filter + refresh */}
      <div className="rounded-xl border border-border bg-bg-elevated">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="flex items-center gap-1">
            {(
              [
                ["all", `All (${counts.all})`],
                ["online", `Online (${counts.online})`],
                ["offline", `Offline (${counts.offline})`],
              ] as Array<[Filter, string]>
            ).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setFilter(key)}
                className={cn(
                  "rounded-md px-3 py-1.5 text-sm transition-colors",
                  filter === key
                    ? "bg-black/10 font-medium text-fg dark:bg-white/10"
                    : "text-fg-muted hover:bg-black/5 hover:text-fg dark:hover:bg-white/5",
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <label className="relative block">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-muted" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter machines"
                className="w-44 rounded-md border border-border bg-bg py-1.5 pl-8 pr-2 text-sm text-fg placeholder:text-fg-muted/70 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30"
              />
            </label>
            <button
              onClick={() => {
                load();
                loadLink();
              }}
              title="Refresh"
              className="rounded-md border border-border p-2 text-fg-muted transition-colors hover:text-fg"
            >
              <RefreshCw className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="flex items-center gap-4 px-4 py-2 text-xs text-fg-muted">
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" /> online
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full bg-amber-400" /> asleep
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full bg-zinc-400" /> offline
          </span>
        </div>

        {!loaded ? (
          <p className="px-4 py-6 text-sm text-fg-muted">Loading machines…</p>
        ) : visible.length === 0 ? (
          <p className="px-4 py-6 text-sm text-fg-muted">
            {devices.length === 0
              ? "No machines yet — install the agent below to add your first one."
              : "No machines match this filter."}
          </p>
        ) : (
          <div>
            {visible.map((d) => {
              const online = d.status === "online" || d.status === "asleep";
              const dot =
                d.status === "online"
                  ? "bg-emerald-500"
                  : d.status === "asleep"
                    ? "bg-amber-400"
                    : "bg-zinc-400";
              return (
                <Link
                  key={d.id}
                  href={`/dashboard/devices/${d.id}`}
                  className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-border px-4 py-3 transition-colors last:border-b-0 hover:bg-black/5 md:grid-cols-[minmax(0,1fr)_140px_150px_130px_36px] dark:hover:bg-white/5"
                >
                  <span className="flex min-w-0 items-center gap-2.5">
                    {online ? (
                      <Monitor className="h-4 w-4 shrink-0 text-fg-muted" />
                    ) : (
                      <Moon className="h-4 w-4 shrink-0 text-fg-muted" />
                    )}
                    <span className="truncate font-mono text-sm text-fg">{d.name}</span>
                  </span>
                  <span className="hidden text-sm text-fg-muted md:block">{osLabel(d)}</span>
                  <span className="flex items-center gap-2 text-sm">
                    <span className={cn("inline-block h-2.5 w-2.5 shrink-0 rounded-full", dot)} />
                    <span className={cn(online ? "text-emerald-500" : "text-fg-muted")}>
                      {statusWord(d.status)}
                    </span>
                  </span>
                  <span className="hidden text-sm text-fg-muted md:block">{relTime(d.lastSeenAt)}</span>
                  <span className="hidden justify-end md:flex">
                    {online ? (
                      <PlugZap className="h-4 w-4 text-fg-muted" />
                    ) : (
                      <Activity className="h-4 w-4 text-fg-muted/60" />
                    )}
                  </span>
                </Link>
              );
            })}
          </div>
        )}
      </div>


      {/* Add-a-device: collapsed by default; carries the one-time install link */}
      <div className="rounded-xl border border-border bg-bg-elevated">
        <button
          onClick={() => setAdding((v) => !v)}
          className="flex w-full items-center justify-between px-4 py-3 text-left"
        >
          <span className="text-sm font-medium text-fg">Add a device</span>
          <span className="text-xs text-fg-muted">{adding ? "hide" : "show"}</span>
        </button>
        {adding && (
          <div className="border-t border-border px-4 py-4">
            {link === null ? (
              <div>
                <p className="text-sm text-fg-muted">
                  Link your SpaceWorker account to the device agent service, then install the agent
                  on the machine you want to reach.
                </p>
                <button
                  onClick={enable}
                  disabled={busy === "enable"}
                  className="mt-3 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-700 disabled:opacity-60"
                >
                  {busy === "enable" ? "Enabling…" : "Enable device link"}
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                <p className="text-sm text-fg-muted">
                  1 · Mint a one-time install link &nbsp;·&nbsp; 2 · Run it on the target machine
                  &nbsp;·&nbsp; 3 · It appears here on first heartbeat.
                </p>
                {!link.installUrl ? (
                  <button
                    onClick={mintInstallLink}
                    disabled={busy === "install"}
                    className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-700 disabled:opacity-60"
                  >
                    {busy === "install" ? "Minting…" : "Mint install link"}
                  </button>
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="max-w-full truncate rounded bg-bg px-2 py-1.5 text-xs text-fg-muted">
                      {`${typeof window !== "undefined" ? window.location.origin : ""}${link.installUrl}`}
                    </code>
                    <button
                      onClick={copyInstallLink}
                      className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-fg transition-colors hover:bg-black/5 disabled:opacity-50 dark:hover:bg-white/5"
                      disabled={copied}
                    >
                      {copied ? "Copied ✓" : "Copy link"}
                    </button>
                    <button
                      onClick={mintInstallLink}
                      disabled={busy === "install"}
                      className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-fg-muted transition-colors hover:text-fg disabled:opacity-50"
                    >
                      {busy === "install" ? "Minting…" : "New link"}
                    </button>
                  </div>
                )}
                <p className="text-xs text-fg-muted">
                  One-time link, valid 72 hours — shown once, run it on the machine you want linked.
                </p>
                {link.status === "pending_install" && (
                  <p className="text-xs text-amber-500">
                    Waiting for install — the machine appears here the moment the agent checks in.
                  </p>
                )}
                {link.lastError && <p className="text-xs text-red-500">Sync error: {link.lastError}</p>}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}


