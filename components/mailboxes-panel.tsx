"use client";
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { timeAgo } from "@/lib/format-date";
import { useConfirm } from "@/components/confirm-provider";
import { PROVIDER_PRESETS, presetForHost } from "@/lib/smtp-provider-presets";

type Mailbox = {
  id: string;
  label: string;
  host: string;
  port: number;
  username: string;
  // Task 30, item 4 — multiple From addresses per mailbox (rotated across
  // recipients at queue-build time). Empty array = send as the SMTP username.
  fromAddresses: string[];
  secure: boolean;
  allowInsecure: boolean;
  dailyLimit: number;
  sentToday: number;
  sentTodayDate: string | null;
  active: boolean;
  lastTestedAt: string | null;
  lastTestOk: boolean | null;
  createdAt: string;
  // TASK_134 (premium) — "us" | "ca" | "uk" | null (direct, the default).
  sendRegion: string | null;
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
  { value: "starttls", label: "STARTTLS (recommended)", hint: "usual port 587 — plaintext first, then upgrade", port: "587" },
  { value: "implicit", label: "Implicit TLS / SSL", hint: "usual port 465 — TLS from the first byte", port: "465" },
  { value: "none", label: "None (unencrypted)", hint: "any port — no encryption (self-hosted/internal relays)", port: "25" },
];

// The `port` above is only a SUGGESTION used to pre-fill the Port field. It must
// never overwrite a port the user typed: doing exactly that silently rewrote a
// working 24610 to a black-holed 587 the moment "STARTTLS" was selected, which
// is why the pre-save test then appeared to hang for two minutes instead of
// reporting anything. See the select's onChange for the guard.

// Provider quick-fill presets live in lib/ as pure data so the host+port+security
// coherence rule is testable (tests/smtp-provider-presets.test.ts) rather than
// something a reviewer has to catch by eye — a preset with a host but the wrong
// port looks authoritative while producing a connection nothing will answer.
// See lib/smtp-provider-presets.ts for why no preset may use "unencrypted".


/**
 * What the SEND will actually negotiate. Deliberately derived the same way the
 * server derives it (lib/mailer-send.ts: port 465 => implicit TLS, anything
 * else => STARTTLS, unless the explicit "None" mode) rather than from the
 * selected label, because the port is what really decides. Shown to the user so
 * the picker can never imply a handshake style that a send won't use — on a
 * non-standard port like 24610 the only honest answer is "STARTTLS, because
 * 24610 isn't 465", and the user should see that before they save.
 *
 * 465 wins outright: the send derives implicit TLS from the port alone, so the
 * "None" opt-out (allowInsecure) has no effect there and the label must not
 * claim otherwise.
 */
function effectiveMode(mode: SecurityMode, port: number): SecurityMode {
  if (port === 465) return "implicit";
  if (mode === "none") return "none";
  return "starttls";
}

/** True when the Security label and the port disagree about the handshake. */
function securityMismatch(mode: SecurityMode, port: number): boolean {
  return effectiveMode(mode, port) !== mode;
}

/** One sentence naming the handshake that will actually be used, and why. */
function describeNegotiation(mode: SecurityMode, port: number): string {
  const effective = effectiveMode(mode, port);
  const mismatched = securityMismatch(mode, port);
  if (effective === "implicit") {
    return mismatched
      ? "TLS from the first byte — port 465 always uses implicit TLS, whatever Security is set to."
      : `TLS from the first byte on port ${port}.`;
  }
  if (effective === "none") {
    return `No encryption — credentials and mail are sent in the clear on port ${port}.`;
  }
  return mismatched
    ? `STARTTLS — implicit TLS is only used on port 465, so port ${port} connects in plaintext and upgrades before logging in.`
    : `Connects in plaintext on port ${port}, then upgrades to TLS before logging in.`;
}

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

/**
 * The pre-save test's answer, plus what the server said about itself. The extra
 * fields come from the server-side capability probe (lib/smtp-diagnostics.ts):
 *
 *  - `warning` — the connection succeeded but with a caveat worth reading. The
 *    important one: the server advertised no AUTH, so our username/password were
 *    never checked and outgoing mail may be accepted and then dropped rather
 *    than relayed. A plain green tick hides that completely.
 *  - `capabilities.banner` — the server's own greeting line ("220 localhost
 *    Python SMTP 1.4.6"). Frequently the fastest way to notice you're talking
 *    to a different service than you assumed on that port.
 */
