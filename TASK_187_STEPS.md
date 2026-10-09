# TASK_187 STEPS — progress log (compaction insurance)

**Created 2026-10-08 (step 0, MANDATORY).** Update after EVERY step so a compaction cannot
lose progress. Scope doc: `TASK_187_PAYMENT_ALERTS_INVOICE.md` (S1–S5). Playbook binding:
`HOW_WE_MOVE_FAST.md` (§7 gates → §2/§3 deploy → §4 live evidence). Verification:
`PROMPT_VERIFY_TASK_187.md`.

## STATUS (updated 2026-10-08 — **TASK_187 DEPLOYED + LIVE-VERIFIED: commits A `c96c272` · B `874162f` · C `515c92e` pushed · box BUILD_ID `F5n788UVXZqaX0b5cFb-j` · e2e PASS 26/26 · NEXT: owner eyeball (TG×2 + inbox×2) + verifier `PROMPT_VERIFY_TASK_187.md`)**

- **TRACK:** TASK_185 holds only P5 + W9 now; N1+N2 live here as S1–S5.
- **HEAD:** `c96c272` = **COMMIT A** (pushed 2026-10-08: `lib/support-notify.ts` + both
  wired routes + `tests/support-tickets.test.ts`, 4 files/252+/3-, msg via
  `/tmp/commit-a-msg.txt` + `git commit -F`; msg body ends `gates: tsc 0, eslint 0,
  support 54/54, invoice 27/27, xdevice 38, wallet 63, module-gate 13, wrapper-cookie 6`;
  origin `442d938..c96c272`). Untracked: this steps file + stray
  `TASK_133_RMM_ENGINE_BRINGUP.md` (NOT ours — NEVER commit it).
- **HOUSE RULES:** never `git stash`; never edit `.env` (flag to owner); no live secrets in
  commits/docs (placeholders only); **money/invoice commits MUST be separate from UI
  commits**; multi-line commit msgs via `/tmp/*-msg.txt` + `git commit -F` (never `-m`);
  never shell-heredoc TSX (editor tool only); no local Postgres → write migration SQL BY
  HAND + `npx prisma generate` locally; gates (§7) before deploy (§3 migrate → §2 build).
- **NEXT ACTION:** **S3/S4 money code (COMMIT B)** — schema `PremiumInvoice.days` +
  hand-written migration `20261119000000_task187_invoice_days_thread_ref` +
  `npx prisma generate`; settle applies `days`; `invoice_sent` email type; wire
  `invoiceId` persistence into admin messages route (schema field already accepted);
  premium-invoice tests → commit B (money files ONLY) → then UI (composer + thread
  cards) → commit C → S5 gates/deploy (§3 migrate → §2 build) + live evidence.
  **S1 CLOSED:** `ADMIN_EMAIL=myrate619@gmail.com` set + restarted + tested
  (Resend id `01a11cbe-ddbb-70e5-a40e-8f74f76b0b6c`, health 200 on :3500 —
  the `:3400` in .env is NOT the service port, systemd uses `-p 3500`).
- **COMMIT B PUSHED 2026-10-08: `874162f`** (11 files, +792/−49; message via
  `/tmp/commit-b-msg.txt` + `git commit -F`; push `c96c272..874162f main`).
  Staged EXACTLY: schema.prisma, migration folder (migration.sql + LOCK.md),
  lib/invoice-notify.ts, lib/license-service.ts, lib/support/tickets.ts, both
  invoice routes, admin messages route, 2 test files. Strays excluded and
  still untracked: `TASK_133_RMM_ENGINE_BRINGUP.md` (NEVER commit),
  `TASK_187_STEPS.md` (commits at closeout). Post-commit `git log`: HEAD =
  `874162f`, tree clean of everything else. Commits in task: A=`c96c272`,
  B=`874162f`.
