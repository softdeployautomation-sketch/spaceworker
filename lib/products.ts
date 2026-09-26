import type { EntitlementKey } from "./entitlements";

// Task 42 — the single source of truth for every product sold on the
// store/landing/pricing pages. Both the public store UI (components/store.tsx)
// and the server-side billing routes (which look up prices by `priceField`)
// import from here so a product's id/name/tagline can never drift between
// the card it's sold on and the Payment.product row a purchase creates.
//
// Product ids double as the `Payment.product` value and the `ExeLicense.product`
// value, so prefixes never get out of sync.

export type ProductId =
  | "web_subscription"
  | "extractor_module"
  | "mailer_module"
  | "assistant_devices_module"
  | "extractor_exe"
  | "mailer_exe"
  | "combined_exe"
  | "automation_exe"
  | "agent_exe";

// TASK_99 / plan §COMMERCIAL C3 — "module" is new: a pick-your-capability web
// subscription that grants ONE OR MORE entitlements (lib/entitlements.ts)
// instead of the full tier-5 bundle "web_subscription" still grants. Priced
// and billed exactly like "web" (flat monthly, no term) — the only
// difference downstream is what handleApprovedPayment does on success
// (lib/license-service.ts): grant specific keys instead of bumping tier.
export type ProductKind = "web" | "module" | "exe";

export interface StoreProduct {
  id: ProductId;
  name: string;
  tagline: string;
  priceField: keyof AdminSettingPriceFields;
  kind: ProductKind;
  // For EXE products, the plan slug embedded in the license key payload (matches
  // the purchased tier). Web subscription has no key, so plan is undefined.
  plan?: string;
  // Module products only — which entitlement key(s) a successful payment
  // grants (lib/entitlements.ts EntitlementKey). Never set for "web"/"exe".
  entitlementKeys?: EntitlementKey[];
  // 2026-09-20 — owner: "add a try for free on the store... so users can get
  // the exe for free". A public download link (GitHub Release asset) for a
  // product whose build has actually been verified working. The EXE itself
  // already grants a silent 24h trial with zero account/payment needed
  // (components/license-gate.tsx) — this is just giving people a way to GET
  // the installer without emailing support first. Only set once a variant's
  // build is confirmed working; absent => the store still only offers "Buy"
  // for it (unchanged), never a broken/unverified download link.
  downloadUrl?: string;
}

// The AdminSetting fields that carry each product's launch price (all real,
// decided 2026-09-14, still admin-adjustable at runtime).
export type AdminSettingPriceFields = {
  webSubscriptionPriceUsd: number;
  extractorExePriceUsd: number;
  mailerExePriceUsd: number;
  combinedExePriceUsd: number;
  automationExePriceUsd: number;
  extractorModulePriceUsd: number;
  mailerModulePriceUsd: number;
  assistantDevicesModulePriceUsd: number;
  agentExePriceUsd: number;
};

export const WEB_SUBSCRIPTION: StoreProduct = {
  id: "web_subscription",
  name: "SpaceWorker OS",
  tagline:
    "The full web app — private browser, lead extraction, outreach campaigns, the AI agent and automations. Everything, live in your browser.",
  priceField: "webSubscriptionPriceUsd",
  kind: "web",
};

// TASK_99 / plan §COMMERCIAL C3 (owner, 2026-09-26) — pick-your-capability
// modules. Each grants its own UserEntitlement key(s) on successful payment
// (lib/license-service.ts) instead of the full bundle above. Cyber Lab is
// deliberately NOT listed as a module yet — same "don't sell what doesn't
// exist" rule TASK_100's marketing pillars follow: TASK_98 has no dashboard
// route anywhere in the codebase today.
export const EXTRACTOR_MODULE: StoreProduct = {
  id: "extractor_module",
  name: "Extractor",
  tagline:
    "Lead extraction on its own — search the web, verify, and export a clean lead list. Nothing else bundled in.",
  priceField: "extractorModulePriceUsd",
  kind: "module",
  entitlementKeys: ["extractor"],
};

export const MAILER_MODULE: StoreProduct = {
  id: "mailer_module",
  name: "Mailer",
  tagline:
    "Outreach campaigns on their own — subject/sender rotation, test-send confirmation, per-recipient variables.",
  priceField: "mailerModulePriceUsd",
  kind: "module",
  entitlementKeys: ["mailer"],
};

export const ASSISTANT_DEVICES_MODULE: StoreProduct = {
  id: "assistant_devices_module",
  name: "Assistant & Devices",
  tagline:
    "The AI agent plus full device control — remote tools, the app launcher, Browser Clone, Wake-on-LAN and keep-awake — with you approving every action.",
  priceField: "assistantDevicesModulePriceUsd",
  kind: "module",
  entitlementKeys: ["assistant", "devices"],
};

