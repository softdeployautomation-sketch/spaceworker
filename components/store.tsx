"use client";

import { useEffect, useState } from "react";

import { Modal } from "@/components/modal";
import { Badge, Button, Card, Select } from "@/components/ui";
import { copyToClipboard } from "@/lib/clipboard";
import { EXE_DURATION_OPTIONS, DEFAULT_EXE_DURATION_DAYS } from "@/lib/products";

type Product = {
  id: string;
  name: string;
  tagline: string;
  kind: "web" | "module" | "exe";
  priceUsd: number;
  downloadUrl?: string;
};

type Kind = "btc" | "usdt_trc20" | "usdt_erc20";

type CheckoutInfo = {
  kind: string;
  toAddress: string;
  amountUsd: number;
  note: string;
};

const EXE_DISCLOSURE = "Desktop app — license issued instantly, download link emailed right away.";
const EXE_TRIAL_DISCLOSURE = "Free to try for 24 hours, no account or payment needed. Buy anytime to keep going.";

// TASK_189 — rendered from BOTH /store and /pricing (they are near-identical
// pages on purpose). The signup/account hrefs come in as props because this is
// a client component and lib/exe-runtime is server-only — pages resolve them
// with accountHref() exactly like their headers already do (EXE runtime must
// bounce account paths to the hosted server).
export function Store({
  signupHref,
  loginHref,
}: {
  signupHref: string;
  loginHref: string;
}) {
  const [products, setProducts] = useState<Product[] | null>(null);
  const [error, setError] = useState("");
  const [buying, setBuying] = useState<Product | null>(null);
  // TASK_189 — the apps are sold from ONE dropdown: this is the selected
  // product id. "" = nothing chosen yet (dropdown shows a placeholder option).
  const [selectedId, setSelectedId] = useState("");

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/store/prices");
        const data = await res.json().catch(() => ({}));
        if (res.ok && Array.isArray(data.products)) {
          setProducts(data.products);
        } else {
          setError(typeof data.error === "string" ? data.error : "Failed to load the store.");
        }
      } catch {
        setError("Network error loading the store.");
      }
    })();
  }, []);

  // TASK_189 — only the desktop apps are sold here anymore (the web bundle and
  // the modules left the store: sign up free, request Premium in the dashboard).
  const exeProducts = products?.filter((p) => p.kind === "exe") ?? [];
  const selected = exeProducts.find((p) => p.id === selectedId) ?? null;

  return (
    <section id="store" className="scroll-mt-24">
      <div className="max-w-5xl">
        <p className="text-xs font-semibold uppercase tracking-wider text-fg-muted">Store</p>
        <h2 className="mt-3 text-3xl font-bold text-fg">Sign up for SpaceWorker OS</h2>
        <p className="mt-2 max-w-2xl text-sm text-fg-muted">
          Create your account for free — no pricing to pick here. Once you&rsquo;re in,
          request Premium from the dashboard when you&rsquo;re ready. Desktop apps
          don&rsquo;t need an account: choose one below and check out straight away.
        </p>

        {error && (
          <p className="mt-4 rounded-lg border border-border bg-bg-elevated px-3 py-2 text-sm text-fg-muted">
            {error}
          </p>
        )}

        {!products && !error && (
          <p className="mt-8 text-sm text-fg-muted">Loading the store…</p>
        )}

        {products && (
          <>
            {/* TASK_189 — where the web bundle's subscription card used to sit.
                No pricing on the web app here anymore: the store's account
                surface is pure signup; Premium is requested from inside the
                dashboard (SupportTicketButton → invoice flow). */}
            <div className="mt-8 flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border bg-bg-elevated p-5">
              <div>
                <p className="text-sm font-semibold text-fg">
                  New to SpaceWorker? Start free.
                </p>
                <p className="mt-1 text-sm text-fg-muted">
                  Sign up, then request Premium from your dashboard — no pricing to
                  pick on this page.
                </p>
              </div>
              <div className="flex gap-3">
                <a
                  href={signupHref}
                  className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
                >
                  Create account
                </a>
                <a
                  href={loginHref}
                  className="rounded-lg border border-border px-4 py-2 text-sm font-semibold text-fg hover:bg-black/5 dark:hover:bg-white/5"
                >
                  Sign in
                </a>
              </div>
            </div>

            {/* TASK_189 — the apps are sold from ONE dropdown (owner: "make the
                apps sale a dropdown. so users can select which one and checkout
                to payment"): pick an app → its card (price + Buy) renders below →
                the existing crypto checkout modal. The server still sells every
                product (/api/store/prices untouched — device-console reads it);
                this page just no longer renders web/module cards. */}
            <div className="mt-10">
              <p className="text-xs font-semibold uppercase tracking-wider text-fg-muted">
                Desktop apps
              </p>
              <p className="mt-1 text-sm text-fg-muted">
                Run it locally instead — no subscription, one license, a real term.
              </p>

              {exeProducts.length > 0 ? (
                <>
                  <label className="mt-4 block max-w-md">
                    <span className="text-sm font-medium text-fg">Choose an app</span>
                    <Select
                      className="mt-1"
                      value={selectedId}
                      onChange={(e) => setSelectedId(e.target.value)}
                    >
                      <option value="">Select an app…</option>
                      {exeProducts.map((product) => (
                        <option key={product.id} value={product.id}>
                          {`${product.name} — $${product.priceUsd.toFixed(2)}`}
                        </option>
                      ))}
                    </Select>
                  </label>

                  {selected ? (
                    <div className="mt-4 max-w-md">
                      <StoreCard product={selected} onBuy={(p) => setBuying(p)} />
                    </div>
                  ) : (
                    <p className="mt-4 text-sm text-fg-muted">
                      Pick an app above to see its price and buy it.
                    </p>
                  )}
                </>
              ) : (
                <p className="mt-4 text-sm text-fg-muted">
                  The desktop apps are unavailable right now — check back shortly.
                </p>
              )}
            </div>
          </>
        )}
      </div>

      {buying && (
        <CheckoutModal product={buying} onClose={() => setBuying(null)} />
      )}
    </section>
  );
}

