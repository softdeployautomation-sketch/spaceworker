// TASK_201 S6 — the one source of truth for "a campaign as a template".
//
// Why this exists: the "Save as template" button and the "My templates" picker
// each inlined their own `(c.variants?.length ?? 0) > 0` check. Task 29 made
// every campaign created from the web form DECOUPLED — content lives in the
// campaign's `subjects[]`/`bodies[]` columns and NO CampaignVariant rows are
// ever created — so that variants-only check was false for every real campaign
// and the button was permanently disabled ("unclickable" in the owner's words,
// confirmed live on the web app 2026-10-10). Gate + filter + apply now all go
// through this helper, so the three can never drift apart again.
//
// Pure data-in/data-out, no imports — safe from client components, server
// routes and node:test suites alike.

export interface TemplateSourceCampaign {
  // Decoupled content (Task 29) — populated for every campaign created from
  // the current web form; [] for legacy pair-based campaigns.
  subjects?: string[] | null;
  bodies?: string[] | null;
  // Legacy pair-based content — the only content pre-Task-29 campaigns have.
  variants?: { subject?: string | null; bodyHtml?: string | null }[] | null;
}

export interface CampaignTemplateContent {
  subjects: string[];
  bodies: string[];
}

/**
 * Resolves a campaign's reusable subject/body content. Decoupled lists win
 * when present (that's what new campaigns store); legacy variant rows are the
 * fallback. Everything is trimmed and empties dropped, so what this returns
 * can be dropped straight into the create form's Subject lines / Bodies state
 * — identical to what the user typed by hand.
 */
export function campaignTemplateContent(c: TemplateSourceCampaign): CampaignTemplateContent {
  const subjects = (c.subjects ?? [])
    .map((s) => (s ?? "").trim())
    .filter((s) => s.length > 0);
  const bodies = (c.bodies ?? [])
    .map((b) => (b ?? "").trim())
    .filter((b) => b.length > 0);
  if (subjects.length > 0 || bodies.length > 0) {
    return { subjects, bodies };
  }
  const variants = (c.variants ?? [])
    .map((v) => ({
      subject: (v.subject ?? "").trim(),
      bodyHtml: (v.bodyHtml ?? "").trim(),
    }))
    .filter((v) => v.subject.length > 0 && v.bodyHtml.length > 0);
  return {
    subjects: variants.map((v) => v.subject),
    bodies: variants.map((v) => v.bodyHtml),
  };
}

/**
 * True when the campaign holds BOTH at least one subject and at least one
 * body — i.e. saving it as a template yields something immediately usable in
 * the create form (which requires both). The row button's enabled state, the
 * "My templates" optgroup filter and applyTemplate's no-op guard all use this.
 */
export function hasTemplateContent(c: TemplateSourceCampaign): boolean {
  const { subjects, bodies } = campaignTemplateContent(c);
  return subjects.length > 0 && bodies.length > 0;
}