export const MODULE_PRODUCTS: StoreProduct[] = [
  EXTRACTOR_MODULE,
  MAILER_MODULE,
  ASSISTANT_DEVICES_MODULE,
];

export const EXTRACTOR_EXE: StoreProduct = {
  id: "extractor_exe",
  name: "Extractor EXE",
  tagline:
    "Lead extraction as a desktop app — run the same Playwright-driven search pipeline locally, no account or subscription required.",
  priceField: "extractorExePriceUsd",
  kind: "exe",
  plan: "extractor",
  downloadUrl:
    "https://github.com/softdeployautomation-sketch/spaceworker/releases/download/extractor-v0.1.0/SpaceWorker.OS.-.Lead.Extractor_0.1.0_x64-setup.exe",
};

export const MAILER_EXE: StoreProduct = {
  id: "mailer_exe",
  name: "Mailer EXE",
  tagline:
    "Outreach campaigns on your own machine — build mailboxes and campaigns, with subject and sender rotation, entirely offline.",
  priceField: "mailerExePriceUsd",
  kind: "exe",
  plan: "mailer",
};

export const COMBINED_EXE: StoreProduct = {
  id: "combined_exe",
  name: "Combined EXE",
  tagline:
    "Extractor + Mailer in one app and one local database — leads flow straight from extraction into your campaigns with no export step.",
  priceField: "combinedExePriceUsd",
  kind: "exe",
  plan: "combined",
};

export const AUTOMATION_EXE: StoreProduct = {
  id: "automation_exe",
  name: "Automation-enabled EXE",
  tagline:
    "The complete top tier — Combined plus the AI agent and scheduled automations. Everything SpaceWorker OS can do, as a desktop app.",
  priceField: "automationExePriceUsd",
  kind: "exe",
  plan: "automation",
};

// New product (owner, 2026-09-26): the AI agent + device control as a
// lightweight desktop app — the same "Assistant & Devices" capability the
// module above sells for the web, packaged standalone with no browser tab
// required. No build variant exists yet (lib/exe-build-target.ts has no
// "agent" target) — sellable now, buildable later, same state
// mailer/combined/automation EXE already sell in today.
export const AGENT_EXE: StoreProduct = {
  id: "agent_exe",
  name: "SpaceWorker Agent",
  tagline:
    "The AI assistant and full device control, as a background desktop app — approve what it proposes, run remote tools, keep machines awake, no browser tab required.",
  priceField: "agentExePriceUsd",
  kind: "exe",
  plan: "agent",
};

export const EXE_PRODUCTS: StoreProduct[] = [
  EXTRACTOR_EXE,
  MAILER_EXE,
  COMBINED_EXE,
  AUTOMATION_EXE,
  AGENT_EXE,
];

export const ALL_PRODUCTS: StoreProduct[] = [WEB_SUBSCRIPTION, ...MODULE_PRODUCTS, ...EXE_PRODUCTS];

const BY_ID = new Map<string, StoreProduct>(ALL_PRODUCTS.map((p) => [p.id, p]));

export function getProduct(id: string): StoreProduct | null {
  const product = BY_ID.get(id);
  return product ?? null;
}

// 2026-09-20 — owner: "the spaceworker price is listed for 6 months, if
// anyone wants to buy more on there license they can buy for 1 year, and
// also for 1 month, just let the calculator do its thing." An EXE product's
// admin-set price (AdminSetting[priceField]) is always the STANDARD 6-month
// (EXE_LICENSE_DAYS = 180) term; every other offered term is a straight
// linear scale of that same per-day rate — no separate admin field per term,
// exactly "let the calculator do its thing" rather than a manually-priced
// tier. Shared by both checkout routes AND the client-side pickers (store.tsx,
// license-activation-form.tsx) so the displayed price always matches what the
// server will actually charge.
export const EXE_DURATION_OPTIONS: { days: number; label: string }[] = [
  { days: 30, label: "1 month" },
  { days: 180, label: "6 months" },
  { days: 365, label: "1 year" },
];
export const STANDARD_EXE_TERM_DAYS = 180;
export const DEFAULT_EXE_DURATION_DAYS = STANDARD_EXE_TERM_DAYS;

export function isValidExeDurationDays(days: number): boolean {
  return EXE_DURATION_OPTIONS.some((o) => o.days === days);
}

/** The price for `durationDays` given a product's standard 6-month price. */
export function calculateExePrice(standardPriceUsd: number, durationDays: number): number {
  return Math.round((standardPriceUsd * (durationDays / STANDARD_EXE_TERM_DAYS)) * 100) / 100;
}

export function isExeProduct(id: string): boolean {
  const product = BY_ID.get(id);
  return !!product && product.kind === "exe";
}

// The one thing that must be disclosed pre-purchase on every EXE card (the fake
// download tradeoff). Stated plainly on the card itself, not in fine print.
export const EXE_DOWNLOAD_DISCLOSURE =
  "Desktop app — license issued instantly; download link emailed once the build is ready.";