- **C1/C2 UI — DONE 2026-10-08.** Before-record (kept as written):
  C1 = admin
  composer in `components/admin/support-queue-panel.tsx`: fetch the ticket
  owner's open invoice (GET `/api/admin/users/[userId]/invoices` — needs
  `ticket.userId`, exposed by B7), show plan/amount/days/methods read-only
  selector, include `invoiceId` in the reply POST body (omit when none).
  C2 = invoice card renderer: admin thread + `components/support-widget.tsx`
  user thread — reads `message.invoice` (ThreadInvoiceView: id/plan/tier/
  amountUsd/status/methods/createdAt/paidAt — NO days, NO userId); Pay entry
  goes to `/dashboard/billing` where the existing submit flow lives. Gates:
  tsc / eslint / full battery / next build. Then commit C (UI + steps file).
  **AFTER record:** the abbreviated "read-only selector" sketch above was
  SUPERSEDED by the committed plan at `### Commit C` §C1 (full send-invoice
  composer) — the code implements §C1/§C2 verbatim:
  - **C1 done** — new state (`invoiceing/invPlan/invAmount(+touched)/invDays/
    invBtc/invTrc/invErc/invNote/invBusy/invError/priceDefaults`); a
    TICKET-keyed reset effect (deps `detail?.id, detail?.category`) closes the
    form, clears fields and re-infers plan (xdevice→premium_xdevice else
    plus) so a re-read after a reply does NOT wipe a half-typed invoice;
    `toggleInvoice` lazily GETs `/api/admin/wallets` once
    (webSubscriptionPriceUsd/xdevicePriceUsd prefill, touched-guard, fail-soft);
    `sendInvoice` = POST invoices → on 400-with-`invoiceId` PATCH that id
    (one-open-invoice rule) → POST messages `{body: note||default, invoiceId}`
    → re-read detail + notice; attach-failure keeps the form open with an
    explicit "Invoice saved, but attaching… failed" error (retry lands on the
    PATCH path — no duplicate). Client checks amount>0, integer days≥1
    (blank ⇒ key omitted), methods all-blank ⇒ omitted (server snapshot) /
    any-typed ⇒ full object blanks→null; every check re-validated server-side.
  - **C2 done** — NEW shared `components/support-invoice-card.tsx` (one
    renderer for BOTH sides, cannot drift): plan label from support-templates,
    `$amount`, status chip (open→"Awaiting payment", paid→"Paid", unknown→raw
    string), non-null methods rows with break-all addresses; `payHref` passed
    ONLY by the widget and ONLY when status==="open" → `/dashboard/billing`;
    type has NO `days` field (unrenderable by construction); malformed Json
    methods ⇒ zero rows, never a throw inside a thread. Panel `Message`
    += invoiceId/invoice, `TicketDetail` += userId; card renders under the
    body in both threads.
  - **Gates:** `tsc --noEmit` **0**; eslint 3 UI files **0** (removed one
    unused exhaustive-deps disable I had added — flagged, then deleted);
    `test:support` **57/57**; `test:invoice` **34/34**; xdevice **38** /
    wallet **63** / module-gate **13** / wrapper-cookie **6**, 0 fail;
    **`CI=true npm run build` exit 0** (compiled 24.1s, TS 41s, 127 pages).
    NOTE: plain `npm run build` FAILS locally on purpose — local `.env` holds
    `local_dev…`/`re_local_dev…` placeholders and `lib/env.ts:57` refuses to
    boot with them in PRODUCTION; the guard skips when `CI=true` (exactly
    `.github/workflows/deploy.yml`'s mode, per its comment) — that is the
    canonical full-build gate locally. Also: editor tool rejects new_text >
    6000 chars — split big inserts into anchored pairs (hit once, fixed).
- **COMMIT C PUSHED 2026-10-08: `515c92e`** (5 files, +1041/−16 —
  `components/support-invoice-card.tsx` (new), `support-queue-panel.tsx`,
  `support-widget.tsx`, this steps file, `TASK_187_PAYMENT_ALERTS_INVOICE.md`;
  msg via `/tmp/commit-c-msg.txt` + `git commit -F`; push `874162f..515c92e`).
  INCIDENTS: (a) heredoc `cat > /tmp/... <<EOF` silently failed under flaky
  shell integration → wrote the msg with the EDITOR tool instead; (b) `git add`
  and `git commit` issued as two commands in one call RACED (commit saw an
  empty index: "nothing to commit") → re-ran add+commit as ONE chained
  command. This steps file is NOW TRACKED (committed inside C) — every later
  edit rides the S5/closeout commit. `TASK_133_RMM_ENGINE_BRINGUP.md` still
  untracked, NEVER commit.
- **S5 DEPLOY — IN PROGRESS 2026-10-08 (before-record; box state read-only first):**
  - Box pre-state: `migrate status` = **103 applied, up to date** (newest
    `20261118000001_task184_payment_invoice_ref`; my `20261119000000_task187_…`
    NOT there yet); BUILD_ID `G-o2lqy1pCOcjJGcZ1N5o`; service was healthy when
    checked earlier today (S1). CI: **all 3 pushes `c96c272`/`874162f`/`515c92e`
    = build+typecheck success on GitHub Actions.**
  - **DEPLOY DECISION (reconciled §2 vs §3, same reasoning TASK_184 recorded
    and EXECUTED successfully TODAY):** §3's 2026-10-04 "VPS does NOT build"
    correction came from TASK_157's PARTIAL-tree state; shipping FULL trees
    first removes that failure mode, and A5 + TASK_184-B5 both proved the
    full-tree path today (build ✓ active ✓ 200 ✓ parity 0/0 ✓ e2e PASS).
    So: **A5-proven path**, in strict order:
    1. §2 full-tree rsync `app lib components tests prisma` (`--exclude='.env'`)
       + root files, then `chown -R trmm:trmm`
    2. `pg_dump` snapshot to `/root/spaceworker-t187-<ts>.sql.gz` (§6b: always)
    3. `sudo -u trmm npx prisma migrate deploy` (applies task187 migration;
       deploy-vps.sh does NOT run it) → **§6b drift diff must be exactly
       `-- This is an empty migration.`** (else filter `/days|invoiceid/i`)
    4. `scripts/deploy-vps.sh /tmp/deploy-root.txt` build half
       (generate → maintenance ON → build → restart → verify → maintenance OFF)
    5. verify: fresh BUILD_ID, `is-active`, localhost:3500 200, `migrate
       status` 104, §2a md5 parity on the 5 trees → 0 missing / 0 stale
    6. §4 live e2e (disposable `scripts/t187-s5-e2e.ts`, self-cleaning) = G5
  - **Fallback (never leave a clobbered `.next`):** if the box build dies with
    a module-not-found (partial tree), fix forward per §3 — `gh workflow run
    "Build & Deploy"` (`.github/workflows/deploy.yml` confirmed present, 412
    lines: CI build → tar → box extract → `migrate deploy` → restart).
- **S5 DEPLOY + LIVE E2E — DONE 2026-10-08 (AFTER record, every step evidence):**
  - **Ship:** §2 rsync of `app lib components tests prisma` +
    root `package.json HOW_WE_MOVE_FAST.md` (`--exclude='.env'`) →
    `chown -R trmm:trmm`; migration folder confirmed on box.
  - **Backup:** `pg_dump | gzip` → `/root/spaceworker-t187-20261009020437.sql.gz`
    (13,024,853 bytes).
  - **Migrate:** `sudo -u trmm npx prisma migrate deploy` applied
    `20261119000000_task187_invoice_days_thread_ref` → **104 migrations, up to
    date**; §6b drift diff = **exactly `-- This is an empty migration.`**
  - **Build half** (`scripts/deploy-vps.sh /tmp/deploy-root.txt`): env snapshot →
    runtime assert all ok → `prisma generate` → maintenance ON → `.next.prev`
    taken → build ✓ → restart → `active` + `localhost:3500 → 200` →
    maintenance OFF → `-- done`. **BUILD_ID `G-o2lqy1pCOcjJGcZ1N5o` →
    `F5n788UVXZqaX0b5cFb-j` (fresh)**; journal `✓ Ready in 231ms` +
    `[env-health] OK`; **https://spaceworker.top AND
    https://spaceworker.instaweb.top → 200** (first external probe hit
    `instaweb.top` — NOT this app's zone → 520; real `server_name`s found in
    `/etc/nginx/sites-enabled/`).
  - **§2a parity: 656 local = 656 remote → 0 missing / 0 stale / 0 extra.**
  - **Live e2e (§4): disposable `scripts/t187-s5-e2e.ts` on the box, real HTTP
    vs `localhost:3500` → `RESULT: PASS — 26 passed, 0 failed`:**
    ticket 201 + `admin_support_ticket` → **myrate619@gmail.com** (outcome
    sent) · admin reply → `support_reply` → user · invoice `days=45` stored,
    open, methods snapshotted, `invoice_sent` → user · attach → **card on BOTH
    sides, NO `days`/`userId` keys, amount 45/open** · submit no-hash →
    `admin_pending_payment` → **owner inbox (S1b LIVE PROOF)** · approve →
    paid + paidAt + **tier 5 + expiry = now+45d exactly (±5min)** + 2nd approve
    refused 400 · **cleanup residue 0/0/0/0/0, no cleanup errors**. Script
    deleted from both ends; 4 test-recipient email-log rows deleted with it;
    **owner-inbox NotificationLog rows KEPT as audit evidence (4 ids)**; owner
    Telegram received 2 real alerts during the run (eyeball). Service healthy
    after: `active`, 200, journal clean.
  - **Incidents (recorded, honest):** (a) parallel tool-call race hit TWICE
    more — `git add`/`commit` earlier and rsync/e2e-run here were issued as
    separate calls in ONE block and ran CONCURRENTLY (e2e ran before the file
    landed, git commit saw an empty index) → **dependent commands must be ONE
    chained command**; (b) tsx on the box compiles scripts as CJS → top-level
    `await` transform error → e2e tail wrapped in `void (async () => …)()`;
    (c) plain `tsx` does not load `.env` → needs `--env-file=.env` (else
    `lib/env.ts required()` throws on `APP_BASE_URL`).
