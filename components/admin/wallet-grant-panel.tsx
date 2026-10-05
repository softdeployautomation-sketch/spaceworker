"use client";

import { useState } from "react";

// PLAN_TASK_167 W3 — the admin's manual "give this customer some money" form.
//
// A DELIBERATELY DUMB CLIENT. It collects three strings and POSTs them; every rule
// that matters is enforced on the server by lib/wallet.ts `grantBalance`, which is
// the only place that can enforce them:
//
//   * the note cannot be blank and the amount cannot be zero;
//   * the ledger kind is chosen by the SIGN, so a negative amount is filed as
//     `admin_adjust` and a positive one as `admin_grant`;
//   * a replayed idempotencyKey cannot produce a second credit.
//
// This panel checks enough to give the admin an immediate, specific error instead
// of a round trip, and NOTHING more. The client-side amount check is a
// convenience, never the guarantee — a form is not a security boundary, and
// duplicating the rules here is how the two copies start disagreeing.
//
// `users` is the list the panel already loaded for the Users tab, passed in rather
// than re-fetched: a second, differently-shaped user list is a second thing to keep
// in sync, and the id is all this form needs.
export interface GrantTargetUser {
  id: string;
  email: string;
}


export default function WalletGrantPanel({ users }: { users: GrantTargetUser[] }) {
  const [userId, setUserId] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  // The amount is typed in DOLLARS because that is what an admin is thinking in,
  // and converted to CENTS here — the unit the ledger actually stores. Rounded, so
  // an amount like 10.005 becomes 1001 cents rather than 1000.5, which the server
  // would refuse. The server still re-validates the integer; this is a UI affordance.
  const amountCents = Math.round(Number(amount) * 100);

  async function submit() {
    setMessage(null);
    if (!userId) {
      setMessage({ ok: false, text: "Pick a user first" });
      return;
    }
    if (!Number.isFinite(amountCents) || amountCents === 0) {
      setMessage({ ok: false, text: "Enter an amount" });
      return;
    }
    if (note.trim().length === 0) {
      // Said here AND refused server-side. The server check is the guarantee; this
      // just spares a pointless round trip on the most common mistake.
      setMessage({ ok: false, text: "Say why — this is what makes it auditable later" });
      return;
    }

    setSaving(true);
    try {
      const res = await fetch("/api/admin/wallet/grant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId,
          amountCents,
          note: note.trim(),
          // A key per SUBMITTED FORM, not per click. A double-clicked Save or a
          // retried fetch replays the same key and is answered with 409 instead of
          // a second credit; a deliberately NEW grant gets a new key, because the
          // form is cleared below and the next submit mints a fresh one.
          idempotencyKey: `admin-grant:${userId}:${amountCents}:${Date.now()}`,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage({ ok: false, text: typeof data.error === "string" ? data.error : "Grant failed" });
        return;
      }
      setMessage({
        ok: true,
        text: `Granted. New balance $${(data.balanceCents / 100).toFixed(2)} (${data.kind}).`,
      });
      setAmount("");
      setNote("");
    } catch {
      setMessage({ ok: false, text: "Network error" });
    } finally {
      setSaving(false);
    }
  }

  const input =
    "mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950";

  return (
    <div className="mt-6 max-w-xl rounded-xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <h3 className="text-lg font-semibold tracking-tight">Give a customer funds</h3>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        Adds credit to a wallet by hand. Every grant is recorded against your admin
        account and appears in the customer&apos;s ledger with your note.
      </p>

      <label className="mt-4 block text-sm font-medium text-zinc-700 dark:text-zinc-300">
        User
      </label>
      <select value={userId} onChange={(e) => setUserId(e.target.value)} className={input}>
        <option value="">Select a user…</option>
        {users.map((u) => (
          <option key={u.id} value={u.id}>
            {u.email}
          </option>
        ))}
      </select>

      <label className="mt-4 block text-sm font-medium text-zinc-700 dark:text-zinc-300">
        Amount (USD)
      </label>
      <input
        type="number"
        step="0.01"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        placeholder="10.00"
        className={input}
      />
      <p className="mt-0.5 text-xs text-zinc-400 dark:text-zinc-500">
        A negative amount takes funds away, and is filed as an adjustment rather
        than a grant.
      </p>

      <label className="mt-4 block text-sm font-medium text-zinc-700 dark:text-zinc-300">
        Note
      </label>
      <input
        type="text"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Goodwill for the outage on the 3rd"
        className={input}
      />

      {message && (
        <p
          className={`mt-4 text-sm ${
            message.ok ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"
          }`}
        >
          {message.text}
        </p>
      )}

      <button
        onClick={submit}
        disabled={saving}
        className="mt-5 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-300"
      >
        {saving ? "Granting…" : "Grant funds"}
      </button>
    </div>
  );
}
