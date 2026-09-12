# Task 29 — Picker fixes, recipient control, and real spam-placement checking

**Status: ready for Cline, after Task 28.** Grounded in live-testing feedback (2026-09-12) plus a fresh read of the actual deliverability code (`lib/deliverability.ts`, `lib/seed-mailbox.ts`, `lib/imap.ts`, `SeedMailbox`/`DeliverabilityCheck` in `prisma/schema.prisma`), which turned out to already do more than earlier planning docs assumed: a real SMTP-send + IMAP-poll-confirms-arrival gate already exists (`POST /api/campaigns/[id]/test-send`), it just only checks `INBOX` on one platform-owned mailbox. This doc is six mostly-independent items — do them in the order below, but 1-3 are small and can ship together fast; 4-6 are the bigger piece and deserve their own careful pass.

---

## 1. Fix the picker's confusing labels (quick)

`app/dashboard/campaigns/page.tsx` lines ~608-615: "Select all visible (156)" and "Select all valid across everything (1657)" read like a pagination distinction when they're actually **this session vs. every session**. Relabel:
- `Select all visible (…)` → `Select all in this session ({visibleLeads.length})`
- `Select all valid across everything (…)` → `Select all valid, every session ({pickerData.leads.length})`

No logic change — `selectAllVisible()`/`selectAllValid()` already do the right thing, this is copy only.

## 2. Fix the automation "uploaded lead list" not loading, and support multiple lists

`app/dashboard/automations/page.tsx`'s `loadAll()` fetches `/api/jobs` once in a mount-only `useEffect` (line ~130-133). If a user uploads a list on the Extract page and then opens the Automations page (or the "New automation" modal) without a full page reload, `uploadJobs` is stale/empty — this is the reported "doesn't load the list" bug. Fix: call `loadAll()` (or at least refetch `/api/jobs`) when the "New automation" modal opens, not only on page mount.

Separately — and this is a real missing feature, not just the bug above — `CampaignAutomation.personalListId` is a single `String?`, so only one uploaded session can ever be selected. Change to `personalListIds String[]` (Prisma migration, additive), update:
- `app/dashboard/automations/page.tsx`'s picker to a multi-select (checkboxes, matching the Extract page's own multi-session merge UI convention) instead of a `<Select>`.
- `lib/automation-run.ts`'s `resolveRunRecipients()` equivalent for `personal_list` runs to pull validated leads from *all* selected `SearchJob` ids, deduping by email across them the same way it already dedupes within one job.
- `app/api/automations/route.ts`/`[id]/route.ts`'s create/edit validation to accept the array.

## 3. Let a user insert an ad-hoc recipient into a campaign's queue at a chosen position

New ask: from the Campaigns picker (or the campaign detail view once created), let a user type a single email address and choose where it lands in the send order — "at the top," "after position N," or "every Nth recipient" (the last form matters most once item 4-6's batch-checking lands, since it's how a user drops their own test mailbox into the middle of a real run to eyeball it live).

Minimum viable version: a text input + a position selector (`top` | `position N` | `every N`) that inserts a synthetic recipient row into `buildQueueItemRows`'s output before `createMany` runs — `lib/campaign-recipients.ts` already assigns `mailboxId`/`variantId` per row by index, so an inserted row just needs to go through the same assignment, not bypass it. Store it as a normal `EmailQueueItem` (no schema change needed) with a `source: "manual_insert"` marker if useful for the run-detail UI to label it distinctly from extracted/uploaded/picked leads (check whether `EmailQueueItem` already has a place for this or needs one small column).

## 4. Decouple subject and body rotation

