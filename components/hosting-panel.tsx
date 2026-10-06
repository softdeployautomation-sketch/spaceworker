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
  /**
   * TASK_155 P6a (PLAN §19.4) — the three-option picker's two facts:
   *   premium       — this user may use OUR Cloudflare accounts
   *   platformReady — at least one platform account is healthy right now
   * The tab must not offer Premium without both, or the user hits a dead end at
   * publish. Free is always available to everyone (§19.2).
   */
  premium: boolean;
  platformReady: boolean;
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
  /** TASK_155 P6c — "local" (our server, free) or "cloudflare" (a Worker). */
  engine: string;
  customHost: string | null;
  /** The Worker address, once it is live; null for a local link or a failed deploy. */
  publicUrl: string | null;
  deployStatus: string;
  deployError: string | null;
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

/** TASK_157 Phase 4 — a domain the USER owns. Mirrors `UserDomainView` on the server. */
interface UserDomain {
  id: string;
  apex: string;
  label: string;
  source: string;
  status: string;
  zoneId: string | null;
  nameservers: string[] | null;
  selectable: boolean;
  note: string | null;
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
  // TASK_155 P6c — links pick an engine too: "local" (our server, free) or
  // "cloudflare" (a Worker on the premium/BYO edge). Same shape as siteForm.
  const [linkForm, setLinkForm] = useState({
    target: "",
    label: "",
    slug: "",
    engine: "local",
    credentialId: "",
    customHost: "",
  });
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
  // TASK_157 Phase 4 adds a fourth: Domains.
  const [tab, setTab] = useState<"sites" | "links" | "files" | "domains">("sites");
  const revisionInput = useRef<HTMLInputElement>(null);

  // TASK_157 Phase 4 — the user's OWN domains (never anybody else's; the route
  // filters server-side, so this list is already scoped by the time it arrives).
  const [domains, setDomains] = useState<UserDomain[]>([]);
  const [domainInput, setDomainInput] = useState("");
  // A single string rather than a global flag: "add" and "verify" are different
  // buttons and both can be in flight, so one shared boolean would disable the
  // wrong one while the other runs.
  const [domainBusy, setDomainBusy] = useState<"" | "add" | `verify:${string}` | `delete:${string}`>("");

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

  // TASK_157 Phase 4 — the caller's own domains. Loaded eagerly (not lazily on
  // tab click) so the tab badge can show a real count, and so an entitlement error
  // surfaces while the user is still looking at Sites rather than after a click.
  // TASK_157 Phase 4 — the domains this user may actually PUBLISH on.
  //
  // `selectable` is the server's own verdict (owned by you AND Cloudflare says the
  // zone is active), so the picker does not re-derive the rule and drift from it. A
  // pending or unverified domain is deliberately absent rather than shown-and-refused:
  // offering a choice that always 403s is worse than not offering it.
  //
  // Platform zones are already excluded — the list route returns only the caller's
  // own rows, and a platform row has no user owner, so it can never appear here.
  const publishableDomains = useMemo(
    () => domains.filter((d) => d.selectable),
    [domains]
  );

  const loadDomains = useCallback(async () => {
    const res = await fetch("/api/hosting/domains");
    if (!res.ok) return;
    const data = (await res.json()) as { domains: UserDomain[] };
    setDomains(data.domains);
  }, []);