- **NEXT ACTION: S5 DEPLOY** per playbook §7 → §3 migrate (`sudo -u trmm npx prisma migrate
  deploy` + generate) → §2 build → §4 verify; live evidence: next
  `admin_pending_payment` NotificationLog recipient = `myrate619@gmail.com`
  (S1b), invoice email row `invoice_sent` (B3), support TG/email (A).
  G2 gates green on commit B tree: tsc 0 · eslint 0 · prisma valid · invoice
  34/34 · support 57/57 · xdevice 38 · wallet 63 · module-gate 13 ·
  wrapper-cookie 6. RECAP: two EARLY support runs showed a non-reproducible
  `fail 1` (no name captured, no support-file change since); 6 consecutive
  runs clean — recheck at S5b.

## S1 DIAGNOSIS — DONE (read-only, VPS 2026-10-08) — ROOT CAUSE = CONFIG, NOT CODE

- `NotificationLog` (quote the camelCase column `"eventType"`) WHERE
  `='admin_pending_payment'`: **7 rows, all `outcome:"sent"`, last 2026-10-08 15:24:31`,
  recipient = `spaceworker@instaweb.top`** (= EMAIL_FROM, the FROM address — owner never
  sees it). Telegram fine (chat `6337977358`, rows land same second).
- `/opt/spaceworker/.env`: **`ADMIN_EMAIL` ABSENT** → `lib/env.ts:168` falls back to
  `EMAIL_FROM`. Resend key real; TELEGRAM_* + ADMIN_TELEGRAM_CHAT_ID present.
- **FIX = config only: owner adds `ADMIN_EMAIL=<owner inbox>` to
  `/opt/spaceworker/.env` + restart (I must NOT edit .env — flag it, ask which inbox).**
  `lib/payment-notify.ts` verified correct: fire-and-forget, `.catch(()=>{})`, telegram
  untouched, 3 call sites (submit:201, topup:156, topup:292). No S1 code change.

## RESEARCH ANCHORS (don't re-read blindly)

- **Notify pattern:** `lib/payment-notify.ts` — `void notifyAdmin(msg)` (lib/telegram:28,
  swallows own errors) + `void sendEmail({to: env.adminEmail, …, eventType}).catch(()=>{})`.
  `sendEmail` (lib/email.ts:55) logs NotificationLog in `finally` and RE-THROWS → always
  `.catch()` it. `env.adminEmail` lib/env.ts:168; `env.appBaseUrl` for URLs.
- **Support service** `lib/support/tickets.ts`: `createSupportTicket` :363 (returns
  getUserTicket), `addAdminMessage` :637 `(ticketId, body, adminId)`, `getUserTicket` :426
  (ownership in WHERE), `getAdminTicket` :597 (selects `user:{email:true}` — ADD
  `id:true` for composer userId), `SupportMessageView` :63, detail view :92; both detail
  message selects `{id,authorRole,body,createdAt}` → ADD `invoiceId:true`.
- **S2 wire points:** `app/api/support/tickets/route.ts` POST :57 (after ok; getCurrentUser
  returns FULL user incl. email); `app/api/admin/support/tickets/[id]/messages/route.ts`
  POST :40 (after ok; schema `{body}` → add `invoiceId: z.string().max(64).nullish()`).
- **Money path:** `POST|GET app/api/admin/users/[id]/invoices/route.ts` (POST :70 — PLANS
  tier 5/3, amount cap 100000, one-open guard :95 returns 400 + existing `invoiceId`,
  methods snapshot from getAdminSettings :121); `PATCH …/[invoiceId]/route.ts` :28 (open
  only). `GET app/api/billing/invoices/route.ts` = user read (session-scoped — NEVER add
  `days` to user-facing selects).
- **Settle:** `lib/license-service.ts` `settleLinkedInvoice` :52 claim-THEN-grant; :66-69
  grantXDeviceTerm/grantPremium with `PREMIUM_DAYS_PER_CHARGE` (lib/premium.ts:10 = 30) →
  CHANGE to `invoice.days ?? PREMIUM_DAYS_PER_CHARGE`. Callers: handleApprovedPayment :93,
  admin approve :61.
- **Schema:** `PremiumInvoice` prisma/schema.prisma:3695 → add `days Int?`;
  `SupportMessage` :3655 → add `invoiceId String?` (SOFT ref, no FK — house style like
  domainRefId). Newest migration on origin/main (fetched) = `20261118000001_…` → name mine
  **`20261119000000_task187_invoice_days_thread_ref`**, hand-written ADDITIVE SQL, comment
  header like TASK_184's, CHECK days NULL OR >=1, plus **`LOCK.md`** in the migration
  folder (no repo precedent → create it). Deploy does NOT auto-migrate: box needs
  `sudo -u trmm npx prisma migrate deploy` + `generate` (§3) BEFORE build.
- **Billing card:** `PremiumInvoiceCard` app/dashboard/billing/page.tsx:632 — chains =
  non-null methods entries, submits `{kind, txHash, invoiceId}` to /api/billing/submit,
  `planLabelForTier`, NO term shown (TASK_181 rule). Pay target for emails/thread =
  **`/dashboard/billing`**.
- **Composer surfaces:** keep `components/admin/user-invoice-cell.tsx`; mirror its pattern
  (lazy fetch invoices + `/api/admin/wallets` → {webSubscriptionPriceUsd, xdevicePriceUsd,
  btcWallet, usdtWallet, usdtErc20Wallet}). `components/admin/support-queue-panel.tsx`
  (532 ln: state :120-138, openTicket :172, sendReply :189, detail :461-527 — composer
  goes there; TicketDetail gains `userId`). `components/support-widget.tsx` (user thread
  :584-624, Message iface :50, mounted once shell.tsx:91, NO deep link → user email links
  to `${env.appBaseUrl}/dashboard`).
- **Labels:** `lib/support-templates.ts` PREMIUM_REQUEST_TEMPLATES (premium_plus→tier 5
  "Premium Plus"; premium_request_xdevice→tier 3 "Premium XDevice"),
  `isPremiumRequestCategory`.
- **Tests:** `tests/premium-invoice.test.ts` — `loadRoute(path,deps)` Module._load hook;
  `adminInvoiceDeps()` ~:303 ADD `"@/lib/invoice-notify"` override; InvoiceRow ~:93 add
  `days: number | null`; `seedInvoice` ~:357; license-service stub `./premium` records
  `grants {fn,userId,days}` + `PREMIUM_DAYS_PER_CHARGE:30`; submitDeps already stubs
  `@/lib/payment-notify`. `tests/support-tickets.test.ts` — loader patch :300 (`isSupportRoute`
  branch: ADD `@/lib/support-notify` return; `@/lib/prisma` faked for routes AND
  `/lib/support/tickets.ts`); `withRelations` :137 maps messages → add `invoiceId`; add
  `store.invoices` + `fakePrisma.premiumInvoice.findUnique` (equality `where {id}` only —
  service must use findUnique per id, NOT `in:` — the fake can't match `in`); `sessionUser`
  :285 → give it `email`. Scripts: `test:invoice`, `test:support`.

## IMPLEMENTATION PLAN (decided — follow this order)

### Commit A = S2 notifications (NOT money, NOT UI)
- [x] A1. NEW `lib/support-notify.ts` (server-only, mirrors payment-notify: outer
      try/catch, fire-and-forget, `.catch(()=>{})` on sendEmail):
      `notifyAdminTicketCreated({ticketId,userEmail,subject,category})` → Telegram
      `notifyAdmin(...)` + email to `env.adminEmail` (skip if empty), eventType
      `admin_support_ticket`, content = ticket id, user email, category, subject,
      `${env.appBaseUrl}/admin`; `notifyUserTicketReply({ticketId,to,subject})` → email
      only, subject `Re: <subject>`, link `${env.appBaseUrl}/dashboard`, eventType
      `support_reply` (skip if no "@").
- [x] A2. Wire: user tickets POST (after ok, `try{ notifyAdminTicketCreated(…
      user.email …) }catch{}` no await); admin messages POST (after ok, **ONLY when NO
      invoiceId** — invoice email covers that arrival; fetch ticket
      `{subject,user:{email}}` → `notifyUserTicketReply`). Neither may fail the request.
- [x] A3. Support tests: notify recorder called on create/reply; notify stub that THROWS
      ⇒ request still succeeds. (Loader: add `@/lib/support-notify` to `isSupportRoute`
      branch; `sessionUser` gains `email`.)

### Commit B = MONEY (schema + invoice API + settle) — separate from UI
- [x] B1. Schema: `PremiumInvoice.days Int?` (optional duration; null ⇒ default 30d at
      settle; **NEVER rendered to user**) + `SupportMessage.invoiceId String?` (soft ref,
      no FK); migration
      `prisma/migrations/20261119000000_task187_invoice_days_thread_ref/migration.sql`
      (2 additive ALTER TABLE ADD COLUMN, `CHECK ("days" IS NULL OR "days" >= 1)`,
      TASK_184-style header) + `LOCK.md` in that folder; `npx prisma generate`.
- [x] B2. POST invoices: accept `days` (absent/null→null; else Number.isInteger 1..3650
      else 400) + `methods` (absent→settings snapshot; else object keys ⊆
      {btc,usdt_trc20,usdt_erc20}, values string|null trimmed ≤200, unknown key → 400,
      FULL REPLACE — unspecified chain = null). user select `{id,email}`; after create →
      `notifyUserInvoiceSent` (try/catch, no await). PATCH: also `days`+`methods` while
      open (explicit admin edit; "no re-snapshot" rule still governs AUTOMATIC snapshots).
- [x] B3. NEW `lib/invoice-notify.ts` — `notifyUserInvoiceSent({invoiceId,to,plan,amountUsd})`
      → email with **Pay button → `${env.appBaseUrl}/dashboard/billing`**, eventType
      `invoice_sent`. **NEVER any duration/term string (TASK_181).**
- [x] B4. Thread read: getUserTicket/getAdminTicket messages select +`invoiceId`; per
      unique id `prisma.premiumInvoice.findUnique({where:{id}})` (user side also require
      `invoice.userId === ticket.userId` else drop) → attach
      `invoice:{id,plan,tier,amountUsd,status,methods,createdAt,paidAt}|null` per message
      (**EXCLUDE `days`**). Views gain `invoiceId?` + `invoice?`.
- [x] B5. `addAdminMessage(ticketId, body, adminId, invoiceId?)`: invoiceId present →
      ticket must exist with userId; invoice must exist AND belong to ticket's user else
      404/400; store on message. Admin messages route parses optional `invoiceId`.
- [x] B6. Settle: `const days = invoice.days ?? PREMIUM_DAYS_PER_CHARGE;` → both grants.
- [x] B7. getAdminTicket `user:{id,email}` + expose `userId` on admin detail (composer
      needs it for POST /api/admin/users/[id]/invoices).
- [x] B8. Tests — `test:invoice`: InvoiceRow `days` + seedInvoice; POST days validation
      (accept 45 / reject 0,-1,1.5,"x"), methods override beats snapshot + unknown key
      400; PATCH days+methods while open; settle days=45 → grant 45, null → 30;
      invoice-sent notify called. `test:support`: thread attaches invoice (owner-scoped,
      other-user invoice dropped), admin reply invoiceId stored+validated.

### Commit C = UI (composer + thread cards) + docs
- [x] C1. `support-queue-panel.tsx`: "Send invoice" toggle on selected ticket → plan
      `<select>` (PREMIUM_REQUEST_TEMPLATES.planName; default inferred from ticket
      category: xdevice → premium_xdevice else plus, re-inferred per ticket), amount
      input (prefilled from `/api/admin/wallets`, must be >0), optional duration days
      (blank = default; admin-only screen), payment-details BTC / USDT-TRC20 /
      USDT-ERC20 (ALL blank ⇒ omit methods ⇒ snapshot; ANY typed ⇒ send full object,
      blanks→null), optional note. Send: POST invoices → on 400-with-`invoiceId` (existing
      open) fallback PATCH that id → POST admin message `{body: note||default, invoiceId}`
      → re-read detail + notice.
- [x] C2. Thread invoice cards (admin panel + support-widget): when `m.invoice` render
      plan name, `$amount`, status chip, methods rows; **widget: "Pay invoice" →
      `/dashboard/billing` (open only)**. **NO duration/term text user-facing.**
- [x] C3. Update this steps file + tick `TASK_187_PAYMENT_ALERTS_INVOICE.md` S1–S5 boxes.

### S5 gates + deploy (playbook §7 → §3 → §2 → §4)
- [x] G1. `npx tsc --noEmit` = 0; eslint touched files = 0 NEW (admin-panel pre-existing
      errors not ours).
- [x] G2. `test:invoice` + `test:support` green with new cases; regression: `test:xdevice`
      38 · `test:wallet` 63 · `test:module-gate` 13 · `test:wrapper-cookie` 6
      (`test:maintenance-cache` does NOT exist — dropped).
- [x] G3. Commits A/B/C via `/tmp/<x>-msg.txt` + `git commit -F` → push (money separate
      from UI). NEVER `TASK_133_RMM_ENGINE_BRINGUP.md`.
- [x] G4. Deploy: sync source trees (§2 tar/rsync -azr, never --files-from for trees) +
      `prisma/`; box: `sudo -u trmm npx prisma migrate deploy` + `generate` (§3) →
      `scripts/deploy-vps.sh` → fresh BUILD_ID, service active, site 200, repo↔box md5
      parity on touched files.
- [x] G5. Live evidence: test ticket → NotificationLog `admin_support_ticket` + owner
      receives BOTH Telegram + email; admin reply → user email; composer invoice → thread
      card + `invoice_sent` email → pay → approve → `paid` + tier granted + `days`
      applied. **Requires owner to set ADMIN_EMAIL first (S1) — flag it.**

## STEPS (checkbox mirror of the plan above — detail lives there)

### S1 — payment alert EMAIL
- [x] S1a. **DONE 2026-10-08 (read-only):** 7 `admin_pending_payment` rows all
      `sent` → but to `spaceworker@instaweb.top` (EMAIL_FROM); `ADMIN_EMAIL` ABSENT in
      box `.env`. Code (lib/payment-notify.ts + 3 call sites) correct — no change.
- [x] S1b. **DONE 2026-10-08 — OWNER-DIRECTED, EXECUTED + TESTED.** Owner answered
      the flag with the inbox `myrate619@gmail.com` (explicit owner instruction =
      the exception to "flag, don't edit .env"). **Evidence, in order:**
      (1) idempotency check found no `^ADMIN_EMAIL=` line, then appended
      `ADMIN_EMAIL=myrate619@gmail.com` to `/opt/spaceworker/.env` (re-grep shows
      the line; no other .env line touched);
      (2) `systemctl restart spaceworker.service` — after-restart journal:
      `✓ Ready in 463ms`, `[env-health] OK`, sweeps running; **health
      `http://localhost:3500` → http:200**;
      (3) **PORT GOTCHA (for S5 health checks):** `.env` says `PORT=3400` but
      systemd's ExecStart is `next start -p 3500` — 3500 is spaceworker, 3300 is
      a different next-server; curl :3400 → 000 is a false alarm;
      (4) **one-off delivery test** sent from the box via EMAIL_FROM + the box's
      Resend key directly to `myrate619@gmail.com` → API accepted,
      `{"id":"01a11cbe-ddbb-70e5-a40e-8f74f76b0b6c"}` (key never left the box,
      never logged). Proves FROM + Resend + inbox delivery end-to-end;
      (5) definitive app-path proof = the NEXT real `admin_pending_payment`
      NotificationLog row must show recipient `myrate619@gmail.com` (the old 7
      rows remain `spaceworker@instaweb.top`) — check at S5. Why it was needed
      despite owner receiving other mail: those emails are TO-customer
      (recipient from DB); `ADMIN_EMAIL` is the missing TO-owner recipient —
      the fallback sent alerts to EMAIL_FROM itself.
      Note: Commit A's `admin_support_ticket` email activates on this box only
      after the S5 deploy (running code predates `c96c272`).

