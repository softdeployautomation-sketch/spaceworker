import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  SUPPORT_OPEN_EVENT,
  PREMIUM_REQUEST_TEMPLATES,
  PREMIUM_REQUEST_CATEGORIES,
  SUPPORT_TEMPLATE_OPTIONS,
  isPremiumRequestCategory,
  supportTemplateFromSlug,
} from "../lib/support-templates";
import {
  PLAN_PREMIUM_PLUS,
  PLAN_PREMIUM_XDEVICE,
  PLAN_FREE,
  planLabelForTier,
  UPGRADE_TO_PREMIUM_PLUS,
  REQUEST_PREMIUM_PLUS_LABEL,
} from "../lib/plan-name";

// ---------------------------------------------------------------------------
// TASK_184 B5 — the STATIC half of the web free-tier locks (N4, C3) plus the
// B2 template contract and the B1 wrapper/price split.
//
// THE FAILURES THIS SUITE EXISTS TO PREVENT:
//   1. N4 naming drift — a tier-5 ask going back to bare "Upgrade to Premium"
//      or "Pro", or an XDevice surface calling itself plain "Premium" (the
//      owner's 2026-10-08 rule: tier 5 = "Premium Plus", tier 3 = "Premium
//      XDevice" — display-name only, TASK_181 server strings untouched).
//   2. C3 — the web request card regressing into a tier-branched or price-
//      rendering component, or losing its SupportTicketButton arm.
//   3. B1 — a subscription amount/quote leaking onto a WEB surface outside
//      `useWrapperMode()`'s wrapper branch (billing's UpgradeFlow/SpendFlow,
//      settings' self-serve link, device-console's price fetch).
//   4. B2 — the ticket template slugs/categories/tiers drifting apart from
//      what the invoice flow (B3) grants on.
//
// Style: source-level locks (comment-stripped) — deliberately brittle, like
// module-route-gate's static section. A FAIL means the invariant moved.
// ---------------------------------------------------------------------------

const ROOT = path.resolve(__dirname, "..");

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

