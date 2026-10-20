"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Activity,
  Moon,
  Monitor,
  Plus,
  PlugZap,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
} from "lucide-react";

import { useConfirm } from "@/components/confirm-provider";
import { PanicButton } from "@/components/panic-button";
import { useWrapperMode } from "@/components/wrapper-mode-context";
import { useSetAgentPageContext } from "@/lib/agent-page-context";
import { cn } from "@/lib/cn";
import { downloadTextFile } from "@/lib/download-text";
import { idleChipLabel, idleReadProvenanceFrom, type IdleReadProvenance } from "@/lib/device-idle";
import { onboardingRowLabel } from "@/lib/device-onboarding";
import {
  formatDownloadCount,
  formatInstallLinkCountdown,
} from "@/lib/install-link-countdown";

// Task 95 — Devices v2 list, ScreenConnect-style session grid. ONE device =
// ONE row with ONE status (from /api/devices only, derived from OUR heartbeat
// age — the old page also rendered the Vantra-sync view, so a machine showed
// twice with two statuses). Row click → /dashboard/devices/[deviceId].

type DeviceRow = {
  id: string;
  name: string;
  deviceKind: string;
  // TASK_230 P4b — the stable identity (already serialized by toDeviceView;
  // declared here so the client can apply the `node//` mesh-only discriminator
  // for capability gating). null only for a legacy row never linked to Vantra.
  vantraAgentId: string | null;
  status: string;
  osName: string | null;
  osVersion: string | null;
  lastSeenAt: string | null;
  // Task 106 (bit C1) — MeshCentral `idletime`, normalised to seconds by
  // Vantra (`/api/devices` enriches each row best-effort; null when unknown).
  idleSeconds: number | null;
  // TASK_128 — which org the agent is in ("public" | "private") and the visible
  // onboarding row (null when none). `isOnline` is computed server-side with
  // `isDeviceOnline(lastSeenAt)` so the strip's "waiting for the device" matches
  // the rest of the app without the client importing the server-only module.
  tier: string;
  onboarding: {
    status: string;
    timerStartedAt: string;
    hideDoneAt: string | null;
    stayOnDoneAt: string | null;
    releasedAt: string | null;
    hideLabel: string | null;
    destinationOrgId: string | null;
    lastError: string | null;
    isOnline: boolean;
    attempts: number;
  } | null;
};

// Task 121 — the artifact names a public mint sends. Mirrors `InstallerNames`
// in lib/vantra-link.ts (declared here instead of imported so this client
// component never pulls in the server-only module).
type InstallerNames = { zipName?: string; updateLinkName?: string; innerFolder?: string };

// TASK_171 — one row of public-link history, as the view carries it. Mirrors
// `InstallLinkHistoryItem` in lib/vantra-link.ts (declared here instead of
// imported so this client component never pulls in the server-only module).
type InstallLinkHistoryItem = {
  id: string;
  installUrl: string;
  installTokenExpiresAt: string;
  downloadCount: number;
  // TASK_179 D6 — "vbs" joins zip/exe: a share-link mint's row.
  installerKind: "zip" | "exe" | "vbs" | null;
  installerNames: InstallerNames | null;
  createdAt: string;
};