### S2 — support notifications (both directions, both channels)
- [x] **COMMIT A `c96c272` PUSHED 2026-10-08** — exactly S2a+S2b+S2c files (4),
      strays excluded; origin `442d938..c96c272`.
- [x] S2a. **A1 DONE 2026-10-08:** `lib/support-notify.ts` created (96 ln) —
      `notifyAdminTicketCreated({ticketId,userEmail,subject,category})` (TG
      `notifyAdmin` + email to `env.adminEmail` if set, eventType
      `admin_support_ticket`, admin link `${env.appBaseUrl}/admin`) +
      `notifyUserTicketReply({ticketId,to,subject})` (email only, subject `Re:
      <subject>`, link `${env.appBaseUrl}/dashboard`, eventType `support_reply`,
      skips non-"@" recipients). `import "server-only"`; each body wrapped in
      try/catch; sendEmail `.catch(()=>{})`; NO duration/term strings. `npx tsc
      --noEmit` clean. NO call-site wiring yet (A2 next).
- [x] S2b. **A2 DONE 2026-10-08** (tsc 0, eslint 0 on touched files):
      (1) `app/api/support/tickets/route.ts` — import + `try{ notifyAdminTicketCreated(
      {ticketId: result.value.id, userEmail: user.email, subject, category:
      result.value.category ?? "general"}) }catch{}` no await, placed BEFORE the 201
      return; session email only.
      (2) `app/api/admin/support/tickets/[id]/messages/route.ts` — schema now
      `{body, invoiceId: z.string().max(64).nullish()}` (accepted-but-not-yet-stored;
      B5 adds validation+store); after ok, `if (!parsed.invoiceId)` → `try{ const
      detail = await getAdminTicket(id); if (detail.ok && detail.value.userEmail)
      notifyUserTicketReply({ticketId: id, to, subject: detail.value.subject})
      }catch{}` — await only the FETCH, never the notify; reply-email SKIPPED when an
      invoice travels with the message. **KNOWN: `npm run test:support` now FAILS
      (loader loads REAL support-notify → `server-only` throws) — A3 (loader stub +
      notify tests) is the immediate next step to fix it.**