// TASK_189 — cards are desktop-app cards only now (web/module cards left the
// store), but `kind` stays on the Product type because the checkout modal and
// /api/store/prices still speak the full catalog.
function StoreCard({
  product,
  onBuy,
}: {
  product: Product;
  onBuy: (p: Product) => void;
}) {
  return (
    <Card className="flex flex-col p-5">
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-lg font-semibold text-fg">{product.name}</h3>
        <Badge tone="neutral">Desktop app</Badge>
      </div>
      <p className="mt-2 text-sm text-fg-muted">{product.tagline}</p>

      <p className="mt-4 text-2xl font-bold text-fg">
        ${product.priceUsd.toFixed(2)}
        <span className="text-sm font-normal text-fg-muted"> / 6 months</span>
      </p>
      <p className="text-xs text-fg-muted">1 month and 1 year terms available at checkout.</p>

      <div className="mt-auto pt-4">
        <p className="text-xs text-fg-muted">
          {product.downloadUrl ? EXE_TRIAL_DISCLOSURE : EXE_DISCLOSURE}
        </p>
        <div className="mt-2 flex gap-2">
          {product.downloadUrl && (
            <a
              href={product.downloadUrl}
              className="flex-1 inline-flex items-center justify-center rounded-lg border border-border px-4 py-2 text-sm font-semibold text-fg hover:bg-black/5 dark:hover:bg-white/5"
            >
              Try for free
            </a>
          )}
          <Button variant="primary" className="flex-1" onClick={() => onBuy(product)}>
            Buy
          </Button>
        </div>
      </div>
    </Card>
  );
}

