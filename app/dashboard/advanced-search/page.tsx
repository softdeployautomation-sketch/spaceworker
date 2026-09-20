"use client";

import Link from "next/link";
import { useState } from "react";
import { Badge, Button, Card, Input, Label, Spinner } from "@/components/ui";

// Advanced Search — a two-stage flow, deliberately separate from the
// Extract page's Search/Verify toggle:
//
//   Stage 1 "Discover": a plain business search (your query text, verbatim,
//   no webmail-dork bias) returns up to 20 real candidate domains. Nothing
//   is saved yet — this is a preview.
//
//   Stage 2 "Verify": you pick which candidates to check, and only those get
//   probed for a self-hosted webmail signature (candidate URLs + fingerprint
//   match, same mechanics as the Extract page's Verify mode). Confirmed
//   matches are saved as a real job + leads, visible in the normal leads
//   table like any other search.
//
// Built this way — search first, review, THEN verify only what you pick —
// instead of one opaque combined action, so you can see exactly which real
// domains a query turns up before spending a probe on any of them.

// Self-hosted platforms (HTTP fingerprint match, common in emerging markets
// on shared hosting) plus hosted providers (MX-record match, dominant in
// the US/Canada/Australia — added 2026-09-20 since real validation showed
// the self-hosted-only set matched under 2% of Western domains checked).
const WEBMAIL_PLATFORM_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "google-workspace", label: "Google Workspace" },
  { value: "microsoft-365", label: "Microsoft 365" },
  { value: "roundcube", label: "RoundCube" },
  { value: "squirrelmail", label: "SquirrelMail" },
  { value: "rainloop", label: "RainLoop" },
  { value: "zimbra", label: "Zimbra" },
  { value: "open-xchange", label: "Open-Xchange" },
  { value: "cpanel", label: "cPanel Webmail" },
];

interface Candidate {
  domain: string;
  sourceUrl: string;
  title: string;
}

interface VerifyResultRow {
  domain: string;
  platform: string | null;
}

