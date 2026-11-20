# TASK_151 — Campaign recipient picker: multi-term include AND multi-term exclude

**Status: SCOPED 2026-10-01. Not started. Two sub-tasks (R1, R2), both live-app, both in one file plus one route.**
**Owner's words:** *"in email filtering during campaign creation, I want to be able to exclude some emails, not only filter with one email, also want to be able to filter multiple and exclude multiple from the list."*

---

## 1. What exists today (verified, file:line)

The recipient picker is **"Pick from my leads"** in the campaign builder.

| Fact | Where |
|---|---|
| Filter is **one** free-text box + one job dropdown | `app/dashboard/campaigns/page.tsx:1385-1398` (job `<select>`), `:1399-1408` (single `pickerSearch` input) |
| The single search is **substring-either**, across three fields | `app/dashboard/campaigns/page.tsx:413-425` |
| `visibleLeads` is the **only** filter step | `page.tsx:414` |
| Selection is a lead-id list | `page.tsx:250-254`, `toggleLead` / `selectedLeadIds` |
| **Bulk buttons act on `visibleLeads`** | `selectAllVisible` `:432-436`, `selectNoneVisible` `:438-442` |
| A full reset already exists | `selectNoneAll` `:451-453` (added 2026-09-27 for "stuck on the full verified total") |
| Data source is validated leads only | `GET /api/leads/selectable` |

So the gap is precise: **there is no way to include by more than one term, and no way to exclude anything at all.**

## 2. The trap that makes this more than a UI change

`selectAllVisible` adds **everything currently visible**. Today "visible" cannot be negative, so select-all can only ever *over*-select in ways the user can see. The moment an **exclude** term exists, the two interact:

- If exclude only hides rows, but `selectAllVisible` is run *after* an address was already selected, that address stays selected and **will be sent to**. The exclude control would be cosmetic — the exact failure mode this project has hit repeatedly (the dead `P2003` check, the cosmetic admin Cancel).
- Therefore: **excluding must prune the existing selection**, not just the view. `R2` below requires this explicitly and requires an assertion that proves it.

## 3. Work order

### R1 — Multi-term include (+ keep the single box working)
1. Replace the single `pickerSearch` with an **include** control that accepts **multiple** terms.
   - Comma- and newline-separated entry is the minimum; chips/removable tokens are preferred.
   - Semantics: a lead matches if **ANY** include term matches (OR), matching the current case-insensitive substring behaviour across email / businessName / contactName.
   - With zero include terms, behaviour must be **identical to today** (no term = show all in the job).
2. Keep the job `<select>` composing with it (job AND include) — do not make them mutually exclusive.
3. Show the active terms as removable chips, and a live count.

### R2 — Multi-term exclude, and it must PRUNE
1. Add an **exclude** control taking **multiple** terms, with the same matching rule as R1.
2. Exclusion is applied **after** include: `visible = (job) AND (include) AND NOT (exclude)`.
3. **Excluding prunes the selection.** Any `selectedLeadIds` entry whose lead is now excluded must be removed from the selection, so a subsequent "send" cannot reach it. This is the deliverable, not a nicety.
4. **Server-side guard, same rule.** `selectAllVisible` is a client convenience; the send path must not be reachable with an excluded address by a crafted request. Confirm how the send path resolves recipients and add the guard where the selection is actually consumed — do NOT rely on the picker alone. If the send path already resolves strictly from `selectedLeadIds` that the server re-validates, say so and show it; if not, add the check.
5. The exclude count must be visible ("12 excluded") — a silent exclude is indistinguishable from a broken filter.

### Out of scope (say so in the report; do not build)
- A **persistent, cross-campaign suppression list** ("never mail this address again, ever"). That is a different feature with a different consent story and needs its own task. If the owner wants it, it is a follow-up.
- Changing the validated-leads-only rule (`/api/leads/selectable`).

## 4. Acceptance / evidence

- Create the failing condition on a scratch DB: ≥10 leads where 3 share a domain, one of which you intend to exclude.
- **R1**: paste raw before/after row counts for 2 include terms (prove OR, not AND), and prove one term still behaves exactly as today.
- **R2**: paste raw counts proving the excluded address is gone from the rendered list **and** from the selection total (the number in the "N recipients selected" line at `page.tsx:1425`), not just from the view.
- The pruning assertion must be shown **failing** against the un-pruned version and passing after — a check that cannot fail is not evidence.
- Compose: job × include × exclude together, one raw count.
- `npx tsc --noEmit` clean; `npx tsx --test tests/*.test.ts` no new failures; paste the tallies.
- If you add unit tests, add them to `tests/` and add the `test:*` script per house convention.

## 5. Constraints
- **One file for the UI** (`app/dashboard/campaigns/page.tsx`) plus the one send-path route. Anything else, stop and log it.
- Do not regress the 2026-09-12 fix (the "job with 0 valid leads" explanatory message at `page.tsx:1427-1441`) or the 2026-09-27 `selectNoneAll` reset (`:451-453`).
- Do not reorder or rename the bulk buttons' semantics — "Select all in this session" must still mean *visible*.
- Live app only; push to `main`; stage by explicit path.
