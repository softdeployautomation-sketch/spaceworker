import { PREMIUM_REQUEST_TEMPLATES } from "@/lib/support-templates";

// TASK_187 C2 — the invoice card rendered inside a support thread, on BOTH
// sides (admin queue + customer widget), from ONE component so the two views
// can never drift apart on what money info shows.
//
// WHAT IT SHOWS: plan name (the single source of plan names is
// support-templates, not retyped here), the amount, a status chip, and the
// payout-address snapshot — chains with no address on THIS invoice are not
// listed, because offering a chain the invoice doesn't carry would send money
// to nothing.
//
// WHAT IT NEVER SHOWS: the term/duration override (`days`). It is an
// admin-only field (TASK_181) and is not even part of this type — the service
// does not select it — so there is no code path from the DB to this card that
// could leak it.
//
// `methods` arrives as untyped Json, so it is read defensively: a malformed
// payload renders zero chain rows rather than throwing inside a thread.

export interface ThreadInvoiceCardData {
  id: string;
  plan: string;
  tier: number;
  amountUsd: number;
  status: string;
  /** Json — the {btc, usdt_trc20, usdt_erc20} snapshot taken at send time. */
  methods: unknown;
  createdAt: string;
  paidAt: string | null;
}

const PLAN_LABELS: Record<string, string> = {
  premium_plus: PREMIUM_REQUEST_TEMPLATES.premium_request_plus.planName,
  premium_xdevice: PREMIUM_REQUEST_TEMPLATES.premium_request_xdevice.planName,
};

const CHAINS = [
  { id: "btc", label: "BTC" },
  { id: "usdt_trc20", label: "USDT · TRC-20" },
  { id: "usdt_erc20", label: "USDT · ERC-20" },
] as const;

function statusChip(status: string): { label: string; className: string } {
  if (status === "open") {
    return {
      label: "Awaiting payment",
      className: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
    };
  }
  if (status === "paid") {
    return {
      label: "Paid",
      className: "bg-green-500/15 text-green-700 dark:text-green-400",
    };
  }
  // Unknown statuses are extensible by convention (no DB CHECK) — render the
  // raw string rather than pretending it means one of the two we know.
  return { label: status, className: "bg-black/5 text-fg-muted dark:bg-white/5" };
}

export function SupportInvoiceCard({
  invoice,
  payHref,
}: {
  invoice: ThreadInvoiceCardData;
  /** User side only (the widget passes it for OPEN invoices): billing owns the pay flow. */
  payHref?: string;
}) {
  const methods: Record<string, unknown> =
    invoice.methods !== null && typeof invoice.methods === "object" && !Array.isArray(invoice.methods)
      ? (invoice.methods as Record<string, unknown>)
      : {};
  const chains = CHAINS.flatMap((c) => {
    const address = methods[c.id];
    return typeof address === "string" && address !== "" ? [{ ...c, address }] : [];
  });
  const chip = statusChip(invoice.status);

  return (
    <div className="mt-2 rounded-lg border border-border bg-bg-elevated p-3 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-medium text-fg">
          {PLAN_LABELS[invoice.plan] ?? invoice.plan} invoice · ${invoice.amountUsd.toFixed(2)}
        </p>
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${chip.className}`}
        >
          {chip.label}
        </span>
      </div>
      <div className="mt-2 flex flex-col gap-1.5">
        {chains.length === 0 ? (
          <p className="text-fg-muted">No payment addresses on this invoice.</p>
        ) : (
          chains.map((c) => (
            <div key={c.id}>
              <p className="text-fg-muted">{c.label}</p>
              {/* break-all is load-bearing: an address has no spaces and would
                  stretch the thread sideways without it. */}
              <p className="break-all font-mono text-fg">{c.address}</p>
            </div>
          ))
        )}
      </div>
      {payHref && (
        <a
          href={payHref}
          className="mt-3 inline-block rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-brand-700"
        >
          Pay invoice
        </a>
      )}
    </div>
  );
}
