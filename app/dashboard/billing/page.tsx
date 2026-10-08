"use client";

import { useEffect, useState } from "react";

import { copyToClipboard } from "@/lib/clipboard";
import { WalletBalance } from "@/components/wallet-balance";

type Kind = "btc" | "usdt_trc20" | "usdt_erc20";

type PaymentInfo = {
  status: string;
  kind: string;
  amountUsd: number;
  txHash: string;
  createdAt: string;
  updatedAt: string;
  autoApproved: boolean;
};

type CheckoutInfo = {
  kind: string;
  toAddress: string;
  amountUsd: number;
  note: string;
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
  // PLAN_TASK_158 W5 — bumped after every spend so SpendFlow re-reads price +
  // premium state and WalletBalance re-fetches. A key-change remount, not a
  // prop thread: the spend result must never linger as a stale "active" line.
  const [spendEpoch, setSpendEpoch] = useState(0);
  // TASK_181 P3 (step 30) — ?product=xdevice drives both purchase flows below
  // (crypto checkout quote + wallet-spend body). Read AFTER mount: window does
  // not exist during SSR, so web renders first and xdevice is adopted on
  // hydration without a server/client mismatch.
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

  function handleResult(p: PaymentInfo | null, resultNote?: string) {
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
  const subscription =
    payment === undefined ? (
      <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>
    ) : !payment ? (
      <UpgradeFlow onResult={handleResult} product={product} />
    ) : (
      <StatusCardView payment={payment} note={note} onResult={handleResult} product={product} />
    );

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Billing</h1>
      <WalletBalance key={spendEpoch} />
      {payment !== undefined && (
        <SpendFlow
          key={`${spendEpoch}-${product}`}
          onSpent={() => setSpendEpoch((n) => n + 1)}
          product={product}
        />
      )}
      <TopUpFlow />
      {subscription}
    </div>
  );
}

