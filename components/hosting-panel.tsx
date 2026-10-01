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
  };
  usage: { storageBytes: number; fileCount: number; bandwidthBytes: number; period: string };
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
  const fileInput = useRef<HTMLInputElement>(null);

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

  useEffect(() => {
    void loadStatus();
    void loadFiles();
  }, [loadStatus, loadFiles]);

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

      {/* Upload */}
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

      {/* Files */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">Your files</h2>
        {files.length === 0 && <p className="text-sm text-zinc-500">Nothing hosted yet. Upload a file above.</p>}
        {files.map((file) => {
          const publicUrl = file.url ?? `${status.publicBase}/hf/${file.token}`;
          return (
            <div key={file.id} className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate font-medium text-zinc-900 dark:text-zinc-100">{file.dispositionFilename}</div>
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
    </div>
  );
}

