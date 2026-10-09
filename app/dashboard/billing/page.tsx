"use client";

import { useEffect, useState } from "react";

import { useWrapperMode } from "@/components/wrapper-mode-context";
import { SupportTicketButton } from "@/components/support-ticket-cta";
import { copyToClipboard } from "@/lib/clipboard";
import { WalletBalance } from "@/components/wallet-balance";
import { planLabelForTier } from "@/lib/plan-name";

type Kind = "btc" | "usdt_trc20" | "usdt_erc20";

// TASK_184 B4 — the caller's own premium invoice as GET /api/billing/invoices
// returns it. `methods` is the SNAPSHOT the admin sent: the card renders pay
// buttons only for chains with a non-null address in it, and submits against
// those addresses (the server re-reads the same snapshot).
type InvoiceInfo = {
  id: string;
  plan: string;
  tier: number;
  amountUsd: number;
  status: string;
  methods: Partial<Record<Kind, string>> | null;
  createdAt: string;
  paidAt: string | null;
};

type PaymentInfo = {
  status: string;
  kind: string;
  amountUsd: number;
  txHash: string;
  createdAt: string;
  updatedAt: string;
  autoApproved: boolean;
};

const KIND_OPTIONS: Array<{ id: Kind; label: string }> = [
  { id: "btc", label: "Bitcoin" },
  { id: "usdt_trc20", label: "USDT (TRC-20)" },
  { id: "usdt_erc20", label: "USDT (ERC-20)" },
];

function kindLabel(kind: string): string {
  return KIND_OPTIONS.find((o) => o.id === kind)?.label ?? kind;
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  async function copy() {
    const ok = await copyToClipboard(value);
    if (ok) {
      setCopied(true);
      setFailed(false);
      setTimeout(() => setCopied(false), 2000);
    } else {
      setFailed(true);
      setTimeout(() => setFailed(false), 2000);
    }
  }
  return (
    <button
      onClick={copy}
      className="rounded-lg border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
    >
      {copied ? "Copied!" : failed ? "Copy failed — select manually" : "Copy"}
    </button>
  );
}