// PLAN_TASK_167 W4 §4a — the ONE copy-address / submit-hash block, shared by the
// subscription checkout and the wallet top-up. The plan forbids a second copy of
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
}: {
  kind: Kind;
  toAddress: string;
  amountUsd: number;
  note?: string;
  submitLabel: string;
  onSubmitHash: (txHash: string) => Promise<string | null>;
}) {
  const [txHash, setTxHash] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    const hash = txHash.trim();
    if (!hash) {
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

function UpgradeFlow({
  onResult,
  product,
}: {
  onResult: (p: PaymentInfo | null, note?: string) => void;
  // TASK_181 P3 (step 30) — "xdevice" quotes/charges xdevicePriceUsd and lands
  // a tier-3 term; "web_subscription" behaves exactly as before.
  product: "web_subscription" | "xdevice";
}) {
  const [kind, setKind] = useState<Kind>("btc");
  const [checkout, setCheckout] = useState<CheckoutInfo | null>(null);
  const [loadingInfo, setLoadingInfo] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- resets the previous quote when kind/product change; the fetch below is async (pre-existing pattern, rule flagged on HEAD too)
    setCheckout(null);
    setError("");
    setLoadingInfo(true);
    (async () => {
      const res = await fetch(`/api/billing/checkout?kind=${kind}&product=${product}`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!cancelled) {
        setLoadingInfo(false);
        if (res.ok) setCheckout(data);
        else setError(typeof data.error === "string" ? data.error : "Failed to load payment info");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [kind, product]);

  // Delegated to PaymentInstructions as its `onSubmitHash`: the shared block owns
  // the input and the submitting state; this owns what the hash MEANS for a
  // subscription — POST it to /api/billing/submit, then re-read the status and
  // hand the page the row it should render. Returned string = error to show.
  async function submitHash(hash: string): Promise<string | null> {
    const res = await fetch("/api/billing/submit", {
      method: "POST",
      body: JSON.stringify({ kind, txHash: hash, product }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return typeof data.error === "string" ? data.error : "Submission failed";
    }
    const statusRes = await fetch("/api/billing/status", { cache: "no-store" });
    const statusData = await statusRes.json().catch(() => ({}));
    if (statusRes.ok) {
      onResult(statusData.status === null ? null : statusData, data.note);
    }
    return null;
  }

  return (
    <div className="mt-6">
      <div className="max-w-2xl rounded-xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="text-xl font-semibold tracking-tight">
          {/* TASK_181 P3 (step 30) — owner wording for the wrapper premium:
              "Subscribe to Premium" + the admin-set price. NO term/duration
              copy, ever (owner: "never show it on ui how long the premium is
              for"). */}
          {product === "xdevice" ? "Subscribe to Premium" : "Upgrade to Pro"}
        </h2>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          {product === "xdevice"
            ? "Terminal, remote control, browser clones and screen monitoring — premium tools on devices you own."
            : "Pro plan gives your jobs higher queue priority."}
          {checkout
            ? product === "xdevice"
              ? ` $${checkout.amountUsd.toFixed(2)}.`
              : ` $${checkout.amountUsd.toFixed(2)} / month.`
            : ""}
        </p>

        <div className="mt-5 flex gap-2">
          {KIND_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              onClick={() => setKind(opt.id)}
              className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                kind === opt.id
                  ? "bg-zinc-900 text-white dark:bg-zinc-50 dark:text-zinc-900"
                  : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {loadingInfo && (
          <p className="mt-5 text-sm text-zinc-500 dark:text-zinc-400">Loading payment details…</p>
        )}

        {checkout && (
          <PaymentInstructions
            kind={kind}
            toAddress={checkout.toAddress}
            amountUsd={checkout.amountUsd}
            submitLabel="Submit Payment"
            onSubmitHash={submitHash}
          />
        )}

        {error && <p className="mt-4 text-sm text-red-600 dark:text-red-400">{error}</p>}
      </div>
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
          submitLabel="Submit Transaction Hash"
          onSubmitHash={submitHash}
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

function StatusCardView({
  payment,
  note,
  onResult,
  product,
}: {
  payment: PaymentInfo;
  note: string | null;
  onResult: (p: PaymentInfo | null, n?: string) => void;
  // TASK_181 P3 — the rejected-payment resubmit must re-quote the SAME product
  // the original payment was for (web vs xdevice), not silently fall back.
  product: "web_subscription" | "xdevice";
}) {
  const labels: Record<string, { badge: string; text: string }> = {
    approved: {
      badge: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400",
      text: "Pro — Active",
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
        <h2 className="text-xl font-semibold tracking-tight">Pro plan</h2>
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
          <h3 className="text-lg font-semibold tracking-tight">Submit a new payment hash</h3>
          <UpgradeFlow onResult={onResult} product={product} />
        </div>
      )}
    </div>
  );
}

// PLAN_TASK_158 W5 — "Activate with balance". Reads the spend price + premium
// state, then POSTs { product } — web_subscription (W5) or xdevice
// (TASK_181 P3 step 30). No amount, no userId: the price is server-computed
// from the same AdminSetting field as checkout, and the user comes from the
// session. After a success the parent remounts (balance refresh) via onSpent.
function SpendFlow({ onSpent, product }: { onSpent: () => void; product: "web_subscription" | "xdevice" }) {
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "ready"; priceUsd: number; balanceCents: number; premiumActive: boolean }
    | { kind: "error"; message: string }
  >({ kind: "loading" });
  const [spending, setSpending] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    (async () => {
      try {
        // Price from the SAME source the spend route charges: the checkout
        // quote for this product (AdminSetting.webSubscriptionPriceUsd /
        // xdevicePriceUsd). No second constant anywhere — display and charge
        // read one field.
        const [walletRes, quoteRes] = await Promise.all([
          fetch("/api/wallet", { cache: "no-store" }),
          fetch(`/api/billing/checkout?kind=usdt_trc20&product=${product}`, { cache: "no-store" }),
        ]);
        if (!quoteRes.ok) throw new Error(`price lookup failed (${quoteRes.status})`);
        const qd = (await quoteRes.json()) as { amountUsd?: unknown };
        if (typeof qd.amountUsd !== "number" || !Number.isFinite(qd.amountUsd)) throw new Error("price lookup failed");
        let balanceCents = 0;
        if (walletRes.ok) {
          const wd = (await walletRes.json()) as { wallet?: { balanceCents?: unknown } };
          if (typeof wd.wallet?.balanceCents === "number") balanceCents = wd.wallet.balanceCents;
        }
        let premiumActive = false;
        if (product === "xdevice") {
          // The XDevice term is an ENTITLEMENT state, not a web-payment row: a
          // live tier-3 term or a devices grant shows as `devices`, full
          // Premium as `premium` — either already covers the device tools, so
          // the spend would be refused server-side with already_active anyway.
          const ent = await fetch("/api/entitlements", { cache: "no-store" });
          if (ent.ok) {
            const ed = (await ent.json()) as { premium?: unknown; keys?: unknown };
            premiumActive =
              ed.premium === true || (Array.isArray(ed.keys) && ed.keys.includes("devices"));
          }
        } else {
          const st = await fetch("/api/billing/status", { cache: "no-store" });
          if (st.ok) {
            const sd = (await st.json()) as { status?: { status?: unknown } | null };
            premiumActive = !!sd.status && (sd.status as { status?: unknown }).status === "approved";
          }
        }
        setState({ kind: "ready", priceUsd: qd.amountUsd, balanceCents, premiumActive });
      } catch {
        setState({ kind: "error", message: "Could not load the subscription price. Try again shortly." });
      }
    })();
  }, [product]);

  async function spend() {
    setSpending(true);
    setResult(null);
    try {
      const res = await fetch("/api/wallet/spend", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ product }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: unknown; code?: unknown; premiumExpiresAt?: unknown };
      if (!res.ok) {
        const message = typeof data.error === "string" ? data.error : `Spend failed (${res.status})`;
        setResult({ ok: false, message });
        return;
      }
      const expiry = typeof data.premiumExpiresAt === "string" ? data.premiumExpiresAt : null;
      setResult({
        ok: true,
        // xdevice: NEVER a date or a term length (owner: "never show it on ui
        // how long the premium is for"). Web copy unchanged.
        message:
          product === "xdevice"
            ? "Premium activated."
            : expiry
              ? `Premium active until ${new Date(expiry).toLocaleDateString()}.`
              : "Premium activated for 30 days.",
      });
      onSpent();
    } catch {
      setResult({ ok: false, message: "Spend failed. Try again shortly." });
    } finally {
      setSpending(false);
    }
  }

  if (state.kind === "loading") return null;
  if (state.kind === "error") {
    return (
      <section aria-label="Activate with balance" className="mb-6 rounded-xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <p className="text-sm text-zinc-500 dark:text-zinc-400">{state.message}</p>
      </section>
    );
  }

  const priceCents = Math.ceil(state.priceUsd * 100);
  const affordable = state.balanceCents >= priceCents;
  const money = `$${(priceCents / 100).toFixed(2)}`;

  return (
    <section aria-label="Activate with balance" className="mb-6 rounded-xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">Activate with balance</h2>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        {state.premiumActive
          ? "Premium is already active on this account — no charge was made."
          : product === "xdevice"
            ? `Subscribe to Premium for ${money} from your wallet balance.`
            : `One month of Pro for ${money} from your wallet balance.`}
      </p>
      {!state.premiumActive && (
        <button
          onClick={() => void spend()}
          disabled={spending || !affordable}
          className="mt-3 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-300"
        >
          {spending
            ? "Activating…"
            : affordable
              ? product === "xdevice"
                ? `Subscribe — ${money}`
                : `Activate Pro — ${money}`
              : `Insufficient balance (need ${money})`}
        </button>
      )}
      {result && (
        <p className={`mt-3 text-sm ${result.ok ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>
          {result.message}
        </p>
      )}
    </section>
  );
}