function CheckoutModal({ product, onClose }: { product: Product; onClose: () => void }) {
  const [kind, setKind] = useState<Kind>("btc");
  const [durationDays, setDurationDays] = useState(DEFAULT_EXE_DURATION_DAYS);
  const [checkout, setCheckout] = useState<CheckoutInfo | null>(null);
  const [loadingInfo, setLoadingInfo] = useState(false);
  const [email, setEmail] = useState("");
  const [txHash, setTxHash] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ status: string; note?: string } | null>(null);
  const [addressCopied, setAddressCopied] = useState(false);
  const [addressCopyFailed, setAddressCopyFailed] = useState(false);
  // TASK_189 — the web/module "Subscribe with your account" paths left the
  // store with their cards: only desktop apps are buyable here, checkout for
  // them is session-free, and the email field is therefore always shown. A 401
  // can no longer come back from this fetch, so it falls into the generic
  // error branch like any other failure.

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // Reset synchronous fetch state inside the async callback (not the effect
      // body) — avoids the react-hooks/set-state-in-effect cascade lint rule
      // while keeping the reset-before-load behaviour.
      setCheckout(null);
      setError("");
      setLoadingInfo(true);
      const qs = new URLSearchParams({ kind, product: product.id });
      if (product.kind === "exe") qs.set("durationDays", String(durationDays));
      const res = await fetch(`/api/billing/checkout?${qs.toString()}`);
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
  }, [kind, product.id, product.kind, durationDays]);

  async function copy(value: string) {
    const ok = await copyToClipboard(value);
    if (ok) {
      setAddressCopied(true);
      setAddressCopyFailed(false);
      setTimeout(() => setAddressCopied(false), 2000);
    } else {
      setAddressCopyFailed(true);
      setTimeout(() => setAddressCopyFailed(false), 2000);
    }
  }

  async function submit() {
    // Task 44 — the hash is optional: a buyer who doesn't know how to find it
    // can still submit; the payment just sits pending for manual review
    // instead of being auto-verified on-chain.
    const hash = txHash.trim();
    if (email.trim() && !email.includes("@")) {
      setError("Enter a valid email — it receives your license key.");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch("/api/billing/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind,
          txHash: hash,
          product: product.id,
          email: email.trim().toLowerCase() || undefined,
          durationDays: product.kind === "exe" ? durationDays : undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : "Submission failed");
        return;
      }
      setResult({ status: data.status, note: typeof data.note === "string" ? data.note : undefined });
    } catch {
      setError("Network error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={`Buy ${product.name}`} wide>
      {result ? (
        <div className="space-y-3 text-sm">
          <p className="font-medium text-fg">
            {result.status === "approved"
              ? "Payment approved — your license is being issued."
              : result.status === "flagged"
                ? "Payment under review — we'll verify it manually."
                : "Payment pending — we're checking the blockchain."}
          </p>
          {result.note && <p className="text-fg-muted">{result.note}</p>}
          <p className="text-fg-muted">
            We&rsquo;ll email your license key to <span className="font-medium">{email || "your email"}</span>{" "}
            the moment your payment is approved (or as soon as it verifies on-chain).
          </p>
          <Button variant="secondary" type="button" onClick={onClose}>
            Close
          </Button>
        </div>
      ) : (
        <div className="space-y-4 text-sm">
          <p className="text-fg-muted">
            {EXE_DISCLOSURE} Send the exact amount below; a license key is issued
            once your payment is approved, and downloads become available when the
            build ships.
          </p>

          <div>
            <p className="text-sm font-medium text-fg">Pay with</p>
            <div className="mt-2 flex gap-2">
              {[
                { id: "btc", label: "Bitcoin" },
                { id: "usdt_trc20", label: "USDT (TRC-20)" },
                { id: "usdt_erc20", label: "USDT (ERC-20)" },
              ].map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setKind(opt.id as Kind)}
                  className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                    kind === opt.id
                      ? "bg-brand-600 text-white"
                      : "border border-border bg-bg-elevated text-fg hover:bg-black/5 dark:hover:bg-white/5"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {product.kind === "exe" && (
            <div>
              <p className="text-sm font-medium text-fg">License term</p>
              <div className="mt-2 flex gap-2">
                {EXE_DURATION_OPTIONS.map((opt) => (
                  <button
                    key={opt.days}
                    type="button"
                    onClick={() => setDurationDays(opt.days)}
                    className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                      durationDays === opt.days
                        ? "bg-brand-600 text-white"
                        : "border border-border bg-bg-elevated text-fg hover:bg-black/5 dark:hover:bg-white/5"
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          <label className="block">
            <span className="text-sm font-medium text-fg">Email for your license key</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="mt-1 w-full rounded-lg border border-border bg-bg-elevated px-3 py-2 text-sm text-fg focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30"
            />
          </label>

          {loadingInfo ? (
            <p className="text-sm text-fg-muted">Loading payment details…</p>
          ) : checkout ? (
            <div className="rounded-lg border border-border bg-bg-elevated p-4">
              <p className="text-sm font-medium text-fg">
                Send {kind === "btc" ? "Bitcoin" : "USDT-TRC20"} to this address
              </p>
              <div className="mt-2 flex items-center gap-2">
                <code className="flex-1 break-all rounded-lg bg-black/5 px-3 py-2 font-mono text-xs dark:bg-white/10">
                  {checkout.toAddress}
                </code>
                <Button variant="secondary" type="button" onClick={() => copy(checkout.toAddress)}>
                  {addressCopied ? "Copied!" : addressCopyFailed ? "Copy failed — select manually" : "Copy"}
                </Button>
              </div>
              <p className="mt-2 text-sm text-fg-muted">
                Send exactly ${checkout.amountUsd.toFixed(2)} worth of {kind === "btc" ? "BTC" : "USDT"}{" "}
                — within ±5% is accepted.
              </p>
            </div>
          ) : null}

          <label className="block">
            <span className="text-sm font-medium text-fg">
              Transaction hash <span className="font-normal text-fg-muted">(optional)</span>
            </span>
            <input
              type="text"
              value={txHash}
              onChange={(e) => setTxHash(e.target.value)}
              placeholder="Enter it if you have it — leave blank otherwise"
              className="mt-1 w-full rounded-lg border border-border bg-bg-elevated px-3 py-2 font-mono text-sm text-fg focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30"
            />
            <p className="mt-1 text-xs text-fg-muted">
              Don&apos;t know how to find it? Leave this blank — we&apos;ll verify your payment manually instead. It just takes a little longer.
            </p>
          </label>

          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

          <div className="flex justify-end gap-3">
            <Button variant="secondary" type="button" onClick={onClose} disabled={submitting}>
              Cancel
            </Button>
            <Button variant="primary" type="button" onClick={submit} disabled={submitting}>
              {submitting ? "Submitting…" : "Submit Payment"}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}