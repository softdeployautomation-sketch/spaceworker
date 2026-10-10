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

/**
 * TASK_199 S2 — broadcast message templates for the admin's "Broadcast"
 * composer (support queue panel). Pure data, same rules as everything above:
 * one place they are written down, client-safe (no prisma), and picking one
 * only PREFILLS the textarea — the admin always reads/edits before sending,
 * and the server re-validates body + audience regardless.
 *
 * Written for the operational incidents we actually hit: dead install links,
 * maintenance windows, devices not showing, remote-control disconnects,
 * screenshot outages. Bodies deliberately name the next step ("we'll message
 * you again when it's back") so users know a follow-up is coming and don't
 * all open tickets asking.
 */
export const BROADCAST_TEMPLATES: ReadonlyArray<{
  id: string;
  label: string;
  body: string;
}> = [
  {
    id: "maintenance_soon",
    label: "Maintenance in ~1 hour",
    body:
      "Scheduled maintenance: we'll be performing maintenance on SpaceWorker in about an hour. " +
      "The service may be briefly unavailable during this window. No action is needed from you — " +
      "your devices will reconnect automatically. We'll send another message here when it's done.",
  },
  {
    id: "maintenance_done",
    label: "Maintenance finished",
    body:
      "Maintenance is complete — SpaceWorker is back to normal. If any device still looks offline, " +
      "give it a couple of minutes to reconnect, then reply here if it doesn't.",
  },
  {
    id: "vbs_link_down",
    label: "Install link (.vbs) is down",
    body:
      "We're aware that the agent install (.vbs) download is currently failing, and our team is on it. " +
      "Devices that are already installed and running are NOT affected. We'll message you again here " +
      "as soon as the link is back up.",
  },
  {
    id: "agent_install_issue",
    label: "Agent install trouble",
    body:
      "Having trouble installing the agent? Please re-download the installer from your Devices page " +
      "and run it again. If it still won't install, reply here with the device name and what happened, " +
      "and we'll take a look.",
  },
  {
    id: "new_device_pending",
    label: "New device slow to appear",
    body:
      "Your new device is registered and may take a few minutes to fully come online while the agent " +
      "finishes setting up. If it hasn't appeared in your Devices list after 10 minutes, reply here " +
      "and we'll check it.",
  },
  {
    id: "remote_control_issue",
    label: "Remote control shows disconnected",
    body:
      "We're aware that some remote-control sessions may show as disconnected even when the device is " +
      "online, and the team is investigating. Your device's online status in the Devices list remains " +
      "accurate in the meantime.",
  },
  {
    id: "screenshots_down",
    label: "Screen monitoring delayed",
    body:
      "Screen monitoring may be delayed or temporarily unavailable while we work on it. No action is " +
      "needed — captures resume automatically once it's back.",
  },
];
