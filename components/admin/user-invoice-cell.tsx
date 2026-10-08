"use client";

import { useState } from "react";

// TASK_184 B3 (MONEY) — the "Send invoice" cell on the admin UsersTab row (the
// user detail surface the spec points at: "on the user detail an action 'Send
// invoice'"). Collapsed, it is ONE button; expanded, it lazily fetches that
// user's invoices + the configured prices and renders either the send form or
// the already-open invoice with its editable amount.
//
// Money surface rules:
//   - the amount input is PRE-FILLED with the AdminSetting default for the
//     chosen plan (live from /api/admin/wallets — never hardcoded) and freely
//     editable (owner: "the pricing will be at the default price we set for
//     each but i can edit before sending");
//   - switching the plan re-prefills from that plan's default;
//   - everything else (tier, methods, validation) is the SERVER's job — this
//     component never computes a tier and never sends one.

type PlanName = "premium_plus" | "premium_xdevice";

type Invoice = {
  id: string;
  plan: string;
  tier: number;
  amountUsd: number;
  status: string;
  createdAt: string;
};

type Defaults = { premium_plus: number; premium_xdevice: number };

const PLAN_LABELS: Record<PlanName, string> = {
  premium_plus: "Premium Plus (tier 5)",
  premium_xdevice: "Premium XDevice (tier 3)",
};

export function UserInvoiceCell({ userId }: { userId: string }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [plan, setPlan] = useState<PlanName>("premium_plus");
  const [amount, setAmount] = useState("");
  const [amountTouched, setAmountTouched] = useState(false);
  const [defaults, setDefaults] = useState<Defaults | null>(null);
  const [openInvoice, setOpenInvoice] = useState<Invoice | null>(null);

  function prefill(p: PlanName, d: Defaults | null) {
    if (!amountTouched && d) setAmount(String(d[p]));
  }

  async function expand() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    setError("");
    setMsg("");
    setLoading(true);
    try {
      const [invRes, pricesRes] = await Promise.all([
        fetch(`/api/admin/users/${userId}/invoices`),
        fetch(`/api/admin/wallets`),
      ]);
      const invData = await invRes.json().catch(() => ({}));
      if (!invRes.ok) {
        setError(typeof invData.error === "string" ? invData.error : "Failed to load invoices");
        return;
      }
      const existing: Invoice | undefined = invData.invoices?.find(
        (i: Invoice) => i.status === "open",
      );
      setOpenInvoice(existing ?? null);
      if (existing) {
        setPlan(existing.plan as PlanName);
        setAmount(String(existing.amountUsd));
        setAmountTouched(true);
      }
      if (pricesRes.ok) {
        const prices = await pricesRes.json().catch(() => ({}));
        const d: Defaults = {
          premium_plus: Number(prices.webSubscriptionPriceUsd),
          premium_xdevice: Number(prices.xdevicePriceUsd),
        };
        if (Number.isFinite(d.premium_plus) && Number.isFinite(d.premium_xdevice)) {
          setDefaults(d);
          if (!existing) {
            setAmountTouched(false);
            setAmount(String(d[plan]));
          }
        }
      }
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }

  async function send() {
    setSaving(true);
    setError("");
    setMsg("");
    try {
      const res = await fetch(`/api/admin/users/${userId}/invoices`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan, amountUsd: Number(amount) }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setOpenInvoice(data.invoice);
        setAmountTouched(true);
        setMsg("✓ invoice sent");
      } else {
        setError(typeof data.error === "string" ? data.error : "Failed to send invoice");
      }
    } catch {
      setError("Network error");
    } finally {
      setSaving(false);
    }
  }

  async function save() {
    if (!openInvoice) return;
    setSaving(true);
    setError("");
    setMsg("");
    try {
      const res = await fetch(`/api/admin/users/${userId}/invoices/${openInvoice.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan, amountUsd: Number(amount) }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setOpenInvoice(data.invoice);
        setMsg("✓ saved");
      } else {
        setError(typeof data.error === "string" ? data.error : "Failed to save");
      }
    } catch {
      setError("Network error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="min-w-[240px]">
      <button
        onClick={() => void expand()}
        className="rounded-lg border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800"
      >
        {open ? "Close" : openInvoice ? `Invoice ${openInvoice.status}…` : "Send invoice"}
      </button>

      {open && (
        <div className="mt-2 space-y-2 rounded-lg border border-zinc-200 bg-zinc-50 p-2 dark:border-zinc-700 dark:bg-zinc-900/50">
          {loading ? (
            <p className="text-xs text-zinc-500">Loading…</p>
          ) : (
            <>
              <select
                value={plan}
                onChange={(e) => {
                  const p = e.target.value as PlanName;
                  setPlan(p);
                  prefill(p, defaults);
                }}
                aria-label="Invoice plan"
                className="w-full rounded-lg border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-700 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-200"
              >
                {(Object.keys(PLAN_LABELS) as PlanName[]).map((p) => (
                  <option key={p} value={p}>
                    {PLAN_LABELS[p]}
                  </option>
                ))}
              </select>
              <input
                type="number"
                min={1}
                step="0.01"
                value={amount}
                onChange={(e) => {
                  setAmountTouched(true);
                  setAmount(e.target.value);
                }}
                aria-label="Invoice amount (USD)"
                placeholder="Amount (USD)"
                className="w-full rounded-lg border border-zinc-300 bg-white px-2 py-1 text-sm text-zinc-700 outline-none focus:border-zinc-500 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-200"
              />
              <button
                onClick={() => void (openInvoice ? save() : send())}
                disabled={saving || !amount}
                className="w-full rounded-lg bg-emerald-600 px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
              >
                {saving ? "Saving…" : openInvoice ? "Save invoice" : "Send invoice"}
              </button>
              {openInvoice && openInvoice.status !== "open" && (
                <p className="text-xs text-zinc-500">
                  Settled — editing is disabled server-side.
                </p>
              )}
              {msg && <p className="text-xs text-emerald-600 dark:text-emerald-400">{msg}</p>}
              {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
            </>
          )}
        </div>
      )}
    </div>
  );
}
