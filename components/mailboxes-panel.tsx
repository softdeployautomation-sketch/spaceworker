"use client";
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { timeAgo } from "@/lib/format-date";
import { useConfirm } from "@/components/confirm-provider";

type Mailbox = {
  id: string;
  label: string;
  host: string;
  port: number;
  username: string;
  fromAddress: string | null;
  secure: boolean;
  allowInsecure: boolean;
  dailyLimit: number;
  sentToday: number;
  sentTodayDate: string | null;
  active: boolean;
  lastTestedAt: string | null;
  lastTestOk: boolean | null;
  createdAt: string;
}

// Task 29, item 5 — a user's OWN deliverability test/seed mailbox (their Gmail or
// any IMAP inbox). It's what the test-send probe and the batch gate poll to check
// placement (inbox vs spam). Separate from sending mailboxes; password is
// encrypted, IMAP only. NULL row = use the platform default.
type TestMailbox = {
  id: string;
  label: string;
  host: string;
  port: number;
  username: string;
  secure: boolean;
  active: boolean;
  createdAt: string;
};

// Task 26, Piece 5a — real-world SMTP security as three explicit choices instead
// of the old single ambiguous "Use TLS" checkbox. Each maps to a conventional
// default port (STILL editable after, for nonstandard providers), and the send
// path enforces the correct TLS negotiation per choice.
type SecurityMode = "starttls" | "implicit" | "none";

const SECURITY_OPTIONS: { value: SecurityMode; label: string; hint: string; port: string }[] = [
  { value: "starttls", label: "STARTTLS (recommended)", hint: "port 587 — plaintext first, then upgrade", port: "587" },
  { value: "implicit", label: "Implicit TLS / SSL", hint: "port 465 — TLS from the first byte", port: "465" },
  { value: "none", label: "None (unencrypted)", hint: "port 25 — self-hosted/internal relays only", port: "25" },
];

// The `secure` (implicit TLS) of the eventual Mailbox row is derived from the port
// (465 => true) exactly like the send path, so the form and a real send agree.
function securityToPayload(mode: SecurityMode, port: number): { secure: boolean; allowInsecure: boolean } {
  return { secure: port === 465, allowInsecure: mode === "none" };
}

function modeForMailbox(m: Mailbox): SecurityMode {
  if (m.allowInsecure) return "none";
  if (m.port === 465) return "implicit";
  return "starttls";
}

type MailboxForm = {
  label: string;
  host: string;
  port: string;
  username: string;
  fromAddress: string;
  password: string;
  securityMode: SecurityMode;
  dailyLimit: string;
};

const EMPTY_FORM: MailboxForm = {
  label: "",
  host: "",
  port: "587",
  username: "",
  fromAddress: "",
  password: "",
  securityMode: "starttls",
  dailyLimit: "40",
};

