"use client";

// TASK_155 P6a (PLAN §19) — OUR Cloudflare accounts: the premium engine's roster.
//
// The owner asked for "option to add more to rotate at the admin". This panel is
// that: an ordered list where row 1 is the primary and the rest are fallbacks.
// A new account APPENDS, so adding a backup can never steal live traffic.
//
// The kill switch is the point of the first card: turning the premium engine off
// makes every premium Cloudflare deploy fail CLOSED with plain language rather
// than silently serving from a possibly-broken account.

import { useCallback, useEffect, useState } from "react";

import { WorkerTokenHelp } from "../hosting-worker-token-help";

/** The workers.dev state the route reports for one account (PLAN_TASK_157 §4). */
interface WorkersDevSubdomainStateView {
  /** What WE last stamped on the row. */
  configured: string | null;
  /** What Cloudflare answers with right now. Null if the read failed. */
  live: string | null;
  /** True when the row has no Workers/DNS token, so the live read was skipped. */
  needsWorkerToken: boolean;
}

export interface PlatformAccountView {
  id: string;
  accountId: string;
  label: string;
  tokenHint: string;
  /** TASK_155 P6c — the optional Workers/DNS token, as a HINT only. */
  workerTokenHint: string;
  hasWorkerToken: boolean;
  workerTokenError: string | null;
  /** TASK_158 W0 — the optional Zones token, as a HINT only. */
  zoneTokenHint: string;
  hasZoneToken: boolean;
  zoneTokenError: string | null;
  /** TASK_157 Phase 1 — the account's workers.dev subdomain (public, not a secret). */
  workersDevSubdomain: string | null;
  priority: number;
  status: string;
  lastVerifiedAt: string | null;
  verifyError: string | null;
  createdAt: string;
}

interface PlatformAccountsState {
  enabled: boolean;
  accounts: PlatformAccountView[];
  live: { platformSites: number };
}

/**
 * TASK_158 W1 — did a token we just sent ACTUALLY LAND on the row?
 *
 * Returns a plain-language complaint when a token we sent is not readable on the row
 * the server just returned, and "" when there is nothing to check.
 *
 * WHY THIS EXISTS. A token that is accepted, answers 200, and is then not stored is
 * the worst outcome there is: the panel looks saved, the operator moves on, and the
 * capability is silently absent — which is precisely how "I added the token and it
 * disappeared" is experienced, and precisely what happened to the Zones token
 * (verified by forensics on 2026-10-04: `zoneTokenHint` was length 0 on all three
 * accounts while the equivalent Workers hint was length 4, so the write never
 * happened — nothing removed it afterwards).
 *
 * The HINT is the right thing to check, and it is not a heuristic: it is written by
 * the same helper, in the same statement, as the encrypted ciphertext, so a stored
 * token ALWAYS carries a 4-character hint and a missing hint always means nothing was
 * stored. The roster the server just returned is the authority, so this compares
 * against it rather than trusting the status code.
 *
 * Deliberately scoped to a PATCH that names a row `id`. A POST ("Add and verify")
 * cannot be checked the same way: the response has no id for the row it just made,
 * and matching on accountId could land on a pre-existing row for the same account and
 * report a false failure. The replace box is the path this guard exists for.
 */
function tokenSaveComplaint(body: Record<string, unknown>, next: PlatformAccountsState): string {
  const id = typeof body.id === "string" ? body.id : "";
  if (!id) return "";
  const checks = [
    { field: "token", hint: "tokenHint", label: "Pages" },
    { field: "workerToken", hint: "workerTokenHint", label: "Workers/DNS" },
    { field: "zoneToken", hint: "zoneTokenHint", label: "Zones" },
  ] as const;
  const sent = checks.filter((c) => typeof body[c.field] === "string" && String(body[c.field]).trim() !== "");
  if (sent.length === 0) return "";
  const row = next.accounts?.find((a) => a.id === id);
  if (!row) return "";
  const missing = sent.filter((c) => !row[c.hint]);
  if (missing.length === 0) return "";
  return `The ${missing.map((c) => c.label).join(" and ")} token did not save. Paste it again and press Replace — if it still will not stick, the row is not being written.`;
}

