# TASK_150 — Campaign batch-gate, mid-send edits, and extractor filter + dedupe

**Status:** OPEN — assigned, not started.
**Phase 1 (extractor, T1–T2)** may start immediately.
**Phase 2 (campaigns, T3–T6)** is **BLOCKED** until the agent holding uncommitted
changes in `lib/deliverability.ts` commits them — see §7.

**Repo:** `/Users/mikeolab/spaceworker`, branch `main` — the LIVE app.
This is **not** the self-hosted line (`/Users/mikeolab/sw-selfhost`).

**Numbering:** this is **TASK_150**. Not `TASK_15*` (an unrelated
`TASK_15_STALL_DETECTION_SPEED_AND_STOP_STATUS.md` exists). `TASK_145` is already
claimed in code comments by the in-flight merge-vars work
(`lib/deliverability.ts:57`, `:263`), so 145–149 are left to it.

**Touches (expected):**
- **Phase 1:** `app/dashboard/extract/page.tsx`,
  `app/api/internal/dispatch/route.ts`, `app/api/jobs/[id]/validate/route.ts`,
  `app/api/jobs/[id]/leads/delete-duplicates/` (new), `prisma/schema.prisma`
  + one additive migration, `tests/lead-dedupe.test.ts` (new)
- **Phase 2:** `app/api/internal/mail-queue-drain/route.ts`,
  `lib/deliverability.ts`, `app/api/campaigns/[id]/mailboxes/` (new route),
  `app/api/campaigns/[id]/route.ts`, `app/api/campaigns/[id]/test-send/route.ts`,
  `app/api/campaigns/[id]/test-recipient/route.ts`, `lib/test-target.ts`,
  `app/dashboard/campaigns/[id]/page.tsx`, `app/dashboard/campaigns/page.tsx`

---

## 1. What the owner reported

1. Campaign, "use my test email" selected: the **first batch completes, then the
   campaign goes back to auto send checking and reports a deliverability error**,
   instead of offering the manual test for the next batch "as it did before".
2. He wants to **edit a campaign while it is sending** — take a mailbox out of the
   sending, and change the test email. He believes the test-email edit already
   exists during a send.
3. He wants **multiple test emails**, with the choice of sending a test to **all**
   of them or to a **selected subset**.
4. Extractor: the **"filter by domain" control covers the whole screen**; it should
   show a little with expand, or be a dropdown.
5. Extractor: **selecting a domain does nothing** — there is no trigger for the
   filter.
6. Extractor: **the same emails come back every session.** Already-collected
   addresses should be skipped, and clicking **Validate emails** should also check
   against previously saved leads and remove the repeats, "so users have clean
   leads every session".

---

## 2. Verified root causes (senior, established before assignment)

### 2.1 Domain filter cannot filter the list — CONFIRMED (design gap, not a regression)

Task 54 built the chips as an **export-time-only** filter, deliberately:

- `app/dashboard/extract/page.tsx:235-236` — *"export-time-only domain filter …
  Selection is NOT a DB [filter]"*
- `:1501-1504` — *"Selecting some narrows the export links below via `?domains=`.
  Never mutates rows"*
- `domainSuffix()` (`:67-72`) only appends `&domains=` to export URLs.

The rendered list never consults it — `visibleLeads` (`:1648-1650`) branches **only**
on `resultMode`:

```js
const visibleLeads = mode === "emailsOnly"
  ? selectedJob.leads.filter((lead) => lead.email)
  : selectedJob.leads;
```

So the owner is describing the control exactly as built: it narrows exports, and
nothing else. **This is a feature gap, not a broken feature.** The fix is to apply
the selection to the view as well, keeping the export behaviour.

The "covers the whole screen" half is `DomainsFilterChips` (`:74-134`): it renders
`domains.map(...)` as a wrapping row of chips for **every** distinct domain, with no
cap and no collapse (`:115-131`).

### 2.2 Repeated emails across sessions — CONFIRMED (constraint scope)

Uniqueness is **per job** (`prisma/schema.prisma`, `model Lead`):

```
@@unique([searchJobId, sourceUrl, email])
```

Two sessions are two `SearchJob`s, so the same address is legitimately stored twice,
and extraction has no knowledge of previous sessions. A documented trap sits in the
same area — `app/api/leads/upload/route.ts:91-100`: `skipDuplicates` does **not**
collapse rows whose `sourceUrl` is NULL, because SQL treats every NULL as distinct.
Any dedupe written must not rely on the constraint for NULL-`sourceUrl` rows.

Prior art already exists and should be reused, not reinvented:
`app/api/jobs/merge/route.ts:110-140` dedupes by email across jobs.

`POST /api/jobs/[id]/validate` (`route.ts:39-46`) only touches
`validationStatus: "unchecked"` leads of **that one job**, so it can never see a
repeat from an earlier session.