- [x] S2c. **A3 DONE 2026-10-08 — ALL GATES GREEN.** `tests/support-tickets.test.ts`:
      notify recorder + `notifyThrows` switch (reset in beforeEach), loader now
      (a) injects `email` into the fake `getCurrentUser` from `userEmails` (the
      real getCurrentUser returns the full row; route reads `user.email`) and
      (b) stubs `@/lib/support-notify` (without it the REAL module loads →
      `server-only` throws under plain node). 4 new tests: create-alert args
      (session email + created id + `category ?? "general"` fallback); admin
      reply → `notifyUserTicketReply` to OWNER email/subject; `invoiceId`
      present → NO reply notify + still 201 + message stored; THROWING notifier
      → both paths still 201 with all writes landed (initially failed on a
      `t_1` id collision with `nextId` — fixed with `t_admin`). **Evidence:**
      test:support **54/54**, test:invoice **27/27**, test:xdevice 38,
      test:wallet 63, test:module-gate 13, test:wrapper-cookie 6 — all 0 fail;
      `tsc --noEmit` 0; eslint 0 on all 4 touched files.
      **CORRECTION: there is NO `test:maintenance-cache` script in package.json
      (pre-compaction note was wrong) — regression battery = xdevice, wallet,
      module-gate, wrapper-cookie.**