/** Drop block comments, full-line `//` comments and trailing `// …` (URLs intact). */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => {
      if (line.trimStart().startsWith("//")) return "";
      return line.replace(/(^|[^:"'\w])\/\/.*$/, "$1");
    })
    .join("\n");
}

function walkTsx(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkTsx(full, out);
    else if (entry.name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

/** Source slice between two markers (`to === null` ⇒ end of file). */
function region(src: string, from: string, to: string | null): string {
  const start = src.indexOf(from);
  assert.ok(start >= 0, `expected to find \`${from}\``);
  const end = to === null ? src.length : src.indexOf(to, start + from.length);
  assert.ok(end > start, `expected to find \`${to}\` after \`${from}\``);
  return src.slice(start, end);
}

// ---------------------------------------------------------------------------
// B2 — THE TEMPLATE CONTRACT (slugs ↔ categories ↔ tiers ↔ plan names)
// ---------------------------------------------------------------------------

test("B2: exactly two requestable plans, each carrying the tier its invoice will grant", () => {
  assert.deepEqual([...PREMIUM_REQUEST_CATEGORIES], [
    "premium_request_plus",
    "premium_request_xdevice",
  ]);
  assert.deepEqual({ ...PREMIUM_REQUEST_TEMPLATES.premium_request_plus }, {
    slug: "premium-plus",
    label: "Request for Premium Plus",
    tier: 5,
    planName: "Premium Plus",
  });
  assert.deepEqual({ ...PREMIUM_REQUEST_TEMPLATES.premium_request_xdevice }, {
    slug: "premium-xdevice",
    label: "Request for Premium XDevice",
    tier: 3,
    planName: "Premium XDevice",
  });
});

test("B2: supportTemplateFromSlug routes ?template= — null stays technical, unknown falls to tier 5", () => {
  assert.equal(supportTemplateFromSlug(null), "", "absent ?template= preselects nothing");
  assert.equal(supportTemplateFromSlug("premium-xdevice"), "premium_request_xdevice");
  assert.equal(supportTemplateFromSlug("premium-plus"), "premium_request_plus");
  assert.equal(
    supportTemplateFromSlug("typo-future"),
    "premium_request_plus",
    "present-but-unrecognized ⇒ tier-5 default, so a typo never files as technical",
  );
  assert.equal(supportTemplateFromSlug(""), "premium_request_plus");
});

test("B2: the composer's options carry the template labels verbatim, and the event name is fixed", () => {
  assert.equal(SUPPORT_TEMPLATE_OPTIONS.length, 4);
  assert.equal(SUPPORT_TEMPLATE_OPTIONS[0].value, "", "plain technical ticket is first");
  for (const cat of PREMIUM_REQUEST_CATEGORIES) {
    const opt = SUPPORT_TEMPLATE_OPTIONS.find((o) => o.value === cat);
    assert.ok(opt, `${cat} must be offered in the composer`);
    assert.equal(opt.label, PREMIUM_REQUEST_TEMPLATES[cat].label, "one source for the label");
  }
  assert.equal(isPremiumRequestCategory("premium_request_plus"), true);
  assert.equal(isPremiumRequestCategory("premium_request_xdevice"), true);
  assert.equal(isPremiumRequestCategory("billing_question"), false);
  assert.equal(isPremiumRequestCategory(""), false);
  assert.equal(isPremiumRequestCategory(null), false);
  assert.equal(SUPPORT_OPEN_EVENT, "sw:open-support");
});

// ---------------------------------------------------------------------------
// N4 — THE PLAN NAMES (display-name only; server/API strings stay TASK_181)
// ---------------------------------------------------------------------------

test("N4: planLabelForTier maps the tiers to the owner's names — tier 3 is never plain Premium", () => {
  assert.equal(planLabelForTier(5), PLAN_PREMIUM_PLUS);
  assert.equal(planLabelForTier(6), PLAN_PREMIUM_PLUS, ">= 5 reads as Premium Plus");
  assert.equal(planLabelForTier(3), PLAN_PREMIUM_XDEVICE);
  assert.equal(planLabelForTier(4), PLAN_FREE);
  assert.equal(planLabelForTier(1), PLAN_FREE);
  assert.equal(planLabelForTier(0), PLAN_FREE);
  assert.equal(PLAN_FREE, "Free");
  assert.equal(UPGRADE_TO_PREMIUM_PLUS, "Upgrade to Premium Plus");
  assert.equal(REQUEST_PREMIUM_PLUS_LABEL, "Request for Premium Plus");
});

// ---------------------------------------------------------------------------
// B1/C3 — BILLING: quotes live in the wrapper branch, the web gets the card
// ---------------------------------------------------------------------------

const BILLING = "app/dashboard/billing/page.tsx";

test("B1: billing's quote surfaces are exactly the two wrapper ternaries plus the gated SpendFlow", () => {
  const billing = stripComments(read(BILLING));

  // No-payment branch: WRAPPER buys, WEB requests.
  assert.match(
    billing,
    /wrapperMode \? \(\s*<UpgradeFlow onResult=\{handleResult\} product=\{product\} \/>\s*\) : \(\s*<PremiumRequestCard product=\{product\} \/>/,
    "the main subscription branch must stay wrapperMode ? UpgradeFlow : PremiumRequestCard",
  );
  // Rejected-payment branch: same split on resubmit.
  assert.match(
    billing,
    /wrapper \? \(\s*<>\s*<h3[^>]*>Submit a new payment hash<\/h3>\s*<UpgradeFlow onResult=\{onResult\} product=\{product\} \/>[\s\S]{0,80}?\) : \(\s*<PremiumRequestCard product=\{product\} \/>/,
    "the rejected-resubmit branch must stay wrapper ? UpgradeFlow : PremiumRequestCard",
  );
  // Balance-activation quote: gated on wrapper mode being active at all.
  assert.match(
    billing,
    /payment !== undefined && wrapperMode !== null && \(\s*<SpendFlow/,
    "SpendFlow fetches a server price — it may only render in the wrapper build",
  );

  assert.equal(
    (billing.match(/<UpgradeFlow/g) ?? []).length,
    2,
    "exactly two UpgradeFlow renders, both inside the ternaries above",
  );
  assert.equal(
    (billing.match(/<PremiumRequestCard/g) ?? []).length,
    2,
    "exactly two PremiumRequestCard renders, both on the web side of those ternaries",
  );
});

test("B1: every checkout quote lives in a wrapper-only component; the invoice card never prices anything", () => {
  const billing = stripComments(read(BILLING));

  assert.equal(
    (billing.match(/\/api\/billing\/checkout/g) ?? []).length,
    2,
    "exactly two quote fetches exist",
  );
  assert.equal(
    (region(billing, "function UpgradeFlow", "function PremiumRequestCard").match(/\/api\/billing\/checkout/g) ?? []).length,
    1,
    "quote fetch #1 belongs to UpgradeFlow (wrapper-only)",
  );
  assert.equal(
    (region(billing, "function SpendFlow", null).match(/\/api\/billing\/checkout/g) ?? []).length,
    1,
    "quote fetch #2 belongs to SpendFlow (gated by wrapperMode !== null)",
  );
  assert.equal(
    (region(billing, "function PremiumRequestCard", "function PremiumInvoiceCard").match(/\/api\/billing\/checkout/g) ?? []).length,
    0,
    "the web request card fetches no price",
  );
  assert.equal(
    (region(billing, "function PremiumInvoiceCard", "function SpendFlow").match(/\/api\/billing\/checkout/g) ?? []).length,
    0,
    "the invoice card renders the invoice's own amount — no quote endpoint",
  );
  assert.ok(
    !/\/api\/store\/prices/.test(billing),
    "billing quotes from checkout only — store/prices is a different surface's concern",
  );
});

test("C3: PremiumRequestCard is tier-independent — product prop only, both templates, no price", () => {
  const billing = stripComments(read(BILLING));
  const card = region(billing, "function PremiumRequestCard", "function PremiumInvoiceCard");

  assert.match(
    card,
    /function PremiumRequestCard\(\{ product \}: \{ product: "web_subscription" \| "xdevice" \}\)/,
    "the ONLY input is the product — no tier, no payment, no plan state",
  );
  assert.ok(!/\btier\b/.test(card), "C3: the card must not branch on tier");
  assert.ok(!/\bfetch\(/.test(card), "C3: the card must not fetch (prices or otherwise)");
  assert.ok(!/checkout|price/i.test(card), "C3: no quote vocabulary in the web card");
  assert.match(
    card,
    /template=\{plus \? "premium-plus" : "premium-xdevice"\}/,
    "both template slugs, chosen by product",
  );
  assert.match(
    card,
    /\{plus \? "Request for Premium Plus" : "Request for Premium XDevice"\}/,
    "both N4-safe labels, chosen by product",
  );
  assert.match(
    billing,
    /import \{ SupportTicketButton \} from "@\/components\/support-ticket-cta";/,
    "the card's CTA is the ticket button — C3's whole point",
  );
});

// ---------------------------------------------------------------------------
// B1 — SETTINGS / DEVICE-CONSOLE / MODULE-LOCK: price only behind the wrapper
// ---------------------------------------------------------------------------

test("B1: the settings XDevice card — wrapper gets the priced link, web gets the ticket button", () => {
  const settings = stripComments(read("app/dashboard/settings/page.tsx"));

  assert.match(
    settings,
    /\{wrapper \? \(\s*<Link\s+href="\/dashboard\/billing\?product=xdevice"[\s\S]{0,600}?Subscribe to Premium XDevice — \$\{xdevicePrice\}\s*<\/Link>\s*\) : \(\s*<SupportTicketButton template="premium-xdevice"[\s\S]{0,500}?>\s*Request Premium XDevice\s*<\/SupportTicketButton>\s*\)\}/,
    "the price may live ONLY in the wrapper arm; web's arm is the ticket CTA",
  );
  assert.equal(
    (settings.match(/\$\{xdevicePrice\}/g) ?? []).length,
    1,
    "one price interpolation in the whole page, inside that wrapper arm",
  );
  assert.match(settings, /<h2[^>]*>Premium XDevice<\/h2>/, "the card names its plan (N4)");
});

test("B1: device-console never fetches or renders a price on web — guard first, label fallback has no $", () => {
  const dc = stripComments(read("components/device-console.tsx"));

  assert.match(
    dc,
    /if \(!isWrapper\) return;[\s\S]{0,600}?\/api\/store\/prices/,
    "the guard must PRECEDE the only price fetch on this surface",
  );
  assert.equal(
    (dc.match(/\/api\/store\/prices/g) ?? []).length,
    1,
    "exactly one price fetch, behind that guard",
  );
  assert.match(
    dc,
    /const label = isWrapper\s*\? priceUsd !== null\s*\? `Subscribe to Premium XDevice — \$\$\{priceUsd\}`\s*: "Subscribe to Premium XDevice"\s*: "Upgrade to Premium XDevice";/,
    "the web arm of the label carries NO amount (B1)",
  );
});

test("B1/C3: the module tool lock is price-free and always offers the ticket CTA", () => {
  const lock = stripComments(read("components/module-tool-lock.tsx"));

  assert.ok(!/price/i.test(lock), "the web lock never mentions a price (B1)");
  assert.ok(!/checkout|store\/prices/.test(lock), "nor any price endpoint");
  assert.match(
    lock,
    /<SupportTicketButton template="premium-plus">/,
    "the locked free-tier surface always offers the tier-5 ticket request (C3)",
  );
});

// ---------------------------------------------------------------------------
// N4 — TREE-WIDE NAMING SCAN (comment-stripped; admin operator UI excluded
//      from label rules only where it is not a user-facing plan ask)
// ---------------------------------------------------------------------------

function strippedTree(): Array<{ file: string; src: string }> {
  const files = [
    ...walkTsx(path.join(ROOT, "app")),
    ...walkTsx(path.join(ROOT, "components")),
  ];
  return files.map((p) => ({
    file: path.relative(ROOT, p),
    src: stripComments(fs.readFileSync(p, "utf8")),
  }));
}

test("N4: no bare 'Upgrade to Premium' CTA survives anywhere in user-facing source", () => {
  for (const f of strippedTree()) {
    const m = f.src.match(/Upgrade to Premium(?! (?:Plus|XDevice))/);
    assert.equal(m, null, `${f.file}: bare "Upgrade to Premium${m ? m[0].slice(21) : ""}" — say Premium Plus or Premium XDevice`);
  }
});

test("N4: no bare 'Subscribe to Premium' or 'Request … Premium' label survives anywhere", () => {
  for (const f of strippedTree()) {
    let m = f.src.match(/Subscribe to Premium(?! (?:Plus|XDevice))/);
    assert.equal(m, null, `${f.file}: bare subscribe label — the plan must be named`);
    m = f.src.match(/Request (?:for )?Premium(?! (?:Plus|XDevice))/);
    assert.equal(m, null, `${f.file}: bare request label — the plan must be named`);
  }
});

test("N4: no legacy 'Pro' plan label survives anywhere", () => {
  for (const f of strippedTree()) {
    const m = f.src.match(/"Pro"|>Pro<|\bPro plan\b/);
    assert.equal(m, null, `${f.file}: legacy "Pro" label — tier 5 reads Premium Plus`);
  }
});

test("N4: the XDevice surfaces never say plain 'Premium' as a plan name", () => {
  for (const relPath of [
    "app/dashboard/settings/page.tsx",
    "components/device-console.tsx",
    "components/module-tool-lock.tsx",
  ]) {
    const src = stripComments(read(relPath));
    let m = src.match(/>Premium\s*</);
    assert.equal(m, null, `${relPath}: bare >Premium< label — tier 3 is "Premium XDevice"`);
    m = src.match(/"Premium"/);
    assert.equal(m, null, `${relPath}: bare "Premium" string — tier 3 is "Premium XDevice"`);
  }
});

// ---------------------------------------------------------------------------
// B2 WIRING — one event name, one option list, one category source
// ---------------------------------------------------------------------------

test("B2 wiring: CTA event, composer options and admin queue all read the shared module", () => {
  const cta = stripComments(read("components/support-ticket-cta.tsx"));
  const widget = stripComments(read("components/support-widget.tsx"));
  // Dispatch AND listen must both name the shared constant — and neither may
  // hardcode the raw string, which is what would let the two ends drift apart.
  assert.ok(cta.includes("SUPPORT_OPEN_EVENT"), "the CTA dispatches by the shared constant name");
  assert.ok(widget.includes("SUPPORT_OPEN_EVENT"), "the widget listens on the shared constant name");
  for (const [f, src] of [["cta", cta], ["widget", widget]] as const) {
    assert.ok(
      !src.includes(`"${SUPPORT_OPEN_EVENT}"`) && !src.includes(`'${SUPPORT_OPEN_EVENT}'`),
      `${f} must not hardcode the event literal — import the constant`,
    );
  }
  assert.ok(
    widget.includes("SUPPORT_TEMPLATE_OPTIONS"),
    "the composer's <select> renders the one shared option list",
  );
  const queue = stripComments(read("components/admin/support-queue-panel.tsx"));
  assert.ok(
    queue.includes("PREMIUM_REQUEST_TEMPLATES"),
    "the admin queue reads the same templates (planName chips, tier context)",
  );
});




