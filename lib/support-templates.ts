// TASK_184 B2 — premium-request ticket templates.
//
// Pure data, deliberately NOT a "use client" module: the support widget (client), the
// admin queue panel (client), the settings page (server) and tests all read this one
// list, and the category strings are the CONTRACT the admin later filters and the
// invoice flow (B3) flags on. There is exactly one place they are written down.
//
// No migration: `SupportTicket.category` is free-text (max 40, prisma/schema.prisma)
// — these values ride in as-is from the composer's <select>.

/** Custom-event name: an Upgrade CTA opens the widget in place, wherever it lives. */
export const SUPPORT_OPEN_EVENT = "sw:open-support";

/** Two requestable plans. `tier` is what the admin's invoice grants (B3/B4). */
export const PREMIUM_REQUEST_TEMPLATES = {
  premium_request_plus: {
    slug: "premium-plus",
    label: "Request for Premium Plus",
    tier: 5,
    planName: "Premium Plus",
  },
  premium_request_xdevice: {
    slug: "premium-xdevice",
    label: "Request for Premium XDevice",
    tier: 3,
    planName: "Premium XDevice",
  },
} as const;

export type PremiumRequestCategory = keyof typeof PREMIUM_REQUEST_TEMPLATES;
export type SupportTemplateSlug = (typeof PREMIUM_REQUEST_TEMPLATES)[PremiumRequestCategory]["slug"];

export const PREMIUM_REQUEST_CATEGORIES = Object.keys(
  PREMIUM_REQUEST_TEMPLATES,
) as PremiumRequestCategory[];

/**
 * The composer's <select>, in display order. `value` is what lands in
 * `SupportTicket.category`; "" = a plain technical ticket (stored as null).
 */
export const SUPPORT_TEMPLATE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "", label: "Technical issue" },
  { value: "billing_question", label: "Billing question" },
  { value: "premium_request_plus", label: PREMIUM_REQUEST_TEMPLATES.premium_request_plus.label },
  { value: "premium_request_xdevice", label: PREMIUM_REQUEST_TEMPLATES.premium_request_xdevice.label },
];

export function isPremiumRequestCategory(value: string | null | undefined): value is PremiumRequestCategory {
  return value === "premium_request_plus" || value === "premium_request_xdevice";
}

/**
 * `?template=` slug → the compose <select>'s value.
 *
 * - ABSENT (null) → "" (no preselect: a plain "New ticket" stays a technical ticket).
 * - `premium-xdevice` → tier-3 template.
 * - anything else present (incl. `premium-plus` and unknown future values) → tier-5
 *   template — premium-plus is B2's documented default for a present-but-unrecognized
 *   slug, so a typo can never silently file a premium request under "technical".
 */
export function supportTemplateFromSlug(slug: string | null): string {
  if (slug === null) return "";
  return slug === "premium-xdevice" ? "premium_request_xdevice" : "premium_request_plus";
}
