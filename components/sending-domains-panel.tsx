"use client";
import { useCallback, useEffect, useState } from "react";

import { useConfirm } from "@/components/confirm-provider";
import { Badge, Button, Card, Input, Label } from "@/components/ui";
import { timeAgo } from "@/lib/format-date";

// TASK_139 — Sending domains (self-serve DKIM for mail sent through our relay).
//
// The relay removed the dependency on a customer's own SMTP server. What it
// cannot remove is DKIM: a receiver fetches the public key from the From
// domain's DNS, so one record has to be published. This panel turns that into
// copy-paste — the key is generated here, and "Verify" tells you whether the DNS
// really answers with the key this server signs with.

type SendingDnsRecord = {
  purpose: "dkim" | "spf" | "dmarc";
  type: "TXT";
  name: string;
  value: string;
  note: string;
};

type SendingDomainRow = {
  id: string;
  domain: string;
  selector: string;
  publicKeyTxt: string;
  status: string;
  installedOnRelay: boolean;
  lastCheckedAt: string | null;
  lastCheckDetail: string | null;
  createdAt: string;
  records: SendingDnsRecord[];
};

type Check = { purpose: string; ok: boolean; advisory: boolean; detail: string };

const PURPOSE_LABEL: Record<string, string> = { dkim: "DKIM", spf: "SPF", dmarc: "DMARC" };

export function SendingDomainsPanel() {
  const confirm = useConfirm();
  const [domains, setDomains] = useState<SendingDomainRow[]>([]);
  const [relay, setRelay] = useState<{ ipv4: string; ipv6: string }>({ ipv4: "", ipv6: "" });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [newDomain, setNewDomain] = useState("");
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Fresh per-record results, keyed by domain id. Survives only until reload —
  // lastCheckDetail is the durable version of the same thing.
  const [checks, setChecks] = useState<Record<string, Check[]>>({});
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/sending-domains");
      if (!res.ok) {
        setError(res.status === 401 ? "Please sign in again." : "Could not load sending domains.");
        return;
      }
      const data = (await res.json()) as {
        domains: SendingDomainRow[];
        relay: { ipv4: string; ipv6: string };
      };
      setDomains(data.domains ?? []);
      setRelay(data.relay ?? { ipv4: "", ipv6: "" });
      setError("");
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Every setState inside `load` follows its `await fetch`, so nothing here is
    // a synchronous setState-in-effect — the rule cannot see through the call
    // boundary. Same disable + reasoning as components/device-list.tsx.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function add() {
    const domain = newDomain.trim();
    if (!domain) return;
    setAdding(true);
    setError("");
    try {
      const res = await fetch("/api/sending-domains", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? "Could not add that domain.");
        return;
      }
      setNewDomain("");
      await load();
    } catch {
      setError("Network error");
    } finally {
      setAdding(false);
    }
  }

  async function verify(id: string) {
    setBusyId(id);
    setError("");
    try {
      const res = await fetch(`/api/sending-domains/${id}/verify`, { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { error?: string; checks?: Check[] };
      if (!res.ok) {
        setError(data.error ?? "Verification failed.");
        return;
      }
      setChecks((prev) => ({ ...prev, [id]: data.checks ?? [] }));
      await load();
    } catch {
      setError("Network error");
    } finally {
      setBusyId(null);
    }
  }

  async function remove(row: SendingDomainRow) {
    const ok = await confirm({
      title: `Remove ${row.domain}?`,
      description:
        "Its signing key is removed from the relay too. Mail already sent stays signed; new mail from this domain stops being signed until it is added again.",
      confirmLabel: "Remove",
      confirmVariant: "danger",
    });
    if (!ok) return;
    setBusyId(row.id);
    setError("");
    try {
      const res = await fetch(`/api/sending-domains/${row.id}`, { method: "DELETE" });
      const data = (await res.json().catch(() => ({}))) as { error?: string; relayWarning?: string | null };
      if (!res.ok) {
        setError(data.error ?? "Could not remove that domain.");
        return;
      }
      if (data.relayWarning) {
        setError(`Removed here, but the relay key could not be cleaned up: ${data.relayWarning}`);
      }
      await load();
    } catch {
      setError("Network error");
    } finally {
      setBusyId(null);
    }
  }

  async function copy(key: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      window.setTimeout(() => setCopied((prev) => (prev === key ? null : prev)), 1500);
    } catch {
      setError("Your browser blocked clipboard access — select the value and copy it manually.");
    }
  }

  const relayConfigured = relay.ipv4 !== "" || relay.ipv6 !== "";

  return (
    <Card className="p-6">
      <h2 className="text-lg font-semibold text-fg">Sending domains</h2>
      <p className="mt-1 text-sm text-fg-muted">
        Prove you own the domain your mail is sent from, so receivers can verify it. SpaceWorker
        signs with a key it generates for you — publish the records below and press Verify.
      </p>
      <p className="mt-2 text-xs text-fg-muted">
        This is a one-time DNS edit on the sending domain, not a change to any mail server: nothing
        here needs your own SMTP server to be reachable or working.
      </p>

      {!relayConfigured ? (
        <p className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200">
          The server&apos;s sending addresses are not configured (SENDING_RELAY_IPV4 / SENDING_RELAY_IPV6),
          so SPF cannot be verified yet. Ask an operator to set them — DKIM can still be published meanwhile.
        </p>
      ) : null}

      {error ? (
        <p className="mt-4 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-200">
          {error}
        </p>
      ) : null}

      <div className="mt-5 flex items-end gap-2">
        <div className="w-full max-w-sm">
          <Label htmlFor="sending-domain-input">Add a domain</Label>
          <Input
            id="sending-domain-input"
            placeholder="example.com"
            value={newDomain}
            onChange={(e) => setNewDomain(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void add();
            }}
          />
        </div>
        <Button type="button" onClick={() => void add()} disabled={adding || newDomain.trim() === ""}>
          {adding ? "Adding…" : "Add"}
        </Button>
      </div>

      {loading ? (
        <p className="mt-6 text-sm text-fg-muted">Loading…</p>
      ) : domains.length === 0 ? (
        <p className="mt-6 text-sm text-fg-muted">
          No sending domains yet. Mail still goes out through the relay — it just isn&apos;t
          cryptographically signed, which is the usual reason it lands in spam.
        </p>
      ) : (
        <ul className="mt-6 flex flex-col gap-5">
          {domains.map((row) => (
            <DomainRow
              key={row.id}
              row={row}
              checks={checks[row.id] ?? []}
              busy={busyId === row.id}
              copiedKey={copied}
              onVerify={() => void verify(row.id)}
              onRemove={() => void remove(row)}
              onCopy={(key, value) => void copy(key, value)}
            />
          ))}
        </ul>
      )}
    </Card>
  );
}

