"use client";

// TASK_157 Phase 4b — the ADMIN's domain registry panel.
//
// The user side (components/hosting-panel.tsx → Domains tab) lets someone manage
// THEIR OWN domains. This is the other half: every domain on the platform, who owns
// it, and the one path that can attribute a domain to a user who did not add it
// themselves.
//
// WHY IT SITS NEXT TO PlatformAccountsPanel. Those two are one workflow. A domain
// row is only meaningful next to the Cloudflare account that will serve it: an admin
// looking at a `pending` domain needs to know WHICH account's token has to grow
// Zone|Zone:Edit before that domain can go live.
//
// WHAT IT DOES NOT DO. It cannot activate a domain. Activation comes from Cloudflare
// reporting the zone `active` (reconcileUserDomain), and with zone.create blocked
// (TASK_157 §7.3) the only way a domain goes live today is the domain already
// existing in a Cloudflare account someone points us at. So this panel creates rows
// and removes them; it never asserts readiness. A row added here starts `pending`,
// which is correct — a checkbox that lied about readiness would be worse than one
// that says "wait".

import { useCallback, useEffect, useState } from "react";

/** A user offered by the chooser. Deliberately id + email + tier only. */
interface OwnerOption {
  id: string;
  email: string;
  tier: string;
}

/** One row of the admin registry. Mirrors `AdminDomainView` in the registry lib. */
interface AdminDomainView {
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
  ownerKind: string;
  ownerUserId: string | null;
  ownerEmail: string | null;
  credentialId: string | null;
}

/** Status → the dot colour and the plain-language meaning. */
function statusStyle(status: string): { dot: string; text: string } {
  if (status === "active") return { dot: "bg-emerald-500", text: "Live — publishable" };
  if (status === "error") return { dot: "bg-red-500", text: "Error" };
  return { dot: "bg-amber-500", text: "Pending — not yet publishable" };
}
export default function DomainsPanel() {
  const [domains, setDomains] = useState<AdminDomainView[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");

  // --- the add form ---
  const [apex, setApex] = useState("");
  const [label, setLabel] = useState("");
  const [ownerQuery, setOwnerQuery] = useState("");
  const [ownerId, setOwnerId] = useState("");
  const [ownerChoices, setOwnerChoices] = useState<OwnerOption[]>([]);

  /** The chosen user's email, shown in the confirmation. */
  const ownerEmail = ownerChoices.find((o) => o.id === ownerId)?.email ?? "";

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/hosting/domains");
      if (!res.ok) throw new Error("Failed to load domains");
      const data = await res.json();
      setDomains((data.domains ?? []) as AdminDomainView[]);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load domains");
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- every setState in load is behind the fetch await, not synchronous
    void load();
  }, [load]);

  // The chooser list. Debounced with the effect's own timer rather than a library --
  // an admin typing a domain owner is not a hot path, and this keeps the panel
  // dependency-free the way the rest of the admin components are.
  useEffect(() => {
    let cancelled = false;
    const handle = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/admin/hosting/domains/users?q=${encodeURIComponent(ownerQuery)}&limit=50`
        );
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setOwnerChoices((data.users ?? []) as OwnerOption[]);
      } catch {
        // A failed chooser search is not worth an error banner -- the admin can still
        // type an exact address, and the POST route validates the id regardless.
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [ownerQuery]);

  async function addDomain() {
    if (!apex.trim() || !ownerId) return;
    setBusy("add");
    setError("");
    setNotice("");
    try {
      const res = await fetch("/api/admin/hosting/domains", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domain: apex.trim(),
          userId: ownerId,
          label: label.trim() || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : "Failed to add the domain");
        return;
      }
      setNotice(`Added ${data.domain.apex} for ${ownerEmail}. It starts pending -- see below.`);
      setApex("");
      setLabel("");
      setOwnerId("");
      setOwnerQuery("");
      await load();
    } catch {
      setError("Network error");
    } finally {
      setBusy("");
    }
  }

  async function removeDomain(id: string) {
    setBusy("del:" + id);
    setError("");
    setNotice("");
    try {
      const res = await fetch(`/api/admin/hosting/domains?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : "Failed to remove the domain");
        return;
      }
      setNotice("Domain removed.");
      await load();
    } catch {
      setError("Network error");
    } finally {
      setBusy("");
    }
  }

  const rows = domains ?? [];