export default function MailboxesPanel() {
  const confirm = useConfirm();
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Mailbox | null>(null);
  const [form, setForm] = useState<MailboxForm>(EMPTY_FORM);
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; error?: string }>>({});
  // Task 26, Piece 5a — live pre-save connection test in the Add/Edit modal.
  const [testConnecting, setTestConnecting] = useState(false);
  const [testConnResult, setTestConnResult] = useState<{ ok: boolean; error?: string } | null>(null);
  // Task 29, item 5 — per-user deliverability test/seed mailbox registration.
  const [testMailboxes, setTestMailboxes] = useState<TestMailbox[]>([]);
  const [testMbLoading, setTestMbLoading] = useState(true);
  const [testMbForm, setTestMbForm] = useState({ label: "", host: "", port: "993", username: "", password: "" });
  const [testMbError, setTestMbError] = useState("");
  const [testMbSaving, setTestMbSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      // Sending mailboxes + (Task 29, item 5) the user's registered
      // deliverability test/seed mailbox, loaded together.
      const mailRes = await fetch("/api/mailboxes");
      if (!mailRes.ok) throw new Error("Failed to load mailboxes");
      setMailboxes((await mailRes.json()) as Mailbox[]);
      const testRes = await fetch("/api/test-mailboxes");
      if (testRes.ok) setTestMailboxes((await testRes.json()) as TestMailbox[]);
      setTestMbLoading(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load mailboxes");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function openAdd() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setFormError("");
    setTestConnResult(null);
    setModalOpen(true);
  }

  function openEdit(m: Mailbox) {
    setEditing(m);
    setForm({
      label: m.label,
      host: m.host,
      port: String(m.port),
      username: m.username,
      fromAddress: m.fromAddress ?? "",
      password: "",
      securityMode: modeForMailbox(m),
      dailyLimit: String(m.dailyLimit),
    });
    setFormError("");
    setTestConnResult(null);
    setModalOpen(true);
  }

  async function save() {
    setSaving(true);
    setFormError("");
    try {
      const port = Number(form.port);
      const dailyLimit = Number(form.dailyLimit);
      if (!form.label.trim() || !form.host.trim() || !form.username.trim() || !Number.isInteger(port) || port <= 0) {
        setFormError("Label, host, username and a valid port are required");
        return;
      }
      const { secure, allowInsecure } = securityToPayload(form.securityMode, port);
      const payload: Record<string, unknown> = {
        label: form.label.trim(),
        host: form.host.trim(),
        port,
        username: form.username.trim(),
        secure,
        allowInsecure,
        dailyLimit: Math.max(1, dailyLimit),
      };
      if (form.fromAddress.trim()) payload.fromAddress = form.fromAddress.trim();
      if (form.password.trim()) payload.password = form.password;

      const url = editing ? `/api/mailboxes/${editing.id}` : "/api/mailboxes";
      const res = await fetch(url, {
        method: editing ? "PUT" : "POST",
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(typeof data.error === "string" ? data.error : "Failed to save mailbox");
      }
      const saved = data as Mailbox;
      setMailboxes((prev) =>
        editing ? prev.map((m) => (m.id === saved.id ? saved : m)) : [...prev, saved]
      );
      setModalOpen(false);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "Failed to save mailbox");
    } finally {
      setSaving(false);
    }
  }

  // Task 26, Piece 5a — pre-save connection test. POSTs the CURRENT form values
  // (nothing persisted) to /api/mailboxes/test-connection, which verifies against
  // the same transport logic a real send uses. Lets the user catch a bad
  // host/port/credentials/TLS-config immediately, before saving.
  async function testConnection() {
    setFormError("");
    setTestConnResult(null);
    const port = Number(form.port);
    if (!form.host.trim() || !form.username.trim() || !form.password.trim() || !Number.isInteger(port) || port <= 0) {
      setTestConnResult({ ok: false, error: "Enter a host, port, username and password first." });
      return;
    }
    const { secure, allowInsecure } = securityToPayload(form.securityMode, port);
    setTestConnecting(true);
    try {
      const res = await fetch("/api/mailboxes/test-connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host: form.host.trim(), port, username: form.username.trim(), password: form.password, secure, allowInsecure }),
      });
      const data = await res.json().catch(() => ({}));
      setTestConnResult({ ok: Boolean(data.ok), error: typeof data.error === "string" ? data.error : undefined });
    } catch {
      setTestConnResult({ ok: false, error: "Network error" });
    } finally {
      setTestConnecting(false);
    }
  }

  async function runTest(m: Mailbox) {
    setTestingId(m.id);
    setTestResults((prev) => ({ ...prev, [m.id]: { ok: false, error: "Testing…" } }));
    try {
      const res = await fetch(`/api/mailboxes/${m.id}/test`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      const ok = Boolean(data.ok);
      setTestResults((prev) => ({
        ...prev,
        [m.id]: { ok, error: data.error as string | undefined },
      }));
      setMailboxes((prev) =>
        prev.map((x) =>
          x.id === m.id
            ? { ...x, lastTestedAt: new Date().toISOString(), lastTestOk: ok }
            : x
        )
      );
    } catch {
      setTestResults((prev) => ({ ...prev, [m.id]: { ok: false, error: "Network error" } }));
    } finally {
      setTestingId(null);
    }
  }

  async function toggleActive(m: Mailbox) {
    try {
      const res = await fetch(`/api/mailboxes/${m.id}`, {
        method: "PUT",
        body: JSON.stringify({ active: !m.active }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setMailboxes((prev) => prev.map((x) => (x.id === m.id ? (data as Mailbox) : x)));
      }
    } catch {
      // ignore transient toggle errors
    }
  }

  async function remove(m: Mailbox) {
    if (!(await confirm({
      title: `Delete mailbox "${m.label}"?`,
      description: "This cannot be undone.",
      confirmLabel: "Delete",
    }))) return;
    try {
      const res = await fetch(`/api/mailboxes/${m.id}`, { method: "DELETE" });
      if (res.ok) {
        setMailboxes((prev) => prev.filter((x) => x.id !== m.id));
      }
    } catch {
      // ignore transient delete errors
    }
  }

  // --- Task 29, item 5 — per-user deliverability test/seed mailbox ---

  async function registerTestMailbox() {
    const port = Number(testMbForm.port);
    if (!testMbForm.label.trim() || !testMbForm.host.trim() || !testMbForm.username.trim() || !testMbForm.password.trim() || !Number.isInteger(port) || port <= 0) {
      setTestMbError("Label, host, port, username and password are required.");
      return;
    }
    setTestMbSaving(true);
    setTestMbError("");
    try {
      const res = await fetch("/api/test-mailboxes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label: testMbForm.label.trim(),
          host: testMbForm.host.trim(),
          port,
          username: testMbForm.username.trim(),
          password: testMbForm.password,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : "Failed to register test mailbox");
      setTestMailboxes((prev) => {
        const existing = prev.find((x) => x.id === (data as TestMailbox).id);
        return existing ? prev.map((x) => (x.id === (data as TestMailbox).id ? data as TestMailbox : x)) : [...prev, data as TestMailbox];
      });
      setTestMbForm({ label: "", host: "", port: "993", username: "", password: "" });
    } catch (e) {
      setTestMbError(e instanceof Error ? e.message : "Failed to register test mailbox");
    } finally {
      setTestMbSaving(false);
    }
  }

  async function removeTestMailbox(t: TestMailbox) {
    if (!(await confirm({
      title: `Delete test mailbox "${t.label}"?`,
      description: "You'll go back to using the platform-default seed mailbox for deliverability checks unless you register another one.",
      confirmLabel: "Delete",
    }))) return;
    try {
      const res = await fetch("/api/test-mailboxes", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: t.id }),
      });
      if (res.ok) setTestMailboxes((prev) => prev.filter((x) => x.id !== t.id));
    } catch {
      // ignore transient delete errors
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Mailboxes</h1>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            Your own SMTP accounts. Passwords are encrypted — we never store or return them in plaintext.
          </p>
        </div>
        <button
          type="button"
          onClick={openAdd}
          className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-300"
        >
          Add Mailbox
        </button>
      </div>

      {error && <p className="mt-4 text-sm text-red-600 dark:text-red-400">{error}</p>}

      {loading ? (
        <p className="mt-8 text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>
      ) : mailboxes.length === 0 ? (
        <div className="mt-8 rounded-xl border border-dashed border-zinc-300 p-10 text-center dark:border-zinc-700">
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            No mailboxes yet. Add your first SMTP mailbox to get started.
          </p>
        </div>
      ) : (
        <div className="mt-8 grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
  {mailboxes.map((m) => {
            const test = testResults[m.id];
            return (
              <div
                key={m.id}
                className={`flex flex-col rounded-xl border bg-white p-5 shadow-sm dark:bg-zinc-900 ${
                  m.active
                    ? "border-zinc-200 dark:border-zinc-800"
                    : "border-zinc-200 opacity-60 dark:border-zinc-800"
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h2 className="truncate font-semibold">{m.label}</h2>
                    <p className="mt-0.5 truncate text-sm text-zinc-500 dark:text-zinc-400">
                      {(m.fromAddress || m.username)} @ {m.host}:{m.port}
                    </p>
                  </div>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
                      m.active
                        ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400"
                        : "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
                    }`}
                  >
                    {m.active ? "Active" : "Paused"}
                  </span>
                </div>

                <div className="mt-4 rounded-lg bg-zinc-50 px-3 py-2 text-sm dark:bg-zinc-800/60">
                  <span className="text-zinc-500 dark:text-zinc-400">Sent today</span>{" "}
                  <span className="font-medium">
                    {m.sentToday} / {m.dailyLimit}
                  </span>
                </div>

                <div className="mt-2 text-sm">
                  {m.lastTestedAt ? (
                    <p className="flex items-center gap-1.5 text-zinc-500 dark:text-zinc-400">
                      <span className={m.lastTestOk ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}>
                        {m.lastTestOk ? "✓" : "✗"}
                      </span>
                      Last test {timeAgo(m.lastTestedAt)}
                    </p>
                  ) : (
                    <p className="text-zinc-400 dark:text-zinc-500">Not tested yet</p>
                  )}
                  {test && (
                    <p
                      className={`mt-1 text-xs ${
                        test.ok
                          ? "text-emerald-600 dark:text-emerald-400"
                          : "text-red-600 dark:text-red-400"
                      }`}
                    >
                      {test.ok ? "✓ Connection OK" : `✗ ${test.error ?? "Failed"}`}
                    </p>
                  )}
                </div>

                <div className="mt-4 flex flex-wrap gap-2 border-t border-zinc-100 pt-4 dark:border-zinc-800">
                  <button
                    type="button"
                    onClick={() => runTest(m)}
                    disabled={testingId === m.id}
                    className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium transition-colors hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                  >
                    {testingId === m.id ? "Testing…" : "Test"}
                  </button>
                  <button
                    type="button"
                    onClick={() => toggleActive(m)}
                    className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                  >
                    {m.active ? "Pause" : "Resume"}
                  </button>
                  <button
                    type="button"
                    onClick={() => openEdit(m)}
                    className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(m)}
                    className="ml-auto rounded-lg border border-red-200 px-3 py-1.5 text-xs font-medium text-red-600 transition-colors hover:bg-red-50 dark:border-red-900/50 dark:text-red-400 dark:hover:bg-red-950/40"
                  >
                    Delete
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Task 29, item 5 — per-user deliverability test/seed mailbox. A user's own
          IMAP account (e.g. their Gmail) checked for placement by the test-send
          probe and batch gate. Optional — with none registered, the platform
          default seed is used. */}
      <div className="mt-10 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Deliverability test mailbox</h2>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            Your own IMAP account used to confirm that campaign mail lands in the inbox and not spam.
            A Gmail account works well — its spam filter gives a realistic signal. With none registered,
            SpaceWorker uses its platform default seed mailbox. Passwords are encrypted and used for IMAP reads only.
          </p>
        </div>

        {testMbLoading ? (
          <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>
        ) : testMailboxes.length === 0 ? (
          <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">No test mailbox registered — using the platform default.</p>
        ) : (
          <div className="mt-3 flex flex-col gap-2">
            {testMailboxes.map((t) => (
              <div key={t.id} className="flex items-center justify-between gap-3 rounded-lg border border-zinc-200 px-3 py-2 dark:border-zinc-800">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{t.label}</p>
                  <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">{t.username} @ {t.host}:{t.port}</p>
                </div>
                <button
                  type="button"
                  onClick={() => removeTestMailbox(t)}
                  className="rounded-lg border border-red-200 px-3 py-1.5 text-xs font-medium text-red-600 transition-colors hover:bg-red-50 dark:border-red-900/50 dark:text-red-400 dark:hover:bg-red-950/40"
                >
                  Delete
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="mt-4 grid grid-cols-2 gap-3">
          <input
            type="text"
            value={testMbForm.label}
            onChange={(e) => setTestMbForm({ ...testMbForm, label: e.target.value })}
            placeholder="Label — e.g. My Gmail"
            className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-normal outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950"
          />
          <input
            type="text"
            value={testMbForm.host}
            onChange={(e) => setTestMbForm({ ...testMbForm, host: e.target.value })}
            placeholder="imap.gmail.com"
            className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-normal outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950"
          />
          <input
            type="text"
            value={testMbForm.username}
            onChange={(e) => setTestMbForm({ ...testMbForm, username: e.target.value })}
            placeholder="you@gmail.com"
            className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-normal outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950"
          />
          <input
            type="password"
            value={testMbForm.password}
            onChange={(e) => setTestMbForm({ ...testMbForm, password: e.target.value })}
            placeholder="App password"
            className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-normal outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950"
          />
        </div>
        <div className="mt-2 grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)] items-center gap-3">
          <label className="flex flex-col gap-1 text-xs text-zinc-500 dark:text-zinc-400">
            Port
            <input
              type="number"
              value={testMbForm.port}
              onChange={(e) => setTestMbForm({ ...testMbForm, port: e.target.value })}
              className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-normal outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950"
            />
          </label>
          <span className="text-xs text-zinc-400 dark:text-zinc-500">IMAP — 993 (implicit TLS) is the Gmail/standard default.</span>
        </div>
        {testMbError && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{testMbError}</p>}
        <button
          type="button"
          onClick={() => void registerTestMailbox()}
          disabled={testMbSaving}
          className="mt-3 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-300"
        >
          {testMbSaving ? "Saving…" : "Register test mailbox"}
        </button>
      </div>
  {modalOpen && typeof document !== "undefined" && createPortal(
        // Rendered via a portal to document.body, not in place — this page's
        // content sits inside Shell's z-10 wrapper, a SIBLING of the app's
        // z-30 Dock (the desktop-style bottom nav), not an ancestor of it. A
        // nested z-50 only competes within its own stacking context, so this
        // modal was rendering behind the Dock regardless of its own z-index —
        // confirmed live via a screenshot showing the Dock's icons overlapping
        // the modal's bottom edge. A portal escapes that ancestor entirely so
        // z-50 is compared against the real global stacking order.
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-xl bg-white p-5 shadow-xl dark:bg-zinc-900">
            <h2 className="text-lg font-semibold">
              {editing ? "Edit mailbox" : "Add mailbox"}
            </h2>
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
              {editing
                ? "Leave the password blank to keep the current one."
                : "Credentials are encrypted with AES-256-GCM before they are stored."}
            </p>

            <div className="mt-3 flex flex-col gap-2.5">
              <label className="flex flex-col gap-1 text-sm font-medium">
                Label
                <input
                  type="text"
                  value={form.label}
                  onChange={(e) => setForm({ ...form, label: e.target.value })}
                  placeholder="e.g. Sales outreach"
                  className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-normal outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950"
                />
              </label>

              <label className="flex flex-col gap-1 text-sm font-medium">
                Host
                <input
                  type="text"
                  value={form.host}
                  onChange={(e) => setForm({ ...form, host: e.target.value })}
                  placeholder="smtp.example.com"
                  className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-normal outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950"
                />
              </label>

              <div className="grid grid-cols-2 gap-3">
                <label className="flex flex-col gap-1 text-sm font-medium">
                  Port
                  <input
                    type="number"
                    value={form.port}
                    onChange={(e) => setForm({ ...form, port: e.target.value })}
                    className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-normal outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950"
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm font-medium">
                  Daily limit
                  <input
                    type="number"
                    value={form.dailyLimit}
                    onChange={(e) => setForm({ ...form, dailyLimit: e.target.value })}
                    className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-normal outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950"
                  />
                </label>
              </div>

              <label className="flex flex-col gap-1 text-sm font-medium">
                Username
                <input
                  type="text"
                  value={form.username}
                  onChange={(e) => setForm({ ...form, username: e.target.value })}
                  placeholder="you@example.com"
                  className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-normal outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950"
                />
              </label>

              <label className="flex flex-col gap-1 text-sm font-medium">
                From address (optional)
                <input
                  type="text"
                  value={form.fromAddress}
                  onChange={(e) => setForm({ ...form, fromAddress: e.target.value })}
                  placeholder="you@example.com"
                  className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-normal outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950"
                />
                <span className="text-xs font-normal leading-snug text-zinc-500 dark:text-zinc-400">
                  Leave blank for a normal account. Only needed for a relay service like Resend where you send as a different address than you log in with.
                </span>
              </label>

              <label className="flex flex-col gap-1 text-sm font-medium">
                Password
                <input
                  type="password"
                  value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                  placeholder={editing ? "Leave blank to keep current" : "SMTP password"}
                  className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-normal outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950"
                />
                <span className="text-xs font-normal text-zinc-500 dark:text-zinc-400">
                  Chrome may warn about reusing a saved password here — that behavior is expected. We need your real SMTP credentials to send on your behalf, so choose to mark the site as legitimate if prompted.
                </span>
              </label>

              <label className="flex flex-col gap-1 text-sm font-medium">
                Security
                <select
                  value={form.securityMode}
                  onChange={(e) => {
                    const value = e.target.value as SecurityMode;
                    const option = SECURITY_OPTIONS.find((o) => o.value === value);
                    // Choosing a security mode pre-fills the conventional port for it
                    // (still editable after, for nonstandard providers).
                    setForm({ ...form, securityMode: value, port: option ? option.port : form.port });
                  }}
                  className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-normal outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950"
                >
                  {SECURITY_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label} — {o.hint}</option>
                  ))}
                </select>
                {form.securityMode === "none" ? (
                  <span className="text-xs font-normal leading-snug text-amber-600 dark:text-amber-400">
                    ⚠ Unencrypted — real SMTP providers essentially never need this; it exists for self-hosted/internal relays only.
                  </span>
                ) : (
                  <span className="text-xs font-normal leading-snug text-zinc-500 dark:text-zinc-400">
                    The send is always encrypted; this only picks how the connection negotiates it.
                  </span>
                )}
              </label>

              <div className="mt-1 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void testConnection()}
                  disabled={testConnecting}
                  className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium transition-colors hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                >
                  {testConnecting ? "Testing…" : "Test connection"}
                </button>
                {testConnResult && (
                  <span
                    className={`text-xs ${testConnResult.ok ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}
                  >
                    {testConnResult.ok ? "✓ Connection OK" : `✗ ${testConnResult.error ?? "Failed"}`}
                  </span>
                )}
              </div>
            </div>

            {formError && <p className="mt-2.5 text-sm text-red-600 dark:text-red-400">{formError}</p>}

            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={save}
                disabled={saving}
                className="flex-1 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-300"
              >
                {saving ? "Saving…" : editing ? "Save changes" : "Add mailbox"}
              </button>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}