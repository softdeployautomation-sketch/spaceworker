"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// TASK_155 P1 — the Hosting tab. Talks only to /api/hosting/*. Kept deliberately
// plain (no new libraries): a status strip, an upload box, and a file list with
// rename / copy-link / delete. The "zero-experience path" (PLAN §8) is the
// one-sentence box at the top, which the agent flow will later hook into.

interface HostingProviderInfo {
  id: string;
  label: string;
  implemented: boolean;
}

interface HostingStatus {
  enabled: boolean;
  entitled: boolean;
  entitlementReason: string;
  provider: string;
  providers: HostingProviderInfo[];
  publicBase: string;
  caps: {
    storageQuotaMb: number;
    maxFileSizeMb: number;
    maxFiles: number;
    maxBandwidthGbPerMonth: number;
    pagesMaxAssetMb: number;
    maxLinks: number;
    /** TASK_155 P3 — the site/premium dials (PLAN §16.3/§16.6). */
    premiumMaxProjects: number;
    premiumMaxFilesPerProject: number;
    premiumDeploymentsPerDay: number;
    maxZipMb: number;
    previewTtlHours: number;
    publishedRevisionsKept: number;
  };
  usage: {
    storageBytes: number;
    fileCount: number;
    bandwidthBytes: number;
    period: string;
    linkCount: number;
  };
  /** TASK_155 P2 — the caller's own hosting credentials (never the token). */
  credentials: HostingCredential[];
  /** Where a /r/<slug|token> short link resolves (the app host). */
  linksBase: string;
}

/** TASK_155 P2 — a user-owned short link (/r/<slug|token> → target). */
interface HostedLink {
  id: string;
  token: string;
  slug: string | null;
  label: string | null;
  target: string;
  clickCount: number;
  shortPath: string;
  createdAt: string;
}

/** TASK_155 P2 — a BYO Cloudflare credential (account id + encrypted token). */
interface HostingCredential {
  id: string;
  provider: string;
  accountId: string;
  label: string;
  tokenHint: string;
  isDefault: boolean;
  status: string;
  /** TASK_155 P3 — §16.4 verify stamp + per-account project count. */
  lastVerifiedAt: string | null;
  verifyError: string | null;
  projectCount?: number;
  createdAt: string;
}

interface HostedFile {
  id: string;
  name: string;
  token: string;
  slug: string | null;
  mime: string;
  bytes: number;
  sha256: string;
  dispositionFilename: string;
  visibility: string;
  provider: string;
  url: string | null;
  expiresAt: string | null;
  downloadCount: number;
  createdAt: string;
}

/** TASK_155 P3 — a hosted static site (a zipped folder → preview → publish). */
interface HostingSite {
  id: string;
  name: string;
  engine: string;
  credentialId: string | null;
  status: string;
  previewToken: string;
  liveToken: string | null;
  liveUrl: string | null;
  previewUrl: string | null;
  createdAt: string;
}

