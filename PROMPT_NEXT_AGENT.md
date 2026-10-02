# PROMPT — NEXT SENIOR AGENT (Task 155 **P3**: Pages engine, folder→preview→publish, engine switch)

> **Self-contained, copy-paste prompt.** Paste the `TASK BLOCK` below into the next senior agent.
> It supersedes the D1 instantiated prompt in `PROMPTS_SENIOR_ENGINEERS.md` §"Owner-requested design
> work", which still says "START D1 AT P2" — **stale: P1 and P2 are built, deployed and LIVE**
> (see VERIFIED STATE). Everything the agent needs is in this file plus the three docs it names.
> **This run is P3 only.** When P3 is done, the SAME agent picks up **D2 / Task 156** — the handoff for
> that is the final section of this file ("AFTER P3 — the D2 run"); the build spec is
> `PLAN_TASK_156_CYBERLAB_REAL_WORLD_TOOLS.md` **§12 (owner addendum 2026-10-02, BINDING)**.

---

## TASK BLOCK (paste from here)

```
TREE:            /Users/mikeolab/spaceworker           (branch: main)
TASK:            D1 / Task 155 - "Workers & Pages" (the Hosting tab).
                 YOU START AT:  P3 - the Cloudflare Pages engine + the folder/zip ->
                 PREVIEW -> PUBLISH flow + the per-item server/premium engine picker +
                 the account chooser. This is the NEXT build; P1 and P2 are already
                 deployed and live (do NOT redeploy them, do NOT rebuild their UI).
TASK DOCS:       PLAN_TASK_155_WORKERS_AND_PAGES.md       read section 16 FIRST (owner
                                                          additions 2026-10-02 - it BINDS this
                                                          whole build), then 9 (the P3 entry),
                                                          8 (the UI), 14 (caps), 15 (public
                                                          host), and 3/5/11.
                 SENIOR_HANDOFF.md                        sections 3, 4, 5 (traps - read 19,
                                                          20, 21), 8, 9, 10.
                 PROMPT_NEXT_AGENT.md                     this file (current state + asks).
                 (PLAN_TASK_156_CYBERLAB_REAL_WORLD_TOOLS.md is D2 - NOT this run.)
DEPENDS ON:      Nothing external. P1 (`a131835`) and P2 (`435d419`) are built, proven,
                 committed, PUSHED, DEPLOYED and LIVE (build `9RVryDnQoHNZL4NL-Zdy6`).
                 `hostingEnabled = true`. The throwaway Cloudflare account/token from PLAN
                 13.2 is in the gitignored `.env` (`CLOUDFLARE_API_TOKEN_DEV` /
                 `CLOUDFLARE_ACCOUNT_ID_DEV`) and is FOR P3 DEV/DEPLOY. START NOW.
BRANCH:          main
DEPLOY?          yes - after it is green. P3 is additive and DARK until a user deploys a
                 site, so shipping it does not disturb anything live. Follow section 9 of the
                 handoff verbatim (dispatch, verify BUILD_ID, grep the BUILT chunks under
                 /opt/spaceworker/.next/static - components/ and lib/ are NOT shipped).
                 If the P3 migration is needed, it is ADDITIVE only; run `prisma migrate
                 deploy` in-window exactly as the P2 deploy did.
```

## OWNER'S ASKS (these BIND; do not re-litigate)

