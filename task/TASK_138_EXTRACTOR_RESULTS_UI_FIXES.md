# TASK_138 — Lead Extractor results UI: domain filter + list sizing

Owner report, 2026-09-28/29 (two related complaints on the extraction results
view, both web `/dashboard/extract` and the desktop EXE's local extractor):

> "the filter by domain during the lead extractor when its done, doesn't do
> anything, I clicked a domain, it only highlighted, no button to filter or
> do any other action, and also the list is just occupying space, add a drop
> down for users or add a scroll or both so users can see the leads well."

Do this BEFORE starting self-hosted Phase 5.

## Bug 1 — the domain filter looks broken (it isn't; it's silent)

`DomainsFilterChips` (`app/dashboard/extract/page.tsx:77`) and its EXE twin
`DomainsFilterChipsExe` (`app/dashboard/extract/local-extract.tsx:188`) are
real, working chip toggles — clicking one does update `filterDomains` state
(confirmed in code: `selected.includes(d) ? ... : [...selected, d]`) and the
chip's own highlight (`border-brand-500 bg-brand-500`) proves it. The bug is
that **selecting a domain has NO visible effect anywhere except inside the
"Export CSV" / "Emails only" download links' `?domains=` query string**
(`domainSuffix(filterDomains)`, `page.tsx` ~line 1517). The on-screen leads
table below is never filtered by this state at all — it always renders every
lead in `selectedJob.leads` regardless of what's selected.

So a user selecting a domain sees: a chip lights up, nothing else changes,
no button appears. That's not a broken feature, it's an export-time-only
filter with zero on-screen feedback — which reads as "does nothing."

**Fix**: make the chips also filter the on-screen table, not just the export
links. Concretely:
- Derive a `visibleLeads` (web) / equivalent (EXE) as
  `filterDomains.length === 0 ? selectedJob.leads : selectedJob.leads.filter(l => filterDomains.some(d => leadDomain(l.email, l.website) === d || leadDomain(...).endsWith(`.${d}`)))` —
  reuse the exact matching logic the export route already applies
  (`leadDomainExe` / the web's equivalent in `lib/leads.ts` or wherever
  `/api/jobs/[id]/export.csv?domains=` implements it — use ONE shared
  helper for both, don't fork the matching logic a third time).
- Render the table from `visibleLeads`, not `selectedJob.leads`, in both
  `page.tsx` and `local-extract.tsx`.
- Add a small "Showing X of Y leads" label next to the chips when a filter
  is active, so the effect is unmistakable even without scrolling to notice
  fewer rows.
- The export links keep using `filterDomains` exactly as today — no change
  needed there, this only adds the missing on-screen half.

## Bug 2 — the domain chip list (and long leads lists) just grow the page

Both `DomainsFilterChips` and `DomainsFilterChipsExe` render as a bare
`flex flex-wrap` row (`page.tsx:104`, `local-extract.tsx:214`) with no
`max-height`/scroll and no collapse — a run with many distinct domains (the
owner's screenshot showed 28+ terms / dozens of domain chips) pushes the
whole page down and makes the actual leads table hard to find below it.

**Fix** (either is acceptable, owner didn't specify which — pick whichever
is less invasive to ship first):
- **Option A (scroll)**: wrap the chip row in a fixed-height scroll
  container once the domain count passes a threshold (e.g. `domains.length
  > 12`): `max-h-24 overflow-y-auto` (or similar — match the existing scroll
  treatment already used elsewhere on this same page, e.g. `local-extract.tsx:1648`'s
  `max-h-[46vh] overflow-auto` pattern, for visual consistency).
- **Option B (dropdown)**: collapse to a single "Filter by domain (N)"
  button that opens a dropdown/popover listing the same toggleable chips —
  reuse the existing `Dropdown` component already used elsewhere on this
  page (`page.tsx` — see the "Actions" dropdown right next to where these
  chips render) instead of building a new popover primitive.

Either way: the fix must not remove the "Clear" affordance or the
multi-select toggle behavior — only change how much vertical space the list
takes before those still work.

## Verification

- `tsc --noEmit` + `eslint` on both touched files.
- Real functional check (not just visual): create/open a run with >15
  distinct domains, confirm selecting 1-2 domains narrows the on-screen
  table to only those leads (Bug 1) AND that the chip list itself no longer
  pushes the table off-screen (Bug 2). Do this on both `/dashboard/extract`
  (web) and the EXE's local extractor — they're separate components with
  duplicated logic, fixing one does not fix the other.