function DomainRow({
  row,
  checks,
  busy,
  copiedKey,
  onVerify,
  onRemove,
  onCopy,
}: {
  row: SendingDomainRow;
  checks: Check[];
  busy: boolean;
  copiedKey: string | null;
  onVerify: () => void;
  onRemove: () => void;
  onCopy: (key: string, value: string) => void;
}) {
  const statusTone =
    row.status === "verified" ? "success" : row.status === "invalid" ? "warning" : "neutral";

  return (
    <li className="rounded-xl border border-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-fg">{row.domain}</span>
          <Badge tone={statusTone}>
            {row.status === "verified" ? "Verified" : row.status === "invalid" ? "Not verified" : "Pending"}
          </Badge>
          <Badge tone={row.installedOnRelay ? "success" : "danger"}>
            {row.installedOnRelay ? "Signing key installed" : "Signing key NOT installed"}
          </Badge>
          <span className="text-xs text-fg-muted">
            {row.lastCheckedAt ? `checked ${timeAgo(row.lastCheckedAt)}` : "never checked"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" variant="secondary" onClick={onVerify} disabled={busy}>
            {busy ? "Checking…" : "Verify"}
          </Button>
          <Button type="button" variant="ghost" onClick={onRemove} disabled={busy}>
            Remove
          </Button>
        </div>
      </div>

      {checks.length > 0 ? (
        <ul className="mt-3 flex flex-col gap-1">
          {checks.map((check) => (
            <li key={check.purpose} className="text-xs">
              <span
                className={
                  check.ok
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-amber-600 dark:text-amber-400"
                }
              >
                {check.ok ? "✓" : "✗"} {PURPOSE_LABEL[check.purpose] ?? check.purpose}
              </span>
              {check.advisory && !check.ok ? (
                <span className="text-fg-muted"> (advisory — does not block verification)</span>
              ) : null}
              <span className="text-fg-muted"> — {check.detail}</span>
            </li>
          ))}
        </ul>
      ) : row.lastCheckDetail ? (
        <p className="mt-3 text-xs text-fg-muted">{row.lastCheckDetail}</p>
      ) : null}

      <div className="mt-4 flex flex-col gap-3">
        {row.records.map((record) => {
          const key = `${row.id}:${record.purpose}`;
          return (
            <div key={key} className="rounded-lg bg-black/[0.03] p-3 dark:bg-white/[0.04]">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
                  {PURPOSE_LABEL[record.purpose] ?? record.purpose} · {record.type}
                </span>
                <Button type="button" variant="ghost" onClick={() => onCopy(key, record.value)}>
                  {copiedKey === key ? "Copied" : "Copy value"}
                </Button>
              </div>
              <dl className="mt-2 grid gap-1 text-xs">
                <div className="flex gap-2">
                  <dt className="w-14 shrink-0 text-fg-muted">Name</dt>
                  <dd className="break-all font-mono text-fg">{record.name}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="w-14 shrink-0 text-fg-muted">Value</dt>
                  <dd className="break-all font-mono text-fg">{record.value}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="w-14 shrink-0 text-fg-muted">Note</dt>
                  <dd className="text-fg-muted">{record.note}</dd>
                </div>
              </dl>
            </div>
          );
        })}
      </div>
    </li>
  );
}