// TASK_154 N2 — `relTime` / `statusWord` / the idle chip moved to the ONE shared,
// client-safe helper (`lib/device-idle.ts`) so this list and the device console
// can no longer diverge. See that module for why (the bare-status flicker).

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
  // TASK_181 — the devices-only wrapper build (WRAPPER_MODE=devices): same
  // component, scoped down — no public/private vocabulary, no private path,
  // no Panic button; zip + PowerShell install paths stay web-only.
  const wrapper = useWrapperMode() !== null;
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
  // TASK_125 — the optional install-guide PDF (Vantra's Task 77/78 "FIX 5"),
  // the same option Vantra's own Add-a-device ZIP card offers: the PDF rides
  // INSIDE the zip and opens right after install. `pdfError` blocks the mint
  // (mirroring Vantra's modal) because a file the user explicitly picked must
  // never be silently dropped; `pdfAttached` is only for the post-mint chip,
  // since the bytes are forwarded to Vantra and never stored on our side.
  const [pdf, setPdf] = useState<File | null>(null);
  const [pdfError, setPdfError] = useState("");
  const [pdfAttached, setPdfAttached] = useState("");
  // TASK_178 stage 1 — which public flow the panel is showing (owner's
  // dropdown: ZIP / PowerShell / VBS / EXE — one method at a time so the
  // screen never shows every option at once). The private tier never uses
  // it: private stays PowerShell-only. TASK_181 — the wrapper build ships the
  // .vbs/EXE options only, so it starts on .vbs (zip/PowerShell are web-only).
  const [method, setMethod] = useState<"zip" | "powershell" | "vbs" | "exe">(
    wrapper ? "vbs" : "zip",
  );
  // The stage-1 file-rename field for the .vbs mint + its success chip.
  const [vbsName, setVbsName] = useState("");
  const [vbsSaved, setVbsSaved] = useState("");
  // TASK_179 stage 2 — the VBS card's OWN guide-PDF picker (separate from the
  // zip flow's `pdf` state so switching methods never carries a file across)
  // + the last minted share link. The file mint allows the full 20MB; a SHARE
  // link additionally caps at 2MB server-side (D3 — its bytes sit in the row)
  // with a plain-English error mapped at mint time.
  const [vbsPdf, setVbsPdf] = useState<File | null>(null);
  const [vbsPdfError, setVbsPdfError] = useState("");
  const [vbsLink, setVbsLink] = useState("");

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
    // TASK_171 — every public mint this user ever made, newest first (URL +
    // expiry + download count per row). Never carries the server-only
    // installerUrl — that stays in lib/vantra-link.ts.
    installLinks: InstallLinkHistoryItem[];
  } | null>(null);
  const [psRevealed, setPsRevealed] = useState(false);
  // TASK_128 §15 — the PUBLIC tier's PowerShell command (owner request: the
  // same convenience the private tier has). Held in memory only: the public
  // tier's primary artifact stays the shareable link, and Vantra does not store
  // this one (see `mintPublicPsCommand` in lib/vantra-link.ts).
  const [publicPs, setPublicPs] = useState<{ command: string; expiresAt: string } | null>(null);
  const [publicPsRevealed, setPublicPsRevealed] = useState(false);
  // TASK_128 §15 — which row's Delete is in flight (per-row spinner, so a slow
  // removal never freezes the whole list).
  const [removingId, setRemovingId] = useState("");
  const [movingId, setMovingId] = useState("");
  // TASK_234 B1 — the private install command the Move click minted, shown
  // until dismissed (masked until revealed, copy gated on reveal).
  // TASK_235 — `singleLine` is the relay-safe sibling (one line, no `$var =`
  // assignments) shown FIRST: it survives a paste into PowerShell AND the
  // public device terminal untouched; `command` (multiline) kept as fallback.
  const [moveInstruction, setMoveInstruction] = useState<{
    deviceName: string;
    command: string;
    singleLine: string;
    moved: boolean;
    // TASK_236 — the device id the plan belongs to (the verify call needs it)
    // and the verification state: "not_checked" (we haven't asked yet),
    // "checking", "verified" (private copy is live — the user may now delete
    // the public row THEMSELVES), or "not_verified" (private copy not seen yet
    // — the public row stays exactly where it is).
    deviceId: string;
    verifyState: "not_checked" | "checking" | "verified" | "not_verified";
    verifyMessage: string;
  } | null>(null);
  const [moveRevealed, setMoveRevealed] = useState(false);
  // TASK_224 — which history row's Delete is in flight (per-row busy state,
  // mirroring removingId above: a slow delete never freezes the other rows).
  const [deletingId, setDeletingId] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");
  // TASK_128 §15 — the in-app themed confirm (components/confirm-provider.tsx),
  // the same dialog the console uses, never `window.confirm`: removal is
  // irreversible, and a Private device carries an EXTRA warning (it lives on the
  // owner's private agent domain, not the shareable public one).
  const confirm = useConfirm();
  // TASK_128 — a 1-minute tick only re-renders the onboarding strip's live
  // countdown; it does NOT fetch. The countdown derives from the server's
  // timerStartedAt, so a reload never "jumps the clock back" (no websocket).
  const [nowMs, setNowMs] = useState(() => Date.now());
  // TASK_154 N2 — the bulk idle read's provenance (N1's additive `idle` field +
  // `onlineWindowMs`), so the shared chip can bound a latched reading against the
  // SERVER's offline window instead of inventing a second one on the client.
  const [idleRead, setIdleRead] = useState<IdleReadProvenance | null>(null);

  const loadLink = useCallback(async () => {
    try {
      // TASK_185 — no-store: bypasses any HTTP-cached entry (a maintenance
      // HTML replayed as JSON sticks for ~1.4 days under heuristic caching)
      // so a poisoned tab self-heals on the next poll without a hard refresh.
      const res = await fetch("/api/assistant/vantra", { cache: "no-store" });
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
              installLinks: Array.isArray(data.link.installLinks)
                ? data.link.installLinks.filter(
                    (item: unknown): item is InstallLinkHistoryItem =>
                      !!item && typeof item === "object" && typeof (item as { installUrl?: unknown }).installUrl === "string",
                  )
                : [],
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
      const res = await fetch("/api/devices", { cache: "no-store" });
      if (!res.ok) throw new Error("Failed to load devices");
      const data = await res.json();
      setIdleRead(idleReadProvenanceFrom(data));
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
  //
  // WHY THE DISABLE BELOW IS A FALSE POSITIVE (owner 2026-09-27: "what exactly
  // are this link errors you keep passing"). `react-hooks/set-state-in-effect`
  // fires on any function that transitively contains setState being INVOKED
  // directly in an effect body — it never checks that a setState actually runs
  // synchronously. Here none does: `refreshAll` is
  // `await loadLink(); await load();`, and every setState in that chain
  // (`setError` / `setDevices` / `setLoaded`) sits behind an await. Proven
  // against this repo's own eslint config (eslint-plugin-react-hooks 7.1.1)
  // with a three-case probe: an async loader called directly in the body is
  // flagged even when its only setState follows an await, while the IDENTICAL
  // loader reached via setInterval is clean. The rule stays armed repo-wide
  // otherwise, so a genuinely synchronous setState-in-effect is still caught.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- every setState in refreshAll is behind an await, not synchronous
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

  // TASK_128 — 1-minute tick for the onboarding strip/badge countdown. Separate
  // from the 20 s data poll on purpose: the time text must move even when the
  // list payload is unchanged.
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

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
    // TASK_125 — a PDF the user explicitly picked must never be silently
    // dropped, so a validation error blocks the mint instead of being ignored
    // (Vantra's modal refuses to submit for the same reason).
    if (kind === "public" && pdfError) {
      setError(pdfError);
      return;
    }
    setBusy(`install-${kind}`);
    setError("");
    try {
      // TASK_125 — the guide PDF is read to a data URL HERE, at mint time, so
      // a 20MB file is never held in state as base64 while the user types. The
      // values on screen are the values this mint uses — the same rule the
      // names already follow.
      let pdfBody: Record<string, string> = {};
      let pdfFileName = "";
      // TASK_178 — the guide PDF rides INSIDE the zip, so only the zip method
      // can attach it (exe/powershell/vbs never build a zip).
      if (kind === "public" && method === "zip" && pdf) {
        let dataUrl: string;
        try {
          dataUrl = await readFileAsDataUrl(pdf);
        } catch {
          setError("Couldn't read the install guide. Please re-select the PDF.");
          return;
        }
        pdfBody = { pdf: dataUrl, pdfName: pdf.name };
        pdfFileName = pdf.name;
      }
      const res = await fetch("/api/assistant/vantra/install-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          kind !== "public"
            ? { kind }
            : // TASK_178 — the method dropdown decides the artifact: EXE mints
              // with NO `names` key (the route's raw-exe branch — `{}` would
              // already mean "launcher ZIP with defaults", TASK_121); ZIP keeps
              // the names + the guide PDF. powershell/vbs never reach here.
              method === "exe"
                ? { kind }
                : { kind, names: names ?? {}, ...pdfBody },
        ),
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
              // TASK_171 — a fresh public mint prepends its own history row, so
              // the new link appears at the top without waiting for the 20 s
              // poll. The server is newest-first; trust its order, don't invent
              // one client-side.
              installLinks:
                kind === "private" || !Array.isArray(data.link.installLinks)
                  ? prev.installLinks
                  : data.link.installLinks.filter(
                      (item: unknown): item is InstallLinkHistoryItem =>
                        !!item && typeof item === "object" && typeof (item as { installUrl?: unknown }).installUrl === "string",
                    ),
            }
          : prev,
      );
      if (kind === "private") setPsRevealed(false);
      // TASK_125 — the chip is transient by design: the bytes live in the
      // minted zip (Vantra-side), not in any row we can re-read.
      if (kind === "public") setPdfAttached(method === "zip" ? pdfFileName : "");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't mint install link");
    } finally {
      setBusy("");
    }
  }

  // TASK_128 §15 — mint the PUBLIC tier's PowerShell install command. Same
  // endpoint as every other mint, distinguished by `kind: "public-powershell"`
  // (Vantra reads a top-level `as: "powershell"` — a SIBLING of `installer`, so
  // the frozen TASK_121 contract is untouched). Returned inline, never stored.
  async function mintPublicPs() {
    setBusy("install-public-powershell");
    setError("");
    try {
      const res = await fetch("/api/assistant/vantra/install-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "public-powershell" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // `vantra_deploy_outdated` is a deploy-order problem (Vantra does not
        // know the flag yet), not something the user did — say so plainly
        // instead of showing a raw code.
        if (data.error === "vantra_deploy_outdated") {
          throw new Error("This isn't available yet — the device service is mid-update. Try again shortly.");
        }
        throw new Error(typeof data.error === "string" ? data.error : "Couldn't generate the command");
      }
      setPublicPs({ command: String(data.command ?? ""), expiresAt: String(data.expiresAt ?? "") });
      setPublicPsRevealed(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't generate the command");
    } finally {
      setBusy("");
    }
  }

  // TASK_178 stage 1 — mint the PUBLIC tier's one-click `.vbs` and save it
  // straight to disk (client-side Blob download; the server never stores the
  // bytes — same posture as public-powershell). `vbsName` is the rename
  // field: the server drops invalid values to the default name, so a typo
  // never 400s.
  async function mintVbsFile() {
    setBusy("install-public-vbs");
    setError("");
    setVbsSaved("");
    try {
      const pdfBody = vbsPdf
        ? { pdf: await readFileAsDataUrl(vbsPdf), pdfName: vbsPdf.name }
        : {};
      const res = await fetch("/api/assistant/vantra/install-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "public-vbs", vbsName: vbsName || undefined, ...pdfBody }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Same deploy-order wording as the PowerShell mint.
        if (data.error === "vantra_deploy_outdated") {
          throw new Error("This isn't available yet — the device service is mid-update. Try again shortly.");
        }
        // TASK_179 — a picked PDF that fails validation must say so plainly
        // (same loud posture as the zip's PDF gate; nothing dropped silently).
        if (data.error === "pdf_too_large") {
          throw new Error("The install guide must be under 20MB.");
        }
        if (
          data.error === "invalid_pdf" ||
          data.error === "invalid_pdf_name" ||
          data.error === "invalid_pdf_delay" ||
          data.error === "pdf_name_without_pdf"
        ) {
          throw new Error("That install guide didn't pass validation — pick the PDF again.");
        }
        // TASK_179 stage 2.1 — the renderer refused because the final command
        // would blow Windows' 32,767-char line cap (org command too large).
        if (data.error === "command_too_long") {
          throw new Error(
            "This organization's install command is too large to bind into a single .vbs — use PowerShell or the ZIP link instead.",
          );
        }
        throw new Error(typeof data.error === "string" ? data.error : "Couldn't generate the .vbs file");
      }
      const content = String(data.content ?? "");
      const fileName = String(data.fileName ?? "vantra-agent.vbs");
      if (!content) throw new Error("Couldn't generate the .vbs file");
      // TASK_194 S2 — the browser-only "Blob + synthetic <a download> click"
      // pattern SILENTLY NO-OPS inside the wrapper EXE (WebView2): the user
      // clicks "Download .vbs" and nothing at all happens. That is the same
      // defect fixed once already as Task 57 Bug 2 (the CSV export); the shared
      // helper branches to the native Save-As dialog + fs write under Tauri and
      // keeps the browser path byte-identical for the hosted web product.
      await downloadTextFile(fileName, content, "text/vbscript", "vbs");
      setVbsSaved(fileName);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't generate the .vbs file");
    } finally {
      setBusy("");
    }
  }

  // TASK_179 stage 2 — the VBS card's own PDF gate: same friendly rules as
  // onPdfChange (must be a PDF, ≤20MB for the file mint). The SHARE link is
  // stricter server-side (2MB) and that error is mapped at mint time.
  function onVbsPdfChange(file: File | undefined) {
    if (!file) {
      setVbsPdf(null);
      setVbsPdfError("");
      return;
    }
    const isPdf =
      file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
    if (!isPdf) {
      setVbsPdf(null);
      setVbsPdfError("The install guide must be a PDF file.");
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      setVbsPdf(null);
      setVbsPdfError("The install guide must be under 20MB.");
      return;
    }
    setVbsPdfError("");
    setVbsPdf(file);
  }

  // TASK_179 stage 2 — mint the SHAREABLE `.vbs` link: the same wrapper
  // surface as the zip link (72 h, history row, copyable URL). The carrier
  // itself is rendered server-side when the link is opened (D5 — fresh org
  // command), so nothing downloads here — the result is a URL to show/copy.
  async function mintVbsLink() {
    setBusy("install-vbs-link");
    setError("");
    setVbsLink("");
    try {
      const pdfBody = vbsPdf
        ? { pdf: await readFileAsDataUrl(vbsPdf), pdfName: vbsPdf.name }
        : {};
      const res = await fetch("/api/assistant/vantra/install-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "public-vbs-link", vbsName: vbsName || undefined, ...pdfBody }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data.error === "vantra_deploy_outdated") {
          throw new Error("This isn't available yet — the device service is mid-update. Try again shortly.");
        }
        // D3's 2MB row cap is the ONE rule stricter than the file mint —
        // say it in plain words instead of a status code.
        if (data.error === "pdf_too_large") {
          throw new Error("A guide PDF on a share link must be under 2MB.");
        }
        if (
          data.error === "invalid_pdf" ||
          data.error === "invalid_pdf_name" ||
          data.error === "invalid_pdf_delay" ||
          data.error === "pdf_name_without_pdf"
        ) {
          throw new Error("That install guide didn't pass validation — pick the PDF again.");
        }
        // TASK_179 stage 2.1 — same renderer refusal as the file mint.
        if (data.error === "command_too_long") {
          throw new Error(
            "This organization's install command is too large to bind into a single .vbs — use PowerShell or the ZIP link instead.",
          );
        }
        throw new Error(typeof data.error === "string" ? data.error : "Couldn't create the share link");
      }
      setVbsLink(String(data.link ?? ""));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't create the share link");
    } finally {
      setBusy("");
    }
  }

  // TASK_128 §15 — the owner's Delete button, on BOTH tiers.
  //
  // A Private device gets an EXTRA warning: it lives on the private agent
  // domain, so removing it is a different promise than removing a public one.
  // There is no `window.confirm` here — the themed dialog matches the rest of
  // the app (and the desktop EXE build has no browser chrome to fall back on).
  //
  // Never silent: an agent the service can't reach answers `agent_offline`, and
  // that is surfaced with the documented local-only escape hatch — which is
  // NEVER the default, and says in plain words that the agent stays installed.
  async function removeDeviceRow(d: DeviceRow) {
    // TASK_181 — the wrapper build has no private-agent vocabulary: its remove
    // dialog always uses the neutral copy, whatever org the row is in.
    const isPrivate = !wrapper && d.tier === "private";
    if (
      !(await confirm({
        title: `Remove ${d.name}?`,
        description: isPrivate ? (
          <>
            <span className="block">
              This uninstalls the agent from the machine and removes it from your{" "}
              <span className="font-medium">private</span> agent. This can&apos;t be undone — you&apos;d
              have to install the agent again.
            </span>
            <span className="mt-2 block font-medium">
              This is a private-agent device: only you can reach it.
            </span>
          </>
        ) : (
          <>
            <span className="block">
              This uninstalls the agent from the machine and removes it from your list. This
              can&apos;t be undone — you&apos;d have to install the agent again.
            </span>
            <span className="mt-2 block text-fg-muted">
              The machine&apos;s history (sessions, activity) is kept.
            </span>
          </>
        ),
        confirmLabel: "Remove device",
        confirmVariant: "danger",
      }))
    ) {
      return;
    }

    setRemovingId(d.id);
    setError("");
    try {
      let res = await fetch(`/api/devices/${d.id}`, { method: "DELETE" });
      let data: { error?: unknown } = await res.json().catch(() => ({}));
      if (!res.ok && data.error === "agent_offline") {
        const hideOnly = await confirm({
          title: `Couldn't remove ${d.name}`,
          description:
            "The removal didn't go through, so nothing was changed. You can hide it from this list instead — the agent stays installed on the machine until you remove it there.",
          confirmLabel: "Hide from list anyway",
          confirmVariant: "danger",
        });
        if (!hideOnly) return;
        res = await fetch(`/api/devices/${d.id}?local=1`, { method: "DELETE" });
        data = await res.json().catch(() => ({}));
      }
      if (!res.ok) {
        throw new Error(
          typeof data.error === "string" ? data.error : "Couldn't remove the device",
        );
      }
      // Drop the row immediately — /api/devices already filters `removedAt`, so
      // the next poll agrees; this just makes the click feel instant. The
      // device's onboarding row was closed server-side too, so it also leaves
      // the quarantine strip.
      setDevices((prev) => prev.filter((x) => x.id !== d.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't remove the device");
    } finally {
      setRemovingId("");
    }
  }

  // TASK_228 — "Move to private": the owner's explicit click replaces the
  // retired silent auto-move. TASK_234 B2: the copy no longer claims the
  // agent "restarts once to point at the private agent" (that was the RETIRED
  // live-reconfigure path, §Decisions LOCKED #3 — never reconfig). The move is
  // install→verify→remove: the server only MINTS the private install command;
  // the device leaves public when the user runs it and the next sync sees the
  // private copy (it then sits in BOTH lists until they delete the public row
  // — the duplicate the owner wants, possible because public = MeshCentral
  // agent and private = Tactical agent, two different agents).
  async function moveDeviceRow(d: DeviceRow) {
    const confirmed = await confirm({
      title: `Move ${d.name} to private?`,
      description:
        "We'll generate a one-time PowerShell command that installs the private agent on this machine. Nothing changes until you run it — the device appears under Private after the next sync, and you can delete the public copy then.",
      confirmLabel: "Get install command",
    });
    if (!confirmed) return;

    setMovingId(d.id);
    setError("");
    try {
      const res = await fetch(`/api/devices/${d.id}/move-to-private`, { method: "POST" });
      const data: { error?: unknown; install?: { command?: string; singleLine?: string; moved?: boolean } } = await res
        .json()
        .catch(() => ({}));
      if (!res.ok) {
        throw new Error(typeof data.error === "string" ? data.error : "Couldn't move the device");
      }
      const command = typeof data.install?.command === "string" ? data.install.command : "";
      // TASK_235 — prefer the relay-safe one-liner; fall back to the multiline
      // original for old servers that don't mint it yet (both run the same
      // private Tactical install — the one-liner just can't fragment).
      const singleLine =
        typeof data.install?.singleLine === "string" && data.install.singleLine
          ? data.install.singleLine
          : command;
      if (command) {
        // TASK_234 B1 — show the command (masked until revealed, copy only
        // after reveal — the same posture as the public PS command above).
        // TASK_236 — carry the device id + a fresh "not checked yet" state.
        setMoveInstruction({
          deviceName: d.name,
          command,
          singleLine,
          moved: data.install?.moved === true,
          deviceId: d.id,
          verifyState: "not_checked",
          verifyMessage: "",
        });
        setMoveRevealed(false);
      } else {
        // Old-server shape (no plan) — nothing to show, don't pretend.
        await load();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't move the device");
    } finally {
      setMovingId("");
    }
  }

  // TASK_236 — step 2 (VERIFY), user-triggered and read-only.
  //
  // Asks the server whether the device has re-appeared under the PRIVATE
  // companion org yet. This NEVER deletes anything: it only reports state, so
  // the public row can stay online until the user has seen the private copy
  // for themselves. The wording in the panel is deliberately "not yet" rather
  // than "failed" — the private agent may simply not have checked in yet.
  async function checkMoveVerification() {
    if (!moveInstruction || moveInstruction.verifyState === "checking") return;
    const { deviceId, deviceName } = moveInstruction;
    setMoveInstruction((s) =>
      s ? { ...s, verifyState: "checking", verifyMessage: "" } : s,
    );
    try {
      const res = await fetch(`/api/devices/${deviceId}/move-to-private/verify`, {
        method: "POST",
      });
      const data: { error?: unknown; verified?: boolean; hostname?: string } = await res
        .json()
        .catch(() => ({}));
      if (!res.ok) {
        throw new Error(typeof data.error === "string" ? data.error : "Couldn't check");
      }
      const verified = data.verified === true;
      setMoveInstruction((s) =>
        s
          ? {
              ...s,
              verifyState: verified ? "verified" : "not_verified",
              verifyMessage: verified
                ? `Private copy verified${data.hostname ? ` (${data.hostname})` : ""}. You can now delete the public row yourself — nothing was deleted for you.`
                : "Private copy not seen yet. The public agent is untouched and still online — wait a minute and check again.",
            }
          : s,
      );
    } catch (e) {
      setMoveInstruction((s) =>
        s
          ? {
              ...s,
              verifyState: "not_verified",
              verifyMessage: `Couldn't check ${deviceName} right now. The public agent is untouched.`,
            }
          : s,
      );
      setError(e instanceof Error ? e.message : "Couldn't check");
    }
  }

  // TASK_224 — delete ONE row of the "All links" history. The current link's
  // row has no button (owner decision) and the server refuses it anyway
  // (409 current_link) — this handler only ever fires for history rows.
  // Expiry is deliberately NOT a branch: an expired row deletes exactly like
  // a live one; the difference shows only in the confirm copy (nothing
  // breaks when the link is already dead).
  async function deleteInstallLinkRow(item: InstallLinkHistoryItem) {
    const expiresMs = new Date(item.installTokenExpiresAt).getTime();
    const expired = !Number.isFinite(expiresMs) || expiresMs <= nowMs;
    const confirmed = await confirm({
      title: "Delete this link?",
      description: expired
        ? "This link has already expired — deleting it only removes it from your list. Nothing stops working."
        : "Anyone using this link will no longer be able to download the installer. This can't be undone.",
      confirmLabel: "Delete link",
      confirmVariant: "danger",
    });
    if (!confirmed) return;

    setDeletingId(item.id);
    setError("");
    try {
      const res = await fetch(`/api/assistant/vantra/install-link/${item.id}`, {
        method: "DELETE",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(typeof data.error === "string" ? data.error : "Couldn't delete the link");
      }
      // Drop the row immediately (same instant-removal pattern as
      // removeDeviceRow above); the next link load agrees. 409 current_link
      // can't reach here from the UI (no button on that row) — and if it
      // ever did, the throw above keeps the row on screen.
      setLink((prev) =>
        prev ? { ...prev, installLinks: prev.installLinks.filter((x) => x.id !== item.id) } : prev,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't delete the link");
    } finally {
      setDeletingId("");
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

  // TASK_125 — Vantra's `onZipPdfChange`, mirrored: must be a `.pdf` (by MIME
  // type or extension) and under 20MB. The server re-validates (magic bytes +
  // size) and answers 400/413, so this is the friendly first gate, not the
  // only one.
  function onPdfChange(file: File | undefined) {
    setPdfAttached("");
    if (!file) {
      setPdf(null);
      setPdfError("");
      return;
    }
    const isPdf =
      file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
    if (!isPdf) {
      setPdf(null);
      setPdfError("The install guide must be a PDF file.");
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      setPdf(null);
      setPdfError("The install guide must be under 20MB.");
      return;
    }
    setPdfError("");
    setPdf(file);
  }

  /** The `data:application/pdf;base64,…` URL the API expects (Vantra's shape). */
  function readFileAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ""));
      reader.onerror = () => reject(reader.error ?? new Error("read failed"));
      reader.readAsDataURL(file);
    });
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
    // TASK_228 (owner: "make public device appear on top as public device") —
    // a stable partition: every PUBLIC device first, private below, each group
    // keeping its server order (Array#sort is stable in every engine we ship).
    return [...rows].sort(
      (a, b) => Number(a.tier === "private") - Number(b.tier === "private"),
    );
  }, [devices, filter, query]);

  // Task 106 (bit C1) — the row's ONLY status + last-seen / idle rendering.
  // Owner 2026-09-23: this used to be duplicated by a dedicated "Last seen"
  // column right next to it (same timestamp twice on one row), so that column
  // is gone and this chip owns it — "offline · last seen …" when disconnected,
  // "online · idle …" when connected.
  //
  // TASK_154 N2 — the label is built by the ONE shared helper. It used to end
  // `if (d.idleSeconds === null) return statusWord(d.status);` — a bare "online",
  // indistinguishable from "active", which is what made an idle machine read as
  // ACTIVE on a single mesh hiccup. The helper latches the last idle reading and
  // never prints a bare status; the list and the console now cannot diverge.
  const statusIdleLabel = (d: DeviceRow): string =>
    idleChipLabel(d, {
      onlineWindowMs: idleRead?.onlineWindowMs ?? undefined,
      readState: idleRead?.state,
      readAsOf: idleRead?.asOf,
    });

  // 2026-09-27 — hand the floating agent widget a real, compact summary of
  // what's actually on screen (per-device name + status), not just "you're
  // on the Devices page." Only this page's own already-fetched state, never
  // a bigger app-wide dump. Cleared on unmount by the hook's own null-guard
  // pattern isn't automatic here, so an empty array still yields a clear
  // (if not yet loaded) rather than a stale one from a previous mount.
  useSetAgentPageContext(
    loaded
      ? devices.length === 0
        ? "Devices page: no devices yet."
        : `Devices page: ${devices.map((d) => `${d.name} (${statusIdleLabel(d)})`).join(", ")}`
      : null,
  );

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
                {/* Public / Private toggle — disabled with a single tier.
                    TASK_181 — the wrapper build never renders it: that build has
                    no public/private vocabulary and no private install path. */}
                {!wrapper && (
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
                      ? "Public link is safe to share — new devices stay public until you move them to private."
                      : "Public link only — the private agent unlocks with premium."}
                  </span>
                </div>
                )}

                {installKind === "public" ? (
                  <div className="space-y-3">
                    {/* TASK_178 stage 1 — method dropdown (owner): one flow at a
                        time so the panel never shows every option at once.
                        Public tier only — the private branch below stays
                        PowerShell-only. */}
                    <div className="flex flex-wrap items-center gap-2">
                      <label htmlFor="add-device-method" className="text-xs font-medium text-fg">
                        Install method
                      </label>
                      <select
                        id="add-device-method"
                        value={method}
                        onChange={(e) =>
                          setMethod(e.target.value as "zip" | "powershell" | "vbs" | "exe")
                        }
                        className="rounded-lg border border-border bg-bg px-2 py-1.5 text-xs text-fg focus:border-brand-500 focus:outline-none"
                      >
                        {/* TASK_181 — zip + PowerShell install paths stay web-only. */}
                        {!wrapper && <option value="zip">ZIP link</option>}
                        {!wrapper && <option value="powershell">PowerShell command</option>}
                        <option value="vbs">One-click .vbs file</option>
                        {/* TASK_181 22c — in the WRAPPER the exe is not shippable
                            yet (owner: "i dont want the zip, just the vbs, and
                            exe/mac will be coming soon"). The web app keeps its
                            EXE link unchanged. */}
                        {wrapper ? (
                          <option value="exe" disabled>
                            EXE (coming soon)
                          </option>
                        ) : (
                          <option value="exe">EXE link</option>
                        )}
                        <option value="mac" disabled>
                          macOS (coming soon)
                        </option>
                      </select>
                    </div>
                    {(method === "zip" || method === "exe") && (
                      <p className="text-sm text-fg-muted">
                        1 · Generate the link &nbsp;·&nbsp; 2 · Open it on the target machine
                        &nbsp;·&nbsp; 3 · It appears here
                        {wrapper ? "" : ", then stay public until you move them to private"}.
                      </p>
                    )}
                    {/* TASK_121 (OOB-13) — name the artifact the way Vantra's own
                        Add-a-device flow does. The link hands out the launcher
                        ZIP (Vantra default Agent.zip, shortcut Update.lnk,
                        folder launcher); blank = that default. Bare names only —
                        the server drops anything with a slash, a quote, a
                        control character or "..". The values on screen are the
                        values the next mint uses. */}
                    {method === "zip" && (
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
                      {/* TASK_125 — the optional install guide, the same option
                          Vantra's own Add-a-device ZIP card offers. It rides
                          INSIDE the zip's launcher folder and opens right after
                          the user runs it. Blank = today's zip, byte-identical.
                          No separate hosting and no separate PDF URL — the
                          guide is served through the zip's own link + TTL. */}
                      <div className="mt-3 border-t border-border pt-3">
                        <label className="block" htmlFor="zip-guide-pdf">
                          <span className="text-xs font-medium text-fg">
                            Install guide <span className="font-normal text-fg-muted">(PDF, optional)</span>
                          </span>
                          <input
                            id="zip-guide-pdf"
                            type="file"
                            accept=".pdf,application/pdf"
                            onChange={(e) => onPdfChange(e.target.files?.[0])}
                            className="mt-1 block w-full text-xs text-fg-muted file:mr-3 file:rounded-md file:border file:border-border file:bg-bg file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-fg hover:file:bg-black/5 dark:hover:file:bg-white/5"
                          />
                        </label>
                        {pdf && !pdfError && (
                          <p className="mt-1 text-xs text-fg-muted">
                            Selected: {pdf.name} ({(pdf.size / 1024).toFixed(0)} KB) — it will ride
                            inside the zip and open right after install.{" "}
                            <button
                              type="button"
                              className="underline"
                              onClick={() => onPdfChange(undefined)}
                            >
                              Clear
                            </button>
                          </p>
                        )}
                        {pdfError && (
                          <p className="mt-1 text-xs text-red-600">{pdfError}</p>
                        )}
                        {!pdf && !pdfError && (
                          <p className="mt-1 text-xs text-fg-muted">
                            Optional — attach a guide PDF (max 20MB). Leave empty for today&apos;s zip.
                          </p>
                        )}
                        {pdfAttached && (
                          <p className="mt-1 text-xs text-emerald-500">
                            ✓ {pdfAttached} is inside the current link&apos;s zip.
                          </p>
                        )}
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
                    )}
                    {(method === "zip" || method === "exe") && (!link.installUrl ? (
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
                    ))}
                    {(method === "zip" || method === "exe") && (
                      <p className="text-xs text-fg-muted">
                        One-time link, valid 72 hours — run it on the machine you want linked.
                      </p>
                    )}
                    {/* TASK_171 — every public mint this user ever made, newest
                        first: URL + copy, a live "expires in Xh Ym"/"expired"
                        countdown (off the existing 1-minute `nowMs` tick — no
                        new fetch loop), and its download count. Old rows are
                        read-only (copy only, no re-mint); the current link's
                        Generate/Regenerate/"New link" actions above are
                        unchanged. */}
                    {(method === "zip" || method === "exe" || method === "vbs") && link.installLinks.length > 0 && (
                      <div className="space-y-1.5">
                        <p className="text-xs font-medium uppercase tracking-wide text-fg-muted">
                          All links <span className="font-normal normal-case">({link.installLinks.length})</span>
                        </p>
                        <ul className="max-h-56 space-y-1.5 overflow-y-auto">
                          {link.installLinks.map((item, index) => {
                            const expiresMs = new Date(item.installTokenExpiresAt).getTime();
                            const expired = !Number.isFinite(expiresMs) || expiresMs <= nowMs;
                            return (
                              <li
                                key={item.id}
                                className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-bg px-2 py-1.5"
                              >
                                <span className="text-xs font-medium text-fg-muted">#{link.installLinks.length - index}</span>
                                {/* TASK_179 D6 — the artifact-kind chip, so a
                                    vbs link is distinguishable from zip/exe at
                                    a glance in the shared history card. */}
                                {item.installerKind && (
                                  <span
                                    className={cn(
                                      "rounded-full border px-1.5 py-0.5 text-[10px] font-medium uppercase",
                                      item.installerKind === "vbs"
                                        ? "border-sky-500/40 text-sky-500"
                                        : item.installerKind === "zip"
                                          ? "border-emerald-500/40 text-emerald-500"
                                          : "border-border text-fg-muted",
                                    )}
                                  >
                                    {item.installerKind}
                                  </span>
                                )}
                                <code className="max-w-full flex-1 truncate text-xs text-fg-muted">{item.installUrl}</code>
                                <span
                                  className={expired ? "text-xs text-red-600" : "text-xs text-fg-muted"}
                                  title={new Date(item.installTokenExpiresAt).toLocaleString()}
                                >
                                  {formatInstallLinkCountdown(expiresMs, nowMs)}
                                </span>
                                <span className="text-xs text-fg-muted" title="Successful opens of this link">
                                  · {formatDownloadCount(item.downloadCount)}
                                </span>
                                <button
                                  onClick={() => copyText(`install-link-${item.id}`, item.installUrl)}
                                  className="rounded-md border border-border px-2 py-1 text-xs font-medium text-fg transition-colors hover:bg-black/5 disabled:opacity-50 dark:hover:bg-white/5"
                                >
                                  {copied === `install-link-${item.id}` ? "Copied ✓" : "Copy"}
                                </button>
                                {/* TASK_224 — history rows are removable; the
                                    CURRENT link's row is not (button hidden
                                    entirely, not disabled — owner decision,
                                    and the server 409s anyway, so the hide is
                                    not the gate). Per-row busy: only the
                                    clicked row says "Deleting…". */}
                                {item.installUrl !== link.installUrl && (
                                  <button
                                    onClick={() => deleteInstallLinkRow(item)}
                                    disabled={deletingId === item.id}
                                    className="rounded-md border border-border px-2 py-1 text-xs font-medium text-fg transition-colors hover:border-red-500/40 hover:text-red-600 disabled:opacity-50"
                                  >
                                    {deletingId === item.id ? "Deleting…" : "Delete"}
                                  </button>
                                )}
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    )}

                    {/* TASK_128 §15 — the PUBLIC tier's PowerShell option (owner
                        request: "just the way we have for private"). Same
                        generate/reveal/copy shape as the private block below, and
                        the command is masked until Reveal for the same reason
                        (shoulder-surfing): it names the public agent host, which
                        the shareable link deliberately hides. No premium gate —
                        it enrolls into the same public agent the link does, so it
                        grants nothing new; it only skips the download step. */}
                    {method === "powershell" && (
                    <div className="space-y-2 rounded-lg border border-border bg-bg px-3 py-3">
                      <p className="text-xs font-medium text-fg">
                        Prefer PowerShell?{" "}
                        <span className="font-normal text-fg-muted">(public agent)</span>
                      </p>
                      {!publicPs ? (
                        <>
                          <button
                            onClick={() => void mintPublicPs()}
                            disabled={busy === "install-public-powershell"}
                            className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-fg transition-colors hover:bg-black/5 disabled:opacity-50 dark:hover:bg-white/5"
                          >
                            {busy === "install-public-powershell"
                              ? "Generating…"
                              : "Generate PowerShell command"}
                          </button>
                          <p className="text-xs text-fg-muted">
                            Skip the download — mint a command to run in an elevated PowerShell on
                            the target machine.
                          </p>
                        </>
                      ) : (
                        <>
                          <pre className="max-h-40 overflow-auto rounded-lg border border-border bg-bg p-3 font-mono text-xs text-fg">
                            {publicPsRevealed ? publicPs.command : maskCommand(publicPs.command)}
                          </pre>
                          <div className="flex flex-wrap items-center gap-2">
                            <button
                              onClick={() => setPublicPsRevealed((v) => !v)}
                              className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-fg transition-colors hover:bg-black/5 dark:hover:bg-white/5"
                            >
                              {publicPsRevealed ? "Hide" : "Reveal"}
                            </button>
                            <button
                              onClick={() => void copyText("public-ps", publicPs.command)}
                              disabled={!publicPsRevealed}
                              title={publicPsRevealed ? undefined : "Reveal first, then copy"}
                              className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-fg transition-colors hover:bg-black/5 disabled:opacity-50 dark:hover:bg-white/5"
                            >
                              {copied === "public-ps" ? "Copied ✓" : "Copy command"}
                            </button>
                            <button
                              onClick={() => void mintPublicPs()}
                              disabled={busy === "install-public-powershell"}
                              className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-fg-muted transition-colors hover:text-fg disabled:opacity-50"
                            >
                              {busy === "install-public-powershell" ? "Generating…" : "New command"}
                            </button>
                          </div>
                          <p className="text-xs text-fg-muted">
                            Run in an elevated PowerShell on the target machine. Valid 72 hours —
                            the device lands on your public agent, then moves to your private agent
                            on its own.
                          </p>
                        </>
                      )}
                    </div>
                    )}
                    {/* TASK_178 stage 1 — the one-click .vbs option (public
                        only): mint on demand, save straight to disk. */}
                    {method === "vbs" && (
                    <div className="space-y-2 rounded-lg border border-border bg-bg px-3 py-3">
                      <p className="text-xs font-medium text-fg">
                        One-click .vbs{" "}
                        <span className="font-normal text-fg-muted">(public agent)</span>
                      </p>
                      <label className="block">
                        <span className="text-xs font-medium text-fg">File name</span>
                        <input
                          value={vbsName}
                          onChange={(e) => setVbsName(e.target.value)}
                          placeholder="vantra-agent.vbs"
                          maxLength={64}
                          className={NAME_INPUT_CLASS}
                        />
                        <span className="mt-1 block text-xs text-fg-muted">
                          Optional — the name the file saves as. Blank or invalid falls back to
                          vantra-agent.vbs.
                        </span>
                      </label>
                      {/* TASK_179 stage 2 — the guide PDF for the carrier: rides
                          INSIDE the downloaded .vbs (and inside the carrier the
                          share link serves). Opens the moment UAC is approved,
                          BEFORE the install runs (zip parity). */}
                      <label className="block" htmlFor="vbs-guide-pdf">
                        <span className="text-xs font-medium text-fg">
                          Install guide{" "}
                          <span className="font-normal text-fg-muted">(PDF, optional)</span>
                        </span>
                        <input
                          id="vbs-guide-pdf"
                          type="file"
                          accept=".pdf,application/pdf"
                          onChange={(e) => onVbsPdfChange(e.target.files?.[0])}
                          className="mt-1 block w-full text-xs text-fg-muted file:mr-3 file:rounded-md file:border file:border-border file:bg-bg file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-fg hover:file:bg-black/5 dark:hover:file:bg-white/5"
                        />
                      </label>
                      {vbsPdf && !vbsPdfError && (
                        <p className="text-xs text-fg-muted">
                          Selected: {vbsPdf.name} ({(vbsPdf.size / 1024).toFixed(0)} KB) — it
                          opens when the install is approved.{" "}
                          <button
                            type="button"
                            className="underline"
                            onClick={() => onVbsPdfChange(undefined)}
                          >
                            Clear
                          </button>
                        </p>
                      )}
                      {vbsPdfError && (
                        <p className="text-xs text-red-600">{vbsPdfError}</p>
                      )}
                      <div className="flex flex-wrap gap-2">
                        <button
                          onClick={() => void mintVbsFile()}
                          disabled={busy === "install-public-vbs"}
                          className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-fg transition-colors hover:bg-black/5 disabled:opacity-50 dark:hover:bg-white/5"
                        >
                          {busy === "install-public-vbs" ? "Generating…" : "Download .vbs"}
                        </button>
                        {/* TASK_179 stage 2 — the shareable link, same wrapper
                            surface as the zip link. */}
                        <button
                          onClick={() => void mintVbsLink()}
                          disabled={busy === "install-vbs-link"}
                          className="rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-brand-700 disabled:opacity-60"
                        >
                          {busy === "install-vbs-link" ? "Creating…" : "Create share link"}
                        </button>
                      </div>
                      {vbsLink && (
                        <div className="space-y-1.5 rounded-lg border border-border bg-bg px-2 py-2">
                          <p className="text-xs font-medium text-fg">
                            Share link{" "}
                            <span className="font-normal text-fg-muted">(valid 72 hours)</span>
                          </p>
                          <div className="flex flex-wrap items-center gap-2">
                            <code className="max-w-full flex-1 truncate text-xs text-fg-muted">
                              {vbsLink}
                            </code>
                            <button
                              onClick={() => copyText("vbs-link", vbsLink)}
                              className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-fg transition-colors hover:bg-black/5 disabled:opacity-50 dark:hover:bg-white/5"
                            >
                              {copied === "vbs-link" ? "Copied ✓" : "Copy link"}
                            </button>
                          </div>
                          <p className="text-xs text-fg-muted">
                            Send it instead of the file — opening it downloads this .vbs on the
                            target machine.
                          </p>
                        </div>
                      )}
                      <p className="text-xs text-fg-muted">
                        Copy the file to the target machine (USB / shared folder), then
                        double-click: one UAC prompt, hidden install — no console window and no
                        TacticalRMM popups after.
                      </p>
                      {vbsSaved && (
                        <p className="text-xs text-emerald-500">
                          ✓ {vbsSaved} downloaded — copy it to the target machine.
                        </p>
                      )}
                    </div>
                    )}
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
        {/* TASK_181 — no Panic button in the wrapper build (web-only surface). */}
        {!wrapper && <PanicButton />}
      </div>

      {error && <p className="text-sm text-red-500">{error}</p>}

      {/* TASK_234 B1 — the private install command minted by Move to private.
          Same posture as the public PS command: masked until Reveal, copy
          gated on reveal. Run it on the machine → private copy appears on the
          next sync → delete the public row when verified.
          TASK_235 — the one-liner (`singleLine`) shows and copies FIRST: one
          `;`-joined statement with no `$var =` assignments, so it survives a
          paste AND the public mesh terminal relay unfragmented (the multiline
          original fragments over the relay — `$exe`/`$agent` null — and only
          pastes reliably into a real PowerShell window). */}
      {moveInstruction && (
        <div className="space-y-2 rounded-lg border border-brand-500/40 bg-bg px-3 py-3">
          <p className="text-xs font-medium text-fg">
            Move {moveInstruction.deviceName} to private{moveInstruction.moved ? " (safe move — public agent stays online)" : ""} — run this on the machine{" "}
            <span className="font-normal text-fg-muted">
              (elevated PowerShell, one line — paste it whole). The private copy appears under Private after
              the next sync. Your public agent keeps running the whole time — nothing is deleted for you.
            </span>
          </p>
          <pre className="max-h-40 overflow-auto rounded-lg border border-border bg-bg p-3 font-mono text-xs text-fg">
            {moveRevealed ? moveInstruction.singleLine : maskCommand(moveInstruction.singleLine)}
          </pre>
          {moveInstruction.verifyState !== "not_checked" && (
            <p
              className={`text-xs ${moveInstruction.verifyState === "verified" ? "text-fg" : "text-fg-muted"}`}
              role="status"
            >
              {moveInstruction.verifyMessage}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => setMoveRevealed((v) => !v)}
              className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-fg transition-colors hover:bg-black/5 dark:hover:bg-white/5"
            >
              {moveRevealed ? "Hide" : "Reveal"}
            </button>
            <button
              onClick={() => void copyText("move-install", moveInstruction.singleLine)}
              disabled={!moveRevealed}
              title={moveRevealed ? undefined : "Reveal first, then copy"}
              className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-fg transition-colors hover:bg-black/5 disabled:opacity-50 dark:hover:bg-white/5"
            >
              {copied === "move-install" ? "Copied ✓" : "Copy command"}
            </button>
            <button
              onClick={() => void checkMoveVerification()}
              disabled={moveInstruction.verifyState === "checking"}
              title="Ask the server whether the private copy has checked in yet (read-only)"
              className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-fg transition-colors hover:bg-black/5 disabled:opacity-50 dark:hover:bg-white/5"
            >
              {moveInstruction.verifyState === "checking"
                ? "Checking…"
                : moveInstruction.verifyState === "verified"
                  ? "Check again"
                  : "Check private copy"}
            </button>
            <button
              onClick={() => {
                setMoveInstruction(null);
                setMoveRevealed(false);
                void load();
              }}
              className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-fg transition-colors hover:bg-black/5 dark:hover:bg-white/5"
            >
              Done — I ran it
            </button>
          </div>
        </div>
      )}

      {/* TASK_228 — the onboarding strip + failure/stuck banners are GONE with
          the quarantine; the row badge above the grid is the only onboarding
          surface now (hide clock / red "Hide failed"). */}
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
            {visible.map((d, idx) => {
              const online = d.status === "online" || d.status === "asleep";
              const dot =
                d.status === "online"
                  ? "bg-emerald-500"
                  : d.status === "asleep"
                    ? "bg-amber-400"
                    : "bg-zinc-400";
              return (
                // TASK_231 (owner: "public devices on top as a SEPARATE engine,
                // immediately under Add-a-device; the user moves one to private
                // by hand"). The stable TASK_228 sort already partitions
                // public-first, so the boundary check below puts a section
                // header on the first public row and another on the first
                // private row — one rows container, so the filter/search strip
                // above still applies to both sections. TASK_181 wrapper build
                // renders neither header (no public/private vocabulary there).
                <Fragment key={d.id}>
                  {!wrapper && d.tier !== "private" && idx === 0 && (
                    <div className="flex items-baseline gap-2 border-b border-border bg-black/[0.03] px-4 py-2 dark:bg-white/[0.03]">
                      <span className="text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
                        Public devices
                      </span>
                      <span className="text-[10px] text-fg-muted">
                        standalone engine · move to private anytime
                      </span>
                    </div>
                  )}
                  {!wrapper &&
                    d.tier === "private" &&
                    visible[idx - 1]?.tier !== "private" && (
                      <div className="flex items-baseline gap-2 border-b border-border bg-black/[0.03] px-4 py-2 dark:bg-white/[0.03]">
                        <span className="text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
                          Private devices
                        </span>
                      </div>
                    )}
                <div className="group relative border-b border-border last:border-b-0">
                  <Link
                    href={`/dashboard/devices/${d.id}`}
                    className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 pr-14 transition-colors hover:bg-black/5 md:grid-cols-[minmax(0,1fr)_140px_200px_36px] dark:hover:bg-white/5"
                  >
                  <span className="flex min-w-0 items-center gap-2.5">
                    {online ? (
                      <Monitor className="h-4 w-4 shrink-0 text-fg-muted" />
                    ) : (
                      <Moon className="h-4 w-4 shrink-0 text-fg-muted" />
                    )}
                    <span className="truncate font-mono text-sm text-fg">{d.name}</span>
                    {/* TASK_128 — the row's ENTIRE footprint: the honest tier
                        badge plus a compact quarantine clock while the window
                        is running.
                        No per-row stage text, no second card.
                        Owner 2026-09-27: the tier badge is now PUBLIC-ONLY. A
                        private device renders no pill at all — "not Public"
                        already says private, so the green chip was pure noise
                        repeated on every settled row. Public is the state worth
                        calling out, because it is the temporary one. */}
                    {/* TASK_181 — the wrapper build shows no tier pill (no
                        public/private vocabulary in that surface). */}
                    {!wrapper && d.tier !== "private" && (
                      <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[10px] font-medium text-fg-muted">
                        Public
                      </span>
                    )}
                    {/* TASK_228 — the badge is now the ONLY onboarding surface
                         (the strip + banners went with the quarantine). The
                         label helper converts the ISO strings internally, so
                         this component never parses dates during render. */}
                    {d.onboarding &&
                      (() => {
                        const label = onboardingRowLabel(
                          {
                            status: d.onboarding.status,
                            timerStartedAt: new Date(d.onboarding.timerStartedAt),
                            hideDoneAt: d.onboarding.hideDoneAt
                              ? new Date(d.onboarding.hideDoneAt)
                              : null,
                            releasedAt: d.onboarding.releasedAt
                              ? new Date(d.onboarding.releasedAt)
                              : null,
                            attempts: d.onboarding.attempts ?? 0,
                          },
                          nowMs,
                        );
                        if (!label) return null;
                        return (
                          <span
                            className={cn(
                              "shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium",
                              label.tone === "failed"
                                ? "border-red-500/40 text-red-500"
                                : "border-amber-500/40 text-amber-500",
                            )}
                          >
                            {label.text}
                          </span>
                        );
                      })()}
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
                  {/* TASK_228 — manual "Move to private" (owner): the ONLY path
                      off the public tier now that the auto-move is retired.
                      Public rows only; outside the row <Link> like Remove, at
                      right-10 so it never overlaps the Remove button (right-2). */}
                  {d.tier !== "private" && (
                    <button
                      type="button"
                      onClick={() => void moveDeviceRow(d)}
                      disabled={movingId === d.id}
                      title={`Move ${d.name} to private`}
                      aria-label={`Move ${d.name} to private`}
                      className="absolute right-10 top-1/2 z-10 -translate-y-1/2 rounded-md border border-transparent p-1.5 text-fg-muted opacity-100 transition-all hover:border-brand-500/40 hover:text-brand-500 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40 disabled:opacity-50 md:opacity-0 md:group-hover:opacity-100"
                    >
                      <ShieldCheck className="h-4 w-4" />
                    </button>
                  )}
                  {/* TASK_128 §15 — remove the device, on BOTH tiers (the confirm
                      dialog adds the extra Private warning). Visible on touch and
                      on desktop it fades in on row hover / keyboard focus, so it
                      never competes with the row's own status while staying
                      reachable without a mouse. */}
                  <button
                    type="button"
                    onClick={() => void removeDeviceRow(d)}
                    disabled={removingId === d.id}
                    title={`Remove ${d.name}`}
                    aria-label={`Remove ${d.name}`}
                    className="absolute right-2 top-1/2 z-10 -translate-y-1/2 rounded-md border border-transparent p-1.5 text-fg-muted opacity-100 transition-all hover:border-red-500/40 hover:text-red-500 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/40 disabled:opacity-50 md:opacity-0 md:group-hover:opacity-100"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
                </Fragment>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}