  useEffect(() => {
    void loadStatus();
    void loadFiles();
    void loadLinks();
    void loadSites();
    void loadDomains();
  }, [loadStatus, loadFiles, loadLinks, loadSites, loadDomains]);

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
      // §17.4 + §19.4 — the picker only OFFERS options we can honour; this guard
      // covers stale state (the plan lapsed, or an admin turned the engine off
      // while this form sat open). The server re-checks both anyway.
      if (siteForm.engine === "cloudflare" && !siteForm.credentialId) {
        if (!status?.premium) {
          setError("Premium hosting is part of the premium plan — upgrade, or host this site on the free server.");
          return;
        }
        if (!status?.platformReady) {
          setError("Premium hosting is being set up right now — try again shortly, or pick your own account.");
          return;
        }
      }
      if (siteForm.engine === "cloudflare" && siteForm.credentialId) {
        // §19.9 Q1 ANSWERED: "Yours" is premium too — the select disables it, this
        // only catches stale state (the plan lapsed while the form sat open).
        if (!status?.premium) {
          setError("Premium hosting is part of the premium plan — upgrade, or host this site on the free server.");
          return;
        }
        if ((status?.credentials.length ?? 0) === 0) {
          setError("Connect an account in Settings first — then it appears here.");
          return;
        }
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

  // TASK_157 Phase 4 — add one of the user's own domains.
  //
  // The input is normalized SERVER-side (`normalizeDomainInput`), so pasting
  // "https://www.shop.example.co.uk/" is fine and reduces to example.co.uk. The
  // client deliberately does NOT try to pre-validate or trim labels: a second,
  // weaker copy of the rules would drift from the server's and reject domains the
  // server would accept.
  const onAddDomain = useCallback(
    async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const value = domainInput.trim();
      if (!value) return;
      setDomainBusy("add");
      setError("");
      setNotice("");
      try {
        const res = await fetch("/api/hosting/domains", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ domain: value }),
        });
        const data = (await res.json()) as {
          domain?: UserDomain;
          verified?: boolean;
          verifyNote?: string | null;
          error?: string;
        };
        if (!res.ok) {
          setError(data.error ?? "Couldn’t add that domain.");
          // Keep the text ONLY on failure. On success the domain is in the list
          // below, so clearing the box is what tells the user it worked.
          return;
        }
        setDomainInput("");
        // `verified: false` is NOT an error — the domain was added and the user
        // owns it; Cloudflare just hasn't activated the zone yet. Say so plainly
        // instead of showing a red message for a normal state.
        setNotice(
          data.verified
            ? `Added ${data.domain?.apex ?? value} — it’s ready to publish on.`
            : (data.verifyNote ?? `Added ${data.domain?.apex ?? value}.`)
        );
        await loadDomains();
      } catch {
        setError("Couldn’t add that domain — check your connection and try again.");
      } finally {
        setDomainBusy("");
      }
    },
    // `setDomainInput` is listed even though a useState setter is stable: the React
    // Compiler infers it from the clear-on-success call inside, and leaving it out
    // makes the compiler skip memoizing this callback entirely
    // (react-hooks/preserve-manual-memoization). Listing it is a no-op at runtime.
    [domainInput, loadDomains, setDomainInput]
  );

  // Re-check one domain against Cloudflare. Users run out of patience waiting for
  // a nameserver change to propagate, so this is an explicit button rather than a
  // silent poll: we would rather make an API call the user asked for than burn
  // Cloudflare rate limit on a timer.
  const onVerifyDomain = useCallback(
    async (domain: UserDomain) => {
      setDomainBusy(`verify:${domain.id}`);
      setError("");
      setNotice("");
      try {
        const res = await fetch(`/api/hosting/domains/${domain.id}`, { method: "POST" });
        const data = (await res.json()) as { domain?: UserDomain; error?: string };
        if (!res.ok) {
          setError(data.error ?? "Couldn’t check that domain.");
          return;
        }
        setNotice(
          data.domain?.selectable
            ? `${domain.apex} is active — you can publish on it now.`
            : `${domain.apex} is still activating at Cloudflare. Try again shortly.`
        );
        await loadDomains();
      } catch {
        setError("Couldn’t reach Cloudflare — check your connection and try again.");
      } finally {
        setDomainBusy("");
      }
    },
    [loadDomains]
  );

  const onDeleteDomain = useCallback(
    async (domain: UserDomain) => {
      // Spelled out what is and isn't lost: the row goes, but the domain and its
      // DNS do not. A vague "are you sure?" on a destructive action next to a
      // customer's real domain is not good enough.
      if (
        !window.confirm(
          `Remove ${domain.apex} from your list?\n\nNothing at your registrar or Cloudflare changes — you can add it back later.`
        )
      ) {
        return;
      }
      setDomainBusy(`delete:${domain.id}`);
      setError("");
      setNotice("");
      try {
        const res = await fetch(`/api/hosting/domains/${domain.id}`, { method: "DELETE" });
        if (!res.ok) {
          const data = (await res.json()) as { error?: string };
          setError(data.error ?? "Couldn’t remove that domain.");
          return;
        }
        setNotice(`Removed ${domain.apex}.`);
        await loadDomains();
      } catch {
        setError("Couldn’t remove that domain — check your connection and try again.");
      } finally {
        setDomainBusy("");
      }
    },
    [loadDomains]
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
            engine: linkForm.engine,
            // Premium is engine:"cloudflare" with no credentialId; "Yours" adds one.
            credentialId:
              linkForm.engine === "cloudflare" && linkForm.credentialId ? linkForm.credentialId : null,
            customHost:
              linkForm.engine === "cloudflare" && linkForm.customHost.trim()
                ? linkForm.customHost.trim()
                : null,
          }),
        });
        const data = (await res.json()) as { error?: string; link?: HostedLink };
        if (!res.ok) {
          setError(data.error ?? "Couldn’t create that link.");
          return;
        }
        setLinkForm({
          target: "",
          label: "",
          slug: "",
          engine: "local",
          credentialId: "",
          customHost: "",
        });
        // A Worker link can be saved and still not be live — say so plainly
        // instead of claiming success (the /r/ fallback works either way).
        const made = data.link;
        if (made && made.engine === "cloudflare" && made.deployStatus !== "live") {
          setNotice(
            `Link created, but its Worker isn’t live yet — ${made.deployError ?? "still deploying"}. Its /r/ link works in the meantime.`
          );
        } else if (made && made.engine === "cloudflare") {
          setNotice("Link created and live on the edge. The /r/ link still works.");
        } else {
          setNotice("Link created.");
        }
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
          Files, links and sites in one place — upload, check the preview, publish. Rename a file
          any time; what it serves never changes.
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
            // TASK_157 Phase 4 — the count is the domains YOU own, not the
            // platform's, so a user never sees a number that implies they can
            // reach zones they cannot.
            ["domains", `Domains (${domains.length})`],
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
          Zip a folder, check the preview, then publish. Three ways to host, per site: <strong>Free</strong> on our own
          server, <strong>Premium</strong> on our global edge (premium plan, nothing to set up), or <strong>Yours</strong>{" "}
          on an account of your own — connect one under Settings → Hosting accounts.
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
              value={siteForm.engine === "cloudflare" && siteForm.credentialId ? "byo" : siteForm.engine}
              onChange={(e) => {
                // "Yours" is still engine: "cloudflare" on the wire — it just names
                // a credentialId too, which is exactly what separates it from
                // "Premium" (engine: "cloudflare", credentialId: null).
                const v = e.target.value;
                setSiteForm((s) => ({
                  ...s,
                  engine: v === "byo" ? "cloudflare" : v,
                  credentialId: v === "byo" ? (s.credentialId || status.credentials[0]?.id || "") : "",
                }));
              }}
              className="rounded border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            >
              <option value="local">Free — on our server</option>
              <option value="cloudflare" disabled={!status.premium || !status.platformReady}>
                {status.premium
                  ? status.platformReady
                    ? "Premium — our global edge"
                    : "Premium — coming online shortly"
                  : "Premium — upgrade to unlock"}
              </option>
              {/* §19.9 Q1 ANSWERED (2026-10-02): BYO ("Yours") is PREMIUM-only
                  like option 2 — free users get one engine, ours. Both CF-ish
                  options therefore disable together, with one honest hint. */}
              {status.credentials.length > 0 ? (
                <option value="byo" disabled={!status.premium}>
                  {status.premium ? "Yours — your own account" : "Yours — upgrade to unlock"}
                </option>
              ) : (
                <option value="byo" disabled>
                  Yours — connect an account in Settings
                </option>
              )}
            </select>
            {!status.premium && (
              <span className="text-xs text-amber-600 dark:text-amber-400">
                Free hosting is included. Premium and Yours are both part of the premium plan.
              </span>
            )}
            {status.premium && !status.platformReady && (
              <span className="text-xs text-amber-600 dark:text-amber-400">
                Our edge accounts are being set up — try again shortly, or use your own account below.
              </span>
            )}
          </label>
          {siteForm.engine === "cloudflare" && siteForm.credentialId && status.credentials.length === 0 && (
            <span className="text-xs text-amber-600 dark:text-amber-400">
              No account connected yet — add one in Settings; it becomes an option here right away.
            </span>
          )}
          {siteForm.engine === "cloudflare" && (
            <label className="flex flex-col gap-1 text-xs text-zinc-500">
              Account
              <select
                value={siteForm.credentialId}
                onChange={(e) => setSiteForm((s) => ({ ...s, credentialId: e.target.value }))}
                className="rounded border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
              >
                <option value="">Ours (premium)</option>
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
                      {/* §19.4 — the badge must say WHICH source serves the site:
                          a CF site with no credentialId IS ours (option 2), not
                          "premium-ish". Saying only "Premium" is what let a BYO
                          site masquerade as ours. */}
                      {site.engine === "cloudflare"
                        ? site.credentialId
                          ? "Yours"
                          : "Ours · premium"
                        : "Free · our server"}
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

      {/* TASK_157 Phase 4 — Domains: the user's OWN domains, and the setup
          steps for each. The owner's rule is that a user may only publish on a
          domain they own, so this list is the ONLY source of host choices — and it
          is scoped server-side, so nothing here can widen it. */}
      {tab === "domains" && (
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">Your domains</h2>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Publish on a domain you own. Add it here, point it at Cloudflare, then it becomes
          available as a host for your links and sites. Each domain can belong to one account only.
        </p>

        <form
          onSubmit={onAddDomain}
          className="flex flex-wrap items-end gap-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"
        >
          <label className="flex flex-col gap-1 text-xs text-zinc-500">
            Domain you own
            <input
              value={domainInput}
              onChange={(e) => setDomainInput(e.target.value)}
              placeholder="example.com"
              // Disabled mid-flight so a double-submit cannot fire two POSTs, which
              // would race into a confusing 409 "already claimed".
              disabled={domainBusy === "add"}
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="none"
              className="w-64 rounded border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            />
          </label>
          <button
            type="submit"
            disabled={domainBusy === "add" || !domainInput.trim()}
            className="rounded bg-zinc-900 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
          >
            {domainBusy === "add" ? "Adding…" : "Add domain"}
          </button>
        </form>

        {domains.length === 0 ? (
          <p className="rounded-lg border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700">
            No domains yet. Add one above to publish on your own address.
          </p>
        ) : (
          <ul className="space-y-2">
            {domains.map((domain) => (
              <li key={domain.id} className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-medium text-zinc-900 dark:text-zinc-100">{domain.apex}</div>
                    <div className="mt-0.5 text-xs text-zinc-500">
                      {/* `selectable` is the server's own verdict, not a guess made
                          here — true only when Cloudflare reports the zone
                          `active`. A client-side "is it active?" would drift from
                          the rule that actually gates publishing. */}
                      {domain.selectable ? (
                        <span className="text-emerald-600 dark:text-emerald-400">Active — ready to publish on</span>
                      ) : (
                        <span className="text-amber-600 dark:text-amber-400">
                          {domain.status === "error" ? "Cloudflare reported a problem" : "Setting up…"}
                        </span>
                      )}
                      {domain.source === "manual" && <span> · added for you by our team</span>}
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <button
                      type="button"
                      onClick={() => void onVerifyDomain(domain)}
                      disabled={domainBusy !== ""}
                      className="rounded border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-700 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300"
                    >
                      {domainBusy === `verify:${domain.id}` ? "Checking…" : "Check status"}
                    </button>
                    <button
                      type="button"
                      onClick={() => void onDeleteDomain(domain)}
                      disabled={domainBusy !== ""}
                      className="rounded border border-zinc-300 px-3 py-1 text-xs font-medium text-red-600 disabled:opacity-50 dark:border-zinc-700 dark:text-red-400"
                    >
                      {domainBusy === `delete:${domain.id}` ? "Removing…" : "Remove"}
                    </button>
                  </div>
                </div>
                {/* The nameserver hint is the whole point of adding a domain, so it
                    gets real space — this is the one thing the user cannot look up
                    anywhere else, because it is specific to the zone Cloudflare
                    created for them. Copied as text, never auto-submitted. */}
                {!domain.selectable && domain.nameservers && domain.nameservers.length > 0 && (
                  <div className="mt-3 rounded bg-zinc-50 p-3 text-xs dark:bg-zinc-900">
                    <div className="font-medium text-zinc-700 dark:text-zinc-300">
                      Point {domain.apex} at Cloudflare
                    </div>
                    <p className="mt-1 text-zinc-500">
                      Set these two nameservers where you bought the domain, then wait a little and
                      press Check status.
                    </p>
                    <ul className="mt-2 space-y-1 font-mono text-zinc-800 dark:text-zinc-200">
                      {domain.nameservers.map((ns) => (
                        <li key={ns} className="flex items-center gap-2">
                          <span className="break-all">{ns}</span>
                          <button
                            type="button"
                            onClick={() => {
                              // Guarded rather than assumed: the EXE shell can refuse
                              // clipboard access, and an uncaught throw here would
                              // take down the whole panel.
                              void navigator.clipboard
                                ?.writeText(ns)
                                .then(() => setNotice(`Copied ${ns}.`))
                                .catch(() => setError("Couldn’t copy — select the text and copy it manually."));
                            }}
                            className="shrink-0 rounded border border-zinc-300 px-1.5 text-[10px] font-medium text-zinc-600 dark:border-zinc-700 dark:text-zinc-400"
                          >
                            Copy
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* The server's plain-language detail — e.g. "not in your Cloudflare
                    account yet". Shown last, and only when it adds something the
                    status line above does not already say. */}
                {domain.note && !domain.selectable && (
                  <p className="mt-2 text-xs text-zinc-500">{domain.note}</p>
                )}
              </li>
            ))}
          </ul>
        )}
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
          <label className="flex flex-col gap-1 text-xs text-zinc-500">
            Engine
            <select
              value={linkForm.engine === "cloudflare" && linkForm.credentialId ? "byo" : linkForm.engine}
              onChange={(e) => {
                // Same wire mapping as the Sites picker: "Yours" is
                // engine:"cloudflare" plus a credentialId; Premium is
                // engine:"cloudflare" with none.
                const v = e.target.value;
                setLinkForm((s) => ({
                  ...s,
                  engine: v === "byo" ? "cloudflare" : v,
                  credentialId: v === "byo" ? s.credentialId || status.credentials[0]?.id || "" : "",
                }));
              }}
              className="rounded border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            >
              <option value="local">Free — on our server</option>
              <option value="cloudflare" disabled={!status.premium || !status.platformReady}>
                {status.premium
                  ? status.platformReady
                    ? "Premium — our global edge"
                    : "Premium — coming online shortly"
                  : "Premium — upgrade to unlock"}
              </option>
              {status.credentials.length > 0 ? (
                <option value="byo" disabled={!status.premium}>
                  {status.premium ? "Yours — your own account" : "Yours — upgrade to unlock"}
                </option>
              ) : (
                <option value="byo" disabled>
                  Yours — connect an account in Settings
                </option>
              )}
            </select>
            {!status.premium && (
              <span className="text-xs text-amber-600 dark:text-amber-400">
                Edge links need the premium plan. Free links run on our server.
              </span>
            )}
            {status.premium && !status.platformReady && (
              <span className="text-xs text-amber-600 dark:text-amber-400">
                Our edge accounts are being set up — use your own account below.
              </span>
            )}
          </label>
          {linkForm.engine === "cloudflare" && (
            <label className="flex flex-col gap-1 text-xs text-zinc-500">
              Account
              <select
                value={linkForm.credentialId}
                onChange={(e) => setLinkForm((s) => ({ ...s, credentialId: e.target.value }))}
                className="rounded border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
              >
                <option value="">Ours (premium)</option>
                {status.credentials.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label} · …{c.tokenHint}
                  </option>
                ))}
              </select>
            </label>
          )}
          {linkForm.engine === "cloudflare" && (
            <label className="flex flex-col gap-1 text-xs text-zinc-500">
              Your domain (optional)
              {/* TASK_157 Phase 4 — a CHOICE, not a free-text box. The old text input
                  let anyone type any host, which the server would now refuse anyway;
                  offering only the domains this user owns and owns *usefully* (zone
                  active) makes the picker and the server agree. Platform zones are not
                  offered at all — they are ours, not theirs. */}
              <select
                value={linkForm.customHost}
                onChange={(e) => setLinkForm((s) => ({ ...s, customHost: e.target.value }))}
                className="w-48 rounded border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
              >
                <option value="">Our edge address</option>
                {publishableDomains.map((d) => (
                  <option key={d.id} value={`go.${d.apex}`}>
                    go.{d.apex}
                  </option>
                ))}
              </select>
              {publishableDomains.length === 0 && (
                <span className="text-xs text-zinc-400">
                  Add a domain on the Domains tab to publish on your own name.
                </span>
              )}
            </label>
          )}
          <button
            type="submit"
            disabled={busy || !status.enabled || !status.entitled}
            className="rounded bg-zinc-900 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
          >
            Create link
          </button>
        </form>
        {linkForm.engine === "cloudflare" && (
          <p className="text-xs text-zinc-500">
            The link is served by a Cloudflare Worker on your domain. The{" "}
            <span className="font-mono">{status.linksBase}/r/…</span> address always keeps working, so a link
            never goes dark.
          </p>
        )}
        {links.length === 0 && <p className="text-sm text-zinc-500">No links yet.</p>}
        {links.map((link) => {
          const fallbackUrl = `${status.linksBase}/r/${link.slug ?? link.token}`;
          const onEdge = link.engine === "cloudflare";
          const liveUrl = onEdge && link.deployStatus === "live" ? link.publicUrl : null;
          // TASK_169 — share the SHORTEST live address. The edge host is usually
          // the long workers.dev name, so the /r/ fallback (user slug, else the
          // 7-char token) wins whenever the edge URL is longer. Never show a dead
          // address: the edge URL is a candidate only when it is live; the /r/
          // fallback (§19.12.2) always resolves so it is always a candidate.
          const candidates = [fallbackUrl, ...(liveUrl ? [liveUrl] : [])];
          const shareUrl = candidates.sort((a, b) => a.length - b.length)[0];
          const heroIsFallback = shareUrl === fallbackUrl;
          return (
            <div key={link.id} className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <a href={shareUrl} target="_blank" rel="noreferrer" className="truncate text-sm text-emerald-600 hover:underline">
                      {shareUrl}
                    </a>
                    <span
                      className={`rounded px-1.5 py-0.5 text-xs ${
                        onEdge
                          ? "bg-indigo-100 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-200"
                          : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
                      }`}
                    >
                      {onEdge ? "edge" : "our server"}
                    </span>
                    {onEdge && (
                      <span
                        className={`rounded px-1.5 py-0.5 text-xs ${
                          link.deployStatus === "live"
                            ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
                            : link.deployStatus === "error"
                              ? "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200"
                              : "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200"
                        }`}
                      >
                        {link.deployStatus === "live"
                          ? "live"
                          : link.deployStatus === "error"
                            ? "not deployed"
                            : "deploying…"}
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 truncate text-xs text-zinc-500">
                    → {link.target} · {link.clickCount} click{link.clickCount === 1 ? "" : "s"}
                    {onEdge && link.customHost ? ` · ${link.customHost}` : ""}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => copy(shareUrl)} className="text-xs text-zinc-500 hover:underline">
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
              {onEdge && !heroIsFallback && (
                <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-zinc-100 pt-2 text-xs text-zinc-500 dark:border-zinc-800">
                  <span className="shrink-0">Always works:</span>
                  <a href={fallbackUrl} target="_blank" rel="noreferrer" className="truncate font-mono text-emerald-600 hover:underline">
                    {fallbackUrl}
                  </a>
                  <button onClick={() => copy(fallbackUrl)} className="text-xs text-zinc-500 hover:underline">
                    Copy
                  </button>
                </div>
              )}
              {onEdge && link.deployError && (
                <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">{link.deployError}</p>
              )}
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