### 2.3 The batch gate in manual-test mode — CONFIRMED mechanism (a). (b) RULED OUT

Owner symptom: first batch done → auto send checking → "deliverability error",
no manual test for the next batch.

**Ruled out (b):** the drain *does* pass the human target to the probe —
`app/api/internal/mail-queue-drain/route.ts:396` sends
`overrideRecipient: c.testRecipientOverride`.

**Confirmed (a):** in override mode `landedIn` is **always** `"unknown"` by design —
`lib/deliverability.ts:70-71` (*"landedIn always stays 'unknown' (never
auto-verified 'inbox'), which is what keeps the batch gate pausing on every batch
for this mode"*) and `:143-144` (*"Stays 'unknown' for the whole override-recipient
path — there's no mailbox to poll"*). But the drain computes:

```js
// app/api/internal/mail-queue-drain/route.ts:402
const safe = probe.landedIn === "inbox";     // always false in override mode
...
if (safe) continue;                          // :446  — never taken
await tx.emailCampaign.update({ data: { status: "paused_deliverability" } });  // :463
```

So in override mode the batch gate **can never be satisfied**: every batch ends in a
pause, by construction. The owner reads that pause as a failure because of its copy —
the pause notification says the check *"could not be verified to have reached the
inbox"* (`:475`), and the pause is surfaced as a red `paused_deliverability` state
(`app/dashboard/campaigns/[id]/page.tsx:162`).

Two further facts the fix must respect:

- The **"last batch ≠ pause"** guard already exists (`drain:373-376`, `stillQueued`)
  and must **not** be re-added or removed. Do not undo commit `37d8408`.
- TASK_144 already fixed the *display* honesty for override sends — the UI now shows
  `sent — not auto-verified` in amber (`campaigns/[id]/page.tsx:1571`). The **drain's
  pause notification still uses failure wording**, so the two surfaces disagree.
  Reuse TASK_144's neutral wording rather than inventing new copy.

The requirement is therefore **not** "make the gate pass". It is: in manual-test mode
the batch boundary must be an explicit **human-confirm step**, presented as *your
turn*, offering the manual test for the next batch — never as an automatic check that
concludes failure.

### 2.4 Removing a mailbox mid-send is a no-op — CONFIRMED