return (
    <section className="mt-8">
      <h2 className="text-2xl font-semibold tracking-tight">Domains</h2>
      <p className="mt-1 max-w-3xl text-sm text-fg-muted">
        Every domain on the platform and who owns it. Adding one here is the only way to attach a
        domain to a user who did not add it themselves &mdash; useful when they bought it at an
        external registrar, or have not pointed it at Cloudflare yet.
      </p>

      {/* --- add --- */}
      <div className="mt-4 rounded-xl border border-border bg-bg-elevated p-4">
        <h3 className="text-sm font-semibold">Add a domain for a user</h3>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="text-xs font-medium text-fg-muted">Domain</span>
            <input
              value={apex}
              onChange={(e) => setApex(e.target.value)}
              placeholder="example.com"
              className="mt-1 w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-fg-muted">Label (optional)</span>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Main site"
              className="mt-1 w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm"
            />
          </label>
        </div>

        <label className="mt-3 block">
          <span className="text-xs font-medium text-fg-muted">Owner</span>
          <input
            value={ownerQuery}
            onChange={(e) => {
              setOwnerQuery(e.target.value);
              // Changing the search invalidates the chosen id. Keeping a selection whose
              // label no longer matches the text is how a domain gets attributed to the
              // wrong person.
              setOwnerId("");
            }}
            placeholder="Search by email&hellip;"
            className="mt-1 w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm"
          />
        </label>

        {ownerQuery && ownerChoices.length > 0 && (
          <ul className="mt-2 max-h-40 overflow-y-auto rounded-lg border border-border">
            {ownerChoices.map((o) => (
              <li key={o.id}>
                <button
                  type="button"
                  onClick={() => {
                    setOwnerId(o.id);
                    setOwnerQuery(o.email);
                  }}
                  className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-black/5 dark:hover:bg-white/5"
                >
                  <span>{o.email}</span>
                  <span className="text-xs text-fg-muted">{o.tier}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <button
          type="button"
          onClick={addDomain}
          disabled={!apex.trim() || !ownerId || busy === "add"}
          className="mt-3 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
        >
          {busy === "add" ? "Adding&hellip;" : "Add domain"}
        </button>
        <p className="mt-2 text-xs text-fg-muted">
          Domains added here start <strong>pending</strong> and are not publishable until Cloudflare
          reports the zone active. Until zone creation is enabled on a platform token (TASK_157
          &sect;7.3) that means the domain must already exist in a Cloudflare account &mdash; add it
          there first, then use the user&apos;s own &ldquo;Check status&rdquo; button.
        </p>
      </div>

      {error && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
      {notice && <p className="mt-3 text-sm text-emerald-600 dark:text-emerald-400">{notice}</p>}

{/* --- list --- */}
      <div className="mt-5">
        {!domains ? (
          <p className="text-sm text-fg-muted">Loading&hellip;</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-fg-muted">No domains yet.</p>
        ) : (
          <ul className="divide-y divide-border rounded-xl border border-border">
            {rows.map((d) => {
              const style = statusStyle(d.status);
              return (
                <li key={d.id} className="flex flex-wrap items-start justify-between gap-3 p-4">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`h-2 w-2 shrink-0 rounded-full ${style.dot}`} />
                      <span className="font-medium">{d.apex}</span>
                      <span className="text-xs text-fg-muted">{style.text}</span>
                    </div>
                    <div className="mt-1 text-xs text-fg-muted">
                      {d.ownerKind === "platform" ? (
                        <>Owner: platform</>
                      ) : (
                        <>Owner: {d.ownerEmail ?? "unknown user"}</>
                      )}
                      {" &middot; "}Source: {d.source}
                      {d.label && d.label !== d.apex ? <> &middot; {d.label}</> : null}
                    </div>
                    {d.note && <div className="mt-1 text-xs text-fg-muted">{d.note}</div>}
                    {d.nameservers && d.nameservers.length > 0 && (
                      <div className="mt-1 break-all font-mono text-xs text-fg-muted">
                        {d.nameservers.join("  ")}
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => removeDomain(d.id)}
                    disabled={busy === "del:" + d.id}
                    className="shrink-0 rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:bg-black/5 disabled:opacity-40 dark:hover:bg-white/5"
                  >
                    {busy === "del:" + d.id ? "Removing&hellip;" : "Remove"}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