export default function PlatformAccountsPanel() {
  const [state, setState] = useState<PlatformAccountsState | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [label, setLabel] = useState("");
  const [accountId, setAccountId] = useState("");
  const [token, setToken] = useState("");
  // TASK_155 P6c — the Workers/DNS token has its own input so it can be pasted
  // or REPLACED on its own, without touching the Pages token above it.
  const [workerToken, setWorkerToken] = useState("");
  /** Which row's replace-worker-token box is open ("" = none). */
  const [replacingWorkerFor, setReplacingWorkerFor] = useState("");
  // TASK_158 W0 — the Zones token is a THIRD, independent credential with its own
  // input and its own per-row replace box. It rotates on its own, exactly like the
  // Workers token: pasting a new one must never imply replacing Pages or Workers.
  const [zoneToken, setZoneToken] = useState("");
  /** Which row's replace-zone-token box is open ("" = none). */
  const [replacingZoneFor, setReplacingZoneFor] = useState("");
  // The CREATE form's two OPTIONAL tokens get their OWN state, deliberately
  // separate from the per-row replace boxes above. They used to share one variable
  // each, which is a real hazard rather than a style point: opening another row's
  // box runs `setZoneToken("")`, so a token half-typed into the create form could be
  // wiped by a click on an unrelated row — and a token typed into a row box silently
  // appeared in the create form too, inviting it to be posted as a NEW account.
  // Two different intentions must never share one variable.
  const [newWorkerToken, setNewWorkerToken] = useState("");
  const [newZoneToken, setNewZoneToken] = useState("");
  // TASK_157 Phase 1 — the workers.dev account subdomain. Keyed by account ROW id
  // (not Cloudflare accountId) because that is what the route takes, and kept
  // per-row so renaming one account never shows another account's value.
  const [subdomainDraft, setSubdomainDraft] = useState<Record<string, string>>({});
  /**
   * The live state last read from Cloudflare, per row. NOT a plain string: the
   * service reports what we last stamped (`configured`), what Cloudflare answers
   * with today (`live`), and whether the row even has a Workers token to ask
   * with. Collapsing that to one string here would hide exactly the out-of-band
   * rename this dial exists to make visible.
   */
  const [subdomainLive, setSubdomainLive] = useState<
    Record<string, WorkersDevSubdomainStateView>
  >({});

  /**
   * Read one account's LIVE workers.dev subdomain. Deliberately a separate call
   * from `load`: this hits Cloudflare, and the roster renders on every panel open,
   * so it is opt-in per row rather than a cost paid by every account at once.
   */
  async function readSubdomain(id: string) {
    setBusy("GET:" + id);
    setError("");
    try {
      const res = await fetch(`/api/admin/hosting/platform-accounts?subdomain=${encodeURIComponent(id)}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : "Failed to read the subdomain");
        return;
      }
      const read = data.workersDevSubdomain;
      if (read && typeof read === "object") {
        setSubdomainLive((prev) => ({ ...prev, [id]: read as WorkersDevSubdomainStateView }));
      }
    } catch {
      setError("Network error");
    } finally {
      setBusy("");
    }
  }

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/hosting/platform-accounts");
      if (!res.ok) throw new Error("Failed to load the platform accounts");
      setState((await res.json()) as PlatformAccountsState);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load the platform accounts");
    }
  }, []);

  // House pattern (cf. components/admin-research-view.tsx): fire-and-forget on
  // mount so the effect body returns void; every setState in load is behind
  // the fetch await, not synchronous.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- every setState in load is behind the fetch await, not synchronous
    void load();
  }, [load]);

  /**
   * One caller for every mutation: the route answers with the WHOLE fresh state,
   * so the panel never re-derives an order locally and can never drift from what
   * rotation will actually do.
   */
  async function call(body: Record<string, unknown>, method: "POST" | "PATCH" | "DELETE" = "PATCH") {
    setBusy(method + ":" + String(body.id ?? "new"));
    setError("");
    try {
      const res = await fetch("/api/admin/hosting/platform-accounts", {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : "Failed to update");
        return;
      }
      const next = data as PlatformAccountsState;
      setState(next);
      // TASK_158 W1 — never leave a "successful" save that stored nothing. The
      // complaint goes into the SAME error line the panel already renders on failure,
      // so a silent no-op becomes visible immediately instead of being discovered
      // weeks later when domains refuse to provision.
      const complaint = tokenSaveComplaint(body, next);
      if (complaint) setError(complaint);
      // A successful rename comes back with the LIVE value Cloudflare confirms,
      // so show that rather than the text the admin typed — the two can differ.
      if (data.workersDevSubdomain && typeof data.workersDevSubdomain === "object" && body.id) {
        setSubdomainLive((prev) => ({
          ...prev,
          [String(body.id)]: data.workersDevSubdomain as WorkersDevSubdomainStateView,
        }));
        setSubdomainDraft((prev) => {
          const next = { ...prev };
          delete next[String(body.id)];
          return next;
        });
      }
      // Clear BOTH secret inputs on success, so a pasted token is never left
      // sitting in the DOM (or in a screenshot) after the row is saved.
      // Clear EVERY secret input on success — all three tokens, on both the per-row
      // replace boxes AND the create form. Two things go wrong when one is missed:
      // a live credential is left sitting in the DOM (and in any screenshot), and the
      // replace box stays OPEN after a successful save, which reads as "it didn't
      // save" and is exactly how a token gets re-pasted somewhere it does not belong.
      // The Zones pair was missing from this list; that gap is precisely the shape of
      // a working save that looks like a silent failure.
      setToken("");
      setWorkerToken("");
      setReplacingWorkerFor("");
      setZoneToken("");
      setReplacingZoneFor("");
      setNewWorkerToken("");
      setNewZoneToken("");
    } catch {
      setError("Network error");
    } finally {
      setBusy("");
    }
  }

  const healthy = (state?.accounts ?? []).filter((a) => a.status === "active" && !a.verifyError).length;

  // ---------------------------------------------------------------------------
  // TASK_157 Phase 2 — the per-purpose account pins.
  //
  // These live in AdminSetting (saved through /api/admin/hosting), NOT on the
  // roster rows, because they are a routing DECISION about the whole roster
  // rather than a property of one account. That is also why the values are
  // Cloudflare ACCOUNT ids: the decision names an account, and must survive the
  // roster row being deleted and re-added.
  //
  // Loaded from a different endpoint than `load()` on purpose — the roster and the
  // pins are saved independently, and a stale roster must never imply a stale pin.
  const [pins, setPins] = useState<{ links: string; sites: string } | null>(null);

  const loadPins = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/hosting");
      if (!res.ok) return;
      const data = await res.json().catch(() => ({}));
      const domains = (data?.domains ?? {}) as {
        premiumLinksAccountId?: string;
        premiumSitesAccountId?: string;
      };
      setPins({ links: domains.premiumLinksAccountId ?? "", sites: domains.premiumSitesAccountId ?? "" });
    } catch {
      // Non-fatal: the roster above is still usable, and a pin that cannot be
      // LOADED must not be presented as "unpinned" — that would hide the very
      // routing this card exists to make visible.
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- both setState calls are behind fetch awaits, not synchronous
    void loadPins();
  }, [loadPins]);

  async function savePin(which: "links" | "sites", accountId: string) {
    const field = which === "links" ? "premiumLinksAccountId" : "premiumSitesAccountId";
    setBusy("pin:" + which);
    setError("");
    try {
      const res = await fetch("/api/admin/hosting", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        // "" is a MEANINGFUL value here, not a no-op: it unpins and returns the
        // purpose to automatic priority rotation.
        body: JSON.stringify({ [field]: accountId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : "Failed to save");
        return;
      }
      // Re-read instead of trusting the value we sent: the route normalises, and
      // echoing an un-normalised draft would show the admin something the engine
      // is not actually using.
      await loadPins();
    } catch {
      setError("Network error");
    } finally {
      setBusy("");
    }
  }

  /** The row a pin points at, by Cloudflare account id. */
  const rowForAccount = (accountId: string) => (state?.accounts ?? []).find((a) => a.accountId === accountId);

  /**
   * The two ways a pin is wrong, said in the admin's own terms rather than left
   * to be discovered on a live link:
   *   links → no Workers token = premium links will 403 on script upload;
   *   any   → not active or already red = publishes fail instead of rotating.
   */
  function pinWarning(which: "links" | "sites", accountId: string): string | null {
    if (!accountId) return null;
    const row = rowForAccount(accountId);
    if (!row) return "No account in the roster has this ID — premium publishes will fail.";
    if (row.status !== "active") return "This account is switched off — premium publishes will fail.";
    if (row.verifyError) return `This account is marked red (${row.verifyError}) — premium publishes will fail.`;
    if (which === "links" && !row.hasWorkerToken) {
      return "This account has no Workers token — premium links cannot be published to it.";
    }
    return null;
  }

  const inputClass =
    "rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950";
  const ghostClass =
    "rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-600 transition-colors hover:bg-zinc-100 disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800";

  return (
    <div className="mb-8">
      <h2 className="text-2xl font-semibold tracking-tight">Platform accounts (premium Cloudflare)</h2>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        Our own Cloudflare accounts — what the &ldquo;Premium&rdquo; option serves from, so premium users never paste a token.
        Row 1 is the primary; the rest are automatic fallbacks, tried in order and marked red when a token stops working.
        Tokens are encrypted at rest and never shown again after saving.
      </p>
      {error && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
      {!state ? (
        <p className="mt-4 text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="font-medium text-zinc-900 dark:text-zinc-100">Premium engine</p>
                <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                  {healthy} of {state.accounts.length} account(s) usable · {state.live.platformSites} site(s) on this engine
                </p>
              </div>
              <button
                onClick={() => call({ switch: true }, "PATCH")}
                disabled={busy !== ""}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium text-white transition-colors disabled:opacity-50 ${
                  state.enabled ? "bg-emerald-600 hover:bg-emerald-500" : "bg-zinc-400 hover:bg-zinc-500"
                }`}
              >
                {state.enabled ? "Enabled" : "Disabled"}
              </button>
            </div>
            <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
              Turning this off makes every premium Cloudflare publish fail with a clear message. It never falls back to the
              free server behind your back.
            </p>
          </div>

          {/* TASK_157 Phase 2 — the per-purpose pins. Rendered BEFORE the roster so
              the admin reads "these two things route separately" before "here are
              the accounts", which is the opposite of how the priority list reads. */}
          <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
            <p className="font-medium text-zinc-900 dark:text-zinc-100">Where premium links and sites are published</p>
            <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
              By default both follow the account order above. Pin one account for links and another for sites to keep
              them apart — a pinned account is used for that purpose only, and never backs it up with another account.
            </p>
            {!pins ? (
              <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>
            ) : (
              <div className="mt-3 flex flex-col gap-3">
                {(
                  [
                    { which: "links" as const, label: "Premium links", hint: "Redirect workers, e.g. swdocs.workers.dev" },
                    { which: "sites" as const, label: "Premium sites", hint: "Pages projects and their domains" },
                  ] satisfies Array<{ which: "links" | "sites"; label: string; hint: string }>
                ).map(({ which, label, hint }) => {
                  const current = pins[which];
                  const warning = pinWarning(which, current);
                  const chosen = rowForAccount(current);
                  return (
                    <div key={which} className="flex flex-wrap items-center gap-3">
                      <div className="min-w-0">
                        <p className="text-sm text-zinc-800 dark:text-zinc-200">{label}</p>
                        <p className="text-xs text-zinc-500 dark:text-zinc-400">{hint}</p>
                      </div>
                      <select
                        aria-label={`Cloudflare account for ${label.toLowerCase()}`}
                        value={current}
                        disabled={busy !== ""}
                        onChange={(e) => savePin(which, e.target.value)}
                        className={inputClass}
                      >
                        <option value="">Automatic (account order above)</option>
                        {(state?.accounts ?? []).map((a) => (
                          <option key={a.id} value={a.accountId}>
                            {a.label} — {a.accountId.slice(0, 8)}…{a.status === "active" ? "" : " (off)"}
                            {a.hasWorkerToken ? "" : " (no Workers token)"}
                          </option>
                        ))}
                      </select>
                      {chosen && chosen.workersDevSubdomain && (
                        <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                          {chosen.workersDevSubdomain}
                        </span>
                      )}
                      {warning && (
                        <p className="w-full text-xs text-amber-600 dark:text-amber-400">{warning}</p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {state.accounts.length === 0 && (
            <p className="rounded-xl border border-dashed border-zinc-300 p-4 text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
              No platform account yet — premium users will be told hosting is being set up.
            </p>
          )}

          {state.accounts.map((a, i) => {
            const dead = !!a.verifyError;
            const off = a.status !== "active";
            const read = subdomainLive[a.id];
            const shown = subdomainDraft[a.id] ?? read?.live ?? read?.configured ?? "";
            // Cloudflare disagreeing with our stamp is the one thing worth flagging here:
            // it means someone renamed the account in the dashboard, and every link we
            // publish under the stamped name is now broken.
            const drifted =
              !!read && read.live !== null && read.configured !== null && read.live !== read.configured;
            return (
              <div
                key={a.id}
                className={`rounded-xl border bg-white p-4 shadow-sm dark:bg-zinc-900 ${
                  off || dead ? "border-red-300 dark:border-red-900" : "border-zinc-200 dark:border-zinc-800"
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium text-zinc-900 dark:text-zinc-100">
                      <span className="text-zinc-400">{i === 0 ? "① " : `${i + 1}. `}</span>
                      {a.label}
                      {i === 0 && !off && !dead ? (
                        <span className="ml-2 text-xs font-medium text-emerald-600 dark:text-emerald-400">primary</span>
                      ) : null}
                    </p>
                    <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                      {a.accountId} · token …{a.tokenHint} ·{" "}
                      {a.lastVerifiedAt ? `verified ${new Date(a.lastVerifiedAt).toLocaleString()}` : "never verified"}
                    </p>
                    {dead && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{a.verifyError}</p>}
                    {/* TASK_155 P6c — the Workers/DNS token's own status line. A row
                        without one is fine (links use the local /r/ fallback), so it
                        reads as neutral, not as an error. */}
                    <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                      Links (Worker + DNS):{" "}
                      {a.hasWorkerToken ? (
                        <span className="text-emerald-600 dark:text-emerald-400">
                          token …{a.workerTokenHint} set
                        </span>
                      ) : (
                        <span>not set — links use the plain /r/… address</span>
                      )}
                    </p>
                    {a.workerTokenError && (
                      <p className="mt-1 text-xs text-red-600 dark:text-red-400">{a.workerTokenError}</p>
                    )}
                    {/* TASK_158 W0 — the Zones token's status line. A row WITHOUT one
                        is the normal state today (every Cloudflare token we hold is
                        refused zone creation), so it reads as neutral rather than as
                        an error: custom domains simply stay on the manual path. */}
                    <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                      Custom domains (zone create):{" "}
                      {a.hasZoneToken ? (
                        <span className="text-emerald-600 dark:text-emerald-400">
                          token …{a.zoneTokenHint} set
                        </span>
                      ) : (
                        <span>not set — domains are added in the Cloudflare dashboard</span>
                      )}
                    </p>
                    {a.zoneTokenError && (
                      <p className="mt-1 text-xs text-red-600 dark:text-red-400">{a.zoneTokenError}</p>
                    )}
                    {/* The Zones replace box is per-row and collapsed by default, for
                        the same reason the Workers one is: three credentials rotate
                        independently, so replacing one must never imply the others. */}
                    {replacingZoneFor === a.id ? (
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <input
                          placeholder="New Zones (account-scoped) token"
                          type="password"
                          autoComplete="off"
                          value={zoneToken}
                          onChange={(e) => setZoneToken(e.target.value)}
                          className={inputClass}
                        />
                        <button
                          onClick={() => call({ id: a.id, zoneToken }, "PATCH")}
                          disabled={busy !== "" || zoneToken.trim() === ""}
                          className="rounded-lg bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900"
                        >
                          {busy === "PATCH:" + a.id ? "Saving…" : "Replace token"}
                        </button>
                        <button onClick={() => setReplacingZoneFor("")} className={ghostClass}>
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => {
                          setReplacingZoneFor(a.id);
                          setZoneToken("");
                        }}
                        className="mt-2 text-xs text-zinc-600 hover:underline dark:text-zinc-300"
                      >
                        {a.hasZoneToken ? "Replace Zones token" : "Add Zones token"}
                      </button>
                    )}
                    {/* TASK_157 Phase 1 — the workers.dev subdomain for this account.
                        Free short links publish at <worker>.<this>.workers.dev, so
                        this is the one dial that decides what a FREE link looks like.
                        Reading it costs a live Cloudflare call, hence the explicit
                        "Read" button instead of an automatic fetch per row. */}
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <input
                        placeholder="workers.dev subdomain — e.g. spaceworker"
                        value={shown}
                        onChange={(e) => setSubdomainDraft((prev) => ({ ...prev, [a.id]: e.target.value }))}
                        className={inputClass}
                      />
                      <button
                        onClick={() => readSubdomain(a.id)}
                        disabled={busy !== ""}
                        className={ghostClass}
                      >
                        {busy === "GET:" + a.id ? "Reading…" : "Read current"}
                      </button>
                      <button
                        onClick={() =>
                          call({
                            id: a.id,
                            workersDevSubdomain: shown.trim(),
                          })
                        }
                        disabled={busy !== "" || shown.trim() === ""}
                        className="rounded-lg bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900"
                      >
                        {busy === "PATCH:" + a.id ? "Renaming…" : "Set subdomain"}
                      </button>
                    </div>
                    <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                      {read?.needsWorkerToken
                        ? "Needs a Workers/DNS token above — that token is what reads and changes this name."
                        : "Account-wide: renaming re-points EVERY Worker in this account, so existing links start serving the new host. Names are checked for availability before the write."}
                    </p>
                    {drifted && (
                      <p className="mt-1 text-xs font-medium text-red-600 dark:text-red-400">
                        Cloudflare reports <strong>{read?.live}</strong> but we stamped{" "}
                        <strong>{read?.configured}</strong> — it was renamed in the Cloudflare dashboard. Free links
                        published under the stamped name are broken until you save the live value.
                      </p>
                    )}
                    {/* The replace box is per-row and collapsed by default: the Pages
                        token and the Workers token rotate independently, so replacing
                        one must never imply replacing the other. */}
                    {replacingWorkerFor === a.id ? (
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <input
                          placeholder="New Workers + DNS token"
                          type="password"
                          autoComplete="off"
                          value={workerToken}
                          onChange={(e) => setWorkerToken(e.target.value)}
                          className={inputClass}
                        />
                        <button
                          onClick={() => call({ id: a.id, workerToken }, "PATCH")}
                          disabled={busy !== "" || workerToken.trim() === ""}
                          className="rounded-lg bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900"
                        >
                          {busy === "PATCH:" + a.id ? "Saving…" : "Replace token"}
                        </button>
                        <button onClick={() => setReplacingWorkerFor("")} className={ghostClass}>
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => {
                          setReplacingWorkerFor(a.id);
                          setWorkerToken("");
                        }}
                        className="mt-2 text-xs text-zinc-600 hover:underline dark:text-zinc-300"
                      >
                        {a.hasWorkerToken ? "Replace Workers + DNS token" : "Add Workers + DNS token"}
                      </button>
                    )}
                    {off && (
                      <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">Disabled — never used.</p>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      onClick={() => call({ id: a.id, priority: a.priority - 1 })}
                      disabled={i === 0 || busy !== ""}
                      title="Move up"
                      className={ghostClass}
                    >
                      ↑
                    </button>
                    <button
                      onClick={() => call({ id: a.id, priority: a.priority + 1 })}
                      disabled={i === state.accounts.length - 1 || busy !== ""}
                      title="Move down"
                      className={ghostClass}
                    >
                      ↓
                    </button>
                    <button
                      onClick={() => call({ id: a.id, verify: true })}
                      disabled={busy !== ""}
                      className={ghostClass}
                    >
                      {busy === "PATCH:" + a.id ? "Checking…" : "Verify now"}
                    </button>
                    {off ? (
                      <button
                        onClick={() => call({ id: a.id, status: "active" })}
                        disabled={busy !== ""}
                        className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
                      >
                        Enable
                      </button>
                    ) : (
                      <button
                        onClick={() => call({ id: a.id }, "DELETE")}
                        disabled={busy !== ""}
                        className="rounded-lg border border-red-300 px-3 py-1.5 text-sm font-medium text-red-600 disabled:opacity-40 dark:border-red-900 dark:text-red-400"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}

          <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
            <p className="font-medium text-zinc-900 dark:text-zinc-100">Add an account</p>
            <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
              Needs a Cloudflare API token with Account &amp; Pages edit rights. It joins the END of the rotation, so it
              cannot disturb live sites until it is promoted above them.
            </p>
            <div className="mt-3 grid gap-2 sm:grid-cols-3">
              <input
                placeholder="Label (e.g. Primary)"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                className={inputClass}
              />
              <input
                placeholder="Cloudflare account id"
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
                className={inputClass}
              />
              <input
                placeholder="Pages API token"
                type="password"
                autoComplete="off"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                className={inputClass}
              />
            </div>
            {/* TASK_155 P6c — the Workers/DNS token is a SEPARATE, optional input.
                The Pages token cannot upload a Worker script, so it cannot be
                reused here; leaving this blank simply keeps links on /r/…. */}
            <div className="mt-2 grid gap-2 sm:grid-cols-3">
              <input
                placeholder="Workers + DNS token (optional)"
                type="password"
                autoComplete="off"
                value={newWorkerToken}
                onChange={(e) => setNewWorkerToken(e.target.value)}
                className={inputClass}
              />
              {/* TASK_158 W0 — the Zones token is a THIRD, separate, optional input.
                  Neither of the two above can create a zone, so it cannot be reused
                  here; leaving this blank keeps domains on the manual path. */}
              <input
                placeholder="Zones / account-scoped token (optional)"
                type="password"
                autoComplete="off"
                value={newZoneToken}
                onChange={(e) => setNewZoneToken(e.target.value)}
                className={inputClass}
              />
            </div>
            <WorkerTokenHelp audience="admin" className="mt-3" />
            <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
              The Zones token is the only one of the three that can add a domain to a
              Cloudflare account automatically. Until one is pasted here, custom domains
              are connected by adding them in the Cloudflare dashboard — everything else
              works the same.
            </p>
            <button
              onClick={() =>
                call({ accountId, label, token, workerToken: newWorkerToken, zoneToken: newZoneToken }, "POST")
              }
              disabled={busy === "POST:new" || !label.trim() || !accountId.trim() || !token.trim()}
              className="mt-3 rounded-lg bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900"
            >
              {busy === "POST:new" ? "Adding…" : "Add and verify"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}