Queue items are **pinned to a mailbox when the campaign is created**
(`prisma/schema.prisma`, `model EmailQueueItem`: `mailboxId String` required + FK;
its own comment says *"Assigned at queue-creation time via round-robin across the
campaign's mailboxIds (true in-run rotation lives here, not in the drain route)"*).

The drain selects by that pinned id and **never checks the campaign's mailbox list**
(`app/api/internal/mail-queue-drain/route.ts:132-137`):

```js
where: { mailboxId: mailbox.id, status: "queued",
         campaign: { status: "sending" }, ... }
```

So editing `campaign.mailboxIds` alone changes nothing — the removed mailbox keeps
draining its own items. Today the edit is also blocked outright:
`app/api/campaigns/[id]/route.ts:129` returns 409 while
`status === "sending" || "paused_deliverability"`.

### 2.5 Multiple test emails — the pool already exists; this is plumbing

`EmailCampaign.testRecipientPool` exists, `MAX_TEST_RECIPIENTS = 20` and the
add/remove/normalise logic exist (`app/api/campaigns/[id]/test-recipient/route.ts:34-62`),
and the shortlist UI exists (`campaigns/[id]/page.tsx:999-1027`) — but it is
**single-active**: each row's button sets `testRecipientOverride` to that one address
and tests only it. A test send passes exactly **one** `overrideRecipient`
(`app/api/campaigns/[id]/test-send/route.ts:151`). So "all or a chosen subset" is
new plumbing on top of an existing concept, not a new concept.

### 2.6 Changing the test email mid-send — SUSPECTED: UI offers it, API refuses

`test-recipient/route.ts:72` returns **409** when
`status === "sending" || status === "done"`, while the campaign detail page renders
the test-setup panel during a send. That would be the same class of defect as the
mailbox bug: **a control that is offered and then silently refused.** Confirm whether
the panel is actually rendered/clickable while `sending`, and whether the POST 409s.
If confirmed, note that this route is safe to open up: its own header comment
(`:19-22`) says it is *"deliberately separate from everything a real send reads — so
none of this experimenting can leak into the live send."*

---

## 3. Work items

One agent, one item, one session. Acceptance is per item; a static tick alone will be
bounced (see §5).

### T1 — Domain filter actually filters, compactly (extractor, UI only)
- Apply the **same** `filterDomains` selection to the rendered list, at the one place
  `resultMode` is applied (`extract/page.tsx:1648`), so the table, the row count and
  select-all all agree. One source of truth — not a parallel filtered array.
- Keep the existing export behaviour (`domainSuffix`, `?domains=`) working off the same
  selection so the two can never disagree.
- Make the picker compact: collapsed by default (a few domains + a "+N more" count),
  expandable, or a dropdown. It must **not** cover the lead rows at any width.
- Selecting applies **immediately**; clearing restores the list; show the active
  filter as a removable chip.
- Must compose with "Emails only" mode.

**Acceptance:** run it, pick a domain, paste before/after row counts proving only that
domain renders; clear it and paste the count returning; prove the two filters compose;
prove export URLs still carry `?domains=` for the same selection.

### T2 — Repeated emails are marked, and validation also cleans them (extractor)
- **Mark, never delete.** A lead row can be referenced by campaigns and exports.
  Additively: `Lead.duplicateOfId String?` (the earlier lead this one repeats) and a
  **new** `validationStatus` value `"duplicate"`. **Never** overload `"invalid"` —
  that means the MX check failed, and conflating them silently corrupts the owner's
  invalid count.
- Compare **case-insensitively on the trimmed email**, scoped **per user across ALL
  that user's jobs** (per job is the bug). Add `@@index([userId, email])` for it.
- Run it at **extraction/persist time** (`app/api/internal/dispatch/route.ts:294`,
  `:307`, `:347`) **and** in `POST /api/jobs/[id]/validate`, so a new session comes
  back clean rather than only being cleaned when the owner clicks Validate.
- Keep `/validate`'s response contract — the UI reads `{valid, invalid, validated,
  skipped}`. **Add** fields; do not repurpose them.
- New route `app/api/jobs/[id]/leads/delete-duplicates`, modelled on the existing
  `delete-invalid` route, refusing any lead referenced by a campaign.
- UI: a Duplicate pill, a **"Hide duplicates" toggle defaulting on**, and a count,
  following the existing pill markup (`extract/page.tsx:1690-1707`).
- **Out of scope:** making the *worker* skip crawling addresses it already has. That is
  a worker-side contract change in a different repo. Do not touch the worker.

**Acceptance:** create the failing condition on a scratch DB (two jobs, same address):
prove pre-fix both rows exist, post-fix the later is flagged, is **not** counted
invalid, and hides; prove a NULL-`sourceUrl` repeat is also caught; prove a genuinely
new address is not flagged; prove the MX valid/invalid counts are unchanged.

### T3 — Manual-test mode pauses as *your turn*, not as a failure (campaigns)
- At a batch boundary in **override mode**, stop running an automatic probe that can
  never be verified and then reporting it as a failure. Present the boundary as a
  human step: the test has been sent / is ready, **check your inbox, then run the
  manual test or continue the next batch**.
- Copy must be neutral and consistent with TASK_144's existing `sent — not
  auto-verified`; the drain's pause notification (`drain:475`) currently says the
  opposite and must change.
- Keep the pause state `paused_deliverability` so
  `app/api/campaigns/[id]/deliverability-decision` keeps working unchanged. **Do not
  invent a new status**, and do not touch the initial `pending_test_confirm` gate.
- **Never auto-continue** — the safety net stays; only its framing changes.
- Never silently fall back from manual to the seed-mailbox path. State which mode the
  next gate will use.
- Do **not** modify the `stillQueued` guard (`drain:373-376`).

**Acceptance:** a multi-batch campaign in override mode: paste the batch-by-batch
status transitions showing each boundary is a human-confirm step, that no batch is
reported as a failed check, and that the last batch ends at `done` (not paused).

### T4 — Remove a mailbox from an ONGOING send (campaigns)
- Add a **dedicated** route (`app/api/campaigns/[id]/mailboxes`, new) rather than
  loosening the all-fields PATCH guard at `campaigns/[id]/route.ts:129`. The existing
  409 semantics are depended on elsewhere; do not weaken them.
- On removal, in one transaction, reassign that mailbox's `status:"queued"` items
  round-robin across the remaining mailboxes. **No capacity maths is needed** — the
  drain already caps per tick by each mailbox's remaining `dailyLimit - sentToday`
  and simply leaves the rest queued. Do not invent a second scheduler.
- Never touch sent items or their history. Never leave `mailboxId` null (FK).
- If every mailbox is being removed, **refuse** with a clear message rather than
  orphaning the queue.
- Make the drain defensive: skip a queued item whose mailbox is no longer in its
  campaign's `mailboxIds`, so a race cannot send from a removed mailbox.
- UI: show how many queued items will move and where, and confirm before applying.

**Acceptance:** on a sending campaign over 2+ mailboxes, remove one mid-send and paste
raw DB output proving no further item is sent from the removed mailbox and that every
item either moved or stayed queued — none lost, none double-sent; plus the
last-mailbox refusal.

### T5 — Multiple test emails: all, or a chosen subset (campaigns)
- Let one test send target **all** pool members or a **selected subset**, keeping the
  existing single-active behaviour working for callers that pass one address.
- Persist the selection (additive, nullable) so a reload keeps it. Do not add a second
  competing store of the same data.
- Fan out **serially** with the existing human-paced stagger
  (`test-send/route.ts:146-150`, 3–7s). **Never `Promise.all`** for recipients — the
  file's own comment explains that concurrent sends read as a blast.
- One address failing must not abort the others; report per-address outcomes.
- UI: multi-select with all/none shortcuts, showing how many will be sent.

**Acceptance:** send to 3 pool addresses; paste per-address outcomes; prove one
invalid address fails alone without stopping the other two.

### T6 — Confirm and, if needed, fix changing the test email mid-send (campaigns)
- Confirm the §2.6 hypothesis first (rendered while sending? does it 409?).
- If confirmed, allow test-settings changes during `sending` / `paused_deliverability`.
  This cannot affect real sends by construction (see the route's own header comment).
- Do not rebuild this feature if it works — say so and move on.

**Acceptance:** either the confirmed fix with raw before/after HTTP evidence during an
active send, or a clearly stated "already works" with the evidence that shows it.

---

## 4. Non-negotiable rules

- Live app only. Push to `main`. Nothing here goes to the self-hosted branch.
- **Do not touch the in-flight work listed in §7.** Stage only your own files by
  explicit path. **Never `git add -A` / `git add .`**.
- Never edit `.env`.
- No `prisma migrate` / `db push` against a shared or live database. Use a scratch DB,
  confirm the target with `grep '^DATABASE_URL' .env`, and drop it when done.
- Schema changes are **additive and nullable-safe**, shipped as a migration.
- **Mark, do not delete** lead or queue rows to make a count look right.
- **Never edit a file under `src-tauri/target/`** — it is gitignored build output that
  contains stale *copies* of app source (e.g.
  `src-tauri/target/release/_up_/exe/runtime/standalone/lib/deliverability.ts`,
  183 lines vs the real 231). A grep for `probeCampaignPlacement` returns 4 hits and
  only `lib/deliverability.ts:231` is the live one.
- Do not touch `lib/campaign-message.ts`, `lib/test-target.ts` semantics, or the
  `EmailQueueItem`/`Lead` fields you were not asked to change.

---

## 5. Evidence standard

- Every claim of a fix needs **raw** output pasted: DB rows, HTTP responses, counts —
  before **and** after. No "works as expected", no paraphrase.
- A check that cannot fail is not evidence. Where a guard is added, show it firing.
- Always **create the failing condition** first — this repo's dev DBs are thin, so the
  bug is invisible until reproduced.
- State explicitly what you could **not** verify.
- Report per item: confirmed root cause (file:line), files + line ranges changed, raw
  evidence, commands run, unverified items, commit SHA.

## 6. Decision log

| # | Decision | Why |
|---|---|---|
| D1 | Domain filter becomes **view + export**, one selection | The control exists and is correct for exports; the owner expects it to filter the view. Two selections could disagree. |
| D2 | Dedupe **marks** (`duplicateOfId` + `validationStatus:"duplicate"`), never deletes | Leads are referenced by campaigns/exports. Overloading `"invalid"` would corrupt the MX-based counts. |
| D3 | Dedupe scope **per user across all jobs**, case-insensitive | Per-job scope *is* the reported bug. |
| D4 | Worker-side "don't crawl it twice" **out of scope** | Different repo/deploy; app-side persist+mark delivers the owner-visible result now. |
| D5 | Batch boundary in manual mode = **human-confirm step**, status stays `paused_deliverability` | The gate can never be satisfied in this mode; existing decision route and UI depend on the status. |
| D6 | Mailbox removal gets a **dedicated route**, PATCH guard untouched | Avoids relaxing an in-flight guard other surfaces rely on. |
| D7 | Reassignment does **no capacity maths** | The drain already caps per tick by remaining `dailyLimit`; a second scheduler would be a bug farm. |
| D8 | Test-send fan-out stays **serial** with the existing stagger | The file documents why; concurrent recipients read as a blast. |

## 7. BLOCKER — another agent's uncommitted work

At assignment time, uncommitted in this working tree:

```
 M app/dashboard/campaigns/page.tsx
 M lib/deliverability.ts          <-- T3 must edit this file
 M lib/render-merge.ts
 M package.json
?? lib/test-merge-vars.ts         <-- UNTRACKED, but imported by the tracked file above
?? tests/render-merge.test.ts
```

`lib/deliverability.ts:8` — a **tracked** file — now imports `./test-merge-vars`
(untracked). A partial commit by that agent would break `main`'s build.

**Therefore: do not begin T3/T4/T5/T6 until the coordinator confirms that work is
committed.** T1/T2 are unaffected and are the intended starting point.