```
A1  "the cyberlab and workers should be added to the menu and dashboard cards"
      ->  DONE in P2 (Hosting + Cyber Lab nav items AND dashboard cards are live). PROVE
          they are still there; do NOT rebuild them.
A2  "go ahead with deploy ... flip it when we deploy and we test to see how it works"
      ->  DONE in P2 (deployed + hostingEnabled=true + tested via the live tab). Keep it live.
A3  "go ahead with the ssh to get the nginx you need"
      ->  AUTHORISED. P2 already added the `location /hf/` proxy on dl.instaweb.top. Use SSH
          again for any infra P3 needs (a preview namespace/`location`, env vars).
A4  "we need both options available and an option for users to add their own cf tokens and id"
      ->  TWO credential sources: PLATFORM (ours, the throwaway account for now) and BYO
          (the user's OWN Cloudflare account id + a scoped token). The STORE is P2 (done);
          P3 must actually USE both: pick one, load it, deploy with it, verify it.
A5  "if users add multiple like 3, we should be able to switch between them ... lets start with
      one first"
      ->  the multi-credential STORE is P2 (done). P3 uses ONE credential PER deploy. Switching
          accounts DURING a running job is P5. The chooser lists all rows; picking a different
          row for the NEXT deploy is fine.
A6  "use the throwaway cf acct for p3"
      ->  P3 dev + the platform default credential use the throwaway account
          (CLOUDFLARE_ACCOUNT_ID_DEV / CLOUDFLARE_API_TOKEN_DEV).
A7  "you can add the cyberlabs cap to admin"
      ->  DONE in P2 (admin route + panel + RAM dials). P3 only ADDS the new hosting caps
          (section 14 P3 table); it does not re-do the Cyber Lab caps.
A8  "if its going to take a lot of ram ... we need every hard load monitored and queued
      properly, so the governor can also adjust ... lets build first, and when we are done, we
      will update the governor"
      ->  BUILD FIRST. Queue + serialise heavy loads (zip extract, mass upload, deploy) and
          RECORD metrics (bytesProcessed / entries / durationMs / peakRssMb) on the job row so
          the later governor task can shape them. Do NOT edit lib/resource-governor.ts in this
          run. Every heavy-load dial is an AdminSetting field (section 14 rule 1).
A9  "for now we dont need converters, just the rename of file upload is enough for file store"
      ->  CONVERTERS ARE OFF (section 16.5). Do NOT install sharp / ffmpeg / libreoffice /
          ImageMagick. Rename-with-unchanged-bytes IS the whole file feature.
A10 (NEW 2026-10-02) "no option to upload folder and we extract and push to preview first and
      then live"
      ->  section 16.1: a FOLDER goes up as a ZIP, WE extract it (7z), it lands on a PREVIEW
          URL first; the user then presses PUBLISH and only then does the live URL change.
A11 (NEW) "option to switch between the server and the premium"
      ->  section 16.2: a PER-ITEM engine picker - "Our server (free)" vs "Premium
          (Cloudflare)". Premium defaults to the platform account and accepts a BYO credential.
          Switching engines is an explicit MIGRATION, never a silent fallback.
A12 (NEW) "nothing that using premium is capped"
      ->  section 16.3: "premium is not capped" is a PRODUCT rule, not a licence. Premium has
          its OWN cap family (`hostingPremium*`), admin-editable, enforced server-side, so our
          shared Cloudflare account cannot be abused.
A13 (NEW) Cyber Lab must meet today's hacker world (simulate all kinds of email / DNS / server
      attacks, research, Linux tooling, run the simulation on the USER's own VM, created from
      SpaceWorker)
      ->  that is D2 / Task 156 - a SEPARATE task, a DIFFERENT run. Do not start it here.
```


## VERIFIED STATE AT HANDOFF (read this before you touch anything)

**P1 — `a131835` — FILES engine on our own metal. DEPLOYED + LIVE (in `435d419`).**
`/hf/<token>` upload / list / rename / delete behind the new `hosting` entitlement; rename rewrites
only `dispositionFilename`+`mime` so **sha256 is provably unchanged**. Files:
`lib/hosting/{providers,rules,files}.ts`, `app/api/hosting/{status,files,files/[id]}`,
`app/api/admin/hosting/route.ts`, `app/hf/[token]/route.ts`, `app/dashboard/hosting/page.tsx`,
`components/hosting-panel.tsx`, migration `20261028000000_task155_p1_hosting_files` (applied).

**P2 — `435d419` — REDIRECTS (user-owned) + BYO credential store + Cyber Lab scaffolding.
DEPLOYED + LIVE.** `npx tsc --noEmit` → 0, `CI=1 npx next build` → 0, `npm run test:hosting`
**39/39**, all 26 `test:*` suites green. Shipped:
- `lib/hosting/links.ts` — user-owned `/r/<slug|token>` links (create/list/update/delete,
  `resolveLink`, `recordLinkClick`). Reuses the Task 30 `LinkRedirect` row + two NULLABLE
  `userId`/`slug` columns, so **anonymous campaign links are untouched**.
- `lib/hosting/credentials.ts` — `HostingCredential` rows; the token is **AES-256-GCM encrypted**
  via `lib/mailbox-crypto.ts`; the list returns only a **4-char hint**; `getDefaultHostingCredential()`
  decrypts for the engine. **Multi-account ready** (`isDefault`, one default per provider). **P3 must
  USE this — the store exists, nothing consumes it yet.**