### S3 — admin invoice composer in the support panel
- [x] S3a. **B1 DONE 2026-10-08** — schema days+invoiceId, migration
      `20261119000000_task187_invoice_days_thread_ref` + LOCK.md, prisma
      generate/validate OK (task184 overwrite incident caught+restored — see
      COMMIT B PROGRESS).
- [x] S3b. **B2–B8 ALL DONE 2026-10-08** — money API days/methods/strict-keys,
      `lib/invoice-notify.ts`, thread invoice resolve, addAdminMessage
      validation+store, settle days, admin detail userId; **+11 new tests,
      G2 gates green (invoice 34/34, support 57/57, battery 0 fail, tsc 0,
      eslint 0)**. Contract changes flagged: tier accepted-ignored; methods
      override replaces TASK_184's "never the body" rule (test rewritten).
      Commit B next.
- [x] S3c. Composer UI in support-queue-panel (C1).

## COMMIT B EXECUTION LOG — S3a/S3b/S4b MONEY CODE (started 2026-10-08)

**BEFORE (plan of record, recorded BEFORE any edit):** Commit B = money code only,
NO UI. Ordered tasks:
- **B1 schema+migration:** `prisma/schema.prisma` → `PremiumInvoice.days Int?` +
  `SupportMessage.invoiceId String?` (SOFT ref, NO FK — house style, like
  `domainRefId`). Hand-written additive SQL migration
  `prisma/migrations/20261119000000_task187_invoice_days_thread_ref/migration.sql`
  (newest on origin/main = `20261118000001_*`, so this sorts newest; comment
  header in TASK_184 style; `CHECK ("days" IS NULL OR "days" >= 1)`) + create
  `LOCK.md` in that folder (no repo precedent → we define it) → `npx prisma generate`
  locally (no local Postgres → SQL by hand, house rule).
- **B2 money API:** `app/api/admin/users/[id]/invoices/route.ts` POST accepts
  optional `days` (integer ≥1) into create; `PATCH …/[invoiceId]/route.ts`
  accepts `days` + `methods` while open. Both STRICT zod (unknown keys 400);
  `methods` override beats settings snapshot; NEVER expose `days` via
  `GET app/api/billing/invoices/route.ts` (user-facing — no select change).
- **B3 notify:** NEW `lib/invoice-notify.ts` →
  `notifyUserInvoiceSent({invoiceId,to,plan,amountUsd})` email, Pay button →
  `${env.appBaseUrl}/dashboard/billing`, eventType `invoice_sent`, same
  fire-and-forget/try-catch/`.catch(()=>{})` pattern as support-notify;
  **zero duration/term strings (TASK_181)**; called from invoices POST (and on
  PATCH re-send? → NO: only on create; PATCH is edit).
