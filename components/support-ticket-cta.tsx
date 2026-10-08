"use client";

// TASK_184 B2 — the ONE way any "Upgrade to Premium" CTA opens the support widget.
//
// Why an event and not a Link: SupportWidget mounts once in components/shell.tsx
// (the dashboard layout), which PERSISTS across client-side navigations — a
// `?template=` arriving through a Link would change the URL without ever re-running
// the widget's mount effect, so the preselect would silently not happen. The helper
// does both halves: it puts `?template=<slug>` in the URL (shareable, survives a
// refresh — the widget reads it on mount) and dispatches the event (works right now,
// in place, for the click that just happened).

import type { SupportTemplateSlug } from "@/lib/support-templates";
import { SUPPORT_OPEN_EVENT } from "@/lib/support-templates";

export function openSupportTicket(template: SupportTemplateSlug): void {
  if (typeof window === "undefined") return;
  try {
    const url = new URL(window.location.href);
    url.searchParams.set("template", template);
    window.history.replaceState(null, "", url.toString());
  } catch {
    // A URL that cannot be parsed must not stop the ticket from opening — the
    // event below is the path that actually does the work.
  }
  window.dispatchEvent(new CustomEvent(SUPPORT_OPEN_EVENT, { detail: { template } }));
}

/**
 * A styled button that opens the compose view preselected for `template`. A client
 * component so the server settings page can render it too.
 */
export function SupportTicketButton({
  template,
  children,
  className,
}: {
  template: SupportTemplateSlug;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={() => openSupportTicket(template)}
      className={
        className ??
        "inline-flex rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-700"
      }
    >
      {children}
    </button>
  );
}