type TestConnResult = {
  ok: boolean;
  error?: string;
  warning?: string;
  capabilities?: {
    connected: boolean;
    reachable: boolean;
    banner: string | null;
    authAdvertised: boolean | null;
    authMechanisms: string[];
    starttlsAdvertised: boolean | null;
  };
  /**
   * The server's answer to a real MAIL FROM / RCPT TO (aborted with RSET, never
   * DATA). This is what separates "the server talks to us" from "the server will
   * take our mail" — a relay can do the first and refuse the second forever.
   */
  envelope?: {
    attempted: boolean;
    accepted: boolean;
    refused: boolean;
    refusedAt: "MAIL FROM" | "RCPT TO" | null;
    reply: string | null;
  };
  /**
   * TASK_140 — will the mail actually be DKIM-SIGNED once it leaves? The SMTP
   * exchange above cannot answer that: an unsigned message is accepted with 250
   * and then spam-foldered by the receiver, so a mailbox can pass every check
   * here and still be useless. Mirrors lib/sending-domains SigningCoverage.
   */
  signing?: {
    entries: { domain: string; status: "verified" | "unverified" | "unsigned"; detail: string }[];
    unsigned: string[];
    hasUnsigned: boolean;
    platformDomain: string | null;
    warning: string | null;
  };
};
/**
 * TASK_140 — "will this mail actually be SIGNED?"
 *
 * Rendered from both test surfaces (the stored-mailbox Test and the pre-save
 * Test) so a mailbox can never report a clean green tick while its mail is being
 * relayed unauthenticated. That combination — server accepts with 250, receiver
 * spam-folders it — is the one send failure that looks exactly like success, and
 * it is what made a live campaign show "sent" and deliver nothing.
 *
 * Deliberately shows the POSITIVE case too: "signed and its published key
 * matches" is the whole chain working, and without saying so there is no way to
 * tell it apart from "we never checked".
 */
function SigningNotice({ signing }: { signing?: TestConnResult["signing"] }) {
  if (!signing || signing.entries.length === 0) return null;
  if (signing.warning) {
    return (
      <p className="mt-1 rounded-lg border border-red-300 bg-red-50 p-2 text-xs leading-snug text-red-800 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300">
        {signing.warning}
      </p>
    );
  }
  return (
    <p className="mt-1 text-xs leading-snug text-emerald-600 dark:text-emerald-400">
      ✓ DKIM — {signing.entries.map((e) => e.detail).join("; ")}.
    </p>
  );
}



type MailboxForm = {
  label: string;
  host: string;
  port: string;
  username: string;
  fromAddresses: string[];
  password: string;
  securityMode: SecurityMode;
  dailyLimit: string;
  // TASK_134 — "" means direct (no region), matching sendRegion's null on the
  // server; a <select> can't hold null so this is the one place it's "".
  sendRegion: string;
};

const EMPTY_FORM: MailboxForm = {
  label: "",
  host: "",
  port: "587",
  username: "",
  fromAddresses: [],
  password: "",
  securityMode: "starttls",
  dailyLimit: "40",
  sendRegion: "",
};