- **B4 thread attach:** `lib/support/tickets.ts` both detail views' message
  select `+invoiceId:true`; per unique invoiceId
  `prisma.premiumInvoice.findUnique({where:{id}})` (findUnique per id — the
  test fake can't match `in:`); user side ALSO requires
  `invoice.userId === ticket.userId` else drop; expose
  `invoice:{id,plan,tier,amountUsd,status,methods,createdAt,paidAt}|null`
  — **`days` EXCLUDED everywhere user-visible**; views gain `invoiceId?`+`invoice?`.
- **B5 invoiceId store:** `addAdminMessage(ticketId, body, adminId, invoiceId?)` →
  invoice must exist AND belong to ticket's user, else 400; admin messages
  route passes `parsed.invoiceId`.
- **B6 settle days:** `lib/license-service.ts:66-69` →
  `const days = invoice.days ?? PREMIUM_DAYS_PER_CHARGE` for BOTH grants.
- **B7 admin userId:** `getAdminTicket` user select `+id` → expose `userId` on
  admin detail (composer needs it for `POST /api/admin/users/[id]/invoices`).
- **B8 tests:** `test:invoice` — InvoiceRow `days`, seedInvoice, POST days
  validation (45 ok; 0/-1/1.5/"x" 400), methods-override-beats-snapshot,
  PATCH days+methods open, settle days=45→grant 45 / null→30, invoice_sent
  notify called. `test:support` — thread invoice attach (owner-scoped;
  other-user invoice dropped), admin reply invoiceId validated+stored,
  message select invoiceId mapping.
- **Order:** B1 → B2 → B3 → B4 → B5 → B6 → B7 → B8 → gates (tsc/eslint/
  test:invoice/test:support) → **commit B with money files ONLY** (msg via
  `/tmp/commit-b-msg.txt` + `git commit -F`) → push. UI stays untracked for
  Commit C. Steps file updated AFTER with evidence (this section's AFTER block).
**No edits made yet — this is the BEFORE record.**

## COMMIT B PROGRESS (updated after each phase — post-compaction resume point)

**B1 ✅ DONE — schema + migration + LOCK.md + generate:**
- Verified newest origin/main migration = `20261118000001_task184_payment_invoice_ref`
  → mine `20261119000000_task187_invoice_days_thread_ref` sorts newest ✓.
- `prisma/schema.prisma`: `SupportMessage.invoiceId String?` (SOFT ref comment,
  domainRefId precedent) + `PremiumInvoice.days Int?` (admin override comment:
  NULL = standard term, never in user-facing selects).
- Hand-written `migration.sql` (3 stmts): `ADD COLUMN "days" INTEGER` +
  `CHECK ("days" IS NULL OR "days" >= 1)` + `ADD COLUMN "invoiceId" TEXT`.
- `LOCK.md` created (FIRST in repo — defines the convention: allowed-statement
  table, ordering, box deploy `sudo -u trmm npx prisma migrate deploy` →
  `generate` → build, no-down rationale).
- `npx prisma generate` exit 0; `npx prisma validate` "valid 🚀".
- **⚠️ INCIDENT (caught + repaired):** in the creation batch I passed the
  TASK_184 path as target for the task187 content → task184's migration.sql was
  OVERWRITTEN. Detected by `head` check immediately; restored with
  `git checkout -- prisma/migrations/20261118000000_task184_premium_invoice/migration.sql`;
  verified header + `grep -c CREATE TABLE` = 1 + file absent from `git status`.
  **Permanent damage: NONE** (only the new folder + schema.prisma remained
  modified). Lesson: never batch-create + edit migration files in one call.

**B2 ✅ DONE — money API:**
- POST `…/invoices/route.ts`: body `{plan, amountUsd?, days?, methods?}`;
  null/array-body guard; **unknown-key 400** via `ALLOWED_KEYS = [plan,
  amountUsd, days, methods]`; `parseDays` (undefined→as-is / null→clear /
  int≥1 / rejects 0,-1,1.5,"x"); `parseMethods` (exactly btc|usdt_trc20|
  usdt_erc20, string|null, unknown chain 400); user select `+email`; create
  data = methods snapshot **merged with override** + `days` only when number;
  notify before 201 (try/catch, no await).
- PATCH `…/[invoiceId]/route.ts`: validators DUPLICATED in-file (matches
  PLANS/AMOUNT_MAX precedent — sibling routes, isolated test loads); strict
  unknown-key 400; "Nothing to update" = plan/amount/days/methods all absent;
  `days` set-or-clear(null); invoice select `+methods`; explicit methods edit
  merges over CURRENT stored snapshot; plan switch still never re-snapshots.
- **tsc fix:** `data.methods: unknown` → TS2322 (not assignable to Prisma
  `InputJsonValue`) → typed `Record<string, string|null>` + cast on merge base.

**B3 ✅ DONE — `lib/invoice-notify.ts` NEW (67 ln):**
`notifyUserInvoiceSent({invoiceId,to,plan,amountUsd})` — local PLAN_LABELS map
(premium_plus→"Premium Plus", premium_xdevice→"Premium XDevice"; NOT
support-templates: money email must not shift with ticket copy); Pay link
`${env.appBaseUrl}/dashboard/billing`; guards non-"@" `to`; html = Plan/
Amount/Invoice rows + "Pay this invoice" link; eventType **`invoice_sent`**;
**zero duration/term strings (TASK_181)**; outer try/catch + `.catch(()=>{})`.

**B4+B5+B6+B7 ✅ DONE:**
- `lib/support/tickets.ts`: `ThreadInvoiceView` (id,plan,tier,amountUsd,
  status,methods,createdAt,paidAt — **NO days, NO userId**); `SupportMessageView
  +invoiceId?/invoice?`; `SupportTicketDetailView +userId?`; `toMessageView`
  passes `invoiceId ?? null`; **`resolveMessageInvoices(messages,
  ownerUserId?)`** — Set of DISTINCT ids, `findUnique` PER id (equality
  `where {id}` — test fake can't match `in:`), owner-scoped (foreign/dangling
  → `invoice:null`) / admin unscoped; getUserTicket select `+invoiceId` +
  resolve(userId); getAdminTicket `user select {id,email}` + resolve() +
  exposes `userId: row.user.id` (B7).
- `addAdminMessage(…, invoiceId?)`: trim-empty→null; ticket findUnique
  `{id,userId}`; invoice must exist AND belong to ticket's user else **400
  `invoice_not_found` (nothing written)**; create stores + selects `invoiceId`.
- Admin messages route: passes `parsed.invoiceId`; comment updated.
- `lib/license-service.ts` B6: `const days = invoice.days ?? PREMIUM_DAYS_PER_CHARGE`
  → BOTH grants; header comment updated.
- **Gates after B2–B7: `tsc --noEmit` 0; eslint 0 on all 6 touched files.**

**B8 ✅ DONE 2026-10-08 — ALL GATES GREEN.** (Analysis below kept as the
record of WHY the edits below were needed; every item in the list after it was
executed. Gotcha found while writing assertions: the test's `SNAPSHOT`
constant is the `*_AT_SEND` seeded-row default, while `DEFAULT_SETTINGS` is
`*_ADMIN` — the first two new assertions used the wrong one and failed; fixed
to match each contract, both then passed.)

**Pre-fix failure analysis (what B8 had to fix):**
- `test:invoice` **20/27**; failing = #1–6 + #27. SINGLE ROOT CAUSE:
  `adminInvoiceDeps()` (tests/premium-invoice.test.ts:330) lacks
  `"@/lib/invoice-notify"` → REAL module loads → `import "server-only"` throws
  (trace: loader :71 → invoice-notify.ts:1).
- `test:support` **52/54**; failing = #24 "reply carrying invoiceId sends NO
  reply email". ROOT CAUSE: `fakePrisma` has NO `premiumInvoice` → new
  `addAdminMessage` validation TypeError (test sends `inv_1` unseeded).

### B8 — TWO DELIBERATE CONTRACT CHANGES (flagged for the verifier):

### B8 — TWO DELIBERATE CONTRACT CHANGES (flagged for the verifier):
1. **`tier` stays ACCEPTED-but-IGNORED in POST** — existing test #2 ("a
   client-sent tier is ignored") + route header doc both promise it, so
   `ALLOWED_KEYS` gains `tier`. ALL other unknown keys (e.g. `daysx`) still 400.
2. **Methods override REPLACES TASK_184's "never from the body" rule** —
   existing test #4 asserts body methods are IGNORED; that DIRECTLY conflicts
   with TASK_187's composer. NEW contract: absent methods → snapshot (old
   behavior, old assertion kept as the absent case); explicit VALIDATED object
   → override wins. Justification: route is admin-session-gated (403) +
   known-chains-only; owner approved payment-details entry via the composer
   plan. **Test #4 gets REWRITTEN, not deleted.**

### B8 — EXACT EDIT LIST (ALL APPLIED ✓ — was the next-action list):
`tests/premium-invoice.test.ts`:
- [x] P1 `adminInvoiceDeps()` += `"@/lib/invoice-notify"` recorder → NEW
      `invoiceNotifyCalls` array (+ reset in `resetStore`).
- [x] P2 `store.users` type `{id,email}[]` + seed `u1@test.dev`/`u2@test.dev`
      (+ reset line ~:419) — POST now selects email.
- [x] P3 `InvoiceRow` += `days: number|null`; `seedInvoice` default
      `days:null`; fake `create` default `days:null` (BEFORE `...args.data`).
- [x] P4 ROUTE FIX: POST `ALLOWED_KEYS` += `"tier"` (change #1).
- [x] P5 REWRITE test #4 (change #2): absent → snapshot; explicit → override.
- [x] P6 NEW tests: POST days 45→stored / [0,-1,1.5,"x"]→400 + nothing
      written / absent→null; POST unknown key `daysx`→400; POST partial
      methods override merges with snapshot; POST → `invoiceNotifyCalls` == 1
      {invoiceId, to:"u1@test.dev", plan, amountUsd}; PATCH days set 45 +
      clear null + methods merge while open + unknown-key 400; settle
      days=45 → `grants [{fn,userId,days:45}]` (existing test already covers
      null→30 fallback).
`tests/support-tickets.test.ts`:
- [x] S1 `FakeMessage` += `invoiceId: string|null`; `supportMessage.create`
      stores + returns it; `withRelations` messages map += `invoiceId`.
- [x] S2 `store.invoices` + `fakePrisma.premiumInvoice.findUnique` (equality
      `where {id}` ONLY — fake `matches` can't do `in:`) + `seedInvoice`
      helper; reset in `beforeEach`.
- [x] S3 `withRelations` `user` += `id: t.userId` (B7 admin detail userId).
- [x] S4 FIX test #24: `seedInvoice({id:"inv_1", userId:"user_a"})` first.
- [x] S5 NEW tests: valid attach → stored + USER detail card with **no
      `days`/`userId` keys** + ADMIN detail exposes `userId:"user_a"`;
      foreign-user invoice attach → 400 `invoice_not_found` + writes empty;
      user detail with foreign/dangling ref → `invoice:null` (still 200).

**THEN:** G1/G2 gates → **commit B (MONEY FILES ONLY: schema.prisma,
migration folder, lib/invoice-notify.ts, lib/license-service.ts,
lib/support/tickets.ts, both invoice routes, admin messages route, 2 test
files)** → push. UI stays untracked for commit C.

### S4 — user pays from ticket/email
- [x] S4a. Thread invoice cards + widget Pay button + invoice email (B3/C2).
- [x] S4b. **B6 DONE 2026-10-08** — settle uses `invoice.days ?? PREMIUM_DAYS_PER_CHARGE`
      for both grants. Grep-for-no-duration-strings still runs at S5 (G1).

### S5 — gates + deploy
- [x] S5a. `npx tsc --noEmit` 0; eslint touched files 0 NEW (G1).
- [x] S5b. `test:invoice` + `test:support` extended green + regression battery (G2).
- [x] S5c. Commits A/B/C (money separate from UI) → push → deploy (migrate → generate →
      build) → live evidence → record here (G3–G5).

### Closeout
- [ ] Tick scope-doc checkboxes; verifier runs `PROMPT_VERIFY_TASK_187.md`; refresh
      SENIOR_HANDOFF §6; rewrite verification prompt for next verifier.