/** TASK_155 P3 — one revision of a site (the §16.1 state machine). */
interface HostingRevision {
  id: string;
  state: string;
  fileCount: number;
  bytes: number;
  previewToken: string;
  previewUrl: string | null;
  cfUrl: string | null;
  rejection: string | null;
  createdAt: string;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function HostingPanel() {
  const [status, setStatus] = useState<HostingStatus | null>(null);
  const [files, setFiles] = useState<HostedFile[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [slugs, setSlugs] = useState<Record<string, string>>({});
  // TASK_155 P2 — the short links + BYO credentials surfaces.
  const [links, setLinks] = useState<HostedLink[]>([]);
  const [linkForm, setLinkForm] = useState({ target: "", label: "", slug: "" });
  const fileInput = useRef<HTMLInputElement>(null);
  // TASK_155 P3 — the Sites surface (folder → preview → publish + engine picker).
  const [sites, setSites] = useState<HostingSite[]>([]);
  const [siteForm, setSiteForm] = useState<{ name: string; engine: string; credentialId: string }>({
    name: "",
    engine: "local",
    credentialId: "",
  });
  const [revisions, setRevisions] = useState<Record<string, HostingRevision[]>>({});
  const [openSite, setOpenSite] = useState<string | null>(null);

  // Owner ask (2026-10-02) — the hosting page was one long scroll; split it
  // into three tabs: Sites / Links / Files (the upload box lives with Files).
  const [tab, setTab] = useState<"sites" | "links" | "files">("sites");
  const revisionInput = useRef<HTMLInputElement>(null);

  const loadStatus = useCallback(async () => {
    const res = await fetch("/api/hosting/status");
    if (!res.ok) {
      setError("Couldn’t load your hosting status. Try refreshing.");
      return;
    }
    setStatus((await res.json()) as HostingStatus);
  }, []);

  const loadFiles = useCallback(async () => {
    const res = await fetch("/api/hosting/files");
    if (!res.ok) return;
    const data = (await res.json()) as { files: HostedFile[] };
    setFiles(data.files);
  }, []);

  // TASK_155 P2 — the user's short links (deliberately a separate endpoint from
  // files; they are a different resource with a different cap).
  const loadLinks = useCallback(async () => {
    const res = await fetch("/api/hosting/links");
    if (!res.ok) return;
    const data = (await res.json()) as { links: HostedLink[] };
    setLinks(data.links);
  }, []);

  // TASK_155 P3 — the caller's sites, and (on demand) a site's revisions.
  const loadSites = useCallback(async () => {
    const res = await fetch("/api/hosting/sites");
    if (!res.ok) return;
    const data = (await res.json()) as { sites: HostingSite[] };
    setSites(data.sites);
  }, []);

  const loadRevisions = useCallback(async (siteId: string) => {
    const res = await fetch(`/api/hosting/sites/${siteId}`);
    if (!res.ok) return;
    const data = (await res.json()) as { revisions: HostingRevision[] };
    setRevisions((r) => ({ ...r, [siteId]: data.revisions }));
  }, []);

  useEffect(() => {
    void loadStatus();
    void loadFiles();
    void loadLinks();
    void loadSites();
  }, [loadStatus, loadFiles, loadLinks, loadSites]);

  const activeProvider = useMemo(
    () => status?.providers.find((p) => p.id === status.provider) ?? null,
    [status]
  );

  const onUpload = useCallback(
    async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const input = fileInput.current;
      const file = input?.files?.[0];
      if (!file) return;
      setBusy(true);
      setError("");
      setNotice("");
      try {
        const form = new FormData();
        form.append("file", file);
        form.append("filename", file.name);
        form.append("acknowledgeGated", "true");
        const res = await fetch("/api/hosting/files", { method: "POST", body: form });
        const data = (await res.json()) as { file?: HostedFile; error?: string };
        if (!res.ok) {
          setError(data.error ?? "Upload failed.");
        } else {
          setNotice(`Uploaded “${file.name}”.`);
          if (input) input.value = "";
          await Promise.all([loadFiles(), loadStatus()]);
        }
      } catch {
        setError("Upload failed — check your connection and try again.");
      } finally {
        setBusy(false);
      }
    },
    [loadFiles, loadStatus]
  );

  const onRename = useCallback(
    async (file: HostedFile, displayName: string) => {
      const res = await fetch(`/api/hosting/files/${file.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName }),
      });
      const data = (await res.json()) as { file?: HostedFile; error?: string };
      if (!res.ok) {
        setError(data.error ?? "Rename failed.");
        return;
      }
      setNotice("Renamed — the file contents and their hash are unchanged.");
      await loadFiles();
    },
    [loadFiles]
  );

  const onSaveSlug = useCallback(
    async (file: HostedFile) => {
      const slug = slugs[file.id] ?? "";
      const res = await fetch(`/api/hosting/files/${file.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: slug || null }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? "Couldn’t save that link name.");
        return;
      }
      setNotice("Link name saved.");
      await loadFiles();
    },
    [loadFiles, slugs]
  );