Today a `CampaignVariant` is a subject+body **pair** — rotation picks one pair per recipient. Change to two independent lists (subjects, bodies) that each rotate on their own index, cross-combined per recipient (recipient *i* gets `subjects[i % subjects.length]` + `bodies[i % bodies.length]`, not tied together) — this multiplies effective variety without requiring the user to write every subject×body combination by hand. This does touch the campaign-builder UI (`app/dashboard/campaigns/page.tsx`'s variant editor) and `lib/campaign-recipients.ts`'s `buildQueueItemRows` — check with the user before landing this if the cross-combination framing above isn't actually what they meant by "rotate the body as well"; it's a reasonable read of the ask but wasn't spelled out in detail.

**Explicit fallback, owner-specified 2026-09-12**: rotation is per-dimension and only applies where a dimension actually has more than one entry — a single-item list is never an error, it's just held constant while the other dimensions still rotate. Concretely, for each dimension independently (mailboxes, subjects, bodies): if `list.length <= 1`, every recipient gets `list[0]` (or the single mailbox); only if `list.length > 1` does `i % list.length` actually vary across recipients. This generalizes cleanly to mailboxes too (a campaign with one SMTP mailbox and 3 subjects/3 bodies should rotate subjects and bodies normally while every send goes out from that one mailbox — check `lib/campaign-recipients.ts`'s existing mailbox-rotation math already behaves this way for the single-mailbox case, since `i % 1 === 0` is already a degenerate no-op, but confirm rather than assume once subjects/bodies are split into independent lists alongside it).

---

## 5-6. Real spam-placement checking — the bigger piece

### The decided scope (owner's call, 2026-09-12)

Hybrid, not all-automated and not all-manual:
- **Where the IMAP server supports it** (works generically — see below, not Gmail-only), automatically detect whether a test message landed in Inbox or Spam/Junk and gate on that.
- **Where it can't be detected** (provider doesn't expose it, or the user is testing against a plain SMTP-only account with no IMAP access), fall back to human-in-the-loop: the user checks a real inbox themselves and clicks Continue / Try a different subject.
- **Users can register their own test account** (their own Gmail, or anything else with IMAP access) as an alternative to the platform's shared seed mailbox — because a user's own Gmail may filter differently than the platform's, and because they may be sending to non-Gmail recipients they want their own signal on.

### 5. Schema + per-user seed/test mailboxes

`SeedMailbox` (`prisma/schema.prisma` ~line 164) is currently a single platform-wide row with no `userId` — its own comment already anticipated more rows ("the model already supports N"), it just needs the ownership column:

```prisma
model SeedMailbox {
  // ...existing fields unchanged...
  userId String? // null = platform-shared seed (today's default); set = a user's own registered test account
  user   User?   @relation(fields: [userId], references: [id])
}
```

Add a "Test mailbox" section to the Mailboxes tab (`components/mailboxes-panel.tsx`) — separate from sending mailboxes, same host/port/username/app-password form, calling a new `POST /api/test-mailboxes` that encrypts the password the same way `lib/mailbox-crypto.ts` already does for sending mailboxes and creates a `SeedMailbox{ userId: session.userId }` row. A user with no test mailbox registered keeps using the platform default (`ensureSeedMailbox()` / `SeedMailbox.findFirst({ active: true, userId: null })`) exactly as today — this is additive, the existing flow for every current user doesn't change until they opt in.

`DeliverabilityCheck` needs one more column: `landedIn String?` (`"inbox" | "spam" | "unknown"`) — `"unknown"` is what a check reports when spam-folder detection isn't possible for that mailbox's provider, which is exactly the signal the UI uses to decide whether to show "Continue" automatically or ask the user to eyeball it.

### 6. Extend `pollSeedMailbox` to check the Spam/Junk folder too

`lib/imap.ts`'s `pollSeedMailbox()` only ever locks `"INBOX"` (line 54). Extend it to, after checking INBOX and not finding the token there, also check for a spam-equivalent folder:

- **Preferred, provider-generic approach**: use `client.list()` (imapflow) to enumerate folders and find one flagged with the IMAP SPECIAL-USE attribute `\Junk` (RFC 6154 — Gmail, Outlook, and most modern IMAP providers advertise this correctly; verify imapflow's exact API surface for reading special-use flags off `list()` results against its docs before assuming the property name). This is what makes the check work for Gmail AND other providers with the same code path, not a Gmail-specific hardcode.
- **Fallback when special-use isn't advertised**: try common literal folder names (`"[Gmail]/Spam"`, `"Spam"`, `"Junk"`, `"Junk E-mail"`) — best-effort, and if none of them exist/authenticate, report `landedIn: "unknown"` rather than failing the whole check.
- Return shape becomes `{ found: boolean; landedIn: "inbox" | "spam" | "unknown"; messages: string[]; error?: string }`. `runTestSend()` in `lib/deliverability.ts` passes this through into `DeliverabilityCheck.landedIn`.

### Batch-gate behavior (ties 3, 5, 6 together)

On a campaign, let the user set a batch size (default something sane, e.g. 50) alongside the existing `rotateEvery` field. The mail-queue drain (whatever currently reads `EmailQueueItem` rows and sends them — locate the existing drain route/service, likely `app/api/internal/mail-queue-drain/route.ts` per `deploy/mail-queue-drain.service`) pauses after each batch and:
- If the campaign's designated test mailbox (`SeedMailbox` — platform default or the user's own) can be automatically checked (item 6): re-run a `runTestSend`-style check against it. `landedIn: "inbox"` → auto-continue to the next batch. `landedIn: "spam"` → pause the campaign, notify the user (reuse `lib/email.ts`'s `sendEmail`, same as Task 28's item 4 alert), and let them choose Continue-anyway / Switch to a different subject-body pair (picks the next entry from item 4's subject list) / Stop.
- If `landedIn: "unknown"` → always pause for a human check, same UI as the "spam detected" case above, but phrased as "we couldn't verify automatically — please check the test inbox and confirm."
- This is the same use case item 3's "insert a recipient every Nth position" serves: a user can drop their own real address into the batch boundary itself, not just rely on the seed mailbox, and see it arrive in their own client.

**Explicitly build this at the Campaign/send-engine level, not inside the Automation orchestrator.** `lib/automation-run.ts`'s `processSendPhase()` already just calls `createCampaign()` and lets the normal campaign send/confirm machinery take over — the batch gate belongs in that shared machinery so both hand-built campaigns and automation-triggered ones get it automatically, with zero automation-specific code. This is the same "reuse, don't duplicate" discipline the rest of this project has followed (Task 26 Piece 4's REST-endpoint reuse, Task 27/28's `campaign-create.ts` unification) — don't special-case this inside automations.

---

## Sequencing recommendation

1. Items 1-2 (labels + automation list bug/multi-select) — smallest, ship first.
2. Item 3 (insert-recipient) — small, but useful groundwork for testing item 6 once it lands.
3. Item 4 (subject/body decoupling) — confirm the cross-rotation reading with the user before or during implementation if anything is ambiguous once Cline starts.
4. Items 5-6 (schema + per-user test mailboxes + spam-folder detection + batch gate) — the real work in this doc; build and verify against a real Gmail test mailbox before calling it done, the same "verify live, don't trust code-review alone" bar as every deliverability-adjacent piece in this project so far.

## Verification expected before calling this done

- `npx tsc --noEmit` / `npm run build` clean, as always.
- Item 2: confirm live — upload a list, immediately open Automations without reloading, confirm it now appears; confirm selecting 2+ uploaded sessions actually merges their leads (deduped) in a run.
- Item 6: confirm live against a real Gmail test mailbox — deliberately trigger a message that Gmail spam-filters (e.g. an obvious cold-outreach phrase) and confirm `landedIn` correctly reports `"spam"`, not just `"inbox"` on a clean test. A check that only ever reports "inbox" hasn't actually proven the spam-folder path works.
- Report per-item like Task 28, not a single "done" — these are 6 separable pieces of real product surface.