export default function BillingPage() {
  const [payment, setPayment] = useState<PaymentInfo | null | undefined>(undefined);
  const [note, setNote] = useState<string | null>(null);
  // PLAN_TASK_158 W5 — bumped when a payment/invoice result lands so
  // WalletBalance re-fetches (key-change remount, not a prop thread: the spend
  // result must never linger as a stale "active" line). TASK_192: the bump lives
  // in handleResult — SpendFlow, the old site, is gone.
  const [spendEpoch, setSpendEpoch] = useState(0);
  // TASK_181 P3 (step 30) / TASK_192 — ?product=xdevice selects the request
  // card's plan label (the wrapper pins it to xdevice regardless); it also feeds
  // the invoice onPlan mapping below. Read AFTER mount: window does not exist
  // during SSR, so web renders first and xdevice is adopted on hydration
  // without a server/client mismatch.
  const [product, setProduct] = useState<"web_subscription" | "xdevice">("web_subscription");
  useEffect(() => {
    const p = new URLSearchParams(window.location.search).get("product");
    // eslint-disable-next-line react-hooks/set-state-in-effect -- window.location only exists post-mount (SSR has no URL); one-shot adoption of the query param
    if (p === "xdevice") setProduct("xdevice");
  }, []);

  useEffect(() => {
    (async () => {
      const res = await fetch("/api/billing/status", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (res.ok) setPayment(data.status === null ? null : data);
      else setPayment(null);
    })();
  }, []);

  // TASK_184 B4 — the open premium invoice an admin sent this account (B3).
  // Fetched once on mount alongside the status; only the OPEN one is rendered
  // (a settled invoice lives in the admin queue, not on the user's page).
  // Fail-soft: a failed fetch just means no card — nothing else on the page
  // depends on it.
  const [invoice, setInvoice] = useState<InvoiceInfo | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch("/api/billing/invoices", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (cancelled || !res.ok || !Array.isArray(data.invoices)) return;
      const open = data.invoices.find((i: InvoiceInfo) => i.status === "open");
      if (open) setInvoice(open);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function handleResult(p: PaymentInfo | null, resultNote?: string) {
    // TASK_192 — SpendFlow (the old bump site) is gone; a payment/invoice result
    // is now the moment the balance can change, so remount WalletBalance here.
    setSpendEpoch((n) => n + 1);
    setPayment(p);
    setNote(resultNote ?? null);
  }

  // TASK_158 W2 — the balance card sits above every branch below, including the
  // loading one, so the page never renders a billing form without telling the user
  // what they already have. It is rendered ONCE here rather than inside each
  // branch: putting it in the branches would unmount and remount it as the payment
  // state resolves, which throws away the balance it already fetched and issues a
  // second GET on every page view.
  // PLAN_TASK_167 W4 — the top-up surface renders on EVERY branch of the
  // subscription state below: whether the customer has no payment, a pending one
  // or an approved one has no bearing on their ability to add funds to their own
  // wallet. Rendering it once here (rather than inside each branch) also keeps it
  // mounted while `payment` resolves, so an amount someone is already typing
  // isn't thrown away by the state transition.
  // TASK_184 B1 / TASK_192 — NEITHER build shows a subscription quote anymore:
  // without a payment on record the card is the ticket-based request (the admin
  // answers with an invoice at the plan's price, editable before it is sent —
  // B3/B4); with a payment on record the status/history card stays (history ≠
  // quote). TASK_192 removed the wrapper's self-serve UpgradeFlow/SpendFlow
  // surfaces: the wrapper requests exactly like web does, and it can only
  // request Premium XDevice — its one public agent — never Premium Plus
  // (owner: "they can only request for premiumxdevice not premium plus … when
  // they request I just send an invoice … just the way it is on the web").
  const wrapperMode = useWrapperMode();
  // TASK_192 — a wrapper request is pinned to xdevice no matter what ?product=
  // says; the web keeps the query-param product (invoice plan mapping included).
  const requestProduct = wrapperMode !== null ? "xdevice" : product;
  const subscription =
    payment === undefined ? (
      <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>
    ) : !payment ? (
      <PremiumRequestCard product={requestProduct} />
    ) : (
      <StatusCardView
        payment={payment}
        note={note}
        product={product}
        requestProduct={requestProduct}
      />
    );

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Billing</h1>
      <WalletBalance key={spendEpoch} />
      {/* TASK_184 B4 — an invoice is admin-sent and may target any account, so it
          renders right after the balance on EVERY branch (both modes), above the
          request/status cards. */}
      {invoice && (
        <PremiumInvoiceCard
          invoice={invoice}
          onResult={handleResult}
          onPlan={(plan) => setProduct(plan === "premium_xdevice" ? "xdevice" : "web_subscription")}
        />
      )}
      <TopUpFlow />
      {subscription}
    </div>
  );
}

// PLAN_TASK_167 W4 §4a / TASK_192 — the ONE copy-address / submit-hash block,
// shared by the wallet top-up and the premium invoice card (the subscription
// checkout that used to share it is gone — the wrapper requests via ticket now).
// The plan forbids a second copy of
// this component, and the reason is concrete: two copies means the hash rules
// (trimmed, non-empty, submitted with the order it belongs to) drift apart, and
// whichever copy falls behind stops checking. Everything chain-specific arrives
// as props; nothing here knows what a payment is FOR — the parent decides that
// in its `onSubmitHash`.
//
// It owns only the hash input and its own submit lifecycle. The returned string
// from `onSubmitHash` is an ERROR message to display (null means success and the
// parent has already reacted — e.g. redirected to the status card, or marked the
// top-up as submitted).
function PaymentInstructions({
  kind,
  toAddress,
  amountUsd,
  note,
  submitLabel,
  onSubmitHash,
  hashOptional,
}: {
  kind: Kind;
  toAddress: string;
  amountUsd: number;
  note?: string;
  submitLabel: string;
  onSubmitHash: (txHash: string) => Promise<string | null>;
  // TASK_185 follow-up (owner: "confirming from admin before they get credited")
  // — the SUBSCRIPTION form submits without a hash (server stores null →
  // "pending, awaiting manual review"). The top-up form keeps hash required
  // (its route 400s without one).
  hashOptional?: boolean;
}) {
  const [txHash, setTxHash] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    const hash = txHash.trim();
    if (!hash && !hashOptional) {
      setError("Enter your transaction hash");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      const failure = await onSubmitHash(hash);
      if (failure) setError(failure);
    } catch {
      setError("Network error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mt-5 space-y-4">
      <div>
        <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
          Send {kindLabel(kind)} to this address
        </p>
        <div className="mt-2 flex items-center gap-2">
          <code className="flex-1 break-all rounded-lg bg-zinc-100 px-3 py-2 font-mono text-xs text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
            {toAddress}
          </code>
          <CopyButton value={toAddress} />
        </div>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
          Send exactly ${amountUsd.toFixed(2)} worth of{" "}
          {kind === "btc" ? "BTC" : "USDT"} — within ±5% is accepted.
        </p>
        {note && (
          <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">{note}</p>
        )}
      </div>

      <div>
        <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
          Transaction hash
          {hashOptional && (
            <span className="font-normal text-zinc-500 dark:text-zinc-400">
              {" "}
              (optional — admin confirms your payment)
            </span>
          )}
        </label>
        <input
          type="text"
          value={txHash}
          onChange={(e) => setTxHash(e.target.value)}
          placeholder="Enter the transaction hash after sending"
          className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 font-mono text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950"
        />
        <button
          onClick={submit}
          disabled={submitting}
          className="mt-3 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-300"
        >
          {submitting ? "Submitting…" : submitLabel}
        </button>
      </div>

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}

// PLAN_TASK_167 W4 §4a — the top-up surface. ONE route (`/api/billing/topup`) in
// both directions: step 1 opens the order, step 2 attaches the hash — and the
// component NEVER claims success beyond what the server said. The final state it
// renders is "submitted, awaiting review", because a top-up is never auto-approved
// (§8.6) and `/api/billing/status` deliberately excludes top-up rows (so there is
// no status to poll — the admin queue is the state machine).
//
// The minimum comes from GET /api/billing/topup (an AdminSetting), shown before
// the customer types so the floor is a stated rule rather than a surprise 400.
function TopUpFlow() {
  const [limits, setLimits] = useState<{ minimumUsd: number; maximumUsd: number } | null>(null);
  const [amount, setAmount] = useState("");
  const [kind, setKind] = useState<Kind>("usdt_trc20");
  const [order, setOrder] = useState<{ paymentId: string; kind: Kind; toAddress: string; amountUsd: number; note: string } | null>(null);
  const [opening, setOpening] = useState(false);
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch("/api/billing/topup", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!cancelled && res.ok && typeof data.minimumUsd === "number") {
        setLimits({ minimumUsd: data.minimumUsd, maximumUsd: data.maximumUsd });
      }
      // Fail-soft: if the limits can't be read the form still works — the POST
      // re-validates the floor server-side and its error names the minimum. The
      // hint is a convenience, never the enforcement.
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function openOrder() {
    const amountUsd = Number(amount);
    if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
      setError("Enter an amount to add");
      return;
    }
    if (limits && amountUsd < limits.minimumUsd) {
      setError(`The minimum top-up is $${limits.minimumUsd.toFixed(2)}.`);
      return;
    }
    setOpening(true);
    setError("");
    try {
      const res = await fetch("/api/billing/topup", {
        method: "POST",
        body: JSON.stringify({ amountUsd, kind }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : "Could not start the top-up");
        return;
      }
      setOrder({
        paymentId: data.paymentId,
        kind: data.kind,
        toAddress: data.toAddress,
        amountUsd: data.amountUsd,
        note: data.note,
      });
    } catch {
      setError("Network error");
    } finally {
      setOpening(false);
    }
  }

  // Step 2 — attach the hash to OUR order. On success we render the awaiting-
  // review state and stop: there is deliberately no polling here, because the
  // server will never flip this row without an admin (§8.6).
  async function submitHash(txHash: string): Promise<string | null> {
    if (!order) return "Open a top-up order first";
    const res = await fetch("/api/billing/topup", {
      method: "POST",
      body: JSON.stringify({ paymentId: order.paymentId, txHash }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return typeof data.error === "string" ? data.error : "Submission failed";
    }
    setSubmitted(typeof data.note === "string" ? data.note : "Received. We'll confirm the payment and add the funds to your wallet.");
    return null;
  }

  if (submitted) {
    return (
      <section className="mb-6 max-w-2xl rounded-xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">Top-up submitted</h2>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-300">{submitted}</p>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
          This top-up is awaiting review — funds land in your wallet after a human confirms the payment.
        </p>
      </section>
    );
  }

  return (
    <section
      aria-label="Top up wallet"
      className="mb-6 max-w-2xl rounded-xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
    >
      <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">Top up wallet</h2>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        Add funds to your balance with crypto. Minimum ${limits ? limits.minimumUsd.toFixed(2) : "…"}
        {limits ? `, up to $${limits.maximumUsd.toLocaleString()} per order.` : "."}
      </p>

      {order ? (
        <PaymentInstructions
          kind={order.kind}
          toAddress={order.toAddress}
          amountUsd={order.amountUsd}
          note={order.note}
          submitLabel="Submit Payment"
          onSubmitHash={submitHash}
          hashOptional
        />
      ) : (
        <>
          <div className="mt-4 flex gap-2">
            {KIND_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                onClick={() => setKind(opt.id)}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                  kind === opt.id
                    ? "bg-zinc-900 text-white dark:bg-zinc-50 dark:text-zinc-900"
                    : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <div className="mt-4 flex items-end gap-3">
            <div className="w-40">
              <label
                htmlFor="topup-amount"
                className="block text-sm font-medium text-zinc-700 dark:text-zinc-300"
              >
                Amount (USD)
              </label>
              <input
                id="topup-amount"
                type="number"
                inputMode="decimal"
                min={limits?.minimumUsd}
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder={limits ? limits.minimumUsd.toFixed(2) : "25.00"}
                className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950"
              />
            </div>
            <button
              onClick={openOrder}
              disabled={opening}
              className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-300"
            >
              {opening ? "Creating…" : "Continue"}
            </button>
          </div>
        </>
      )}

      {error && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
    </section>
  );
}

// TASK_184 B1 — the WEB subscription surface without a payment on record: request
// the plan by ticket. NO price renders here on purpose — the admin answers the
// request with an invoice at the plan's default price, editable before it is sent
// (B3/B4), so the number never needs to be quoted to the user up front.
function PremiumRequestCard({ product }: { product: "web_subscription" | "xdevice" }) {
  const plus = product === "web_subscription";
  return (
    <div className="mt-6 max-w-2xl rounded-xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <h2 className="text-xl font-semibold tracking-tight">
        {plus ? "Premium Plus" : "Premium XDevice"}
      </h2>
      <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">
        {plus
          ? "All premium tools on the web — extractor, hosting, cyber lab and the private browser. Request it here and we will send you an invoice."
          : "Premium tools on devices you own — remote control, terminal commands, browser clones and screen monitoring. Request it here and we will send you an invoice."}
      </p>
      <div className="mt-4">
        <SupportTicketButton template={plus ? "premium-plus" : "premium-xdevice"}>
          {plus ? "Request for Premium Plus" : "Request for Premium XDevice"}
        </SupportTicketButton>
      </div>
    </div>
  );
}

// TASK_184 B4 — the user's half of an admin-sent invoice (B3): plan, amount,
// pay buttons for the chains the invoice's SNAPSHOT actually carries, and the
// shared PaymentInstructions block (hash optional, TASK_185) submitting through
// the EXISTING /api/billing/submit with {kind, txHash, invoiceId}.
//
// The invoice owns the economics end to end: the card never fetches a price,
// never shows a term (TASK_181 rule), and the address it renders is the snapshot
// the admin sent — the server independently re-reads the same snapshot, so UI
// and DB can never disagree about where the money goes.
//
// On success the form collapses to "submitted, awaiting review", the page
// re-reads /api/billing/status (StatusCardView takes over the subscription
// branch with the pending payment), and `onPlan` switches the product state so
// those labels say the INVOICE's plan (Premium XDevice invoice → xdevice copy).
function PremiumInvoiceCard({
  invoice,
  onResult,
  onPlan,
}: {
  invoice: InvoiceInfo;
  onResult: (p: PaymentInfo | null, note?: string) => void;
  onPlan: (plan: string) => void;
}) {
  // Chains offered = the snapshot's non-null addresses only. An invoice sent
  // with just a BTC address must not offer a USDT button that would 400.
  const chains = KIND_OPTIONS.filter((o) => {
    const addr = invoice.methods?.[o.id];
    return typeof addr === "string" && addr.length > 0;
  });
  const [kind, setKind] = useState<Kind>(chains[0]?.id ?? "btc");
  const [submitted, setSubmitted] = useState(false);

  async function submitHash(hash: string): Promise<string | null> {
    const res = await fetch("/api/billing/submit", {
      method: "POST",
      body: JSON.stringify({ kind, txHash: hash, invoiceId: invoice.id }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return typeof data.error === "string" ? data.error : "Submission failed";
    }
    setSubmitted(true);
    onPlan(invoice.plan);
    const statusRes = await fetch("/api/billing/status", { cache: "no-store" });
    const statusData = await statusRes.json().catch(() => ({}));
    if (statusRes.ok) {
      onResult(statusData.status === null ? null : statusData, data.note);
    }
    return null;
  }

  const address = invoice.methods?.[kind];

  if (submitted) {
    return (
      <section
        aria-label="Premium invoice"
        className="mt-4 max-w-2xl rounded-xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
      >
        <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
          {planLabelForTier(invoice.tier)} invoice — submitted
        </p>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
          We received your payment and it is awaiting review. Your plan is activated once it is
          confirmed.
        </p>
      </section>
    );
  }

  return (
    <section
      aria-label="Premium invoice"
      className="mt-4 max-w-2xl rounded-xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
            {planLabelForTier(invoice.tier)} invoice
          </h2>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            Amount due: <span className="font-medium text-zinc-700 dark:text-zinc-300">${invoice.amountUsd.toFixed(2)}</span>
          </p>
        </div>
      </div>

      {chains.length === 0 ? (
        // An invoice snapshot with no configured chain cannot be paid online —
        // say so and point at the humans instead of rendering an empty form.
        <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">
          Payment details are not available for this invoice yet — please contact support and we
          will help you complete it.
        </p>
      ) : (
        <>
          <div className="mt-4 flex gap-2">
            {chains.map((opt) => (
              <button
                key={opt.id}
                onClick={() => setKind(opt.id)}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                  kind === opt.id
                    ? "bg-zinc-900 text-white dark:bg-zinc-50 dark:text-zinc-900"
                    : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {address && (
            <PaymentInstructions
              kind={kind}
              toAddress={address}
              amountUsd={invoice.amountUsd}
              note="Send the exact amount shown, then submit — we confirm the payment manually and activate your plan."
              submitLabel="Submit Payment"
              onSubmitHash={submitHash}
              hashOptional
            />
          )}
        </>
      )}
    </section>
  );
}

function StatusCardView({
  payment,
  note,
  product,
  requestProduct,
}: {
  payment: PaymentInfo;
  note: string | null;
  // TASK_181 P3 — labels/amount stay truthful to the product the payment was
  // for (web vs xdevice), not a silent fallback.
  product: "web_subscription" | "xdevice";
  // TASK_192 — the rejected-payment resubmit is the request card on EVERY build
  // (the wrapper's self-serve UpgradeFlow is gone), pinned to the product the
  // caller may request: xdevice on the wrapper, query-product on web.
  requestProduct: "web_subscription" | "xdevice";
}) {
  const labels: Record<string, { badge: string; text: string }> = {
    approved: {
      badge: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400",
      text: product === "xdevice" ? "Premium XDevice — Active" : "Premium Plus — Active",
    },
    pending: {
      badge: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400",
      text: "Payment Pending — checking blockchain…",
    },
    flagged: {
      badge: "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-400",
      text: "Under Review — our team will verify this manually",
    },
    rejected: {
      badge: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400",
      text: "Payment Rejected",
    },
  };
  const label = labels[payment.status] ?? labels.pending;

  return (
    <div className="mt-6">
      <div className="max-w-2xl rounded-xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="text-xl font-semibold tracking-tight">
          {product === "xdevice" ? "Premium XDevice" : "Premium Plus"}
        </h2>
        <div className="mt-3">
          <span className={`rounded-full px-3 py-1 text-sm font-medium ${label.badge}`}>
            {label.text}
          </span>
        </div>

        <dl className="mt-5 space-y-2 text-sm">
          <div className="flex items-center justify-between gap-4">
            <dt className="text-zinc-500 dark:text-zinc-400">Amount</dt>
            <dd className="font-medium">${payment.amountUsd.toFixed(2)}</dd>
          </div>
          <div className="flex items-center justify-between gap-4">
            <dt className="text-zinc-500 dark:text-zinc-400">Method</dt>
            <dd>{kindLabel(payment.kind)}</dd>
          </div>
          <div className="flex items-center justify-between gap-4">
            <dt className="text-zinc-500 dark:text-zinc-400">
              {payment.status === "approved" ? "Approved" : "Submitted"}
            </dt>
            <dd>
              {new Date(
                payment.status === "approved" ? payment.updatedAt : payment.createdAt
              ).toLocaleString()}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-4">
            <dt className="text-zinc-500 dark:text-zinc-400">Tx hash</dt>
            <dd className="max-w-[55%] truncate font-mono text-xs">{payment.txHash}</dd>
          </div>
        </dl>

        {note && (
          <p className="mt-4 rounded-lg bg-zinc-100 px-3 py-2 text-sm text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
            {note}
          </p>
        )}
      </div>

      {payment.status === "rejected" && (
        <div className="mt-8 border-t border-zinc-200 pt-6 dark:border-zinc-800">
          {/* TASK_192 — resubmit = the request card on every build (no
              self-serve re-quote anywhere anymore). */}
          <PremiumRequestCard product={requestProduct} />
        </div>
      )}
    </div>
  );
}