- `app/api/hosting/links{,/[id]}`, `app/api/hosting/credentials{,/[id],/[id]/default}`.
- `app/r/[token]/route.ts` — resolves a user slug OR a campaign token.
- Cyber Lab: `app/api/cyberlab/status`, `app/api/admin/cyberlab`, `components/cyberlab-panel.tsx`,
  `app/dashboard/cyberlab/page.tsx` (nav/card/panel + admin RAM dials — **dark**).
- `components/dashboard-nav.tsx` (Hosting **and** Cyber Lab) + `app/dashboard/page.tsx` (cards) — A1.
- migration `20261028000001_task155_p2_links_credentials_caps` (9 `AdminSetting` cols + 2 `LinkRedirect`
  cols + `HostingCredential` table) — applied to production.
- `tests/hosting-links-credentials.test.ts` (13 tests).

**Live right now (proved this session):** build `9RVryDnQoHNZL4NL-Zdy6` (mtime
`2026-10-02 00:15:49 CEST`) @ `435d419`, deploy run `36933764632`; `AdminSetting.hostingEnabled=true`;
`/dashboard/hosting` + `/dashboard/cyberlab` → **307 → /login**; `HOSTING_PUBLIC_BASE_URL=https://dl.instaweb.top`;
bytes at `/opt/spaceworker-hosting` (outside the deploy dir); the `dl.*` nginx `location /hf/` proxy
is live (proved by the **body**: `/hf/deadbeef` → app JSON `{"error":"Not found.","code":"not_found"}`,
not nginx's plain 404).

**What is NOT done (YOUR JOB — this is P3):**
1. **P3 does not exist.** No `cloudflare` engine, no Sites/Folder sections, no preview/publish.
2. **The Cloudflare storage engine is registered but `not_ready`** (`lib/hosting/providers.ts`) — the
   upload path refuses it with a typed `HostingProviderNotReadyError`. You implement it.
3. **No folder/zip upload, no extract, no preview URL, no publish** (section 16.1).
4. **No account chooser** — `HostingCredential` is stored but nothing loads/uses it to deploy.
5. **No premium cap family** (section 16.3) and **no heavy-load job queue/metrics** (section 16.6).
6. **The production WRITE path was never exercised by hand** — the upload→`/hf` 200→rename→delete
   flow is proven only on the local scratch DB + `next start :3999`. Do a live write check early.
7. The governor knows **nothing** about hosting/lab RAM (A8 — deliberately deferred).


## DO IT IN THIS ORDER — do not skip a step

1. **REPRODUCE FIRST.** Before changing a line, produce the failing raw output for each thing you
   build. There is no "bug" here, so prove the **absence**:
   - `GET /api/hosting/status` (authenticated) → the provider list shows `cloudflare` with
     `implemented:false`; the UI has **no engine picker**.
   - try to deploy a folder / a `.zip` → there is **no Sites/Folder section at all**.
   - the `HostingCredential` rows exist but **nothing reads them** (grep: the only consumer is a test).
   Paste the raw output.
2. **READ PLAN section 16 of PLAN_TASK_155.** It binds this build (16.1 folder→preview→publish,
   16.2 the engine switch, 16.3 premium caps, 16.4 multi-credential, 16.5 converters OFF, 16.6 the
   RAM shadow). If you disagree, say so with evidence — do not silently work around it.
3. **BUILD P3** (the deliverables list is in PLAN §9 P3 "Deliverables"). Smallest correct diff per
   file; match the neighbours' conventions (read `lib/hosting/files.ts` and `providers.ts` first).
4. **PROVE IT PASSES — same command, raw output, before AND after:**
   - `npx tsc --noEmit` → exit 0
   - `CI=1 npx next build` → success
   - `npm run test:hosting` (CI does NOT run `test:*` — you must) + **every** other `test:*` suite.
     Add `tests/hosting-pages.test.ts`; the `7z` extract + tree→manifest mapping are **pure** and
     unit-testable without Cloudflare (mock the REST client). A check that cannot fail is not evidence.
5. **PROVE IT VISIBLY (A10–A12).** With a real browser (Playwright is installed), zip a folder,
   upload it, open the **preview** URL from the public internet (`curl` → 200 + `X-Robots-Tag: noindex`),
   press **Publish**, `curl` the live URL → 200 serving the same bytes; then do the same folder on the
   **premium** engine → a live `*.pages.dev` URL. Screenshot the tab. A green build that changed
   nothing the user can see is the exact failure that produced TASK_153.
6. **BROKEN-NOTHING CHECK.** BEFORE and AFTER, `curl` the live `/e/...`, `/downloads/...`, an existing
   campaign `/r/<token>` redirect, and the P1 `/hf/<token>` file path — identical behaviour. Run every
   `test:*` suite that touches what you changed.
7. **COMMIT** — explicit paths only, never `-A`, never `.`:
   `git add <path1> <path2> ...` → `git commit -m "feat(hosting): Task 155 P3 - Pages engine, folder->preview->publish, engine switch"` → `git push origin main:main`.
8. **DEPLOY** (yes — the DEPLOY line above says so). Follow handoff section 9 verbatim; run the
   additive migration in-window if you added one; verify the BUILD_ID + a **BUILT chunk** grep (a
   source-tree grep proves nothing). **Beware trap 15**: a 5-minute oneshot may show `failed` right
   after a deploy — re-check after the next tick before calling it a regression.
9. **UPDATE THE HANDOFF (section 10 — same session):** section 6 last-verified date/HEAD/deployed
   BUILD_ID/sync, section 7 strike your item + promote what's next, section 5 any NEW trap with the
   evidence that proved it, section 12 one log entry (Did / Verified / NOT verified / State left
   behind / Next), and mark the item done in `PLAN_TASK_155_WORKERS_AND_PAGES.md`. Commit + push
   those docs (explicit paths).


## FILES YOU MAY TOUCH / MUST NOT TOUCH

**MAY TOUCH:** `lib/hosting/*.ts` (`providers.ts` — implement the `cloudflare` engine; new
`extract.ts`, `sites.ts`; `credentials.ts` — add verify-on-save; `rules.ts` — the new caps),
`app/api/hosting/**`, `app/api/hosting/sites/**` (new), `app/pv/[token]/route.ts` (new),
`app/dashboard/hosting/**`, `components/hosting*.tsx`, `app/api/admin/hosting/route.ts`,
`app/admin/(protected)/admin-panel.tsx` (**only** the hosting panel + its section label),
`prisma/schema.prisma` (**ADDITIVE only**) + exactly ONE new additive migration,
`tests/*.test.ts`, `.env.example`, `deploy/*` (nginx), and the docs. Reuse
`lib/mailbox-crypto.ts` and `lib/admin-settings.ts` — **do not fork either**.

**MUST NOT TOUCH:** `lib/resource-governor.ts` (A8 — a separate, later task), `lib/agent.ts` (add
the `"hosting"` action kind ONLY if the plan says so; do not refactor it), `lib/clone*.ts`, the
current behaviour of `/e/`, `/downloads/`, or a **campaign** `/r/<token>`, any **already-applied**
migration, the P1/P2 serve routes' existing behaviour, and anything on the `self-hosted-build` branch.

## NON-NEGOTIABLE (from PLAN §11/§13/§14/§15/§16)

- The Cloudflare token is **SERVER-ONLY** — never in a client bundle, a log line, an AI prompt, or an
  error message. BYO tokens are **encrypted at rest** and never echoed back (P2 does this; keep it).
- **No cap is a hard-coded literal.** Every limit is a named `AdminSetting` field, read server-side,
  editable in admin, enforced with a clear message (**never a 500**). This includes the **premium**
  family (§16.3) — premium is capped too.
- **Never serve user bytes from the main `spaceworker.top` app host.** Files come from the instaweb
  family (`dl.instaweb.top`, §15); short links from the app host; the **preview** URL is `noindex`.
- An invalid/revoked BYO token **fails closed** with plain language — never a raw Cloudflare JSON dump.
- Cloudflare per-asset ceiling is **25 MiB** (`hostingPagesMaxAssetMb` must stay below it);
  **pre-validate**. Zip/file **counts** have their own dials.
- **Folders go up as a ZIP** (Cloudflare takes a folder OR a zip, never our zip) → **we extract with
  `7z`** (R19; `unzip` is not on the box) into a staging dir **outside the deploy dir**.
- **Preview → Publish is two deliberate acts**, never one; the live URL only changes on Publish;
  keep the **last 3 published revisions** undoable (R18: there is no CF "promote" — Publish = a new
  production deployment of the same bytes).
- **Heavy loads are queued + measured** (§16.6): one at a time per user, `7z` with a hard timeout and
  an output cap, metrics recorded for the governor. **Do not tune the governor here.**
- **Converters are OFF** (§16.5). Scan uploads (§11.1); custom domains are **premium only**; never
  market links as "anonymous" (§11.5).

## P3 ACCEPTANCE (the exit criterion)

> Owner's words (2026-10-02): *"no option to upload folder and we extract and push to preview first
> and then live"* + *"option to switch between the server and the premium"* + *"nothing that using
> premium is capped"*.
>
> Concretely: **(a)** a user drops a **`.zip`**; the app **extracts** it, shows the file tree, and
> returns a **preview URL** that is **live but `noindex`**; the user presses **Publish** and the
> production URL serves the same bytes; the last 3 revisions are listed and one is undoable.
> **(b)** The **same folder** on the **premium** engine returns a live **`*.pages.dev`** URL.
> **(c)** The **account chooser** lists the platform credential + any BYO rows (label · account id ·
> 4-char hint · last-verified); picking one and deploying uses **that** account.
> Capture: HTTP statuses + each live URL fetched **from the public internet** + a screenshot of the
> Folder + Connection panes, and the raw `tsc`/`build`/`test:*` output.

## LAST — what you must NOT start

- **Converters** (A9 — OFF; §16.5; P4).
- **Switching accounts DURING a running job** (A5 "start with one" — the *store* is P2; the *switch
  during a job* is P5).
- **Resource-governor changes** (A8: *"lets build first, and when we are done, we will update the
  governor"*). Do NOT edit `lib/resource-governor.ts`. Record the heavy-load **metrics + dials**; that
  is all you do about the governor in this run.
- **Task 156 / Cyber Lab C2+** (A13 — the offensive/defensive tooling, the "simulate email/DNS/server
  attacks and run them on the user's own VM" work) — that is the **D2** run, its own doc
  (`PLAN_TASK_156_CYBERLAB_REAL_WORLD_TOOLS.md`). Cyber Lab stays **caps + nav/card + dark panel**.
- **Anything on `self-hosted-build`.**

REPORT BACK WITH EXACTLY: files + line ranges changed; the raw BEFORE output; the raw AFTER output;
the exact commands you ran; what you could NOT verify (expected, not a weakness); the commit SHA(s);
and confirmation the handoff is updated. LABEL ANYTHING SIMULATED AS "SIMULATION".
STOP WHEN YOUR TASK IS DONE. Do not start the next item. Do not deploy someone else's work.

---

## AFTER P3 — the D2 run (Task 156 "Cyber Lab, real world") — SAME agent, next run

> **Do not start this until P3 is committed, deployed and reported.** It is a **different run** with its
> own doc and its own gates. This section exists so the D2 agent has a self-contained prompt. The
> **build spec is `PLAN_TASK_156_CYBERLAB_REAL_WORLD_TOOLS.md` §12** (owner addendum 2026-10-02,
> **BINDING**) — read §12 **before** §5.

### D2 TASK BLOCK (paste from here)

```
TREE:            /Users/mikeolab/spaceworker           (branch: main)
TASK:            D2 / Task 156 - "Cyber Lab, real-world": offensive + defensive tooling that meets
                 TODAY'S attacks (simulate all kinds of emails / DNS / server attacks, research),
                 built on the Linux box, EASY for users and POWERFUL, with the end-to-end
                 simulation running on the USER'S OWN VM (SpaceWorker authors it).
                 YOU START AT:  C0 (AUP/consent text) then C1 (schema + gate + staff badge + admin
                 limits) ONLY. C2+ is a separate assignment - do NOT start it.
TASK DOC:        PLAN_TASK_156_CYBERLAB_REAL_WORLD_TOOLS.md   read section 12 FIRST (owner
                                                              addendum 2026-10-02 - BINDS the lab:
                                                              research gate 12.1, email 12.2, DNS
                                                              12.3, server 12.4, on-your-VM 12.5,
                                                              UX 12.6, Linux charter 12.7, phasing
                                                              impact 12.8), then 2 (exists vs lack),
                                                              3 (rails shared with 155), 4 (where the
                                                              machines are), 5 (matrix + the abuse
                                                              sentinel 5.2), 6 (schema draft),
                                                              7 (phasing C0-C6), 8 (how we prove
                                                              "not simulation"), 10 (the 5 open Qs).
                 SENIOR_HANDOFF.md                            sections 3, 4, 5 (traps - esp. 16:
                                                              "Lab* does not exist yet"), 8, 9, 10.
                 PLAN_TASK_155_WORKERS_AND_PAGES.md           section 16.6 + 14 (the CAP MECHANISM
                                                              you MUST reuse - see NON-NEGOTIABLE).
DEPENDS ON:      Task 155 P1+P2 shipped (DONE, live) AND P3 shipped. AND the owner's answers to
                 PLAN_156 section 10 - ASK the lead before touching C2+.
BRANCH:          main
DEPLOY?          C0 = docs only (no deploy). C1 = schema + gate + staff badge + admin limits:
                 ADDITIVE + NULLABLE, deployable via deploy.yml in-window like P2. C2+ (anything
                 that actually attacks a host) = LEAD decision, on a NON-production host, NEVER the
                 prod VPS. Section 9 of the handoff (deploy verification) applies verbatim.
```

### D2 — what C0/C1 actually are (the only green-light work)

```
C0  AUP + LabConsent text. NOTHING runs before it exists. (Legal, not code - but the text is
    a repo artefact AND a UI screen.)
C1  schema (section 6, one ADDITIVE migration) + the entitlement/gate (key "cyberlab" ALREADY in
    ENTITLEMENT_KEYS) + the staff badge + the admin limits (Lab*) + the section 12.1 LabToolCatalog
    (a row per capability: ATT&CK id, last-reviewed, upstream version, CVE history, licence,
    staleAfter) + the read-only Research admin page (feeds only - it does NOT run an attack).
    STOP HERE.
```

### D2 — non-negotiable (these BIND; from PLAN 156 §12/§5.2 + 155 §14 rule 1)

- **One cap mechanism, never a second.** All lab limits are named `AdminSetting` fields, enforced
  **server-side**, editable in the **admin UI**, shipped with defaults — **exactly** the 155 §14
  pattern. Do **not** invent a parallel config.
- **The abuse sentinel (§5.2) is the price of the power and is not optional:** every run is
  pre-flight **attested-target** checked; the **egress/DNS sentinel** watches volume+entropy; intent
  classification refuses third-party / product research. The §8.2 refusal demo must fire.
- **Never the production VPS.** Attack tooling lives on the **lab host** (second VPS / LAN box) and
  the **user's own VM** (§12.5). Prod keeps only `tcpdump` + purely defensive tools.
- **`requestSlot()` stays the single admission authority** (TASK_105 rule). Do **not** duplicate the
  governor and do **not** edit `lib/resource-governor.ts` — the governor task comes later (owner A8);
  you only *record* the load metrics/dials.
- **Reuse the safety plumbing that already exists** — the panic switch
  (`app/api/devices/panic/route.ts`), `AgentActionAudit`, `UserEntitlement`, the admin routes. Do
  **not** rebuild them.
- **Nothing customer-facing offensive before C0 + the L4 fences + lawyer sign-off.** Every tool row
  carries a **legal-basis note**; email/DNS rows additionally carry the **allow-list check**.

### D2 — FILES YOU MAY TOUCH / MUST NOT TOUCH

```
MAY TOUCH:   new lib/lab/** , app/api/lab/** , app/dashboard/cyberlab/** , components/cyberlab* ,
             app/admin/**/lab* , prisma/schema.prisma (ADDITIVE models only) + exactly ONE additive
             migration, tests/*.test.ts, and minimally lib/entitlements.ts / lib/products.ts /
             components/dashboard-nav.tsx (the Cyber Lab item already exists - extend, don't fork).
MUST NOT:    lib/resource-governor.ts, lib/agent.ts, lib/clone*.ts, any already-applied migration,
             the existing /e/ + /downloads/ + /r/ + /hf/ behaviour, and anything on self-hosted-build.
             REUSE lib/mailbox-crypto.ts for any secret at rest - do not fork it.
```

### D2 ACCEPTANCE (the exit criterion for C0/C1)

> C0: the AUP/consent text exists as a screen + a repo doc and gates the lab (nothing runs without
> accepting it). C1: the schema is applied (additive, no data loss), the `cyberlab` entitlement gates
> the panel, the staff badge shows, every lab limit is an admin-editable `AdminSetting` **live without
> a redeploy**, and `LabToolCatalog` rows render with a **`staleAfter`** date that hides a stale row.
> Capture: the raw `prisma migrate` output, the live admin PATCH (status+body), the panel DOM text,
> and `npx tsc --noEmit` → 0 + `CI=1 npx next build` → 0 + `npm run test:<relevant>` green.
> **C2+ is NOT in this run** — do not scan, spoof, or fire anything.