  const onDelete = useCallback(
    async (file: HostedFile) => {
      if (!window.confirm(`Delete “${file.name}”? The link will stop working.`)) return;
      const res = await fetch(`/api/hosting/files/${file.id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        setError(data.error ?? "Delete failed.");
        return;
      }
      setNotice("Deleted.");
      await Promise.all([loadFiles(), loadStatus()]);
    },
    [loadFiles, loadStatus]
  );

  const copy = useCallback((url: string) => {
    void navigator.clipboard?.writeText(url);
    setNotice("Link copied.");
  }, []);

  // --- TASK_155 P3 — the Sites flow handlers --------------------------------

  const onCreateSite = useCallback(
    async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      if (!siteForm.name.trim()) return;
      // §17.4 — the picker disables Premium (Cloudflare) while there is no
      // account yet; this guard covers stale state (an account removed while
      // this form sat open). The token itself lives in Settings now.
      if (siteForm.engine === "cloudflare" && (status?.credentials.length ?? 0) === 0) {
        setError("Add a Cloudflare account in Settings first — then premium hosting unlocks here.");
        return;
      }
      setBusy(true);
      setError("");
      setNotice("");
      try {
        const res = await fetch("/api/hosting/sites", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: siteForm.name.trim(),
            engine: siteForm.engine,
            credentialId: siteForm.engine === "cloudflare" && siteForm.credentialId ? siteForm.credentialId : null,
          }),
        });
        const data = (await res.json()) as { site?: HostingSite; error?: string };
        if (!res.ok || !data.site) {
          setError(data.error ?? "Couldn’t create the site.");
          return;
        }
        setSiteForm({ name: "", engine: "local", credentialId: "" });
        setNotice(`Created “${data.site.name}”. Zip a folder to preview it.`);
        await loadSites();
      } catch {
        setError("Couldn’t create the site — check your connection and try again.");
      } finally {
        setBusy(false);
      }
    },
    [loadSites, siteForm, status]
  );

  const onUploadRevision = useCallback(
    async (site: HostingSite, file: File) => {
      setBusy(true);
      setError("");
      setNotice("");
      try {
        const form = new FormData();
        form.append("file", file);
        form.append("filename", file.name);
        const res = await fetch(`/api/hosting/sites/${site.id}/revisions`, { method: "POST", body: form });
        const data = (await res.json()) as { revision?: HostingRevision; error?: string };
        if (!res.ok || !data.revision) {
          setError(data.error ?? "The folder couldn’t be prepared.");
          return;
        }
        setNotice(`Prepared ${data.revision.fileCount} file(s) — open the preview, then publish.`);
        setOpenSite(site.id);
        await Promise.all([loadSites(), loadRevisions(site.id), loadStatus()]);
      } catch {
        setError("The upload failed — check your connection and try again.");
      } finally {
        setBusy(false);
      }
    },
    [loadRevisions, loadSites, loadStatus]
  );

  const onPublish = useCallback(
    async (site: HostingSite, revision: HostingRevision) => {
      setBusy(true);
      setError("");
      setNotice("");
      try {
        const res = await fetch(`/api/hosting/sites/${site.id}/revisions/${revision.id}/publish`, {
          method: "POST",
        });
        const data = (await res.json()) as { revision?: HostingRevision; error?: string };
        if (!res.ok) {
          setError(data.error ?? "Publish failed.");
          return;
        }
        setNotice("Published. Your live link is ready.");
        await Promise.all([loadSites(), loadRevisions(site.id), loadStatus()]);
      } catch {
        setError("Publish failed — check your connection and try again.");
      } finally {
        setBusy(false);
      }
    },
    [loadRevisions, loadSites, loadStatus]
  );

  const onDeleteSite = useCallback(
    async (site: HostingSite) => {
      if (!window.confirm(`Delete “${site.name}” and its previews? The live link will stop working.`)) return;
      const res = await fetch(`/api/hosting/sites/${site.id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        setError(data.error ?? "Delete failed.");
        return;
      }
      setNotice("Site deleted.");
      if (openSite === site.id) setOpenSite(null);
      await Promise.all([loadSites(), loadStatus()]);
    },
    [loadSites, loadStatus, openSite]
  );

  const onToggleSite = useCallback(
    async (site: HostingSite) => {
      if (openSite === site.id) {
        setOpenSite(null);
        return;
      }
      setOpenSite(site.id);
      await loadRevisions(site.id);
    },
    [loadRevisions, openSite]
  );

  const onAddLink = useCallback(
    async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      if (!linkForm.target.trim()) return;
      setBusy(true);
      setError("");
      setNotice("");
      try {
        const res = await fetch("/api/hosting/links", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            target: linkForm.target.trim(),
            label: linkForm.label.trim() || null,
            slug: linkForm.slug.trim() || null,
          }),
        });
        const data = (await res.json()) as { error?: string };
        if (!res.ok) {
          setError(data.error ?? "Couldn’t create that link.");
          return;
        }
        setLinkForm({ target: "", label: "", slug: "" });
        setNotice("Link created.");
        await Promise.all([loadLinks(), loadStatus()]);
      } catch {
        setError("Couldn’t create that link — try again.");
      } finally {
        setBusy(false);
      }
    },
    [linkForm, loadLinks, loadStatus]
  );


  // Owner ask (2026-10-02) — the Links tab can re-target and delete, and the
  // Files tab can flip a file between public and private, without touching the
  // other tabs. Both PATCH routes only ever see rows owned by the caller.
  const onEditLink = useCallback(
    async (link: HostedLink) => {
      const next = window.prompt("New destination URL:", link.target);
      if (!next || !next.trim() || next.trim() === link.target) return;
      setBusy(true);
      setError("");
      setNotice("");
      try {
        const res = await fetch(`/api/hosting/links/${link.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ target: next.trim() }),
        });
        const data = (await res.json()) as { error?: string };
        if (!res.ok) {
          setError(data.error ?? "Couldn’t update that link.");
          return;
        }
        setNotice("Link updated — the short address stays the same.");
        await loadLinks();
      } catch {
        setError("Couldn’t update that link — try again.");
      } finally {
        setBusy(false);
      }
    },
    [loadLinks]
  );

  const onDeleteLink = useCallback(
    async (link: HostedLink) => {
      if (!window.confirm(`Delete the short link ${link.shortPath}? Existing shares of it will stop working.`)) return;
      setBusy(true);
      setError("");
      setNotice("");
      try {
        const res = await fetch(`/api/hosting/links/${link.id}`, { method: "DELETE" });
        const data = (await res.json()) as { error?: string };
        if (!res.ok) {
          setError(data.error ?? "Couldn’t delete that link.");
          return;
        }
        setNotice("Link deleted.");
        await Promise.all([loadLinks(), loadStatus()]);
      } catch {
        setError("Couldn’t delete that link — try again.");
      } finally {
        setBusy(false);
      }
    },
    [loadLinks, loadStatus]
  );

  const onToggleVisibility = useCallback(
    async (file: HostedFile) => {
      const next = file.visibility === "private" ? "public" : "private";
      setBusy(true);
      setError("");
      setNotice("");
      try {
        const res = await fetch(`/api/hosting/files/${file.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ visibility: next }),
        });
        const data = (await res.json()) as { error?: string };
        if (!res.ok) {
          setError(data.error ?? "Couldn’t change visibility.");
          return;
        }
        setNotice(next === "public" ? "File is public — anyone with the link can open it." : "File is private — only you can open it.");
        await loadFiles();
      } catch {
        setError("Couldn’t change visibility — try again.");
      } finally {
        setBusy(false);
      }
    },
    [loadFiles]
  );

  if (!status) {
    return <div className="p-6 text-sm text-zinc-500">Loading hosting…</div>;
  }

  const pct = status.caps.storageQuotaMb > 0 ? Math.min(100, (status.usage.storageBytes / (status.caps.storageQuotaMb * 1024 * 1024)) * 100) : 0;

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">Hosting</h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Put a file online and get a link back. Rename it any time — the file itself never changes.
        </p>
      </header>

      {notice && (
        <div className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
          {notice}
        </div>
      )}
      {error && (
        <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200">
          {error}
        </div>
      )}

      {!status.enabled && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          Hosting is switched off platform-wide right now.
        </div>
      )}
      {!status.entitled && (
        <div className="rounded-md border border-zinc-300 bg-zinc-50 px-3 py-2 text-sm text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
          Hosting isn’t included on your account yet. Add the Hosting &amp; Pages module from the store to switch it on.
        </div>
      )}

      {/* Status strip: usage + the storage engine in play. */}
      <section className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
          <div className="text-xs uppercase tracking-wide text-zinc-500">Storage used</div>
          <div className="mt-1 text-lg font-medium text-zinc-900 dark:text-zinc-100">
            {formatBytes(status.usage.storageBytes)} / {status.caps.storageQuotaMb} MB
          </div>
          <div className="mt-2 h-1.5 w-full rounded bg-zinc-200 dark:bg-zinc-800">
            <div className="h-1.5 rounded bg-emerald-500" style={{ width: `${pct}%` }} />
          </div>
        </div>
        <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
          <div className="text-xs uppercase tracking-wide text-zinc-500">Files</div>
          <div className="mt-1 text-lg font-medium text-zinc-900 dark:text-zinc-100">
            {status.usage.fileCount} / {status.caps.maxFiles}
          </div>
          <div className="mt-2 text-xs text-zinc-500">Max {status.caps.maxFileSizeMb} MB each</div>
        </div>
        <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
          <div className="text-xs uppercase tracking-wide text-zinc-500">Storage engine</div>
          <div className="mt-1 text-lg font-medium text-zinc-900 dark:text-zinc-100">
            {activeProvider?.label ?? status.provider}
          </div>
          <div className="mt-2 text-xs text-zinc-500">This month: {formatBytes(status.usage.bandwidthBytes)} downloaded</div>
        </div>
      </section>

      {/* Owner ask (2026-10-02) — Sites / Links / Files tabs with live counts. */}
      <div className="flex flex-wrap gap-1 rounded-lg border border-zinc-200 p-1 dark:border-zinc-800" role="tablist">
        {(
          [
            ["sites", `Sites (${sites.length})`],
            ["links", `Links (${status.usage.linkCount} / ${status.caps.maxLinks})`],
            ["files", `Files (${status.usage.fileCount} / ${status.caps.maxFiles})`],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={`rounded-md px-3 py-1.5 text-sm font-medium ${
              tab === id
                ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* TASK_155 P3 — Sites: zip a folder → PREVIEW → PUBLISH, per-item engine. */}
      {tab === "sites" && (
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">Sites</h2>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Zip a folder, check the preview, then publish. Pick the engine per site — our server is free and instant;
          premium (Cloudflare) gives a global edge and custom domains. Manage the Cloudflare account token under
          Settings → Hosting accounts.
        </p>

        <form
          onSubmit={onCreateSite}
          className="flex flex-wrap items-end gap-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"
        >
          <label className="flex flex-col gap-1 text-xs text-zinc-500">
            Site name
            <input
              value={siteForm.name}
              onChange={(e) => setSiteForm((s) => ({ ...s, name: e.target.value }))}
              placeholder="my-site"
              className="w-48 rounded border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-zinc-500">
            Engine
            <select
              value={siteForm.engine}
              onChange={(e) => setSiteForm((s) => ({ ...s, engine: e.target.value }))}
              className="rounded border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            >
              <option value="local">Our server (free)</option>
              {status.credentials.length > 0 ? (
                <option value="cloudflare">Premium (Cloudflare)</option>
              ) : (
                <option value="cloudflare" disabled>
                  Premium (Cloudflare) — add an account in Settings
                </option>
              )}
            </select>
            {siteForm.engine === "cloudflare" && status.credentials.length === 0 && (
              <span className="text-xs text-amber-600 dark:text-amber-400">
                No account yet — add your Cloudflare token in Settings; it becomes an option here right away.
              </span>
            )}
          </label>
          {siteForm.engine === "cloudflare" && (
            <label className="flex flex-col gap-1 text-xs text-zinc-500">
              Cloudflare account
              <select
                value={siteForm.credentialId}
                onChange={(e) => setSiteForm((s) => ({ ...s, credentialId: e.target.value }))}
                className="rounded border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
              >
                <option value="">Platform account (default)</option>
                {status.credentials.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label} · …{c.tokenHint}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button
            type="submit"
            disabled={busy || !status.enabled || !status.entitled}
            className="rounded bg-zinc-900 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
          >
            Create site
          </button>
        </form>

        {sites.length === 0 && (
          <p className="text-sm text-zinc-500">No sites yet. Create one, then zip a folder to preview it.</p>
        )}

        {sites.map((site) => {
          const open = openSite === site.id;
          const revs = revisions[site.id] ?? [];
          return (
            <div key={site.id} className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium text-zinc-900 dark:text-zinc-100">{site.name}</span>
                    <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                      {site.engine === "cloudflare" ? "Premium" : "Our server"}
                    </span>
                    <span className="text-xs text-zinc-400">{site.status}</span>
                  </div>
                  {site.liveUrl && (
                    <div className="mt-0.5 flex items-center gap-2 text-xs text-emerald-600">
                      <a href={site.liveUrl} target="_blank" rel="noreferrer" className="hover:underline">
                        {site.liveUrl}
                      </a>
                      <button onClick={() => copy(site.liveUrl as string)} className="text-zinc-500 hover:underline">
                        Copy
                      </button>
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => void onToggleSite(site)}
                    className="text-xs text-zinc-600 hover:underline dark:text-zinc-300"
                  >
                    {open ? "Hide" : "Manage"}
                  </button>
                  <button onClick={() => void onDeleteSite(site)} className="text-xs text-red-600 hover:underline">
                    Delete
                  </button>
                </div>
              </div>

              {/* §17.3 — the preview IS the test step; make it impossible to miss. */}
              <p className="mt-2 text-xs text-zinc-500">
                1. Upload zip → preview · 2. Check it, then Publish.
                {revs.some((r) => r.state !== "published")
                  ? ` Previews expire after ${status.caps.previewTtlHours}h.`
                  : ""}
              </p>

              {open && (
                <div className="mt-3 space-y-3 border-t border-zinc-100 pt-3 dark:border-zinc-800">
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      const input = revisionInput.current;
                      const file = input?.files?.[0];
                      if (!file) return;
                      void onUploadRevision(site, file).then(() => {
                        if (input) input.value = "";
                      });
                    }}
                    className="flex flex-wrap items-center gap-3"
                  >
                    <input
                      ref={revisionInput}
                      type="file"
                      accept=".zip,application/zip"
                      className="text-sm text-zinc-700 file:mr-3 file:rounded file:border-0 file:bg-zinc-900 file:px-3 file:py-1.5 file:text-sm file:text-white dark:text-zinc-300 dark:file:bg-zinc-100 dark:file:text-zinc-900"
                    />
                    <button
                      type="submit"
                      disabled={busy}
                      className="rounded bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                    >
                      {busy ? "Working…" : "Upload zip → preview"}
                    </button>
                    <span className="text-xs text-zinc-500">
                      A .zip up to {status.caps.maxZipMb} MB.
                      {site.engine === "cloudflare"
                        ? ` Max ${status.caps.premiumMaxFilesPerProject} files per site.`
                        : ""}
                    </span>
                  </form>

                  {revs.length === 0 && <p className="text-xs text-zinc-500">No revisions yet.</p>}

                  {revs.map((rev) => {
                    const previewUrl = rev.previewUrl ?? rev.cfUrl ?? `${status.publicBase}/pv/${rev.previewToken}/`;
                    const isLive = rev.state === "published";
                    return (
                      <div key={rev.id} className="rounded border border-zinc-200 p-3 text-sm dark:border-zinc-800">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="min-w-0">
                            <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-200">
                              {isLive ? "live" : `preview · expires in ${status.caps.previewTtlHours}h`}
                            </span>
                            <span className="ml-2 text-xs text-zinc-500">
                              {rev.fileCount} file{rev.fileCount === 1 ? "" : "s"} · {formatBytes(rev.bytes)}
                            </span>
                          </div>
                          <div className="flex items-center gap-2">
                            <a
                              href={previewUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="text-xs text-emerald-600 hover:underline"
                            >
                              Open preview
                            </a>
                            <button onClick={() => copy(previewUrl)} className="text-xs text-zinc-500 hover:underline">
                              Copy
                            </button>
                            {!isLive && (
                              <button
                                onClick={() => void onPublish(site, rev)}
                                disabled={busy}
                                className="rounded bg-emerald-600 px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
                              >
                                Publish to live
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </section>
      )}

      {/* Upload */}
      {tab === "files" && (
      <section className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
        <form onSubmit={onUpload} className="flex flex-wrap items-center gap-3">
          <input
            ref={fileInput}
            type="file"
            className="text-sm text-zinc-700 file:mr-3 file:rounded file:border-0 file:bg-zinc-900 file:px-3 file:py-1.5 file:text-sm file:text-white dark:text-zinc-300 dark:file:bg-zinc-100 dark:file:text-zinc-900"
          />
          <button
            type="submit"
            disabled={busy || !status.enabled || !status.entitled}
            className="rounded bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {busy ? "Uploading…" : "Upload & get a link"}
          </button>
        </form>
        <p className="mt-2 text-xs text-zinc-500">
          Any file up to {status.caps.maxFileSizeMb} MB. Executables are fine — scripts and pages aren’t.
        </p>
      </section>
      )}

      {/* TASK_155 P2 — Links: user-owned short links (/r/<slug|token>). */}
      {tab === "links" && (
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">Links</h2>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Short links that redirect to anything — a hosted file, a site, or any URL. {status.usage.linkCount} /{" "}
          {status.caps.maxLinks} used.
        </p>
        <form
          onSubmit={onAddLink}
          className="flex flex-wrap items-end gap-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"
        >
          <label className="flex flex-col gap-1 text-xs text-zinc-500">
            Target URL
            <input
              value={linkForm.target}
              onChange={(e) => setLinkForm((s) => ({ ...s, target: e.target.value }))}
              placeholder="https://…"
              className="w-72 rounded border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-zinc-500">
            Name (optional)
            <input
              value={linkForm.slug}
              onChange={(e) => setLinkForm((s) => ({ ...s, slug: e.target.value }))}
              placeholder="my-link"
              className="w-40 rounded border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            />
          </label>
          <button
            type="submit"
            disabled={busy || !status.enabled || !status.entitled}
            className="rounded bg-zinc-900 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
          >
            Create link
          </button>
        </form>
        {links.length === 0 && <p className="text-sm text-zinc-500">No links yet.</p>}
        {links.map((link) => {
          const shortUrl = `${status.linksBase}/r/${link.slug ?? link.token}`;
          return (
            <div
              key={link.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"
            >
              <div className="min-w-0">
                <a href={shortUrl} target="_blank" rel="noreferrer" className="truncate text-sm text-emerald-600 hover:underline">
                  {shortUrl}
                </a>
                <div className="mt-0.5 truncate text-xs text-zinc-500">
                  → {link.target} · {link.clickCount} click{link.clickCount === 1 ? "" : "s"}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => copy(shortUrl)} className="text-xs text-zinc-500 hover:underline">
                  Copy
                </button>
                <button onClick={() => void onEditLink(link)} className="text-xs text-zinc-600 hover:underline dark:text-zinc-300">
                  Edit
                </button>
                <button onClick={() => void onDeleteLink(link)} className="text-xs text-red-600 hover:underline">
                  Delete
                </button>
              </div>
            </div>
          );
        })}
      </section>
      )}

      {/* Files */}
      {tab === "files" && (
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">Your files</h2>
        {files.length === 0 && <p className="text-sm text-zinc-500">Nothing hosted yet. Upload a file above.</p>}
        {files.map((file) => {
          const publicUrl = file.url ?? `${status.publicBase}/hf/${file.token}`;
          return (
            <div key={file.id} className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-2 font-medium text-zinc-900 dark:text-zinc-100">
                    <span className="truncate">{file.dispositionFilename}</span>
                    <span
                      className={`rounded px-1.5 py-0.5 text-xs ${
                        file.visibility === "private"
                          ? "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
                          : "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
                      }`}
                    >
                      {file.visibility}
                    </span>
                  </div>
                  <div className="mt-0.5 text-xs text-zinc-500">
                    {formatBytes(file.bytes)} · {file.downloadCount} download{file.downloadCount === 1 ? "" : "s"} ·{" "}
                    <span className="font-mono">{file.sha256.slice(0, 12)}…</span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <a href={publicUrl} target="_blank" rel="noreferrer" className="text-xs text-emerald-600 hover:underline">
                    Open
                  </a>
                  <button onClick={() => copy(publicUrl)} className="text-xs text-zinc-500 hover:underline">
                    Copy link
                  </button>
                  <button
                    onClick={() => {
                      const next = window.prompt("New filename (contents unchanged):", file.dispositionFilename);
                      if (next && next.trim()) void onRename(file, next.trim());
                    }}
                    className="text-xs text-zinc-500 hover:underline"
                  >
                    Rename
                  </button>
                  <button onClick={() => void onToggleVisibility(file)} className="text-xs text-zinc-600 hover:underline dark:text-zinc-300">
                    {file.visibility === "private" ? "Make public" : "Make private"}
                  </button>
                  <button onClick={() => void onDelete(file)} className="text-xs text-red-600 hover:underline">
                    Delete
                  </button>
                </div>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <input
                  value={slugs[file.id] ?? file.slug ?? ""}
                  onChange={(e) => setSlugs((s) => ({ ...s, [file.id]: e.target.value }))}
                  placeholder="short link name (optional, e.g. my-app)"
                  className="w-64 rounded border border-zinc-300 px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900"
                />
                <button onClick={() => void onSaveSlug(file)} className="rounded border border-zinc-300 px-2 py-1 text-xs dark:border-zinc-700">
                  Save link name
                </button>
                <span className="truncate text-xs text-zinc-400">{publicUrl}</span>
              </div>
            </div>
          );
        })}
      </section>
      )}
    </div>
  );
}

