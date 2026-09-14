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
  | "extractor_exe"
  | "mailer_exe"
  | "combined_exe"
  | "automation_exe";

export type ProductKind = "web" | "exe";

export interface StoreProduct {
  id: ProductId;
  name: string;
  tagline: string;
  priceField: keyof AdminSettingPriceFields;
  kind: ProductKind;
  // For EXE products, the plan slug embedded in the license key payload (matches
  // the purchased tier). Web subscription has no key, so plan is undefined.
  plan?: string;
}

// The AdminSetting fields that carry each product's launch price (all real,
// decided 2026-09-14, still admin-adjustable at runtime).
export type AdminSettingPriceFields = {
  webSubscriptionPriceUsd: number;
  extractorExePriceUsd: number;
  mailerExePriceUsd: number;
  combinedExePriceUsd: number;
  automationExePriceUsd: number;
};

export const WEB_SUBSCRIPTION: StoreProduct = {
  id: "web_subscription",
  name: "SpaceWorker OS",
  tagline:
    "The full web app — private browser, lead extraction, outreach campaigns, the AI agent and automations. Everything, live in your browser.",
  priceField: "webSubscriptionPriceUsd",
  kind: "web",
};

export const EXTRACTOR_EXE: StoreProduct = {
  id: "extractor_exe",
  name: "Extractor EXE",
  tagline:
    "Lead extraction as a desktop app — run the same Playwright-driven search pipeline locally, no account or subscription required.",
  priceField: "extractorExePriceUsd",
  kind: "exe",
  plan: "extractor",
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

export const EXE_PRODUCTS: StoreProduct[] = [
  EXTRACTOR_EXE,
  MAILER_EXE,
  COMBINED_EXE,
  AUTOMATION_EXE,
];

export const ALL_PRODUCTS: StoreProduct[] = [WEB_SUBSCRIPTION, ...EXE_PRODUCTS];

const BY_ID = new Map<string, StoreProduct>(ALL_PRODUCTS.map((p) => [p.id, p]));

export function getProduct(id: string): StoreProduct | null {
  const product = BY_ID.get(id);
  return product ?? null;
}

export function isExeProduct(id: string): boolean {
  const product = BY_ID.get(id);
  return !!product && product.kind === "exe";
}

// The one thing that must be disclosed pre-purchase on every EXE card (the fake
// download tradeoff). Stated plainly on the card itself, not in fine print.
export const EXE_DOWNLOAD_DISCLOSURE =
  "Desktop app — license issued instantly; download link emailed once the build is ready.";