export default function AdvancedSearchPage() {
  const [query, setQuery] = useState("");
  const [platforms, setPlatforms] = useState<string[]>(WEBMAIL_PLATFORM_OPTIONS.map((p) => p.value));
  const [discovering, setDiscovering] = useState(false);
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [results, setResults] = useState<VerifyResultRow[] | null>(null);
  const [searchJobId, setSearchJobId] = useState<string | null>(null);

  async function runDiscover() {
    if (!query.trim()) return;
    setDiscovering(true);
    setDiscoverError(null);
    setCandidates([]);
    setSelected(new Set());
    setResults(null);
    setSearchJobId(null);
    try {
      const res = await fetch("/api/advanced-search/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, maxCandidates: 20 }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Search failed.");
      setCandidates(data.candidates ?? []);
      // Default to everything selected — "select some" is one click away
      // (uncheck), matching how the checklist reads at a glance.
      setSelected(new Set((data.candidates ?? []).map((c: Candidate) => c.domain)));
    } catch (e) {
      setDiscoverError(e instanceof Error ? e.message : "Search failed.");
    } finally {
      setDiscovering(false);
    }
  }

  async function runVerify() {
    if (selected.size === 0) return;
    setVerifying(true);
    setVerifyError(null);
    setResults(null);
    try {
      const res = await fetch("/api/advanced-search/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, domains: Array.from(selected), platformCodes: platforms }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Verification failed.");
      setResults(data.results ?? []);
      setSearchJobId(data.searchJobId ?? null);
    } catch (e) {
      setVerifyError(e instanceof Error ? e.message : "Verification failed.");
    } finally {
      setVerifying(false);
    }
  }

  function toggleDomain(domain: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(domain)) next.delete(domain);
      else next.add(domain);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) =>
      prev.size === candidates.length ? new Set() : new Set(candidates.map((c) => c.domain)),
    );
  }

  const confirmedCount = results?.filter((r) => r.platform !== null).length ?? 0;

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <div>
        <h1 className="text-xl font-semibold text-fg">Advanced Search</h1>
        <div className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-fg-muted">
          <span><span className="font-semibold text-fg">1. Search</span> a business type + place</span>
          <span aria-hidden="true">→</span>
          <span><span className="font-semibold text-fg">2. Pick</span> which domains to check</span>
          <span aria-hidden="true">→</span>
          <span><span className="font-semibold text-fg">3. Verify</span> — matches save as leads automatically</span>
        </div>
      </div>

      <Card className="space-y-4 p-5">
        <div>
          <Label htmlFor="adv-query">Search query</Label>
          <Input
            id="adv-query"
            placeholder='e.g. "law firms in Lagos Nigeria"'
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && runDiscover()}
          />
        </div>

        <div>
          <Label>Mail platforms to check for in Stage 2</Label>
          <div className="flex flex-wrap gap-x-4 gap-y-1.5">
            {WEBMAIL_PLATFORM_OPTIONS.map((opt) => (
              <label key={opt.value} className="flex items-center gap-1.5 text-sm">
                <input
                  type="checkbox"
                  checked={platforms.includes(opt.value)}
                  onChange={(e) =>
                    setPlatforms((prev) =>
                      e.target.checked ? [...prev, opt.value] : prev.filter((v) => v !== opt.value),
                    )
                  }
                  className="h-4 w-4 cursor-pointer"
                />
                {opt.label}
              </label>
            ))}
          </div>
        </div>

        <Button onClick={runDiscover} disabled={discovering || !query.trim()}>
          {discovering ? <Spinner className="h-4 w-4" /> : null}
          {discovering ? "Searching…" : "Discover candidates"}
        </Button>
        {discoverError && <p className="text-sm text-red-600 dark:text-red-400">{discoverError}</p>}
      </Card>

      {candidates.length > 0 && (
        <Card className="space-y-3 p-5">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-fg">
              {candidates.length} candidate domain{candidates.length === 1 ? "" : "s"} found
            </p>
            <button onClick={toggleAll} className="text-sm text-brand-600 hover:underline dark:text-brand-400">
              {selected.size === candidates.length ? "Deselect all" : "Select all"}
            </button>
          </div>

          <div className="max-h-96 space-y-1 overflow-y-auto">
            {candidates.map((c) => {
              const result = results?.find((r) => r.domain === c.domain);
              return (
                <label
                  key={c.domain}
                  className="flex items-start gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-black/5 dark:hover:bg-white/5"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(c.domain)}
                    onChange={() => toggleDomain(c.domain)}
                    className="mt-0.5 h-4 w-4 cursor-pointer"
                  />
                  <span className="flex-1">
                    <span className="font-medium text-fg">{c.domain}</span>
                    <span className="block truncate text-xs text-fg-muted">{c.title}</span>
                  </span>
                  {result && (
                    <Badge tone={result.platform ? "success" : "neutral"}>
                      {result.platform ?? "no match"}
                    </Badge>
                  )}
                </label>
              );
            })}
          </div>

          <Button onClick={runVerify} disabled={verifying || selected.size === 0} variant="secondary">
            {verifying ? <Spinner className="h-4 w-4" /> : null}
            {verifying ? "Verifying…" : `Verify selected (${selected.size})`}
          </Button>
          {verifyError && <p className="text-sm text-red-600 dark:text-red-400">{verifyError}</p>}
        </Card>
      )}

      {results && (
        <Card className="space-y-2 p-5">
          <p className="text-sm font-medium text-fg">
            {confirmedCount} of {results.length} confirmed — saved to your leads.
          </p>
          {searchJobId && (
            <Link href="/dashboard/extract" className="text-sm text-brand-600 hover:underline dark:text-brand-400">
              View in Extract → job history
            </Link>
          )}
        </Card>
      )}
    </div>
  );
}