// TASK_134 — matches lib/exit-nodes.ts's METADATA exactly (id/label/flag);
// kept as a small static list here rather than fetched, since these three
// are the only regions that will ever exist without a code change on both
// sides anyway.
const SEND_REGIONS: { value: string; label: string }[] = [
  { value: "us", label: "🇺🇸 United States (New York)" },
  { value: "ca", label: "🇨🇦 Canada (Toronto)" },
  { value: "uk", label: "🇬🇧 United Kingdom (London)" },
];

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
  const [testResults, setTestResults] = useState<Record<string, TestConnResult>>({});
  // Task 26, Piece 5a — live pre-save connection test in the Add/Edit modal.
  const [testConnecting, setTestConnecting] = useState(false);
  const [testConnResult, setTestConnResult] = useState<TestConnResult | null>(null);
  // True once the user has typed in the Port field themselves. Choosing a
  // Security mode pre-fills the conventional port ONLY while this is false —
  // otherwise picking "STARTTLS (recommended)" would rewrite a hand-typed
  // non-standard port (e.g. 24610) to 587, which is how a working mailbox got
  // turned into a two-minute "Testing…" hang.
  const [portTouched, setPortTouched] = useState(false);
  // Which provider preset was applied, plus its note. Purely cosmetic state for
  // the picker: it drives the note under the field and lets the select snap back
  // to "Custom" the moment the user edits the host by hand, so the label can
  // never keep claiming "Resend" after the host has been changed to something
  // else (the same "the label must not imply what the send won't do" rule that
  // governs Security above).
  const [presetId, setPresetId] = useState("");
  // Task 29, item 5 — per-user deliverability test/seed mailbox registration.
  const [testMailboxes, setTestMailboxes] = useState<TestMailbox[]>([]);
  const [testMbLoading, setTestMbLoading] = useState(true);
  const [testMbForm, setTestMbForm] = useState({ label: "", host: "", port: "993", username: "", password: "" });
  const [testMbError, setTestMbError] = useState("");
  const [testMbSaving, setTestMbSaving] = useState(false);
  // TASK_134 (premium) — same /api/entitlements pattern already used for the
  // private-browser egress picker (components/device-console.tsx). The region
  // control is always VISIBLE, just disabled with an upsell until this
  // resolves true — never silently hidden (this app's own convention).
  const [isPremium, setIsPremium] = useState(false);
  const [premiumLoaded, setPremiumLoaded] = useState(false);

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
    fetch("/api/entitlements")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { premium?: boolean } | null) => setIsPremium(data?.premium === true))
      .catch(() => setIsPremium(false))
      .finally(() => setPremiumLoaded(true));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function openAdd() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setFormError("");
    setTestConnResult(null);
    setPortTouched(false);
    setPresetId("");
    setModalOpen(true);
  }

  function openEdit(m: Mailbox) {
    setEditing(m);
    setForm({
      label: m.label,
      host: m.host,
      port: String(m.port),
      username: m.username,
      fromAddresses: m.fromAddresses ?? [],
      password: "",
      securityMode: modeForMailbox(m),
      dailyLimit: String(m.dailyLimit),
      sendRegion: m.sendRegion ?? "",
    });
    setFormError("");
    setTestConnResult(null);
    // An existing mailbox already HAS a meaningful port — it was loaded from
    // the saved row, not from a mode preset, so treat it as user-chosen and
    // never let a mode switch overwrite it.
    setPortTouched(true);
    // Recognise a provider from the SAVED host (not from a guess) so the note
    // under the field still explains the login convention when editing a mailbox
    // that was created from a preset. A custom/self-hosted host matches nothing
    // and correctly shows no provider note. Only the label is set here — an
    // existing row's own username is never overwritten by a preset.
    setPresetId(presetForHost(m.host)?.id ?? "");
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
      // Task 30, item 4 — multiple From addresses (rotated across recipients at
      // queue-build time). Empty list / all-blank rows => send as the SMTP username.
      payload.fromAddresses = form.fromAddresses.map((a) => a.trim()).filter((a) => a.length > 0);
      if (form.password.trim()) payload.password = form.password;
      // TASK_134 (premium) — "" in the form means direct/no region; only ever
      // sent as a real region string when the picker isn't disabled.
      payload.sendRegion = isPremium && form.sendRegion ? form.sendRegion : null;

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
        body: JSON.stringify({
          host: form.host.trim(), port, username: form.username.trim(), password: form.password, secure, allowInsecure,
          sendRegion: isPremium && form.sendRegion ? form.sendRegion : null,
          // Lets the route's envelope probe try the address this mailbox actually
          // sends as, not just the login name — a relay service (Resend et al)
          // refuses the bare login but accepts the domain address.
          fromAddress: form.fromAddresses.find((a) => a.trim().length > 0)?.trim() ?? null,
        }),
        // The route bounds itself (30s handshake deadline + an 8s capability
        // probe + an 8s envelope probe), so this is only a backstop for a
        // stalled proxy — but without it the button could sit on "Testing…"
        // forever, which is the exact complaint that started this: a
        // two-minute freeze with no explanation.
        signal: AbortSignal.timeout(75_000),
      });
      const data = (await res.json().catch(() => ({}))) as TestConnResult;
      setTestConnResult({
        ok: Boolean(data.ok),
        error: typeof data.error === "string" ? data.error : undefined,
        warning: typeof data.warning === "string" ? data.warning : undefined,
        capabilities: data.capabilities,
        envelope: data.envelope,
        // TASK_140 — the pre-save test is exactly where a user should learn that
        // the From domain they just typed cannot be signed, BEFORE they save a
        // mailbox and run a campaign through it.
        signing: data.signing,
      });
    } catch (e) {
      setTestConnResult({
        ok: false,
        error:
          e instanceof DOMException && e.name === "TimeoutError"
            ? "The test timed out after 75s with no answer — the port is almost certainly blocked by a firewall."
            : "Network error",
      });
    } finally {
      setTestConnecting(false);
    }
  }

  async function runTest(m: Mailbox) {
    setTestingId(m.id);
    setTestResults((prev) => ({ ...prev, [m.id]: { ok: false, error: "Testing…" } }));
    try {
      // Same reasoning as the pre-save test: the route bounds itself (an 8s
      // capability probe then a 30s handshake deadline), so this is only a
      // backstop for a stalled proxy. Without it the row could sit on
      // "Testing…" indefinitely, which is exactly the freeze this triage was
      // about.
      const res = await fetch(`/api/mailboxes/${m.id}/test`, {
        method: "POST",
        signal: AbortSignal.timeout(75_000),
      });
      const data = (await res.json().catch(() => ({}))) as TestConnResult;
      const ok = Boolean(data.ok);
      setTestResults((prev) => ({
        ...prev,
        [m.id]: {
          ok,
          error: typeof data.error === "string" ? data.error : undefined,
          warning: typeof data.warning === "string" ? data.warning : undefined,
          capabilities: data.capabilities,
          envelope: data.envelope,
          // TASK_140 — carried through only when ok, which is when the route
          // computes it: a failed test already has an error worth reading, and
          // two warnings at once is noise.
          signing: data.signing,
        },
      }));
      setMailboxes((prev) =>
        prev.map((x) =>
          x.id === m.id
            ? { ...x, lastTestedAt: new Date().toISOString(), lastTestOk: ok }
            : x
        )
      );
    } catch (e) {
      setTestResults((prev) => ({
        ...prev,
        [m.id]: {
          ok: false,
          error:
            e instanceof DOMException && e.name === "TimeoutError"
              ? "The test timed out after 45s with no answer — the port is almost certainly blocked by a firewall."
              : "Network error",
        },
      }));
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
                    <h2 className="truncate font-semibold">
                      {m.label}
                      {m.sendRegion && (
                        <span className="ml-2 rounded-full border border-zinc-300 px-1.5 py-0.5 text-[10px] font-medium uppercase text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
                          via {m.sendRegion}
                        </span>
                      )}
                    </h2>
                    <p className="mt-0.5 truncate text-sm text-zinc-500 dark:text-zinc-400">
                      {(m.fromAddresses && m.fromAddresses.length > 0 ? m.fromAddresses.join(", ") : m.username)} @ {m.host}:{m.port}
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
                    <>
                      <p
                        className={`mt-1 text-xs ${
                          test.ok
                            ? test.warning
                              ? "text-amber-600 dark:text-amber-400"
                              : "text-emerald-600 dark:text-emerald-400"
                            : "text-red-600 dark:text-red-400"
                        }`}
                      >
                        {test.ok
                          ? test.warning
                            ? "⚠ Connected — but read this"
                            : "✓ Connection OK"
                          : `✗ ${test.error ?? "Failed"}`}
                      </p>
                      {/* Same evidence the pre-save test shows, for the same
                          reason: a green tick from a server that never asked for
                          a password is the one failure that looks like success. */}
                      {test.warning && (
                        <p className="mt-1 rounded-lg border border-amber-300 bg-amber-50 p-2 text-xs leading-snug text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300">
                          {test.warning}
                        </p>
                      )}
                      <SigningNotice signing={test.signing} />
                      {test.capabilities?.reachable && (
                        <p className="mt-1 break-words text-xs leading-snug text-zinc-500 dark:text-zinc-400">
                          {test.capabilities.banner && (
                            <>
                              Server said: <span className="font-mono">{test.capabilities.banner}</span>{" "}
                            </>
                          )}
                          Authentication:{" "}
                          {test.capabilities.authAdvertised
                            ? (test.capabilities.authMechanisms.join(", ") || "offered")
                            : "not requested"}
                        </p>
                      )}
                      {test.capabilities && !test.capabilities.reachable && (
                        <p className="mt-1 text-xs leading-snug text-zinc-500 dark:text-zinc-400">
                          {test.capabilities.connected
                            ? `Connected to ${m.host}:${m.port}, but it never completed an SMTP greeting.`
                            : `Nothing answered on ${m.host}:${m.port}.`}
                        </p>
                      )}
                    </>
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

              {/* Provider quick-fill. Sits ABOVE Host because it fills Host: the
                  preset sets host + port + security together, which is the whole
                  point — a host without the matching port is the most common way
                  a mailbox quietly fails. */}
              <label className="flex flex-col gap-1 text-sm font-medium">
                Provider (optional quick fill)
                <select
                  value={presetId}
                  onChange={(e) => {
                    const preset = PROVIDER_PRESETS.find((p) => p.id === e.target.value);
                    if (!preset) {
                      setPresetId("");
                      return;
                    }
                    setPresetId(preset.id);
                    // A preset is an explicit "fill the endpoint" action, so it
                    // DOES set the port — unlike the Security picker, which must
                    // never clobber a hand-typed one. Mark it touched so a later
                    // Security change can't silently rewrite the provider's port.
                    setPortTouched(true);
                    setForm({
                      ...form,
                      host: preset.host,
                      port: preset.port,
                      securityMode: preset.securityMode,
                      // Only fill a login the provider itself mandates, and only
                      // when the field is still empty — never overwrite the
                      // user's own address.
                      username: preset.fixedUser && !form.username.trim() ? preset.fixedUser : form.username,
                    });
                  }}
                  className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-normal outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950"
                >
                  <option value="">Custom / self-hosted — fill the fields below yourself</option>
                  {PROVIDER_PRESETS.map((p) => (
                    <option key={p.id} value={p.id}>{p.label} — {p.host}:{p.port}</option>
                  ))}
                </select>
                {(() => {
                  const preset = PROVIDER_PRESETS.find((p) => p.id === presetId);
                  if (!preset) return null;
                  return (
                    <span className="text-xs font-normal leading-snug text-zinc-500 dark:text-zinc-400">
                      {preset.note}
                    </span>
                  );
                })()}
              </label>

              <label className="flex flex-col gap-1 text-sm font-medium">
                Host
                <input
                  type="text"
                  value={form.host}
                  onChange={(e) => {
                    // Hand-editing the host means this is no longer the preset's
                    // endpoint — drop back to Custom so the picker never claims a
                    // provider whose host is no longer filled in.
                    if (presetId) setPresetId("");
                    setForm({ ...form, host: e.target.value });
                  }}
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
                    onChange={(e) => {
                      // Any manual edit marks the port as deliberate, so a later
                      // Security change can't silently overwrite it.
                      setPortTouched(true);
                      setForm({ ...form, port: e.target.value });
                    }}
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

              {/* Task 30, item 4 — multiple From addresses per mailbox, rotated
                  across recipients at queue-build time (resolvedFromAddress on each
                  queued item). Same add/remove-row interaction as the campaign
                  builder's subject/body list. Empty list = send as the SMTP username. */}
              <div className="flex flex-col gap-1 text-sm font-medium">
                <div>
                  From addresses (optional) <span className="text-xs text-zinc-400">— blank list sends as your SMTP username</span>
                </div>
                <div className="mt-1 flex flex-col gap-1.5">
                  {form.fromAddresses.map((addr, i) => (
                    <div key={i} className="inline-flex items-center gap-1.5">
                      <input
                        type="text"
                        value={addr}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            fromAddresses: form.fromAddresses.map((a, j) => (j === i ? e.target.value : a)),
                          })
                        }
                        placeholder="you@example.com"
                        className="flex-1 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-normal outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950"
                      />
                      <button
                        type="button"
                        onClick={() => setForm({ ...form, fromAddresses: form.fromAddresses.filter((_, j) => j !== i) })}
                        className="text-sm text-red-600 hover:underline"
                        aria-label="Remove from address"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  {form.fromAddresses.length < 5 && (
                    <button
                      type="button"
                      onClick={() => setForm({ ...form, fromAddresses: [...form.fromAddresses, ""] })}
                      className="rounded-lg border border-dashed border-zinc-300 px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-400"
                    >
                      + Add from address
                    </button>
                  )}
                </div>
                <span className="text-xs font-normal leading-snug text-zinc-500 dark:text-zinc-400">
                  Leave blank for a normal account. Add several (e.g. admin@, outreach@) to rotate them across recipients from one SMTP login — or use a single
                  address for a relay service like Resend where you send as a different address than you log in with.
                </span>
              </div>

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
                    // Choosing a security mode pre-fills the conventional port for
                    // it — but ONLY while the port field is still untouched. A user
                    // who typed their own port (24610, 2525, anything non-standard)
                    // keeps it; overwriting it here is what turned a working mailbox
                    // into a two-minute hang on a port the server never answers.
                    //
                    // There is deliberately NO "unless the current port is 465"
                    // escape clause. An earlier version had one, and it broke the
                    // Implicit TLS → None switch: 465 is exactly what the previous
                    // selection leaves behind, so the guard fired and "None
                    // (unencrypted)" silently kept port 465 — while the send path
                    // derives implicit TLS from 465 alone, so the label said
                    // "unencrypted" and the connection was TLS. The port must always
                    // follow the mode, or follow the user's own fingers.
                    setForm({
                      ...form,
                      securityMode: value,
                      port: !portTouched && option ? option.port : form.port,
                    });
                  }}
                  className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-normal outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950"
                >
                  {SECURITY_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label} — {o.hint}</option>
                  ))}
                </select>
                {form.securityMode === "none" ? (
                  <span className="text-xs font-normal leading-snug text-amber-600 dark:text-amber-400">
                    ⚠ Unencrypted — real SMTP providers essentially never need this; it exists for
                    self-hosted/internal relays. Works on any port (not just 25), and beware: a relay
                    that asks for no password at all will accept messages and drop them instead of
                    sending them on.
                  </span>
                ) : (
                  <span className="text-xs font-normal leading-snug text-zinc-500 dark:text-zinc-400">
                    The send is always encrypted; this only picks how the connection negotiates it.
                  </span>
                )}
                {/* The port is what ACTUALLY decides the handshake style, so show
                    the user the outcome rather than letting a label imply one. On a
                    non-standard port (24610) "Implicit TLS" is still STARTTLS as far
                    as the send is concerned, and saying so here is the difference
                    between a debuggable test and a mystery. */}
                {(() => {
                  const port = Number(form.port);
                  if (!Number.isInteger(port) || port <= 0) return null;
                  const mismatch = securityMismatch(form.securityMode, port);
                  return (
                    <span
                      className={`text-xs font-normal leading-snug ${
                        mismatch ? "text-amber-600 dark:text-amber-400" : "text-zinc-500 dark:text-zinc-400"
                      }`}
                    >
                      {mismatch && "⚠ "}
                      Will connect with: {describeNegotiation(form.securityMode, port)}
                    </span>
                  );
                })()}
              </label>

              {/* TASK_134 — premium regional send routing, reusing the same exit
                  nodes the private-browser tool uses. Always VISIBLE (never
                  hidden for free tier, per this app's own "expose every
                  setting, gate don't hide" convention) — just disabled with an
                  upsell until entitlements confirm premium. */}
              <label className="flex flex-col gap-1 text-sm font-medium">
                Send region
                <select
                  value={form.sendRegion}
                  onChange={(e) => setForm({ ...form, sendRegion: e.target.value })}
                  disabled={!premiumLoaded || !isPremium}
                  className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-normal outline-none focus:border-zinc-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-950"
                >
                  <option value="">Direct (this server)</option>
                  {SEND_REGIONS.map((r) => (
                    <option key={r.value} value={r.value}>{r.label}</option>
                  ))}
                </select>
                {premiumLoaded && !isPremium ? (
                  <span className="text-xs font-normal leading-snug text-zinc-500 dark:text-zinc-400">
                    Premium — route this mailbox&apos;s sends through a regional exit instead of this server&apos;s own IP.{" "}
                    <a href="/dashboard/billing" className="underline underline-offset-2 hover:text-zinc-700 dark:hover:text-zinc-300">Upgrade</a>
                  </span>
                ) : (
                  <span className="text-xs font-normal leading-snug text-zinc-500 dark:text-zinc-400">
                    Doesn&apos;t fix SPF/DKIM for domains you don&apos;t own — it only changes the connecting IP a recipient&apos;s server sees.
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
                    className={`text-xs ${
                      testConnResult.ok
                        ? testConnResult.warning
                          ? "text-amber-600 dark:text-amber-400"
                          : "text-emerald-600 dark:text-emerald-400"
                        : "text-red-600 dark:text-red-400"
                    }`}
                  >
                    {testConnResult.ok
                      ? testConnResult.warning
                        ? "⚠ Connected — but read this"
                        : "✓ Connection OK"
                      : `✗ ${testConnResult.error ?? "Failed"}`}
                  </span>
                )}
              </div>

              {/* What the server actually said about itself. Shown for successes
                  AND failures because it's the most useful single line when
                  something is wrong: the banner identifies the service ("220
                  localhost Python SMTP 1.4.6" is not the same mail server that
                  answers authenticated on another port), and the AUTH row is
                  what explains a green tick that silently sends nothing. */}
              {testConnResult && (
                <div className="mt-2 space-y-1.5">
                  {testConnResult.warning && (
                    <p className="rounded-lg border border-amber-300 bg-amber-50 p-2 text-xs leading-snug text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300">
                      {testConnResult.warning}
                    </p>
                  )}
                  {testConnResult.capabilities?.reachable && (
                    <p className="text-xs leading-snug text-zinc-500 dark:text-zinc-400">
                      {testConnResult.capabilities.banner && (
                        <>
                          Server says: <code className="break-all">{testConnResult.capabilities.banner}</code>
                          <br />
                        </>
                      )}
                      Authentication:{" "}
                      {testConnResult.capabilities.authAdvertised
                        ? `offered (${testConnResult.capabilities.authMechanisms.join(", ") || "unknown method"})`
                        : "NOT offered — your password isn't checked on this port"}{" "}
                      · STARTTLS: {testConnResult.capabilities.starttlsAdvertised ? "offered" : "not offered"}
                    </p>
                  )}
                  {testConnResult.capabilities && !testConnResult.capabilities.reachable && (
                    <p className="text-xs leading-snug text-zinc-500 dark:text-zinc-400">
                      {testConnResult.capabilities.connected
                        ? `Connected to the server, but it never sent an SMTP greeting on port ${Number(form.port)}.`
                        : `Nothing answered on ${form.host.trim()}:${Number(form.port)}.`}
                    </p>
                  )}
                  {/* Talking to the server is not the same as being allowed to
                      send through it. This row is the difference: a real
                      envelope offered, then aborted with RSET before any DATA,
                      so it reports what the server would do with an actual
                      campaign message without sending one. */}
                  {testConnResult.envelope?.attempted && (
                    <p className="text-xs leading-snug text-zinc-500 dark:text-zinc-400">
                      Send test (MAIL FROM/RCPT TO, cancelled before any message):{" "}
                      {testConnResult.envelope.accepted ? (
                        <span className="text-emerald-600 dark:text-emerald-400">the server accepted it</span>
                      ) : testConnResult.envelope.refused ? (
                        <span className="text-red-600 dark:text-red-400">
                          refused at {testConnResult.envelope.refusedAt} — {testConnResult.envelope.reply}
                        </span>
                      ) : (
                        `inconclusive (${testConnResult.envelope.reply ?? "no answer"})`
                      )}
                    </p>
                  )}
                  <SigningNotice signing={testConnResult.signing} />
                </div>
              )}
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